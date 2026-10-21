/* The 3D replay viewer: a log of every draw the renderer makes, in the
 * GameCube's own terms, to set beside the game's graphics commands as a
 * Dolphin FIFO recording holds them (decoded draw for draw by a separate
 * tool). Each mismatch between the two is then an exact difference: this
 * mesh's blend, that light's color, a texture the game samples and the
 * viewer does not.
 *
 * Debug only, and off unless asked for: nothing here runs, and the renderer
 * has no line of it, until attachDrawLog() wraps one renderer's draw
 * methods on that instance; detach() puts them back. Normal use never
 * attaches it (only an explicit call through the viewer's debug handle).
 *
 * What a draw says (a frame's records, in draw order), in the fields the
 * decoder writes for the game's:
 *
 *   kind      "mesh" (a model's mesh), "particles", "trail", "sphere";
 *             "depth" and "ghost" are the viewer's own passes, never the game's
 *   obj       the mesh's key (its model's tag, joint, mesh), joint, pass
 *   prims     [type, vertices, hash] per primitive of the mesh's display
 *             list, hashed over its bytes in the file (opcode, count, vertex
 *             data) as the game sends them; geo: over all of them
 *   mtx       { slot: 3 x 4 rows }: the modelview the renderer uploaded per
 *             slot (view times the mesh's matrix, as it was sent)
 *   proj      GX's six projection numbers (of the projection the renderer
 *             uploaded) and its kind
 *
 * Numbers are written exactly (`exact`, on by default): matrices, the
 * projection, fog, lights and texture matrices as the float32 values the
 * renderer holds, each one's every bit, so a difference of one unit in the
 * last place shows. With `exact` off they are kept to 6 significant digits.
 *   cull z blend cmask alpha_test fog lights   as the GL state was at the draw
 *   tex       per sampler: texture map, identity (gxHash of the image's
 *             bytes in its file), format, size, wrap, filters, LOD bias,
 *             palette identity, texture matrix
 *   shade     the material as the viewer compiled it (gx.ts compileMaterial)
 *   probe     the shading as a function: final color and alpha (0..255) for
 *             each of probes()' fixed inputs, through gx.ts evalMaterial,
 *             the model of the fragment shader
 */
import type { Archive, Image, PObj, Tlut } from "./hsd";
import type { Drawable, Skeleton, TexState } from "./skeleton";
import type { Renderer } from "./renderer";
import type { Fog, MatProgram } from "./gx";
import { type FogRegs, fogDecoded } from "./fog";
import type { ViewLights } from "./gxlights";
import {
  RENDER, blockOf, byteOf, chanColor, evalMaterial, mulColor, overColor, tevByte, tevStage, textureMatrix,
} from "./gx";
import { SHADOW_SIZE } from "./shadow";
import type { Lighting } from "./lightset";
import type { Tint } from "./fx/colanim";
import type { Mat } from "./math";

// ---------------------------------------------------------------- shared with the decoder

/** two 32-bit FNV-1a hashes (two bases) as 16 hex digits: the identity of a
 *  primitive or an image, the same on both sides */
export function gxHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export interface Probe { t: number[][]; s: number[][]; v: number[][] }

/** the probe's fixed inputs: per probe, texels t[0..7], light sums s[0..1]
 *  and vertex colors v[0..1] (rgba, multiples of 1/255), from one LCG */
export function probes(count = 6): Probe[] {
  let x = 0x2545f491;
  const out: Probe[] = [];
  for (let p = 0; p < count; p++) {
    const q: number[][] = [];
    for (let k = 0; k < 12; k++) {
      const c: number[] = [];
      for (let i = 0; i < 4; i++) {
        x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
        c.push(((x >>> 8) % 256) / 255);
      }
      q.push(c);
    }
    out.push({ t: q.slice(0, 8), s: q.slice(8, 10), v: q.slice(10, 12) });
  }
  return out;
}

const PRIM = ["quads", "quads2", "tris", "strip", "fan", "lines", "linestrip", "points"];
const COMP = [1, 1, 2, 2, 4];
const COLOR = [2, 3, 4, 2, 3, 4];

/** a vertex's bytes in a mesh's display list (HSD's attribute list) */
export function vertexSize(p: PObj): number {
  let n = 0;
  for (const t of p.attrs) {
    if (t.type === 2) { n += 1; continue; }
    if (t.type === 3) { n += 2; continue; }
    if (t.type !== 1) continue;
    const a = t.attr;
    if (a <= 8) n += 1;
    else if (a === 9) n += COMP[t.compType] * (t.cnt === 0 ? 2 : 3);
    else if (a === 10) n += COMP[t.compType] * 3;
    else if (a === 25) n += COMP[t.compType] * 9;
    else if (a === 11 || a === 12) n += COLOR[t.compType] ?? 4;
    else if (a >= 13 && a <= 20) n += COMP[t.compType] * (t.cnt === 0 ? 1 : 2);
  }
  return n;
}

