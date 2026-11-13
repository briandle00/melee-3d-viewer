/* GX renderer: the graphics processor. Reads a GX command stream - what the game's GX calls write to the write-gather
 * pipe - and runs it: register loads (BP 0x61, CP 0x08, XF 0x10, indexed XF 0x20 to 0x38), display list calls (0x40) and
 * draws (0x80 to 0xB8), the draws into the renderer's EFB. A frame is the commands between two copies to the screen.
 *
 * A run of draw commands with no register command between them is one GL draw (the registers are what they were for
 * each of them); a register command ends the run.
 */
import { GxFrame, GxInitial, Memory } from "./dff";
import type { FreshWatch } from "./fresh";
import { bits, GxRegs } from "./state";
import { VertexData, VertexLayout, vertexLayout } from "./vertex";

export interface GpuEvent {
  /** "xfb" (the frame is done), "texture" (a copy into memory) */
  kind: string;
  rect?: number[];
  detail?: string;
}

/** what the processor needs of a renderer: the draws and the copies. `prims` lists the draw commands of the run, in order
 *  (the primitive type of the opcode, the first vertex and the vertex count); registers are what they were for all of them. */
export interface GxBackend {
  draw(regs: GxRegs, mem: Memory, vd: VertexData, tris: number[], lines: number[], points: number[], prims: { type: number; base: number; count: number }[], raw?: RawRun | null): void;
  copy(regs: GxRegs, mem: Memory, value: number): { toXfb: boolean; rect: number[]; clear: boolean };
  copyClear(regs: GxRegs): void;
}

const EMPTY: number[] = [];

/** A run whose vertices were not decoded (the backend asked for it: `rawVertices`): `vd` is set up for the layout and holds no vertices;
 *  `segs` are the draw commands' vertex bytes (the buffer, the offset of the first vertex, the vertex count, for each command), `n` the
 *  vertices in all. `decode()` decodes them into `vd` as an ordinary run would have (the memory as it is now: call it before the run's
 *  draw returns). A memory write inside a run decodes the run's vertices so far first, so the bytes are always read as they were sent. */
export interface RawRun { vat: number; size: number; n: number; segs: (Uint8Array | number)[]; decode(): void }

export class GxGpu {
  regs: GxRegs;
  readonly mem = new Memory();
  readonly events: GpuEvent[] = [];
  /** called when the game copies the EFB to the screen */
  onXfb: ((rect: number[]) => void) | null = null;
  drawCount = 0;
  /** ms spent decoding vertices and applying memory writes (a cost breakdown for tests) */
  timers = { vertex: 0, memory: 0 };
  /** whether `timers` are kept (reading the clock per run costs about 1% of a frame) */
  measure = false;
  /** (a stream started mid-game) what the frames drawn read that this GPU was not given: fresh.ts */
  watch: FreshWatch | null = null;
  private cpVersion = 0;
  private layouts = new Map<number, { v: number; l: VertexLayout; w0: number; w1: number; w2: number; w3: number; w4: number }>();
  private vd = new VertexData(null as never);
  private run: { vd: VertexData; tris: number[]; lines: number[]; points: number[]; prims: { type: number; base: number; count: number }[]; raw: RawRun | null } | null = null;

  constructor(readonly renderer: GxBackend, init: GxInitial, mem1?: Uint8Array | null) {
    this.regs = new GxRegs(init.bp, init.cp, init.xfMem, init.xfRegs);
    this.load(init, mem1);
  }

  private load(init: GxInitial, mem1?: Uint8Array | null): void {
    if (init.texMem.length) this.regs.tmem.set(init.texMem.subarray(0, this.regs.tmem.length));
    if (mem1) { this.mem.data.set(mem1.subarray(0, this.mem.data.length)); this.mem.touch(0, this.mem.data.length); }
  }

  /** the state of the constructor again on the same backend (a restart, a seek backward): memory zero or `mem1`, registers from `init`,
   *  the backend's frame buffer and caches dropped (when it has a `reset`) */
  reset(init: GxInitial, mem1?: Uint8Array | null): void {
    this.run = null;
    this.events.length = 0;
    this.drawCount = 0;
    this.cpVersion++;
    (this.renderer as { reset?: () => void }).reset?.();
    this.mem.data.fill(0);
    this.mem.touch(0, this.mem.data.length);
    this.regs = new GxRegs(init.bp, init.cp, init.xfMem, init.xfRegs);
    this.load(init, mem1);
  }

