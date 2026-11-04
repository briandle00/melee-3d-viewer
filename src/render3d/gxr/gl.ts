/// <reference lib="dom" />
/* GX renderer: the WebGL 2 backend. The front half of the pipeline (vertex transform, clipping, triangle setup: xform.ts and setup.ts)
 * runs on the CPU in 32-bit float; the triangles of a run go to the GPU as words, and one fragment-shader pass per run (glsl-pixel.ts)
 * does the pixel stage. EFB copies into texture memory and the clear after a copy are passes too (glsl-copy.ts).
 *
 * Order and memory: a pass reads texture memory (a copy of main memory on the GPU) as it was at the pass; a run of triangles is queued
 * until something would change what it reads: a copy of the EFB (which reads the EFB as it must then be), a memory write that lands on
 * a texture a queued triangle uses, a new TMEM. Everything else is queued across draws.
 */
import { Memory } from "./dff";
import { copyFormatFor, copyParams } from "./copy";
import { COPY_FS, CLEAR_FS, PICTURE_FS, PRESENT_FS } from "./glsl-copy";
import { expConstants, MEM_BYTES, MEM_PAL, MEM_PAL_SIZE, MEM_ROW, MEM_TMEM, pixelShader, STATE_WORDS, TILE, TILE_SHIFT } from "./glsl-pixel";
import { compile, compileDone, Compiling, finishCompile, FULLSCREEN_VS, intTexture, IntTex, startCompile, uploadRows } from "./glutil";
import { FrontCtx, Growable, HEADER_TEXELS, needsMainThread } from "./front";
import { FrontPool } from "./frontpool";
import { setLastZ } from "./setup";
import { GxGpu, type GxBackend } from "./gpu";
import type { GxInitial } from "./dff";
import { bits, GxRegs } from "./state";
import { formatInfo, levelOffset } from "./texunit";
import { VertexData } from "./vertex";
import { checkOps, checkPixels, checkScene } from "./floatcheck";
import { binTriangles, Entries } from "./bin";
import type { FloatOps } from "./glsl-float";

const EFB_W = 640, EFB_H = 528;
const EXP_CONSTS = expConstants();
const TILES_X = EFB_W / TILE, TILES_Y = EFB_H / TILE;
const NO_PAL = 0xffffffff;
const MEM_ROWS = MEM_BYTES / MEM_ROW;

interface Fbo { fbo: WebGLFramebuffer; tex: IntTex }

/** the optional pixel shader variants a draw's state needs: 1 the indirect texture unit (some TEV stage has indirect settings while indirect stages exist),
 *  2 the exponential fog forms or the fog range adjustment. Only the registers decide, so a stream can be scanned for them ahead of time (`scanFeatures`). */
export function drawFeatures(bp: Uint32Array): number {
  let feat = 0;
  const nStages = bits(bp[0], 10, 4) + 1;
  if (bits(bp[0], 16, 3) > 0) for (let si = 0; si < nStages; si++) if (bp[0x10 + si] !== 0) feat |= 1;
  if (bits(bp[0xf1], 21, 3) > 2 || (bits(bp[0xf1], 21, 3) !== 0 && bits(bp[0xe8], 10, 1))) feat |= 2;
  return feat;
}

/** the shader variants a whole stream needs (the union of `drawFeatures` over its draws): plays the stream without drawing anything */
export function scanFeatures(init: GxInitial, mem1: Uint8Array | undefined, frames: { fifo: Uint8Array; updates: unknown[] }[]): number {
  let feat = 0;
  const be = {
    drawing: true, fastForward: false,
    draw(regs: GxRegs) { feat |= drawFeatures(regs.bp); },
    copy() { return { toXfb: false, rect: [], clear: false }; },
    copyClear() {},
  };
  const gpu = new GxGpu(be as unknown as GxBackend, init, mem1);
  for (const fr of frames) gpu.runFrame(fr as never);
  return feat;
}

export class GxGl implements GxBackend {
  /** draws are skipped while this is false (the spec's reference draws nothing in the first frame of a recording; a viewer leaves it on) */
  drawing = true;
  /** playing through frames to reach a later one: draws are skipped (as with `drawing` false) and so are the frames' copies and clears */
  fastForward = false;
  onPicture: ((rgba: Uint8Array, frame: number) => void) | null = null;
  pictures = 0;
  tris = 0;
  draws = 0;
  /** called after a pass has been drawn (tests compare the EFB there) */
  onFlush: (() => void) | null = null;
  passes = 0;
  /** the features of the last pass's program (tests) */
  lastFeatures = 0;
  /** timing of the last frame's work, ms (CPU front half, GPU submit) */
  stats = { cpuMs: 0, flushMs: 0, uploadMs: 0, memBytes: 0, listEntries: 0, tilesTouched: 0 };