/** a display list's primitives: [type, vertices, hash of its bytes] */
export function dlPrims(a: Archive, p: PObj): [string, number, string][] {
  const out: [string, number, string][] = [];
  const u8 = a.u8, vs = vertexSize(p);
  const end = Math.min(p.dlOff + p.dlSize, u8.length);
  let o = p.dlOff;
  while (o < end) {
    const op = u8[o];
    if (op === 0) { o++; continue; }
    if ((op & 0xc0) !== 0x80 || o + 3 > end) break;
    const count = (u8[o + 1] << 8) | u8[o + 2];
    const stop = o + 3 + count * vs;
    if (stop > end) break;
    out.push([PRIM[(op >> 3) & 7], count, gxHash(u8.subarray(o, stop))]);
    o = stop;
  }
  return out;
}

/** a mesh's identity: gxHash over its primitives' hashes, joined (the decoder's geo_hash) */
export function geoHash(prims: [string, number, string][]): string {
  return gxHash(new TextEncoder().encode(prims.map((x) => x[2]).join("")));
}

const TLUT_ENTRIES: Record<number, number> = { 8: 16, 9: 256, 10: 16384 };

/** an image's identity: its first level's bytes in its file */
export function imageId(a: Archive, img: Image): string | null {
  const [bw, bh, bb] = blockOf(img.format);
  const size = Math.ceil(img.width / bw) * Math.ceil(img.height / bh) * bb;
  if (img.dataOff + size > a.u8.length) return null;
  return gxHash(a.u8.subarray(img.dataOff, img.dataOff + size));
}

/** the bytes of a palette its identity is made over: its entries in whole 16s, as many as the format reads */
export function tlutBytes(t: Tlut, format: number): number {
  return Math.min(Math.ceil(t.count / 16) * 16, TLUT_ENTRIES[format] ?? 256) * 2;
}

/** a palette's identity: its entries (whole 16s) as far as the format reads (the game may load more, which the
 *  decoder hashes in steps of 32 bytes) */
export function tlutId(a: Archive, t: Tlut, format: number): string | null {
  const n = tlutBytes(t, format);
  if (t.dataOff + n > a.u8.length) return null;
  return gxHash(a.u8.subarray(t.dataOff, t.dataOff + n));
}

// ---------------------------------------------------------------- GL state in GX's names

const GL_COMPARE: Record<number, string> = {
  0x200: "never", 0x201: "less", 0x202: "equal", 0x203: "lequal", 0x204: "greater", 0x205: "nequal", 0x206: "gequal", 0x207: "always",
};
const GL_SRC: Record<number, string> = {
  0: "zero", 1: "one", 0x306: "dstclr", 0x307: "invdstclr", 0x302: "srcalpha", 0x303: "invsrcalpha", 0x304: "dstalpha", 0x305: "invdstalpha",
};
const GL_DST: Record<number, string> = {
  0: "zero", 1: "one", 0x300: "srcclr", 0x301: "invsrcclr", 0x302: "srcalpha", 0x303: "invsrcalpha", 0x304: "dstalpha", 0x305: "invdstalpha",
};
const COMPARE = ["never", "less", "equal", "lequal", "greater", "nequal", "gequal", "always"];
const ALPHA_OP = ["and", "or", "xor", "xnor"];
const WRAP = ["clamp", "repeat", "mirror"];
const MIN = ["near", "linear", "near_mip_near", "linear_mip_near", "near_mip_linear", "linear_mip_linear"];
const FOG_TYPE: Record<number, string> = { 0: "none", 2: "linear", 4: "exp", 5: "exp2", 6: "revexp", 7: "revexp2" };
const TEXGEN = ["uv0", "uv1", "reflection", "highlight", "mirror"];

/** a number kept to 6 significant digits (the logs compare with tolerances) */
export function rnd(x: number, digits = 6): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  return Number(x.toPrecision(digits));
}

/** a number as a float32, every bit of it (the value the renderer holds); one that is not finite as null (JSON
 *  has no NaN), and the record says so (`nonfinite`) */
export function f32(x: number): number | null {
  return Number.isFinite(x) ? Math.fround(x) : null;
}

/** GX's projection numbers from a GL projection (column major): GX keeps
 *  depth in [-1, 0] where GL has [-1, 1], so its third row is half of GL's
 *  third minus its fourth (kept as float32: the GPU's arithmetic) */
export function gxProjection(p: ArrayLike<number>, num: (x: number) => number = (x) => rnd(x)): (number | string)[] {
  const persp = p[11] === -1;
  const z0 = Math.fround((p[10] - p[11]) / 2), z1 = Math.fround((p[14] - p[15]) / 2);
  const nums = persp ? [p[0], p[8], p[5], p[9], z0, z1] : [p[0], p[12], p[5], p[13], z0, z1];
  return [...nums.map(num), persp ? "persp" : "ortho"];
}

/** rows 0..2 of a column-major 4 x 4 */
function rows3(m: ArrayLike<number>, o: number, num: (x: number) => number): number[][] {
  return [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => num(m[o + c * 4 + r])));
}

const unit = (v: number[]) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

// ---------------------------------------------------------------- the renderer, as the log reads it