  private layout(vat: number): VertexLayout {
    const c = this.layouts.get(vat);
    if (c && c.v === this.cpVersion) return c.l;
    const cp = this.regs.cp;
    // the games write the vertex descriptor before every draw: a layout depends on five words only, and the same words give the same layout
    const w0 = cp[0x50], w1 = cp[0x60], w2 = cp[0x70 + vat], w3 = cp[0x80 + vat], w4 = cp[0x90 + vat];
    if (c && c.w0 === w0 && c.w1 === w1 && c.w2 === w2 && c.w3 === w3 && c.w4 === w4) { c.v = this.cpVersion; return c.l; }
    const l = vertexLayout(cp, vat);
    this.layouts.set(vat, { v: this.cpVersion, l, w0, w1, w2, w3, w4 });
    return l;
  }

  private flush(): void {
    const r = this.run;
    if (!r) return;
    this.run = null;
    this.drawCount++;
    this.watch?.draw(this.regs);
    this.renderer.draw(this.regs, this.mem, r.vd, r.tris, r.lines, r.points, r.prims, r.raw);
  }

  /** the raw run's vertices so far decoded into its VertexData (the run goes on decoded) */
  private decodeRaw(): void {
    const r = this.run;
    if (!r || !r.raw) return;
    const raw = r.raw;
    r.raw = null;
    this.decodeSegs(raw.segs, r.vd);
  }

  private decodeSegs(segs: (Uint8Array | number)[], vd: VertexData): void {
    const t0 = this.measure ? performance.now() : 0;
    for (let i = 0; i < segs.length; i += 3) vd.add(segs[i] as Uint8Array, segs[i + 1] as number, segs[i + 2] as number, this.regs.cp, this.mem.data, this.mem.view);
    if (this.measure) this.timers.vertex += performance.now() - t0;
  }

  /** run one frame's commands, applying its memory writes where they were read */
  runFrame(frame: GxFrame): void {
    const data = frame.fifo, ups = frame.updates;
    let ui = 0;
    const apply = (pos: number) => {
      while (ui < ups.length && ups[ui].pos <= pos) {
        // (a run's undecoded vertices read the memory as it was before this write)
        if (this.run?.raw) this.decodeRaw();
        const t0 = this.measure ? performance.now() : 0; this.mem.write(ups[ui].addr, ups[ui].data); if (this.measure) this.timers.memory += performance.now() - t0;
        this.watch?.wrote(ups[ui].addr, ups[ui].data.length);
        ui++;
      }
    };
    this.execute(data, apply);
    apply(Number.MAX_SAFE_INTEGER);
    this.flush();
  }

