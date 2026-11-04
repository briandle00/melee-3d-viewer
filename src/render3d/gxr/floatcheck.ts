/// <reference lib="dom" />
/* GX renderer: the start-up check of the graphics card's own float arithmetic (glsl-float.ts FAST_ADD_MUL).
 *
 * The pixel shader adds and multiplies with the card's own float arithmetic only when this card gives exactly the bits of the
 * spec's rounding (glsl-float.ts f_add and f_mul in whole numbers, `softAdd` and `softMul` here, the same steps in JavaScript).
 * Two checks run when the renderer starts, before anything is drawn:
 * 1. operations: a small program adds and multiplies 64 Ki pairs of operands with the card's arithmetic (the very functions the pixel
 *    shader uses): every pairing of the values where cards and the spec can part (zeros, numbers below and at the smallest normal
 *    number, products that round to it, the largest numbers, infinities, not-a-numbers, ties) and random numbers of every size; each
 *    result must equal `softAdd` / `softMul` bit for bit;
 * 2. pixels: a small scene of textured, lit, projected and depth-tested triangles (`checkScene`) drawn by the pixel program the
 *    renderer will use must equal the CPU reference (cpu.ts) in every pixel's color and depth.
 * Any difference, or a check that cannot run, and the renderer uses the whole-number float functions instead (gl.ts).
 */
import { FULLSCREEN_VS, intTexture, startCompile, finishCompile, uploadRows } from "./glutil";
import { floatGlsl } from "./glsl-float";
import { basicScene } from "./encode";
import type { Dff } from "./dff";
import { CpuBackend } from "./cpu";
import { GxGpu } from "./gpu";
import type { GxGl } from "./gl";

const F_NAN = 0x7fc00000, F_INF = 0x7f800000;

function msb(m: number): number { return 31 - Math.clz32(m); }

function pack(s: number, e: number, m: number, guard: number, sticky: number): number {
  const up = guard & (sticky | (m & 1));
  m += up;
  if (m === 0x1000000) { m = 0x800000; e += 1; }
  let r = ((Math.min(Math.max(e, 0), 255) << 23) | (m & 0x7fffff)) >>> 0;
  if (e >= 255) r = F_INF;
  if (e <= 0) r = 0;
  return ((s << 31) | r) >>> 0;
}

/** glsl-float.ts f_add, step for step */
export function softAdd(a: number, b: number): number {
  a >>>= 0; b >>>= 0;
  const aa = (a & 0x7fffffff) >>> 0, ab = (b & 0x7fffffff) >>> 0;
  const sw = aa < ab;
  const x = sw ? b : a, y = sw ? a : b, ax = sw ? ab : aa, ay = sw ? aa : ab;
  const sx = x >>> 31, sy = y >>> 31;
  const ex = ax >>> 23, ey = ay >>> 23;
  const mx = ex === 0 ? 0 : ((((ax & 0x7fffff) | 0x800000) << 3) >>> 0);
  let my = ey === 0 ? 0 : ((((ay & 0x7fffff) | 0x800000) << 3) >>> 0);
  const sh = Math.min(ex - ey, 31);
  const lost = (my & (((1 << sh) >>> 0) - 1)) >>> 0;
  my = ((my >>> sh) | (lost !== 0 ? 1 : 0)) >>> 0;
  const m = (sx === sy ? mx + my : mx - my) >>> 0;
  const ov = m >= 0x8000000;
  const lz = (ov || m === 0) ? 0 : Math.max(0, 26 - msb(m));
  const mn = (ov ? ((m >>> 1) | (m & 1)) : (m << lz)) >>> 0;
  const e = ex + (ov ? 1 : 0) - lz;
  let r = pack(sx, e, mn >>> 3, (mn >>> 2) & 1, (mn & 3) !== 0 ? 1 : 0);
  if (m === 0) r = 0;
  if (ex === 0) r = (a & b & 0x80000000) >>> 0;
  const sp = (ax > F_INF || (ay === F_INF && sx !== sy)) ? F_NAN : x;
  return ex === 255 ? sp : r;
}