/** what of the renderer the log reads (its own fields: the log has no line in it) */
interface Inner {
  gl: WebGL2RenderingContext;
  draws: number;
  cs: { cull: number; blend: number; src: number; dst: number; eq: number; dmask: number; dfunc: number; cmask: number };
  camView: Mat; camVP: Mat; camProj: Mat; camGx: Float32Array | null; shiftView: Mat; shiftVP: Mat; shifted: boolean;
  /** the modelviews the last draw uploaded */
  mvBuf: Float32Array;
  /** the lights as uploaded in view space (gxlights.ts) */
  lightV: ViewLights;
  /** the fog's registers as GXSetFog packs them, as uploaded (fog.ts) */
  fogRegs: FogRegs;
  mirrored: boolean;
  lighting: Lighting | null;
  overlayVP: Mat | null; viewProj: Mat;
  shadowMaps: { mtx: Mat }[];
  shadowMask: number;
  live: WeakMap<Image, unknown>;
  staticsOf(s: Drawable["state"]): { p: MatProgram; I: Int32Array; F: Float32Array };
}

/** the renderer's fields and methods the log reads or wraps (a test checks they are still there) */
export const RENDERER_NAMES = ["draws", "cs", "camView", "camVP", "camProj", "camGx", "mvBuf", "lightV", "fogRegs", "cullOn", "shiftView", "shiftVP",
                               "shifted", "mirrored",
                               "lighting",
                               "overlayVP", "viewProj", "shadowMaps", "shadowMask", "live", "staticsOf", "begin", "setFog",
                               "setTint", "setOutline", "beginShadow", "beginMirror", "endMirror", "endShadow", "drawOne",
                               "drawGeometry", "drawParticles", "drawTrail", "drawSphere", "overlay", "endOverlay"] as const;

export interface FrameLog { frame: number | string | null; draws: Record<string, unknown>[] }

export class DrawLog {
  frames: FrameLog[] = [];
  label: number | string | null = null;
  /** at most this many frames are kept (the oldest go) */
  limit = 600;
  /** numbers written as the float32s they are (else kept to 6 significant digits) */
  exact = true;
  /** a matrix's, projection's, fog's, light's or texture matrix's number, as the log writes it */
  private num = (x: number): number => {
    if (!Number.isFinite(x)) { this.nonfinite = true; return null as unknown as number; }
    return this.exact ? Math.fround(x) : rnd(x);
  };
  /** a number of the record being made was not finite (NaN or infinite: written as null) */
  private nonfinite = false;
  private cur: FrameLog | null = null;
  private fog: Fog | null = null;
  /** the fighter's color animation the draws are made with (setTint) */
  private tint: Tint | null = null;
  /** the outline color the draws are made in (setOutline: Mr. Game & Watch's), else null */
  private outline: number[] | null = null;
  /** a shadow being made: the stage's shadow intensity it is drawn in (beginShadow), else null */
  private cast: number | null = null;
  private inputs = probes();
  private prims = new WeakMap<PObj, [string, number, string][]>();
  private images = new WeakMap<Image, string | null>();
  private spriteIds = new WeakMap<object, string | null>();
  private restore: (() => void) | null = null;

  constructor(private r: Renderer) {}

  private get inner(): Inner { return this.r as unknown as Inner; }

  /** wrap the renderer's draw methods on this instance */
  attach() {
    if (this.restore) return;
    const r = this.r as unknown as Record<string, (...a: unknown[]) => unknown>;
    const saved: [string, unknown][] = [];
    // (GX culls no mesh - only its triangles, at the picture's edge - so while the log is on the renderer culls
    // none either: every mesh the game would send is drawn and logged, its matrices with it)
    const inner = this.r as unknown as { cullOn: boolean };
    const cullWas = inner.cullOn;
    inner.cullOn = false;
    const wrap = (name: string, after: (args: unknown[], drew: boolean) => void) => {
      const own = Object.prototype.hasOwnProperty.call(r, name) ? r[name] : undefined;
      const orig = r[name];
      saved.push([name, own]);
      const log = this;
      r[name] = function (this: unknown, ...args: unknown[]) {
        const before = log.inner.draws;
        const out = orig.apply(this, args);
        try { after(args, log.inner.draws > before); } catch (e) { log.note(String(e)); }
        return out;
      };
    };
    // (each picture's erase: the game's HSD_CObjEraseScreen and the shadow's start draw it as one flat quad, the
    // renderer clears; logged as a "clear" of the picture's size)
    wrap("begin", () => { this.newFrame(); this.clear(640, 480); });
    // (the stage's mirror image, Fountain of Dreams' pond: what is drawn into it - particles too - is logged in
    // that 80 x 60 picture's pixels, as the game's draws into it are)
    wrap("beginMirror", () => { this.clear(80, 60); this.target = [80, 60]; });
    wrap("endMirror", () => { this.target = null; });
    wrap("setFog", (a) => { this.fog = (a[0] as Fog | null) ?? null; });
    wrap("setTint", (a) => { this.tint = (a[0] as Tint | null) ?? null; });
    wrap("setOutline", (a) => { this.outline = (a[0] as number[] | null) ?? null; });
    wrap("beginShadow", (a) => { this.cast = a[3] as number; this.clear(SHADOW_SIZE, SHADOW_SIZE); });  // (the stage's intensity, 0..255)
    wrap("endShadow", () => { this.cast = null; });
    wrap("drawOne", (a, drew) => { if (drew) this.mesh(a[0] as Drawable, a[1] !== null, a[2] as Skeleton | null); });
    wrap("drawGeometry", (a, drew) => { if (drew) this.add({ kind: "depth", obj: (a[0] as Drawable).key }); });
    // (a camera into a target of its own - Stadium's screen - is logged in that picture's pixels)
    // (a target the game erases with a quad - Stadium's screen - is logged as cleared as it goes in, as at a frame's start)
    wrap("overlay", (a) => {
      const t = a[2] as { w: number; h: number; erase?: boolean } | null | undefined;
      this.target = t ? [t.w, t.h] : null;
      if (t?.erase && a[3]) this.clear(t.w, t.h);
    });
    wrap("endOverlay", () => { this.target = null; });
    wrap("drawParticles", (a) => this.particles(a[0] as Float32Array, a[1] as Batch[]));
    // (the trail and the sphere set GL themselves: their state is drawTrail's and drawSphere's own)
    wrap("drawTrail", (a, drew) => {
      if (drew) this.add({ kind: "trail", verts: (a[0] as Float32Array).length / 7, z: { test: true, func: "lequal", write: false },
                           blend: { on: true, src: "srcalpha", dst: "invsrcalpha", sub: false, logic: null } });
    });
    wrap("drawSphere", (a) => this.add({ kind: "sphere", center: (a[0] as number[]).map((v) => rnd(v)), radius: rnd(a[1] as number),
                                          color: (a[2] as number[]).map((v) => rnd(v)), alpha: rnd(a[3] as number) }));
    this.restore = () => {
      inner.cullOn = cullWas;
      for (const [name, own] of saved) {
        if (own === undefined) delete r[name];
        else r[name] = own as (...a: unknown[]) => unknown;
      }
    };
  }