  private gl: WebGL2RenderingContext;
  private pending: Map<string, Compiling>;
  private progs = new Map<string, WebGLProgram>();
  private get progPixel(): WebGLProgram { return this.program("pixel"); }
  private get progCopy(): WebGLProgram { return this.program("copy"); }
  private get progClear(): WebGLProgram { return this.program("clear"); }
  private get progPicture(): WebGLProgram { return this.program("picture"); }
  /** what the queued draws need beyond the base shader: 1 the indirect unit, 2 the exponential fog and range adjustment */
  private needFeatures = 0;
  private stateFeatures: number[] = [];
  private mem!: IntTex;
  private memFbo!: WebGLFramebuffer;
  private efb: Fbo[] = [];
  private cur = 0;
  private pictureFbo!: { fbo: WebGLFramebuffer; tex: WebGLTexture };
  /** the picture framebuffer holds the last copy to the screen (present() shows it) */
  private havePicture = false;
  /** the pass inputs, in a ring: a pass still running on the GPU keeps reading its own set while the next is written */
  private sets: { data: IntTex; list: IntTex; tiles: IntTex }[] = [];
  private setNo = 0;
  private statesTex: IntTex;
  private q = new Growable();
  private states = new Growable();
  private stateCount = 0;
  private stateUploaded = 0;
  private stateIndex = new Map<number, number[]>();
  private stateRanges: number[][] = [];
  private lastStateVersion = [-1, -1, -1];
  private lastState = 0;
  private palMap = new Map<Uint8Array, number>();
  private palNext = 0;
  private attached: Memory | null = null;
  private dirty: number[] = [];
  /** the texture ranges the queued triangles read: start -> length */
  private used = new Map<number, number>();
  private tmemVersion = -1;
  private ctx = new FrontCtx();
  private fp: FrontPool | null = null;
  /** the tile entries of the queued triangles (bin.ts) */
  private ent = new Entries();
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** whether `stats` are kept (reading the clock per draw costs about 1% of a frame) */
  measure = false;
  /** GPU time of the passes (ms), when the browser has timer queries and `timing` is on */
  timing = false;
  private timer: { ext: any; pending: { q: WebGLQuery; what: string }[]; ms: Record<string, number> } | null = null;