/** glsl-float.ts f_mul, step for step */
export function softMul(a: number, b: number): number {
  a >>>= 0; b >>>= 0;
  const s = (a ^ b) >>> 31;
  const aa = (a & 0x7fffffff) >>> 0, ab = (b & 0x7fffffff) >>> 0;
  const ea = aa >>> 23, eb = ab >>> 23;
  const e = ea + eb - 127;
  const ma = (aa & 0x7fffff) | 0x800000, mb = (ab & 0x7fffff) | 0x800000;
  const ah = ma >>> 12, al = ma & 0xfff, bh = mb >>> 12, bl = mb & 0xfff;
  const ll = al * bl, mid = al * bh + ah * bl, hh = ah * bh;
  let lo = ll + ((mid & 0xfff) << 12);
  const hi = hh + (mid >>> 12) + Math.floor(lo / 0x1000000);
  lo = lo % 0x1000000;
  const top = hi >= 0x800000;
  const m = top ? hi : ((hi * 2) | (lo >>> 23));
  const guard = top ? (lo >>> 23) : ((lo >>> 22) & 1);
  const sticky = top ? ((lo & 0x7fffff) !== 0 ? 1 : 0) : ((lo & 0x3fffff) !== 0 ? 1 : 0);
  let r = pack(s, e + (top ? 1 : 0), m, guard, sticky);
  const za = ea === 0, zb = eb === 0, ia = aa === F_INF, ib = ab === F_INF;
  const nan = aa > F_INF || ab > F_INF || (ia && zb) || (ib && za);
  if (za || zb) r = (s << 31) >>> 0;
  if (ia || ib) r = ((s << 31) | F_INF) >>> 0;
  return nan ? F_NAN : r;
}

/** the operand pairs of the check: every pairing of the edge values (with both signs), and random numbers of every size */
export function checkOperands(n = 65536, seed = 0x6a5d39e1): Uint32Array {
  const edge: number[] = [0, 1, 2, 0x3ff, 0x400000, 0x7fffff, 0x800000, 0x800001, 0x80ffff, 0xffffff, 0x1000000, 0x1800000, 0x0c800000, 0x0c7fffff,
    0x0c000000, 0x0b800000, 0x0b7fffff, 0x3f800000, 0x3f800001, 0x3fffffff, 0x3f7fffff, 0x40000000, 0x33800000, 0x33000000, 0x34000000,
    0x4b7fffff, 0x4b800000, 0x43000000, 0x3effffff, 0x3f000000, 0x3f3504f3, 0x5f800000, 0x1f800000, 0x1f000000, 0x20000000, 0x7effffff,
    0x7f000000, 0x7f7fffff, 0x7f800000, 0x7f800001, 0x7fc00000, 0x7fffffff, 0x00fffffe, 0x01000000, 0x01800000, 0x197fffff, 0x26800000];
  const vals: number[] = [];
  for (const v of edge) vals.push(v >>> 0, (v | 0x80000000) >>> 0);
  const out = new Uint32Array(n * 2);
  let k = 0;
  for (const a of vals) for (const b of vals) { if (k >= n) break; out[2 * k] = a; out[2 * k + 1] = b; k++; }
  let s = seed >>> 0;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  for (; k < n; k++) {
    const a = next(), kind = next() & 7;
    let b = next();
    // products and sums near the smallest normal number, equal and opposite operands, exponents a little apart
    if (kind === 0) b = (((a & 0x80000000) ^ (next() & 0x80000000)) | (((253 - ((a >>> 23) & 255) + (next() % 5)) & 255) << 23) | (next() & 0x7fffff)) >>> 0;
    else if (kind === 1) b = (a ^ 0x80000000) >>> 0;
    else if (kind === 2) b = ((b & 0x807fffff) | ((((a >>> 23) & 255) + (next() % 50) - 25) & 255) << 23) >>> 0;
    else if (kind === 3) b = ((a & 0xff800000) | (next() & 0x7fffff)) >>> 0;
    out[2 * k] = a; out[2 * k + 1] = b;
  }
  return out;
}