  detach() {
    this.restore?.();
    this.restore = null;
  }

  get attached(): boolean { return this.restore !== null; }

  /** the frames logged since the last take, and a fresh start */
  take(): FrameLog[] {
    const out = this.frames;
    this.frames = [];
    this.cur = null;
    return out;
  }

  private clear(w: number, h: number) {
    this.add({ kind: "clear", w, h, z: { test: false, func: "always", write: false },
               blend: { on: false, src: null, dst: null, sub: false, logic: null } });
  }

  /** the size of the target the draws go into now, when it is not the frame's picture */
  private target: [number, number] | null = null;

  private note(msg: string) {
    this.add({ kind: "error", msg });
  }

  private newFrame() {
    this.cur = { frame: this.label, draws: [] };
    this.frames.push(this.cur);
    if (this.frames.length > this.limit) this.frames.shift();
  }

  private add(rec: Record<string, unknown>) {
    if (!this.cur) this.newFrame();
    rec.i = this.cur!.draws.length;
    this.cur!.draws.push(rec);
  }

  /** the camera of the draw being made: view and GX projection (the one uploaded) */
  private camera(): { view: Mat; proj: (number | string)[] } {
    const s = this.inner;
    const view = s.shifted ? s.shiftView : s.camView;
    // (GX's own numbers when the renderer has them - the game camera's C_MTXPerspective - else GL's taken back)
    const g = s.camGx;
    if (g && !s.mirrored) {
      const persp = g[14] === -1;
      const nums = persp ? [g[0], g[2], g[5], g[6], g[10], g[11]] : [g[0], g[3], g[5], g[7], g[10], g[11]];
      return { view, proj: [...nums.map(this.num), persp ? "persp" : "ortho"] };
    }
    const proj = Float32Array.from(s.camProj);
    // (a picture the renderer draws upside down - the magnifier's, so its first row is the texture's top - is
    // the game's picture the right way up: its projection's y turned back)
    if (s.mirrored) for (const k of [1, 5, 9, 13]) proj[k] = -proj[k];
    return { view, proj: gxProjection(proj, this.num) };
  }

  /** the pixel engine as GL has it now */
  private pe(): Record<string, unknown> {
    const s = this.inner, c = s.cs, gl = s.gl;
    const blendOn = c.blend === 1;
    return {
      z: { test: true, func: GL_COMPARE[c.dfunc] ?? String(c.dfunc), write: c.dmask === 1 },
      blend: { on: blendOn, src: blendOn ? GL_SRC[c.src] ?? String(c.src) : null, dst: blendOn ? GL_DST[c.dst] ?? String(c.dst) : null,
               sub: blendOn && c.eq === gl.FUNC_REVERSE_SUBTRACT, logic: null },
      cmask: { color: c.cmask !== 0, alpha: c.cmask !== 0 },
    };
  }