  /** the commands of one buffer (a frame, or a called display list) */
  execute(data: Uint8Array, apply: (pos: number) => void = () => {}): void {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = data.length;
    const regs = this.regs;
    let pos = 0;
    while (pos < n) {
      const op = data[pos];
      apply(pos);
      if (op === 0x00) { pos++; continue; }
      if ((op & 0xc0) === 0x80) {
        if (pos + 3 > n) break;
        const prim = (op >> 3) & 7, vat = op & 7;
        const count = dv.getUint16(pos + 1);
        const L = this.layout(vat);
        const end = pos + 3 + L.size * count;
        if (end > n) break;
        // a renderer that is not drawing (the frames a seek plays through) needs only the command stepped over: no vertex decoding
        const rr = this.renderer as { drawing?: boolean; fastForward?: boolean };
        if (rr.drawing === false || rr.fastForward === true) { pos = end; continue; }
        let run = this.run;
        if (run && run.vd.layout !== L) { this.flush(); run = null; }
        if (!run) {
          const xf = regs.xf;
          const dflt = [bits(xf[0x1018], 6, 6), bits(xf[0x1018], 12, 6), bits(xf[0x1018], 18, 6), bits(xf[0x1018], 24, 6),
            bits(xf[0x1019], 0, 6), bits(xf[0x1019], 6, 6), bits(xf[0x1019], 12, 6), bits(xf[0x1019], 18, 6)];
          this.vd.setup(L, bits(xf[0x1018], 0, 6), dflt);
          // (a backend that decodes the vertices elsewhere gets the command bytes: frontpool.ts)
          const raw: RawRun | null = (this.renderer as { rawVertices?: boolean }).rawVertices === true ?
            { vat, size: L.size, n: 0, segs: [], decode: () => this.decodeSegs(raw!.segs, this.vd) } : null;
          run = this.run = { vd: this.vd, tris: EMPTY, lines: EMPTY, points: EMPTY, prims: [], raw };
        }
        if (run.raw) {
          const raw = run.raw, base = raw.n;
          raw.segs.push(data, pos + 3, count);
          raw.n += count;
          run.prims.push({ type: prim, base, count });
          pos = end;
          continue;
        }
        const base = run.vd.n;
        const tv = this.measure ? performance.now() : 0;
        run.vd.add(data, pos + 3, count, regs.cp, this.mem.data, this.mem.view);
        if (this.measure) this.timers.vertex += performance.now() - tv;
        run.prims.push({ type: prim, base, count });
        pos = end;
        continue;
      }
      this.flush();
      switch (op) {
        case 0x61: {
          if (pos + 5 > n) return;
          const ev = regs.loadBp(dv.getUint32(pos + 1));
          if (ev.kind === "tlut") {
            regs.tluts.set(ev.tmem, this.mem.read(ev.addr, ev.count).slice());
            this.watch?.tlut(ev.tmem);
          } else if (ev.kind === "preload") {
            regs.tmem.set(this.mem.read(ev.src, ev.bytes).subarray(0, Math.max(0, regs.tmem.length - ev.tmem)), ev.tmem);
            regs.tmemVersion++;
          } else if (ev.kind === "copy" && (this.renderer as { fastForward?: boolean }).fastForward === true) {
            // (fast-forwarding: the frame's copies are the next frame's own to make)
            this.watch?.skipped(regs.bp);
          } else if (ev.kind === "copy") {
            this.watch?.copied(regs.bp, (this.renderer as { drawing?: boolean }).drawing !== false);
            const c = this.renderer.copy(regs, this.mem, ev.value);
            if (c.toXfb) { this.events.push({ kind: "xfb", rect: c.rect }); this.onXfb?.(c.rect); }
            else this.events.push({ kind: "texture", rect: c.rect });
            if (c.clear) this.renderer.copyClear(regs);
          }
          pos += 5;
          break;
        }
        case 0x08:
          if (pos + 6 > n) return;
          regs.loadCp(data[pos + 1], dv.getUint32(pos + 2));
          this.cpVersion++;
          pos += 6;
          break;
        case 0x10: {
          if (pos + 5 > n) return;
          const head = dv.getUint32(pos + 1);
          const cnt = (head >>> 16) + 1;
          if (pos + 5 + 4 * cnt > n) return;
          const vals = new Uint32Array(cnt);
          for (let i = 0; i < cnt; i++) vals[i] = dv.getUint32(pos + 5 + 4 * i);
          regs.loadXf(head & 0xffff, vals);
          pos += 5 + 4 * cnt;
          break;
        }
        case 0x20: case 0x28: case 0x30: case 0x38: {
          if (pos + 5 > n) return;
          const word = dv.getUint32(pos + 1);
          const array = 12 + ((op - 0x20) >> 3);
          const index = word >>> 16, size = bits(word, 12, 4) + 1, addr = word & 0xfff;
          const base = regs.cp[0xa0 + array] & 0x03ffffff, stride = regs.cp[0xb0 + array];
          const b = this.mem.read(base + stride * index, size * 4);
          const vals = new Uint32Array(size);
          const bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
          for (let i = 0; i < size && i * 4 + 4 <= b.length; i++) vals[i] = bv.getUint32(i * 4);
          regs.loadXf(addr, vals);
          pos += 5;
          break;
        }
        case 0x40: {
          // a display list call: the recorder inlines these, a stream from the simulator may not
          if (pos + 9 > n) return;
          const addr = dv.getUint32(pos + 1), size = dv.getUint32(pos + 5);
          if (size > 0) this.execute(this.mem.read(addr, size).slice());
          pos += 9;
          break;
        }
        case 0x44: case 0x48: case 0x01:
          pos += 1;
          break;
        default:
          this.events.push({ kind: "error", detail: `unknown command ${op.toString(16)} at ${pos}` });
          return;
      }
    }
    if (this.run && n > 0) { /* runs continue across buffers */ }
  }
}