const CHECK_FS = (fast: string) => `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn;
out uvec4 o;
${fast}
void main() {
  uvec2 v = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0).rg;
  o = uvec4(f_add(v.x, v.y), f_mul(v.x, v.y), f_add(f_mul(v.x, v.y), v.x), f_mul(f_add(v.x, v.y), v.y));
}`;

/** check 1: the card's add and multiply against softAdd / softMul on `checkOperands` (also a product followed by a sum and the
 *  reverse, so that a compiler fusing them would show). Returns the number of results that differ (0: the card is exact) */
export function checkOps(gl: WebGL2RenderingContext): number {
  const W = 256, H = 256, ops = checkOperands(W * H);
  const prog = finishCompile(gl, startCompile(gl, FULLSCREEN_VS, CHECK_FS(floatGlsl("fast"))));
  const input = intTexture(gl, "RG32UI", W, H), output = intTexture(gl, "RGBA32UI", W, H);
  const fbo = gl.createFramebuffer()!;
  try {
    uploadRows(gl, input, 0, 0, W, H, ops);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.tex, 0);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "uIn"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const res = new Uint32Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, res);
    let bad = 0;
    for (let i = 0; i < W * H; i++) {
      const a = ops[2 * i], b = ops[2 * i + 1];
      const s = softAdd(a, b), p = softMul(a, b);
      if (res[4 * i] !== s) bad++;
      if (res[4 * i + 1] !== p) bad++;
      if (res[4 * i + 2] !== softAdd(p, a)) bad++;
      if (res[4 * i + 3] !== softMul(s, b)) bad++;
    }
    return bad;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(input.tex); gl.deleteTexture(output.tex); gl.deleteProgram(prog);
  }
}

const f32bytes = (v: number): number[] => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); return [d.getUint8(0), d.getUint8(1), d.getUint8(2), d.getUint8(3)]; };

/** check 2's scene: a stream and the memory it reads. Triangles in the top-left 96 x 96 pixels: a vertex color and two texture
 *  generators (one projective) into two textures with linear filtering and a level of detail from the block, three TEV stages,
 *  depth test and update, blending; the triangles overlap, some nearly edge-on, with depths and coordinates from tiny to large. */