  private mesh(d: Drawable, ghost: boolean, sk: Skeleton | null) {
    const s = this.inner;
    this.nonfinite = false;
    // (a part of the record that fails is left out and says why, the rest - the matrices first - is still written)
    const errors: string[] = [];
    const safe = <T>(what: string, f: () => T, none: T): T => {
      try { return f(); } catch (e) { errors.push(`${what}: ${String(e)}`); return none; }
    };
    const st = s.staticsOf(d.state), p = st.p;
    const { view, proj } = this.camera();
    let prims = this.prims.get(d.pobj);
    if (!prims) this.prims.set(d.pobj, (prims = dlPrims(d.archive, d.pobj)));
    // (the modelviews as the renderer uploaded them for this draw: drawOne has just sent them)
    const mtx: Record<string, number[][]> = {};
    for (let k = 0; k < d.nMats; k++) mtx[String(k)] = rows3(s.mvBuf, k * 16, this.num);
    const cull = d.pobj.flags & 0xc000;
    let cullName = cull === 0 ? "none" : cull === 0x8000 ? "back" : cull === 0x4000 ? "front" : "all";
    // (in a picture drawn upside down the renderer turns the front face over with it, so the faces culled are
    // the material's own: the name is the mode as the game sets it)
    const I = st.I, F = st.F;
    const rec: Record<string, unknown> = {
      kind: ghost ? "ghost" : "mesh",
      obj: d.key, group: d.group?.tag ?? null, joint: d.jobj.index, pass: d.translucent ? "xlu" : "opa",
      prims, geo: geoHash(prims), indexed: true,
      verts: prims.reduce((n, x) => n + x[1], 0),
      mtx, proj, cull: cullName, ...this.pe(),
      alpha_test: [COMPARE[I[3] & 7], rnd(F[20]), ALPHA_OP[(I[3] >> 6) & 3], COMPARE[(I[3] >> 3) & 7], rnd(F[21])],
      fog: safe("fog", () => this.fogRec(), null),
      lights: safe("lights", () => this.lightsRec(view, this.firstOnly(d)), []),
      tex: safe("tex", () => p.textures.map((ti, n) => this.texRec(d.archive, d.state.tex[ti], p.texGen[n], F, n)), []),
      shade: { channel: p.channel, vertexBase: p.vertexBase, lit: p.lit, specular: p.specular, bump: p.bump,
               stages: p.stages.map((x) => ({ tex: d.state.tex[p.textures[x.tex]]?.tobj.id ?? null, colorMap: x.colorMap,
                                              alphaMap: x.alphaMap, phase: x.phase })),
               diffuse: Array.from(d.state.override ?? d.state.diffuse).map((v) => rnd(v)), alpha: rnd(d.state.alpha),
               ambient: Array.from(d.state.ambient).map((v) => rnd(v)), spec: Array.from(d.state.specular).map((v) => rnd(v)) },
      probe: safe("probe", () => this.probe(d, p), null),
    };
    if (errors.length) rec.errors = errors;
    // (a shadow being made: the mesh in one flat gray, no texture, no depth, color only: HSD_ShadowStartRender)
    if (this.cast !== null) {
      const g = this.cast, gray = g / 255;
      Object.assign(rec, { kind: "mesh", tex: [], fog: null, lights: [], alpha_test: ["always", 0, "and", "always", 0],
                           z: { test: false, func: "always", write: false }, cmask: { color: true, alpha: false },
                           blend: { on: false, src: null, dst: null, sub: false, logic: null },
                           shade: { channel: 0, vertexBase: false, lit: false, specular: false, bump: -1, stages: [],
                                    diffuse: [gray, gray, gray, 1], alpha: 1, ambient: [0, 0, 0, 1], spec: [0, 0, 0, 1] },
                           probe: this.inputs.map(() => [g, g, g, 255]), shadow: "cast" });
      if (this.nonfinite) rec.nonfinite = true;
      this.add(rec);
      return;
    }
    // (a material that takes the fighters' shadows: each one a texture after its own, sampled where the point
    // falls through the shadow's matrix, its color times the texel)
    // (only those the stage's shadow check lets onto this joint: the renderer's mask)
    const taken = d.state.mobj.renderMode & RENDER.SHADOW ? s.shadowMaps.filter((_, k) => (s.shadowMask >> k) & 1) : [];
    const nShadow = taken.length;
    for (let k = 0; k < nShadow; k++) {
      const m = taken[k].mtx;
      (rec.tex as Record<string, unknown>[]).push({
        map: p.textures.length + k, id: "efb:shadow", format: 0, w: SHADOW_SIZE, h: SHADOW_SIZE, wrap: ["clamp", "clamp"],
        mag: "near", min: "linear", lod_bias: 0, texgen: "shadow",
        mtx: [0, 1].map((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]].map(this.num)) });
    }
    // (the shadows' texels are in the probe: the inputs after the material's own, laid on after its stages)
    if (nShadow) rec.probe = this.probe(d, p, nShadow);
    // (a fighter's color animation: its color is in the probe, blended over last as the shader does)
    const t = this.tint;
    if (t && (t.color || t.light)) {
      rec.tint = { color: t.color ? t.color.map((v) => rnd(v)) : null,
                   light: t.light ? { rgb: t.light.rgb.map((v) => rnd(v)), a: rnd(t.light.a), adds: t.light.adds } : null };
    }
    if (sk && (sk as unknown as { pointSize?: number }).pointSize) rec.point = (sk as unknown as { pointSize: number }).pointSize;
    if (this.nonfinite) rec.nonfinite = true;
    this.add(rec);
  }

  private fogRec(): Record<string, unknown> | null {
    const f = this.fog;
    if (!f || !(f.type & 7)) return null;
    // (and as the hardware takes it: GXSetFog's registers, and A, B and C as they hold them)
    const r = this.inner.fogRegs;
    const hx = (v: number) => v.toString(16).padStart(8, "0");
    // (start and end as the registers hold them - worked back from A, B and C with the camera's near, as a reader
    // of the game's registers does - and as they were handed to GXSetFog: set_start, set_end)
    const dec = r ? fogDecoded(r) : null;
    return { type: FOG_TYPE[f.type & 7] ?? String(f.type & 7), ortho: ((f.type >> 3) & 1) === 1,
             start: dec ? dec.start : this.num(f.start), end: dec ? dec.end : this.num(f.end),
             set_start: this.num(f.start), set_end: this.num(f.end),
             color: f.color.map((v) => Math.round(v * 255)),
             ...(r && dec ? { regs: [r.fog0, r.fog1, r.fog2, r.fog3, r.fogclr].map(hx), a: dec.a, b: dec.b, c: dec.c,
                              a_reg: this.num(r.a), b_mag: r.bMag, b_shift: r.bShift, c_reg: this.num(r.c), fsel: r.fsel, proj: r.proj,
                              near: this.num(r.near), far: this.num(r.far) } : {}) };
  }

  /** a see-through material while a color animation adds its light: lit by the set's first light alone (the
   *  renderer's firstLightOnly: ftCo_8009F75C) */
  private firstOnly(d: Drawable): boolean {
    const ol = this.tint?.light ?? null;
    return !!ol && ol.adds && (d.state.mobj.renderMode & RENDER.XLU) !== 0;
  }

  /** the lights as HSD_LObjSetup loads them into GX, through the view (float32, gxmath): an infinite light's
   *  position 2^20 times its LObj's, as a point (setup_infinite_lightobj); a point or spot light's position
   *  (MTXMultVec), a spot's axis toward it (its light vector, interest - position, through PSMTXMultVecSR and
   *  PSVECNormalize, turned round) */
  private lightsRec(_view: Mat, first = false): Record<string, unknown>[] {
    const l = this.inner.lighting, v = this.inner.lightV;
    if (!l || !v) return [];
    const out: Record<string, unknown>[] = [];
    // (a color animation's light, ftCo_8009F5AC's x588: added to the set (white, its alpha the strength), or
    // with the ambient light alone (its color): the renderer's uOverMode 1 and 2)
    const ol = this.tint?.light ?? null;
    for (let k = 0; k < (first ? Math.min(1, l.n) : l.n) && !(ol && !ol.adds); k++) {
      const w = l.pos[k * 4 + 3];
      const at = Array.from(v.pos.subarray(k * 4, k * 4 + 3)), ax = Array.from(v.axis.subarray(k * 4, k * 4 + 3));
      const flags = l.attnA[k * 4 + 3];
      // (an infinite light's `at` its direction - the position GX holds, normalized - and `pos` that position)
      out.push({ k: out.length, at: (w === 0 ? unit(at) : at).map(this.num), ...(w === 0 ? { pos: at.map(this.num) } : {}),
                 infinite: w === 0, axis: ax.map(this.num),
                 color: Array.from(l.color.subarray(k * 4, k * 4 + 4)).map((c) => Math.round(c * 255)),
                 cosatt: Array.from(l.attnA.subarray(k * 4, k * 4 + 3)).map(this.num),
                 distatt: Array.from(l.attnK.subarray(k * 4, k * 4 + 3)).map(this.num),
                 diffuse: (flags & 1) !== 0, specular: (flags & 2) !== 0 && !first });
    }
    if (ol && !first) {
      const rgb = ol.adds ? [255, 255, 255] : ol.rgb.map((c) => Math.round(c * 255));
      const op = Array.from(v.over.subarray(0, 3));
      // (the next light the game loads: after the set's, or the first when it is the ambient's alone)
      out.push({ k: out.length, at: unit(op).map(this.num), pos: op.map(this.num), infinite: true, axis: [0, 0, 0],
                 color: [...rgb, Math.round(ol.a * 255)], cosatt: [1, 0, 0], distatt: [1, 0, 0], diffuse: true, specular: false,
                 overlay: true });
    }
    return out;
  }

  private texRec(a: Archive, t: TexState | undefined, gen: number, F?: Float32Array, n = 0): Record<string, unknown> {
    if (!t) return { id: null };
    const o = t.tobj;
    let id = this.images.get(t.image);
    // (a picture made at run time - the mirror's, one the page draws into, Stadium's screen - is a frame
    // copy to the game, not the file's bytes)
    if (this.inner.live.has(t.image)) id = "efb:live";
    else if (id === undefined) this.images.set(t.image, (id = gen === 4 ? "mirror" : imageId(a, t.image)));
    const at = 24 + n * 12;
    const m = F && F.length >= at + 8 ? Array.from(F.subarray(at, at + 8))
      : textureMatrix([t.translate[0], t.translate[1], o.translate[2]], [t.scale[0], t.scale[1], o.scale[2]],
                      [t.rotX, t.rotY, t.rotate], o.repeatS, o.repeatT, o.wrapT);
    const rec: Record<string, unknown> = {
      map: o.id, id, format: t.image.format, w: t.image.width, h: t.image.height,
      wrap: [WRAP[o.wrapS] ?? String(o.wrapS), WRAP[o.wrapT] ?? String(o.wrapT)],
      mag: o.magFilt ? "linear" : "near", min: o.lod ? MIN[o.lod.minFilt] ?? String(o.lod.minFilt) : null,
      lod_bias: o.lod ? this.num(o.lod.bias) : 0, texgen: TEXGEN[gen] ?? String(gen),
      mtx: [m.slice(0, 4), m.slice(4, 8)].map((r) => r.map(this.num)), blending: rnd(t.blending),
    };
    if (t.tlut) {
      rec.tlut = tlutId(a, t.tlut, t.image.format);
      rec.tlut_bytes = tlutBytes(t.tlut, t.image.format);
    }
    return rec;
  }

  /** the material's output for each probe input, through evalMaterial */
  private probe(d: Drawable, p: MatProgram, nShadow = 0): number[][] | null {
    const s = d.state, l = this.inner.lighting;
    if (p.bump >= 0) return null;                     // (an emboss needs the shifted texel: not probed)
    const amb = l?.ambient ?? [0, 0, 0];
    const ol = this.tint?.light ?? null;
    const first = this.firstOnly(d);
    const anyDiffuse = first ? !!l && l.n > 0 && (l.attnA[3] & 1) !== 0
      : !!ol || (!!l && Array.from({ length: l.n }, (_, k) => (l.attnA[k * 4 + 3] & 1) !== 0).some(Boolean));
    const anySpec = !first && !(ol && !ol.adds) && !!l && Array.from({ length: l.n }, (_, k) => (l.attnA[k * 4 + 3] & 2) !== 0).some(Boolean);
    const addsOn = !!ol && ol.adds && !(s.mobj.renderMode & RENDER.XLU);
    const B = (v: number[]) => v.map(byteOf);
    return this.inputs.map((q) => {
      // (every input as the bytes the TEV takes: a texel round(t * 255), the channels' integers)
      const texels = p.textures.map((ti) => B(q.t[s.tex[ti].tobj.id & 7]));
      // (each texture's own TEV colors, konst, tev0, tev1: its stages read them as constants)
      const tevColors = p.textures.map((ti) => {
        const c = s.tex[ti].tevColors;
        return [0, 4, 8].map((o) => (c ? B(Array.from(c.subarray(o, o + 4))) : [0, 0, 0, 0]));
      });
      // (the lit channel: the ambient register, HSD_MulColor of the material's ambient and the ambient light, plus
      // the probe's light sum, through the channel; its alpha 255)
      const ambReg = mulColor(B([s.ambient[0], s.ambient[1], s.ambient[2]]), B([amb[0], amb[1], amb[2]]));
      const sum0 = B(q.s[0]), sum1 = B(q.s[1]);
      const lit = [0, 1, 2].map((i) => chanColor(255, ambReg[i] + (anyDiffuse ? sum0[i] : 0)));
      // (while the light adds, a lit material's alpha channel is lit by it: the light's alpha by the probe's turn,
      // which the material's alpha stage takes as the rasterized alpha, as the shader does)
      const litA = ol && ol.adds ? chanColor(255, byteOf(q.s[0][3])) : 255;
      const ras0 = p.channel === 1 ? B(q.v[0]) : p.channel === 2 ? [...lit, litA] : [255, 255, 255, 255];
      const ras1 = [0, 1, 2].map((i) => chanColor(255, anySpec ? sum1[i] : 0)).concat([255]);
      const dif = s.override ?? s.diffuse;
      const out = evalMaterial(p, {
        diffuse: B([dif[0], dif[1], dif[2]]), alpha: tevByte(s.alpha), specular: B([s.specular[0], s.specular[1], s.specular[2]]),
        ras0, ras1, texels, tevColors, blend: p.textures.map((ti) => tevByte(s.tex[ti].blending)),
        shadows: Array.from({ length: nShadow }, (_, k) => B(q.t[(p.textures.length + k) & 7])),
      });
      // (the overlay light's color where its alpha channel falls: ftMaterial_800BF534's stage, prev + konst x ras.a)
      // (its strength the rasterized alpha: the lit channel's - the light's alpha by the probe's turn - else the
      // vertex alpha or the material's)
      // (the probe's light sum is the lights' term already, color and all, as for the rgb: not the light's alpha again)
      const rasA = p.channel === 2 && ol ? chanColor(255, byteOf(q.s[0][3]))
        : p.channel === 1 ? byteOf(q.v[0][3]) : byteOf(s.alpha);
      if (addsOn) { const k = B(ol!.rgb); for (let i = 0; i < 3; i++) out[i] = tevStage(0, k[i], rasA, out[i], 0, 0, 0, true); }
      const tc = this.tint?.color;
      if (tc && tc[3] > 0) out.splice(0, 3, ...overColor(out.slice(0, 3), B(tc.slice(0, 3)), byteOf(tc[3])));
      // (an outline: the color so far taken toward the outline's by its alpha, ftMaterial_800BF6BC's stage)
      const oc = this.outline;
      if (oc) out.splice(0, 3, ...overColor(out.slice(0, 3), B(oc.slice(0, 3)), byteOf(Math.max(oc[3], 1e-3))));
      return out;
    });
  }

  private particles(data: Float32Array, batches: Batch[]) {
    const s = this.inner;
    const vp = s.overlayVP ?? s.viewProj;
    const [PW, PH] = this.target ?? [640, 480];
    // (a camera that turns the picture over has its rows the other way)
    const flip = s.mirrored && this.target !== null;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    for (const b of batches) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      // (each quad's own box, in the batch's order and the picture's pixels: the game draws each particle, and each
      // glyph, on its own; a lettering batch - the name plates' or Stadium's screen's - the picture's corner each reads too)
      const boxes: (number[] | null)[] = [];
      const cells: { box: number[]; uv: number[] }[] | null = b.sprite && (b.sprite.key === "plate-font" || b.sprite.key.startsWith("screen-font")) ? [] : null;
      // (each quad's four corners on the screen, in its vertex order, unrounded: to pair the game's quads one by one;
      // a corner behind the camera null)
      const quads: ([number, number] | null)[][] = [];
      for (let q = b.first; q < b.first + b.count; q++) {
        let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
        const corners: ([number, number] | null)[] = [];
        quads.push(corners);
        for (let v = 0; v < 4; v++) {
          const o = (q * 4 + v) * 17, X = data[o], Y = data[o + 1], Z = data[o + 2];
          const w = vp[3] * X + vp[7] * Y + vp[11] * Z + vp[15];
          if (w <= 1e-9) { corners.push(null); continue; }
          const sx = ((vp[0] * X + vp[4] * Y + vp[8] * Z + vp[12]) / w * 0.5 + 0.5) * PW;
          const ny = (vp[1] * X + vp[5] * Y + vp[9] * Z + vp[13]) / w * 0.5;
          const sy = (flip ? 0.5 + ny : 0.5 - ny) * PH;
          corners.push([sx, sy]);
          qx0 = Math.min(qx0, sx); qy0 = Math.min(qy0, sy); qx1 = Math.max(qx1, sx); qy1 = Math.max(qy1, sy);
        }
        if (cells) {
          const t = (q * 4 + 1) * 17;
          cells.push({ box: [qx0, qy0, qx1, qy1].map((v) => Math.round(v * 100) / 100), uv: [data[t + 3], data[t + 4]] });
        }
        if (!Number.isFinite(qx0)) { boxes.push(null); continue; }
        boxes.push([r1(qx0), r1(qy0), r1(qx1), r1(qy1)]);
        x0 = Math.min(x0, qx0); y0 = Math.min(y0, qy0); x1 = Math.max(x1, qx1); y1 = Math.max(y1, qy1);
      }
      // (the sprite's identity as the game's texture's: its image's bytes in the effect file)
      const src = b.sprite?.src;
      let id = src ? this.spriteIds.get(src) : undefined;
      if (src && id === undefined) this.spriteIds.set(src, (id = imageId(src.archive, src.image)));
      this.add({
        kind: "particles", quads: b.count, sprite: b.sprite ? { key: b.sprite.key, w: b.sprite.w, h: b.sprite.h } : null,
        ...(id ? { tex_id: id } : {}),
        blend: { on: true, src: "srcalpha", dst: b.additive ? "one" : "invsrcalpha", sub: false, logic: null },
        z: { test: true, func: b.nozcomp ? "always" : "lequal", write: b.zwrite }, near: b.near,
        overlay: s.overlayVP !== null,
        bbox: Number.isFinite(x0) ? [x0, y0, x1, y1].map(r1) : null, boxes,
        ...(cells ? { cells } : {}),
        corners: quads,
        ...(this.target ? { target: this.target } : {}),
      });
    }
  }
}

interface Batch { sprite: { key: string; w: number; h: number; src?: { archive: Archive; image: Image } } | null; additive: boolean;
                  near: boolean; zwrite: boolean;
                  nozcomp: boolean; first: number; count: number }

// ---------------------------------------------------------------- the debug handle's entry

const logs = new WeakMap<Renderer, DrawLog>();

/** the debug handle's command: { start } attaches, { label } names the frames
 *  drawn next, { take } hands over the frames logged, { stop } detaches;
 *  { exact: false } keeps the numbers to 6 digits from then on */
export function drawLogCommand(r: Renderer | null | undefined,
                               cmd: { start?: boolean; label?: number | string | null; take?: boolean; stop?: boolean; limit?: number;
                                      exact?: boolean }) {
  if (!r) return null;
  let log = logs.get(r);
  if (!log) logs.set(r, (log = new DrawLog(r)));
  if (cmd.limit) log.limit = cmd.limit;
  if (cmd.exact !== undefined) log.exact = cmd.exact;
  if (cmd.start) log.attach();
  if (cmd.label !== undefined) log.label = cmd.label;
  const out = cmd.take ? log.take() : null;
  if (cmd.stop) log.detach();
  return out ?? { attached: log.attached, frames: log.frames.length };
}