  /** options of the pixel shader (test aids) */
  constructor(gl: WebGL2RenderingContext, private shaderOptions: { debugRegs?: [number, number]; mutate?: (source: string) => string; floatOps?: FloatOps | "auto" } = {}, front: { workers?: number; factory?: () => Worker } = {}) {
    this.gl = gl;
    // (auto: the card's own float arithmetic, once floatCheck has found it exact on this card; the whole-number functions otherwise)
    this.floatOps = !shaderOptions.floatOps || shaderOptions.floatOps === "auto" ? "fast" : shaderOptions.floatOps;
    this.floatAuto = !shaderOptions.floatOps || shaderOptions.floatOps === "auto";
    // the front half on worker threads (a page that is cross-origin isolated); otherwise it runs on this thread, with the same result
    if ((front.workers ?? 0) > 0 && FrontPool.available()) {
      this.fp = new FrontPool(front.workers!, front.factory ?? (() => new Worker(new URL("./frontworker.ts", import.meta.url), { type: "module" })));
    }
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < MEM_ROWS) throw new Error(`the GX renderer needs textures of ${MEM_ROWS} texels (this GPU's limit is ${gl.getParameter(gl.MAX_TEXTURE_SIZE)})`);
    // the programs compile in the background (when the browser can); `prepare()` waits for them, and the first draw would
    this.pending = new Map([
      ["pixel", startCompile(gl, FULLSCREEN_VS, pixelShader(this.pixelOptions()))], ["copy", startCompile(gl, FULLSCREEN_VS, COPY_FS)],
      ["clear", startCompile(gl, FULLSCREEN_VS, CLEAR_FS)], ["picture", startCompile(gl, FULLSCREEN_VS, PICTURE_FS)],
      ["present", startCompile(gl, FULLSCREEN_VS, PRESENT_FS)],
    ]);
    this.mem = intTexture(gl, "R8UI", MEM_ROW, MEM_ROWS);
    this.memFbo = this.fboOf(this.mem);
    for (let i = 0; i < 2; i++) { const t = intTexture(gl, "RG32UI", EFB_W, EFB_H); this.efb.push({ fbo: this.fboOf(t), tex: t }); }
    const pt = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, pt);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, EFB_W, EFB_H);
    const pf = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pt, 0);
    this.pictureFbo = { fbo: pf, tex: pt };
    for (let i = 0; i < 4; i++) this.sets.push({ data: intTexture(gl, "RGBA32UI", 1024, 64), list: intTexture(gl, "R32UI", 4096, 64), tiles: intTexture(gl, "RG32UI", 1024, Math.ceil(TILES_X * TILES_Y / 1024)) });
    this.statesTex = intTexture(gl, "R32UI", 4096, 64);
    this.timer = { ext: gl.getExtension("EXT_disjoint_timer_query_webgl2"), pending: [], ms: {} };
  }

  private syncPixel = new Uint32Array(4);
  private sync(): void {
    // reading a pixel back waits for everything before it (gl.finish() may return at once)
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.syncPixel);
  }
  private timeBegin(): number {
    if (!this.timing) return 0;
    const t = this.timer!;
    if (t.ext) { const q = this.gl.createQuery()!; this.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q); (t as { cur?: WebGLQuery }).cur = q; return 0; }
    this.sync();
    return performance.now();
  }
  private timeEnd(t0: number, what: string): void {
    if (!this.timing || !this.timer) return;
    const t = this.timer as { ext: any; pending: { q: WebGLQuery; what: string }[]; ms: Record<string, number>; cur?: WebGLQuery };
    if (t.ext) { this.gl.endQuery(t.ext.TIME_ELAPSED_EXT); t.pending.push({ q: t.cur!, what }); return; }
    this.sync();
    t.ms[what] = (t.ms[what] ?? 0) + performance.now() - t0;
  }
  /** ms of the passes by kind since the last call. With `timing` on: the GPU's own time per pass (timer queries) where the browser offers them, otherwise the wall-clock time with a wait after each pass */
  collectTimes(): Record<string, number> {
    const t = this.timer;
    if (!t) return {};
    const gl = this.gl;
    if (t.ext) {
      // wait for the queries to finish
      gl.finish();
      for (const p of t.pending) {
        for (let i = 0; i < 1000 && !gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE); i++) { /* spin */ }
        t.ms[p.what] = (t.ms[p.what] ?? 0) + Number(gl.getQueryParameter(p.q, gl.QUERY_RESULT)) / 1e6;
        gl.deleteQuery(p.q);
      }
      t.pending = [];
    }
    const out = t.ms;
    t.ms = {};
    return out;
  }

  /** back to a fresh processor: an empty frame buffer, no memory attached */
  reset(): void {
    const gl = this.gl;
    if (this.attached) { this.attached.onTouch = null; this.attached.beforeWrite = null; }
    this.attached = null;
    this.drainFront();
    this.q.n = 0; this.ent.n = 0; this.used.clear(); this.dirty = [];
    this.palMap.clear(); this.palNext = 0;
    this.resetStates();
    this.tmemVersion = -1;
    for (const e of this.efb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, e.fbo);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    }
    this.cur = 0; this.pictures = 0; this.tris = 0; this.passes = 0;
  }

  private program(name: string): WebGLProgram {
    let p = this.progs.get(name);
    if (!p) { p = finishCompile(this.gl, this.pending.get(name)!); this.progs.set(name, p); this.pending.delete(name); }
    return p;
  }

  /** how the pixel programs add and multiply floats (glsl-float.ts): "fast" the card's own arithmetic, "soft" whole numbers ("dual": a check) */
  floatOps: FloatOps;
  private floatAuto: boolean;
  /** the start-up check of the card's float arithmetic (floatcheck.ts): operations and pixels that differed, and the time it took; null before it ran */
  floatCheck: { ops: number; pixels: number; ms: number; error?: string } | null = null;
  private floatChecking: Promise<void> | null = null;
  private pixelOptions() { return { ...this.shaderOptions, floatOps: this.floatOps }; }

  /** With floatOps auto: the card's float arithmetic is checked (floatcheck.ts: operations, then a scene's pixels against the CPU
   *  reference, through the base pixel program) before anything is drawn; on any difference the programs are made again with the
   *  whole-number float functions. Every user of the renderer (the player, the export, a host's own player) goes through prepare() or
   *  its first draw, so none draws before the check. */
  private checkFloat(): Promise<void> {
    if (!this.floatAuto || this.floatOps !== "fast") return Promise.resolve();
    if (!this.floatChecking) this.floatChecking = (async () => {
      let ms = 0, ops = -1, pixels = -1, error: string | undefined;
      try {
        let t0 = performance.now();
        ops = checkOps(this.gl);
        ms += performance.now() - t0;
        if (ops === 0) {
          // (the scene is drawn by the base pixel program: its compile is waited for, not counted)
          const c = this.pending.get("pixel");
          while (c && !compileDone(this.gl, c)) await new Promise((r) => setTimeout(r, 10));
          t0 = performance.now();
          pixels = checkPixels(this);
          ms += performance.now() - t0;
        }
      } catch (e) { error = String((e as Error)?.message ?? e); }
      this.floatCheck = { ops, pixels, ms, error };
      if (ops !== 0 || pixels !== 0) this.useSoftFloat();
    })();
    return this.floatChecking;
  }

  /** the pixel programs again with the whole-number float functions (the card's arithmetic failed the check) */
  private useSoftFloat(): void {
    this.floatOps = "soft";
    for (const k of [...this.progs.keys()]) if (k.startsWith("pixel")) { this.gl.deleteProgram(this.progs.get(k)!); this.progs.delete(k); }
    for (const k of [...this.pending.keys()]) if (k.startsWith("pixel")) this.pending.delete(k);
    this.pending.set("pixel", startCompile(this.gl, FULLSCREEN_VS, pixelShader(this.pixelOptions())));
  }

  /** Draw a small built-in scene (floatcheck.ts checkScene) `times` times and forget it: the JavaScript engine has compiled the draw path,
   *  and the workers have started, before a replay's first frame. Leaves the renderer as reset() does. Call after prepare(). */
  warmUp(times = 6): void {
    const sc = checkScene();
    const draws = this.draws, drawing = this.drawing, ff = this.fastForward;
    try {
      this.reset();
      this.drawing = true; this.fastForward = false;
      const g = new GxGpu(this, sc.init, sc.mem);
      for (let i = 0; i < times; i++) { g.runFrame({ fifo: sc.stream, updates: [] }); this.flush(); }
      this.finish();
    } finally {
      this.reset();
      this.draws = draws; this.drawing = drawing; this.fastForward = ff;
    }
  }

  /** wait (without blocking the page) until the shaders are compiled; `features` also starts the optional pixel shader variants
   *  (1: the indirect texture unit, 2: the exponential fog and range adjustment) so that no draw has to wait for them later */
  async prepare(features = 0): Promise<void> {
    await this.checkFloat();
    for (const f of [1, 2, 3]) if ((features & f) === f && !this.pending.has("pixel" + f) && !this.progs.has("pixel" + f)) {
      this.pending.set("pixel" + f, startCompile(this.gl, FULLSCREEN_VS, pixelShader({ ...this.pixelOptions(), indirect: (f & 1) !== 0, fogExtra: (f & 2) !== 0 })));
    }
    for (const [name, c] of [...this.pending]) {
      while (!compileDone(this.gl, c)) await new Promise((r) => setTimeout(r, 10));
      this.program(name);
    }
  }

  /** compile the optional pixel shader variants one after another in the background (the browser compiles on its own threads where it can), so that a draw
   *  that needs one finds it ready. Resolves when all are done; nothing waits for it. Call after `prepare()`. */
  async warm(features = 3): Promise<void> {
    await this.checkFloat();
    for (const f of [2, 1, 3]) {
      if ((features & f) !== f || this.progs.has("pixel" + f)) continue;
      if (!this.pending.has("pixel" + f)) this.pending.set("pixel" + f, startCompile(this.gl, FULLSCREEN_VS, pixelShader({ ...this.pixelOptions(), indirect: (f & 1) !== 0, fogExtra: (f & 2) !== 0 })));
      const c = this.pending.get("pixel" + f)!;
      while (!compileDone(this.gl, c)) await new Promise((r) => setTimeout(r, 50));
      if (this.pending.has("pixel" + f)) this.program("pixel" + f);
    }
  }

  /** counters of the draws that had to wait for a shader to compile (it should stay zero when `prepare` or `warm` ran early enough) */
  compileWaits = { count: 0, ms: 0 };

  /** the pixel program for a set of features (compiled when first needed) */
  private pixelProgram(features: number): WebGLProgram {
    if (features === 0) return this.progPixel;
    const key = "pixel" + features;
    if (this.progs.has(key)) return this.progs.get(key)!;
    if (!this.pending.has(key)) this.pending.set(key, startCompile(this.gl, FULLSCREEN_VS, pixelShader({ ...this.pixelOptions(), indirect: (features & 1) !== 0, fogExtra: (features & 2) !== 0 })));
    const t0 = performance.now();
    const p = this.program(key);
    this.compileWaits.count++; this.compileWaits.ms += performance.now() - t0;
    return p;
  }

  private fboOf(t: IntTex): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return fbo;
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p);
    if (!m) { m = new Map(); this.uniforms.set(p, m); }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private bindTex(p: WebGLProgram, unit: number, name: string, t: IntTex): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.u(p, name), unit);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // memory

  /** upload main memory and TMEM to the GPU now, rather than at the first draw (which then would take a frame's time for it): call it once the memory holds the game's first state, off the frame loop */
  prepareMemory(mem: Memory, regs: GxRegs): void { this.attach(mem, regs); }

  private attach(mem: Memory, regs: GxRegs): void {
    if (this.attached === mem) return;
    this.attached = mem;
    const gl = this.gl;
    // the whole main memory, then TMEM
    uploadRows(gl, this.mem, 0, 0, MEM_ROW, mem.data.length / MEM_ROW, mem.data);
    this.uploadTmem(regs);
    this.dirty = [];
    mem.onTouch = (a, n) => { this.dirty.push(a, n); };
    mem.beforeWrite = (a, n) => {
      for (const [start, len] of this.used) {
        if (a < start + len && start < a + n) { this.flush(); break; }
      }
    };
  }

  private uploadTmem(regs: GxRegs): void {
    uploadRows(this.gl, this.mem, 0, MEM_TMEM / MEM_ROW, MEM_ROW, regs.tmem.length / MEM_ROW, regs.tmem);
    this.tmemVersion = regs.tmemVersion;
  }

  /** upload bytes [a, a + n) of a source array that holds memory from address `base` */
  private uploadBytes(a: number, n: number, src: Uint8Array, base: number): void {
    const gl = this.gl;
    const end = a + n;
    let p = a;
    // head: up to the next row start
    if (p & (MEM_ROW - 1)) {
      const m = Math.min(end, (p | (MEM_ROW - 1)) + 1) - p;
      uploadRows(gl, this.mem, p & (MEM_ROW - 1), p / MEM_ROW | 0, m, 1, src.subarray(p - base, p - base + m));
      p += m;
    }
    const rows = (end - p) / MEM_ROW | 0;
    if (rows > 0) { uploadRows(gl, this.mem, 0, p / MEM_ROW, MEM_ROW, rows, src.subarray(p - base, p - base + rows * MEM_ROW)); p += rows * MEM_ROW; }
    if (p < end) uploadRows(gl, this.mem, 0, p / MEM_ROW, end - p, 1, src.subarray(p - base, end - base));
  }

  private uploadDirty(mem: Memory): void {
    if (!this.dirty.length) return;
    const d = this.dirty;
    this.dirty = [];
    for (let i = 1; i < d.length; i += 2) this.stats.memBytes += d[i];
    // merge into ranges by start
    const idx: number[] = [];
    for (let i = 0; i < d.length; i += 2) idx.push(i);
    idx.sort((x, y) => d[x] - d[y]);
    let s = -1, e = -1;
    for (const i of idx) {
      const a = d[i], b = d[i] + d[i + 1];
      if (s < 0) { s = a; e = b; } else if (a <= e) e = Math.max(e, b); else { this.uploadBytes(s, e - s, mem.data, 0); s = a; e = b; }
    }
    if (s >= 0) this.uploadBytes(s, e - s, mem.data, 0);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // state

  private paletteAddress(bytes: Uint8Array): number {
    let a = this.palMap.get(bytes);
    if (a !== undefined) return a;
    if (this.palNext + bytes.length > MEM_PAL_SIZE) {
      this.flush();
      this.palMap.clear(); this.palNext = 0;
      this.resetStates();
    }
    a = MEM_PAL + this.palNext;
    this.uploadBytes(a, bytes.length, bytes, a);
    this.palMap.set(bytes, a);
    this.palNext = (this.palNext + bytes.length + 31) & ~31;
    return a;
  }

  private resetStates(): void {
    this.stateCount = 0; this.stateUploaded = 0; this.states.n = 0;
    this.stateIndex.clear(); this.stateRanges = []; this.stateFeatures = [];
    this.lastStateVersion = [-1, -1, -1];
  }

  /** the state index for the registers now (queued draws share it until a register changes) */
  private wScratch = new Uint32Array(STATE_WORDS);

  /** the memory ranges (start, length) of the textures the enabled stages read, for the hazard check */
  private textureRanges(regs: GxRegs, nStages: number): number[] {
    const ranges: number[] = [];
    const seen = new Set<number>();
    for (let si = 0; si < nStages; si++) {
      const ord = regs.bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (!bits(ord, 6, 1)) continue;
      const m = bits(ord, 0, 3);
      if (seen.has(m)) continue;
      seen.add(m);
      const hi = m >= 4, k = m & 3;
      const img0 = regs.bp[(hi ? 0xa8 : 0x88) + k], img1 = regs.bp[(hi ? 0xac : 0x8c) + k], img3 = regs.bp[(hi ? 0xb4 : 0x94) + k];
      const fmt = bits(img0, 20, 4), W = bits(img0, 0, 10), H = bits(img0, 10, 10);
      if (bits(img1, 21, 1)) continue;
      let levels = 1, mw = W + 1, mh = H + 1;
      while (mw > 1 || mh > 1) { mw >>= 1; mh >>= 1; levels++; }
      const fi = formatInfo(fmt);
      const size = levelOffset(fmt, W, H, levels - 1) + Math.max(mw, fi.bw) * Math.max(mh, fi.bh) * fi.nibbles / 2 + 64;
      ranges.push((img3 & 0xffffff) * 32, size);
    }
    return ranges;
  }

  private stateFor(regs: GxRegs): number {
    if (this.stateCount > 20000) { this.flush(); this.palMap.clear(); this.palNext = 0; this.resetStates(); }
    const tv = regs.tmemVersion;
    if (this.lastStateVersion[0] === regs.bpVersion && this.lastStateVersion[1] === regs.xfVersion && this.lastStateVersion[2] === tv) return this.lastState;
    const w = this.wScratch;
    w.fill(0);
    w.set(regs.bp);
    for (let i = 0; i < 8; i++) w[0xe0 + i] = regs.tevBank[0][i];
    for (let i = 0; i < 8; i++) w[256 + i] = regs.tevBank[1][i];
    let projMask = 0;
    for (let n = 0; n < 8; n++) if ((regs.xf[0x1040 + n] >> 1) & 1) projMask |= 1 << n;
    w[272] = projMask;
    w[273] = regs.xf[0x101a];
    const nStages = bits(regs.bp[0], 10, 4) + 1;
    let seen = 0;
    for (let m = 0; m < 8; m++) w[264 + m] = NO_PAL;
    for (let si = 0; si < nStages; si++) {
      const ord = regs.bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (!((ord >> 6) & 1)) continue;
      const m = ord & 7;
      if ((seen >> m) & 1) continue;
      seen |= 1 << m;
      const hi = m >= 4, k = m & 3;
      const fmt = (regs.bp[(hi ? 0xa8 : 0x88) + k] >> 20) & 15;
      if (fmt === 8 || fmt === 9 || fmt === 10) {
        const pal = regs.tluts.get(regs.bp[(hi ? 0xb8 : 0x98) + k] & 0x3ff);
        if (pal) { w[264 + m] = this.paletteAddress(pal); w[274 + m] = pal.length; }
      }
    }
    // hash and find
    let h = 2166136261;
    for (let i = 0; i < STATE_WORDS; i++) { h ^= w[i]; h = Math.imul(h, 16777619); }
    h >>>= 0;
    let found = -1;
    const cands = this.stateIndex.get(h);
    if (cands) {
      for (const c of cands) {
        const base = c * STATE_WORDS;
        let same = true;
        for (let i = 0; i < STATE_WORDS; i++) if (this.states.words[base + i] !== w[i]) { same = false; break; }
        if (same) { found = c; break; }
      }
    }
    if (found < 0) {
      found = this.stateCount++;
      this.states.ensure(STATE_WORDS);
      this.states.words.set(w, found * STATE_WORDS);
      this.states.n = this.stateCount * STATE_WORDS;
      if (cands) cands.push(found); else this.stateIndex.set(h, [found]);
      this.stateRanges[found] = this.textureRanges(regs, nStages);
      this.stateFeatures[found] = drawFeatures(regs.bp);
    }
    this.lastStateVersion = [regs.bpVersion, regs.xfVersion, tv];
    this.lastState = found;
    return found;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // draws

  draw(regs: GxRegs, mem: Memory, vd: VertexData, tris: number[], lines: number[], points: number[], prims: { type: number; base: number; count: number }[]): void {
    if (!this.drawing || this.fastForward) return;
    this.draws++;
    const t0 = this.measure ? performance.now() : 0;
    this.attach(mem, regs);
    if (regs.tmemVersion !== this.tmemVersion) { this.flush(); this.uploadTmem(regs); }
    const st = this.stateFor(regs);
    const ranges = this.stateRanges[st];
    this.needFeatures |= this.stateFeatures[st];
    for (let i = 0; i < ranges.length; i += 2) if ((this.used.get(ranges[i]) ?? 0) < ranges[i + 1]) this.used.set(ranges[i], ranges[i + 1]);
    if (this.fp && !needsMainThread(regs.bp, prims)) this.fp.submit(regs, vd, prims, st, () => this.drainFront());
    else {
      // on this thread: after the jobs of the earlier draws, so the queue keeps the draw order
      this.drainFront();
      const q = this.q, o0 = q.n;
      this.ctx.run(regs, vd, prims, st, q);
      this.tris += binTriangles(q.ints.subarray(o0), q.words.subarray(o0), q.n - o0, o0 >> 2, this.ent);
    }
    if (this.measure) this.stats.cpuMs += performance.now() - t0;
  }

  /** the draws on the worker threads, taken into the queue in draw order */
  private drainFront(): void {
    const fp = this.fp;
    if (!fp || !fp.busy) return;
    const q = this.q;
    const E = this.ent;
    fp.drain((words, ents, tris) => {
      q.ensure(words.length);
      const o0 = q.n;
      q.words.set(words, o0);
      q.n += words.length;
      if (!ents) { this.tris += binTriangles(q.ints.subarray(o0), q.words.subarray(o0), words.length, o0 >> 2, E); return; }
      // (the worker's entries name triangles from its job's first word: the job's words start at texel o0 >> 2 here)
      this.tris += tris;
      E.ensure(ents.length);
      const A = E.a, base = o0 >> 2;
      let n = E.n;
      for (let i = 0; i < ents.length; i += 2) { A[n++] = ents[i]; A[n++] = ents[i + 1] + base; }
      E.n = n;
    });
    if (fp.zFresh) { fp.zFresh = false; setLastZ(fp.zPlane!); }
  }

  /** the worker pool's counters (null without one) */
  get poolStats(): { mainJobs: number; jobs: number; waitMs: number; mergeMs: number; workerJobs: number; workersStarted: number } | null { return this.fp ? { ...this.fp.stats, workerJobs: this.fp.workerJobs, workersStarted: this.fp.workersStarted } : null; }

  /** stop the worker threads (the backend draws on this thread from then on) */
  dispose(): void { this.drainFront(); this.fp?.dispose(); this.fp = null; }

  // -------------------------------------------------------------------------------------------------------------------
  // passes

  private grow(t: IntTex, n: number, perRow: number): IntTex {
    const rows = Math.ceil(n / perRow);
    if (rows <= t.h) return t;
    let h = t.h;
    while (h < rows) h *= 2;
    this.gl.deleteTexture(t.tex);
    return intTexture(this.gl, t.fmt, t.w, h);
  }

  /** (floatcheck.ts draws its scene through this backend while it checks) */
  floatChecking_ = false;

  flush(): void {
    this.drainFront();
    const qn = this.q.n;
    // memory writes that have landed go to the GPU now, before anything that writes memory there (a copy) or reads it
    const tu = this.measure ? performance.now() : 0;
    if (this.attached) this.uploadDirty(this.attached);
    if (this.measure) this.stats.uploadMs += performance.now() - tu;
    if (qn === 0) { this.used.clear(); return; }
    // (nothing is drawn with the card's float arithmetic before the check has found it exact: a draw that comes first gets the whole-number functions)
    if (this.floatAuto && this.floatOps === "fast" && !this.floatCheck && !this.floatChecking_) this.useSoftFloat();
    const t0 = this.measure ? performance.now() : 0;
    const gl = this.gl;
    // the tile lists: the entries of the queued triangles (bin.ts; made by the workers for their draws, here for the others), counted and placed in draw order
    const nTiles = TILES_X * TILES_Y;
    const counts = new Uint32Array(nTiles + 1);
    const EA = this.ent.a, ne2 = this.ent.n;
    for (let e = 0; e < ne2; e += 2) counts[EA[e]]++;
    const start = new Uint32Array(nTiles + 1);
    let total = 0;
    for (let t = 0; t < nTiles; t++) { start[t] = total; total += counts[t]; }
    this.stats.listEntries += total;
    const list = new Uint32Array(Math.max(1, Math.ceil(total / 4096)) * 4096);
    const fill = new Uint32Array(nTiles);
    for (let e = 0; e < ne2; e += 2) { const t = EA[e]; list[start[t] + fill[t]++] = EA[e + 1]; }
    const tileRows = Math.ceil(nTiles / 1024);
    const tiles = new Uint32Array(1024 * tileRows * 2);
    for (let t = 0; t < TILES_X * TILES_Y; t++) { tiles[t * 2] = start[t]; tiles[t * 2 + 1] = counts[t]; }
    // uploads
    const set = this.sets[this.setNo++ % this.sets.length];
    set.data = this.grow(set.data, this.q.n, 4096);
    const dataRows = Math.ceil(this.q.n / 4096);
    uploadRows(gl, set.data, 0, 0, 1024, dataRows, this.q.words.subarray(0, dataRows * 4096));
    set.list = this.grow(set.list, list.length, 4096);
    uploadRows(gl, set.list, 0, 0, 4096, list.length / 4096, list);
    uploadRows(gl, set.tiles, 0, 0, 1024, tileRows, tiles);
    const st0 = this.statesTex;
    this.statesTex = this.grow(this.statesTex, this.states.n, 4096);
    if (this.statesTex !== st0) this.stateUploaded = 0;
    const sRows = Math.ceil(this.states.n / 4096);
    const sFirst = Math.floor(this.stateUploaded * STATE_WORDS / 4096);
    this.states.ensure(sRows * 4096 - this.states.n);
    uploadRows(gl, this.statesTex, 0, sFirst, 4096, sRows - sFirst, this.states.words.subarray(sFirst * 4096, sRows * 4096));
    this.stateUploaded = this.stateCount;
    // the pass
    const src = this.efb[this.cur], dst = this.efb[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const p = this.pixelProgram(this.needFeatures);
    this.lastFeatures = this.needFeatures;
    gl.useProgram(p);
    this.bindTex(p, 0, "uMem", this.mem);
    this.bindTex(p, 1, "uData", set.data);
    this.bindTex(p, 2, "uTiles", set.tiles);
    this.bindTex(p, 3, "uList", set.list);
    this.bindTex(p, 4, "uStates", this.statesTex);
    this.bindTex(p, 5, "uEfb", src.tex);
    gl.uniform1i(this.u(p, "uTilesX"), TILES_X);
    gl.uniform4i(this.u(p, "uK"), 4, 25, 3, 2);
    if (this.needFeatures & 2) gl.uniform4uiv(this.u(p, "uExpC"), EXP_CONSTS);
    const tq = this.timeBegin();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timeEnd(tq, "pixel");
    this.cur = 1 - this.cur;
    this.passes++;
    this.q.n = 0; this.ent.n = 0; this.used.clear(); this.needFeatures = 0;
    if (this.measure) this.stats.flushMs += performance.now() - t0;
    this.onFlush?.();
  }

  /** wait for the GPU (timing, tests) */
  finish(): void { this.gl.finish(); }

  copy(regs: GxRegs, mem: Memory, value: number): { toXfb: boolean; rect: number[]; clear: boolean } {
    this.attach(mem, regs);
    this.flush();
    const gl = this.gl;
    const p = copyParams(regs.bp);
    const src = this.efb[this.cur];
    if (p.toScreen) {
      // the copy to the screen is kept as it is made (the EFB is often cleared by the same copy, so present() cannot show the EFB
      // afterwards); read back only for a page that asks for the pixels
      this.drawPicture(p.pixFmt);
      this.havePicture = true;
      if (this.onPicture) this.onPicture(this.readKept(), this.pictures);
      this.pictures++;
    } else {
      const fmt = copyFormatFor(p);
      const ID: Record<string, number> = { I4: 0, I8: 1, IA4: 2, IA8: 3, RGB565: 4, RGB5A3: 5, RGBA8: 6, R4: 7, Z16: 16, Z16L: 17, RA4: 8, RA8: 9, A8: 10, R8: 11, G8: 12, B8: 13, RG8: 14, GB8: 15 };
      if (fmt !== "none") {
        const BL: Record<string, [number, number, number]> = {
          I4: [3, 3, 32], I8: [3, 2, 32], IA4: [3, 2, 32], IA8: [2, 2, 32], RGB565: [2, 2, 32], RGB5A3: [2, 2, 32], RGBA8: [2, 2, 64],
          R4: [3, 3, 32], Z16: [2, 2, 32], Z16L: [2, 2, 32], RA4: [3, 2, 32], RA8: [2, 2, 32], A8: [3, 2, 32], R8: [3, 2, 32], G8: [3, 2, 32], B8: [3, 2, 32], RG8: [2, 2, 32], GB8: [2, 2, 32],
        };
        const [kw, kh, bytes] = BL[fmt];
        const sh = p.half ? 1 : 0;
        const bx = ((p.wm >> sh) >> kw) + 1, by = ((p.hm >> sh) >> kh) + 1;
        const dest = p.dest & 0x1ffffff;
        const total = (by - 1) * p.stride + bx * bytes;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.memFbo);
        gl.viewport(0, 0, MEM_ROW, MEM_ROWS);
        gl.enable(gl.SCISSOR_TEST);
        const row0 = dest / MEM_ROW | 0, row1 = Math.min(MEM_ROWS - 1, (dest + total) / MEM_ROW | 0);
        gl.scissor(0, row0, MEM_ROW, row1 - row0 + 1);
        const pr = this.progCopy;
        gl.useProgram(pr);
        this.bindTex(pr, 0, "uEfb", src.tex);
        const set = (n: string, v: number) => gl.uniform1i(this.u(pr, n), v);
        set("uDest", dest); set("uStride", p.stride); set("uFmt", ID[fmt]); set("uBlocksX", bx); set("uBlocksY", by); set("uKw", kw); set("uKh", kh);
        set("uBytes", bytes); set("uHalf", sh); set("uX0", p.x0); set("uY0", p.y0); set("uPixFmt", p.pixFmt);
        const tq = this.timeBegin();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.timeEnd(tq, "copy");
        gl.disable(gl.SCISSOR_TEST);
      }
    }
    return { toXfb: p.toScreen, rect: [p.x0, p.y0, p.wm + 1, p.hm + 1], clear: p.clear };
  }

  copyClear(regs: GxRegs): void {
    this.flush();
    const gl = this.gl;
    const p = copyParams(regs.bp);
    const bp = regs.bp;
    const mode = bp[0x41];
    const r = bp[0x4f] & 255, a = (bp[0x4f] >> 8) & 255, b = bp[0x50] & 255, g = (bp[0x50] >> 8) & 255;
    const src = this.efb[this.cur], dst = this.efb[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.progClear;
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", src.tex);
    gl.uniform4i(this.u(pr, "uRect"), p.x0, p.y0, p.x0 + p.wm, p.y0 + p.hm);
    const color = p.pixFmt === 1 ? ((b >> 2) << 6 | (g >> 2) << 12 | (r >> 2) << 18) >>> 0 : (b | (g << 8) | (r << 16)) >>> 0;
    gl.uniform1ui(this.u(pr, "uColor"), color);
    gl.uniform1ui(this.u(pr, "uAlpha6"), a >> 2);
    gl.uniform1ui(this.u(pr, "uDepth"), bp[0x51] & 0xffffff);
    gl.uniform1i(this.u(pr, "uColorUpd"), (mode >> 3) & 1);
    gl.uniform1i(this.u(pr, "uAlphaUpd"), (mode >> 4) & 1);
    gl.uniform1i(this.u(pr, "uZUpd"), bits(bp[0x40], 4, 1));
    gl.uniform1i(this.u(pr, "uPixFmt"), p.pixFmt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }

  /** set the frame buffer (tests) */
  writeEfb(color: Uint32Array, depth: Uint32Array): void {
    const raw = new Uint32Array(EFB_W * EFB_H * 2);
    for (let i = 0; i < color.length; i++) { raw[i * 2] = color[i]; raw[i * 2 + 1] = depth[i]; }
    uploadRows(this.gl, this.efb[this.cur].tex, 0, 0, EFB_W, EFB_H, raw);
  }

  /** bytes [a, a + n) of the GPU's copy of memory (slow: tests) */
  readMem(a: number, n: number): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.memFbo);
    const row0 = a / MEM_ROW | 0, row1 = (a + n - 1) / MEM_ROW | 0;
    const raw = new Uint32Array(MEM_ROW * (row1 - row0 + 1) * 4);
    gl.readPixels(0, row0, MEM_ROW, row1 - row0 + 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = raw[(a - row0 * MEM_ROW + i) * 4];
    return out;
  }

  /** the whole EFB: color words and depths (slow: tests) */
  readEfb(): { color: Uint32Array; depth: Uint32Array } {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efb[this.cur].fbo);
    const raw = new Uint32Array(EFB_W * EFB_H * 4);
    gl.readPixels(0, 0, EFB_W, EFB_H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
    const color = new Uint32Array(EFB_W * EFB_H), depth = new Uint32Array(EFB_W * EFB_H);
    for (let i = 0; i < color.length; i++) { color[i] = raw[i * 4]; depth[i] = raw[i * 4 + 1]; }
    return { color, depth };
  }

  /** Show the last picture copied to the screen (before any: the frame buffer's top 640 x 480, queued triangles drawn first). With
   *  no target, or the context's own canvas, it is drawn into the canvas's framebuffer without a read-back (nearest filtering, the
   *  canvas size, or `width` x `height`); a 2D context or another canvas gets the picture through a read-back and putImageData. */
  present(target?: HTMLCanvasElement | { putImageData(d: ImageData, x: number, y: number): void } | number, height?: number, pixFmt = 0): void {
    if (target !== undefined && typeof target !== "number" && target !== (this.gl.canvas as unknown)) {
      const ctx = "putImageData" in target ? target : (target as HTMLCanvasElement).getContext("2d");
      const rgba = this.readPicture(pixFmt);
      ctx?.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) as unknown as ImageDataArray, 640, 480), 0, 0);
      return;
    }
    const width = typeof target === "number" ? target : this.gl.drawingBufferWidth;
    height = typeof target === "number" ? height! : this.gl.drawingBufferHeight;
    this.flush();
    const gl = this.gl;
    if (this.havePicture) {
      // (the kept picture's first row is the picture's top: flipped onto the canvas, whose first row is its bottom)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.pictureFbo.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, EFB_W, 480, 0, height, width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.program("present");
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", this.efb[this.cur].tex);
    gl.uniform1i(this.u(pr, "uPixFmt"), pixFmt);
    gl.uniform2f(this.u(pr, "uSize"), width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** the top 640 x 480 of the EFB as RGBA bytes (R, G, B, A) */
  readPicture(pixFmt: number): Uint8Array {
    this.drawPicture(pixFmt);
    return this.readKept();
  }

  /** the last picture copied to the screen as RGBA bytes (a read-back), or null before the first: for a page that starts showing the
   *  picture another way while paused (a TV turned on) */
  picture(): Uint8Array | null { return this.havePicture ? this.readKept() : null; }

  /** the picture framebuffer's 640 x 480 as RGBA bytes */
  private readKept(): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pictureFbo.fbo);
    const out = new Uint8Array(EFB_W * 480 * 4);
    gl.readPixels(0, 0, EFB_W, 480, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /** the top 640 x 480 of the EFB into the picture framebuffer, as the copy's pixel format shows it */
  private drawPicture(pixFmt: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pictureFbo.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.progPicture;
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", this.efb[this.cur].tex);
    gl.uniform1i(this.u(pr, "uPixFmt"), pixFmt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