export function checkScene(): { stream: Uint8Array; mem: Uint8Array; init: Dff } {
  let s = 0x2545f491;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const mem = new Uint8Array(0x1800000);
  const TEX = 0x100000;
  for (let i = TEX; i < TEX + 0x10000; i++) mem[i] = (rnd() * 256) | 0;
  const w = basicScene();
  // vertex: position, color 0, two texture coordinates (s, t)
  w.cp(0x50, (1 << 9) | (1 << 13));
  w.cp(0x60, (1 << 0) | (1 << 2));
  w.cp(0x70, 1 | (4 << 1) | (5 << 14) | (1 << 21) | (4 << 22));
  w.cp(0x80, 1 | (4 << 1));
  w.xf(0x103f, [2]);
  w.xf(0x1040, [5 << 7]);
  w.xf(0x1041, [(6 << 7) | (1 << 1)]);
  // two RGB565 maps 32 x 32 and 16 x 64, linear, mipmaps off, lod from the block (bias 0, clamp 0..2)
  for (let m = 0; m < 2; m++) {
    w.bp(0x80 + m, (m === 0 ? 0 : 1 | (2 << 2)) | (1 << 4) | (4 << 5));
    w.bp(0x84 + m, 0 | (32 << 8));
    w.bp(0x88 + m, (m === 0 ? 31 | (31 << 10) : 15 | (63 << 10)) | (4 << 20));
    w.bp(0x94 + m, (TEX + m * 0x4000) >> 5);
    w.bp(0x30 + 2 * m, m === 0 ? 31 : 15); w.bp(0x31 + 2 * m, m === 0 ? 31 : 63);
  }
  // TEV: stage 0 texture 0 x color, stage 1 texture 1 blended with the previous by its alpha, stage 2 adds the color halved
  w.bp(0x00, 2 | (1 << 4) | (2 << 10));
  w.bp(0x28, (0 | (0 << 3) | (1 << 6) | (0 << 7)) | ((1 | (1 << 3) | (1 << 6) | (0 << 7)) << 12));
  w.bp(0x29, 0 | (0 << 3) | (0 << 6) | (0 << 7));
  w.bp(0xc0, 15 | (10 << 4) | (8 << 8) | (15 << 12)); w.bp(0xc1, (7 << 4) | (5 << 7) | (4 << 10) | (7 << 13));
  w.bp(0xc2, 0 | (9 << 4) | (8 << 8) | (15 << 12)); w.bp(0xc3, (0 << 4) | (4 << 7) | (7 << 10) | (7 << 13));
  w.bp(0xc4, 0 | (10 << 4) | (15 << 8) | (15 << 12) | (1 << 20)); w.bp(0xc5, (0 << 4) | (5 << 7) | (7 << 10) | (7 << 13));
  w.bp(0xf3, (7 << 16) | (7 << 19));
  w.bp(0x40, 1 | (6 << 1) | (1 << 4));
  w.bp(0x41, 1 | (1 << 3) | (1 << 4) | (4 << 5) | (5 << 8));
  for (let t = 0; t < 14; t++) {
    const bytes: number[] = [];
    const cx = 8 + rnd() * 80, cy = 8 + rnd() * 80, sz = 4 + rnd() * (t < 4 ? 120 : 40);
    for (let v = 0; v < 3; v++) {
      const thin = t % 5 === 4 && v === 2 ? 0.01 : 1;
      const px = cx + (rnd() * 2 - 1) * sz * thin, py = cy + (rnd() * 2 - 1) * sz, pz = -(1 + rnd() * (t % 3 === 0 ? 1e6 : 900));
      bytes.push(...f32bytes(px), ...f32bytes(py), ...f32bytes(pz), (rnd() * 256) | 0, (rnd() * 256) | 0, (rnd() * 256) | 0, (rnd() * 256) | 0);
      const big = t % 4 === 1 ? 1e5 : t % 4 === 2 ? 1e-30 : 1;
      bytes.push(...f32bytes((rnd() * 2 - 0.5) * big), ...f32bytes((rnd() * 2 - 0.5) * big), ...f32bytes(rnd() * 3 - 1), ...f32bytes(t % 6 === 3 ? 1e-38 * rnd() : rnd() * 4 - 1));
    }
    w.draw(2, 0, 3, bytes);
  }
  const init: Dff = { version: 4, bp: new Uint32Array(256), cp: new Uint32Array(256), xfMem: new Uint32Array(0x1000), xfRegs: new Uint32Array(0x60), texMem: new Uint8Array(0), frames: [] };
  return { stream: w.bytes(), mem, init };
}

/** check 2: `checkScene` through the renderer `be` (its pixel program as it will draw) and through the CPU reference; returns the pixels
 *  whose color or depth differ. The renderer is reset before and after (nothing of the scene stays). */
export function checkPixels(be: GxGl): number {
  const sc = checkScene();
  let ref!: GxGpu;
  const cpu = new CpuBackend(() => ({ mem: ref.mem.data, tmem: ref.regs.tmem, tluts: ref.regs.tluts }));
  ref = new GxGpu(cpu, sc.init, sc.mem);
  cpu.drawing = true;
  ref.runFrame({ fifo: sc.stream, updates: [] });
  const a = cpu.efb;
  const draws = be.draws, drawing = be.drawing, ff = be.fastForward;
  be.floatChecking_ = true;
  try {
    be.reset();
    be.drawing = true; be.fastForward = false;
    const g = new GxGpu(be, sc.init, sc.mem.slice());
    g.runFrame({ fifo: sc.stream, updates: [] });
    be.flush();
    const b = be.readEfb();
    let bad = 0;
    for (let i = 0; i < a.color.length; i++) if (a.color[i] !== b.color[i] || a.depth[i] !== b.depth[i]) bad++;
    return bad;
  } finally {
    be.reset();
    be.floatChecking_ = false;
    be.draws = draws; be.drawing = drawing; be.fastForward = ff;
  }
}