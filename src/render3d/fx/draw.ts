/* 3D replay viewer: the game's particles as quads to draw.
 *
 * As the game's particle display (psdisp.c) builds them: a square facing
 * the camera, `size` from its middle to each side, turned by the
 * particle's rotation (or along its motion); a trail stretched from where
 * it was to where it is. Color: the texture blends the environment color
 * into the primary one (or the primary color alone, untextured); the
 * alpha-compare the particle carries decides which pixels are drawn; the
 * blend is plain or additive. The game draws each particle on its own, in
 * its lists' order; a run of them with one texture and blend is one batch
 * here. */
import { K, Particle } from "./particles";
import type { Sprite } from "./bank";
import { appExtents, appMatrix, drawPoint, followMatrix, mtxDir, mtxPoint } from "./appsrt";
import { madd, msub, PSMTXConcat, PSMTXInverse, PSMTXMultVec, PSMTXRotAxisRad, mtxFromGL } from "../gxmath";
import { atan2f, cosf, sinf, tanf } from "./gamemath";

export const FLOATS = 17; // pos 3, uv 2, prim 4, env 4, alpha-compare 3, textured 1

export interface Batch {
  sprite: Sprite | null;
  additive: boolean;
  /** its texture sampled nearest (the particle's TexInterpNear), else bilinear */
  near: boolean;
  zwrite: boolean;
  nozcomp: boolean;
  /** its corners are in the camera's space (psDispSubAppSRT's GX_PNMTX1): drawn through the projection alone */
  view?: boolean;
  first: number; // quad index
  count: number;
}

// the game's corner texture coordinates, by its flip bits (0, S, T, S+T)
const UV = [
  [0, 1, 0, 0, 1, 0, 1, 1],
  [1, 1, 1, 0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1, 1, 1, 0],
  [1, 0, 1, 1, 0, 1, 0, 0],
];

let scratch = new Float32Array(FLOATS * 4 * 256);
// (the draw order's and a quad's scratch, and the batches, kept between frames: the caller draws them before
// the next build)
let order = new Int32Array(256), batchOf = new Int32Array(256);
const pool: Batch[] = [];
const CORNERS = new Float64Array(8);

/** a particle's color byte part-way to its target as the game draws it (getColorPrimEnv, and
 *  psDispParticles' alpha compare): the share left, 65536 * remain / count, an integer division, then
 *  ((target << 16) + (color - target) * share) >> 16, kept to a byte as the GXColor it is stored in */
export function psColorByte(cur: number, target: number, remain: number, count: number): number {
  if (!count) return cur & 0xff;
  const scale = Math.trunc((65536 * remain) / count);
  return (((target << 16) + (cur - target) * scale) >> 16) & 0xff;
}
const mixed = psColorByte;

const WORLD_AXES = { right: [1, 0, 0], up: [0, 1, 0] };
// (the camera's view as GX's 3 x 4 and its inverse, the follow-only transforms' draw matrix, points: kept)
const viewG = new Float32Array(12), viewInv = new Float32Array(12), followM = new Float32Array(12);
const curV = [0, 0, 0], prevV = [0, 0, 0], curW = [0, 0, 0], prevW = [0, 0, 0];
// (the game skips a particle smaller than this: psDispParticles' FLT_EPSILON; and FLT_MIN, below which a
// motion's up part counts as none)
const FLT_EPSILON = 1.1920929e-7, FLT_MIN = 1.1754944e-38;

const lastT = [0, 0, 0];
const HALF_PI_F = Math.fround(Math.PI / 2), ssM = new Float32Array(12), appV = new Float32Array(12);
const f32 = Math.fround;
// (psUpdateBillboardAxes: the inverse view's right plus and minus its up, per axis - HSD_PSDisp_804D7914..7928 - and
// psDispSub's turn and corners, kept)
const bbAxes = new Float32Array(6), rotM = new Float32Array(12), rotAxis = [0, 0, 0], exactV = new Float32Array(12);
const psCam: PsCamera = { view: viewG, pv: new Float32Array(8) };

/** the camera as psDispParticles keeps it for psDispSub: the view (vmtx, GX's 3 x 4) and the projection's first two
 *  rows times it (pvmtx: GXGetProjectionv's perspective scale and offset, p[1] p[2] and p[3] p[4]) */
export interface PsCamera { view: Float32Array; pv: Float32Array }

/** psDispParticles' pvmtx rows for a perspective projection (GX's 4 x 4 `gx`, as C_MTXPerspective makes it): each
 *  x_scale * vmtx[0][c] + x_offset * vmtx[2][c], and y_scale * vmtx[1][c] + y_offset * vmtx[2][c] (that product made
 *  first) - the sum fusing its first product, as -fp_contract on code does */
export function psCamera(view: Float32Array, gx: ArrayLike<number>, out: PsCamera): PsCamera {
  const xs = gx[0], xo = gx[2], ys = gx[5], yo = gx[6], v = view, pv = out.pv;
  out.view = view;
  for (let c = 0; c < 4; c++) {
    pv[c] = madd(xs, v[c], f32(xo * v[8 + c]));
    pv[4 + c] = madd(ys, v[4 + c], f32(yo * v[8 + c]));
  }
  return out;
}

/** A particle's corners as psDispSub makes them (no transform of its own): its size times the billboard axes
 *  (psUpdateBillboardAxes, from the inverse of the view), turned about right x up when the turn is more than 0.01
 *  (PSMTXRotAxisRad, the axis and the turn as the game's fused multiply-adds round them) - by its rotation, or for
 *  a trail or a direction particle by its way across the picture (atan2f of where it is less where it was a step
 *  back, each through pvmtx over its depth, -1.0f / w; plus its rotation for a direction particle) - then its place
 *  less right, less up, plus right, plus up, a trail's first and last from where it was (psDispSubMakePolygon). In
 *  float32, the game's order, so a corner the camera sees almost edge on lands where the game's does. Into `out`
 *  (12 floats); null for a trail or a direction particle without the camera's perspective (`cam`) */
export function psDispSubCorners(p: Particle, axes: Float32Array, out: Float32Array, cam: PsCamera | null = null): Float32Array | null {
  const size = p.size;
  let rx = f32(axes[0] * size), ux = f32(axes[1] * size), ry = f32(axes[2] * size), uy = f32(axes[3] * size);
  let rz = f32(axes[4] * size), uz = f32(axes[5] * size);
  const x = p.px, y = p.py, z = p.pz;
  const trail = (p.kind & K.TRAIL) !== 0;
  // (where it was a step back: calcTornadoLastPos for a tornado, else its place less its velocity)
  let qx = 0, qy = 0, qz = 0;
  if (trail || p.kind & K.DIRVEC) {
    if (p.kind & K.TORNADO) { tornadoLast(p, lastT); qx = lastT[0]; qy = lastT[1]; qz = lastT[2]; }
    else { qx = f32(x - p.vx); qy = f32(y - p.vy); qz = f32(z - p.vz); }
  }
  let angle: number;
  if (trail || p.kind & K.DIRVEC) {
    if (!cam) return null;
    const v = cam.view, pv = cam.pv;
    const w0 = f32(v[11] + madd(v[10], z, madd(v[8], x, f32(v[9] * y))));
    if (w0 === 0) return null;
    const w0inv = f32(-1 / w0);
    const w1 = f32(v[11] + madd(v[10], qz, madd(v[8], qx, f32(v[9] * qy))));
    if (w1 === 0) return null;
    const w1inv = f32(-1 / w1);
    const row = (o: number, px: number, py: number, pz: number) => f32(pv[o + 3] + madd(pv[o + 2], pz, madd(pv[o], px, f32(pv[o + 1] * py))));
    const sx = msub(w0inv, row(0, x, y, z), f32(w1inv * row(0, qx, qy, qz)));
    const sy = msub(w0inv, row(4, x, y, z), f32(w1inv * row(4, qx, qy, qz)));
    angle = Math.abs(sy) < FLT_MIN ? (sx >= 0 ? f32(1.5707964) : f32(-1.5707964)) : atan2f(sx, sy);
    if (p.kind & K.DIRVEC) angle = f32(angle + p.rotate);
  } else angle = p.rotate;
  if (Math.abs(angle) > 0.01) {
    rotAxis[0] = msub(ry, uz, f32(rz * uy));
    rotAxis[1] = msub(rz, ux, f32(rx * uz));
    rotAxis[2] = msub(rx, uy, f32(ry * ux));
    const m = PSMTXRotAxisRad(rotM, rotAxis, angle);
    const nrx = madd(m[2], rz, madd(m[0], rx, f32(m[1] * ry)));
    const nry = madd(m[6], rz, madd(m[4], rx, f32(m[5] * ry)));
    const nrz = madd(m[10], rz, madd(m[8], rx, f32(m[9] * ry)));
    const nux = madd(m[2], uz, madd(m[0], ux, f32(m[1] * uy)));
    const nuy = madd(m[6], uz, madd(m[4], ux, f32(m[5] * uy)));
    const nuz = madd(m[10], uz, madd(m[8], ux, f32(m[9] * uy)));
    rx = nrx; ry = nry; rz = nrz; ux = nux; uy = nuy; uz = nuz;
  }
  const bx = trail ? qx : x, by = trail ? qy : y, bz = trail ? qz : z;
  out[0] = f32(bx - rx); out[1] = f32(by - ry); out[2] = f32(bz - rz);
  out[3] = f32(x - ux); out[4] = f32(y - uy); out[5] = f32(z - uz);
  out[6] = f32(x + rx); out[7] = f32(y + ry); out[8] = f32(z + rz);
  out[9] = f32(bx + ux); out[10] = f32(by + uy); out[11] = f32(bz + uz);
  return out;
}
/** where a tornado particle was a step back (psdisp.c calcTornadoLastPos): its angle round its generator and its
 *  way along less a step of its generator's, in its generator's space - its trail's tail and its way across the
 *  picture are drawn from it (a tornado's velocity is no motion). Until 2026-11-09 they were drawn from its
 *  velocity as any particle's: the KO blast's two spirals (common 0xD8) 30 to 50 pixels off */
export function tornadoLast(p: Particle, out: number[]): number[] {
  const g = p.gen;
  // (the game reads a generator it does not have here: never so in its lists)
  if (!g) { out[0] = p.px; out[1] = p.py; out[2] = p.pz; return out; }
  // (calcTornadoLastPos, the tornado step's own fused order on the step-back motion)
  const sinA = sinf(p.grav), sinB = sinf(p.fric), cosA = cosf(p.grav), cosB = cosf(p.fric);
  const vz0 = f32(p.vz - (g.aux[0] ?? 0)), vx0 = f32(p.vx - g.grav);
  const R = f32(madd(vz0, tanf(Math.abs(g.angle)), Math.abs(g.radius)) * p.vy);
  const d = f32(R * cosf(vx0)), e = f32(R * sinf(vx0)), nd = -d;
  out[0] = f32(g.px + madd(d, cosB, f32(vz0 * sinB)));
  out[1] = f32(g.py + madd(cosB, f32(vz0 * sinA), madd(sinB, f32(nd * sinA), f32(e * cosA))));
  out[2] = f32(g.pz + madd(cosB, f32(vz0 * cosA), msub(sinB, f32(nd * cosA), f32(e * sinA))));
  return out;
}

/** A particle under a transform as psDispSubAppSRT draws it: in the camera's space (GX_PNMTX1, the projection
 *  alone after it). `ss`: the draw matrix - the view times the transform's matrix (PSMTXConcat(vmtx, mmtx)), or for
 *  a transform that only follows its follow matrix; `ex`, `ey`: |vmtx mmtx col 0| size and |col 1| size. Its place
 *  and where it was a step back through `ss` (drawPoint), the corners' half-extents (ax, ay) = (ex, ey) and
 *  (bx, by) = (ex, -ey), turned when the turn is more than 0.01 (cosf and sinf, c ax - s ay one fmsubs on s ay,
 *  s ax + c ay one fmadds on c ay) by its rotation, or for a trail or a direction particle by its way across the
 *  picture: the place less where it was through the projection's first two rows times `ss`, each over its depth
 *  (-1.0f / w), atan2f of the two (plus its rotation, a direction particle). Corners: place less a, less b, plus a,
 *  plus b - a trail's first and last from where it was. All float32 in main.dol's order. Into `out` (12 floats);
 *  null when its depth or the old one is 0 (the game draws nothing) */
export function appSrtCorners(p: Particle, ss: Float32Array, ex: number, ey: number, gx: ArrayLike<number> | null,
                              out: Float32Array): Float32Array | null {
  const tornado = (p.kind & K.TORNADO) !== 0;
  drawPoint(ss, p.px, p.py, p.pz, curV);
  let lx: number, ly: number, lz: number;
  if (tornado) { tornadoLast(p, lastT); lx = lastT[0]; ly = lastT[1]; lz = lastT[2]; }
  else { lx = f32(p.px - p.vx); ly = f32(p.py - p.vy); lz = f32(p.pz - p.vz); }
  drawPoint(ss, lx, ly, lz, prevV);
  let ax = ex, ay = ey, bx = ex, by = -ey;
  const trail = (p.kind & K.TRAIL) !== 0;
  let angle: number;
  if (trail || p.kind & K.DIRVEC) {
    let vf1: number, vf2: number;
    if (gx && gx[15] === 0) {
      // (perspective: s808 s804 f16 f20 the x row, f12 f8 f11 f13 the y row, each prj * ss + prj * ss fused on its
      // first product; w the draw matrix's third row)
      const p1 = gx[0], p2 = gx[2], p3 = gx[5], p4 = gx[6];
      const w0 = f32(ss[11] + madd(ss[10], p.pz, madd(ss[8], p.px, f32(ss[9] * p.py))));
      const x0 = madd(p1, ss[0], f32(p2 * ss[8])), x1 = madd(p1, ss[1], f32(p2 * ss[9]));
      const x2 = madd(p1, ss[2], f32(p2 * ss[10])), x3 = madd(p1, ss[3], f32(p2 * ss[11]));
      const y0 = madd(p3, ss[4], f32(p4 * ss[8])), y1 = madd(p3, ss[5], f32(p4 * ss[9]));
      const y2 = madd(p3, ss[6], f32(p4 * ss[10])), y3 = madd(p3, ss[7], f32(p4 * ss[11]));
      if (w0 === 0) return null;
      const w0inv = f32(-1 / w0);
      const w1 = f32(ss[11] + madd(ss[10], lz, madd(ss[8], lx, f32(ss[9] * ly))));
      if (w1 === 0) return null;
      const w1inv = f32(-1 / w1);
      const prevX = f32(x3 + madd(x2, lz, madd(x0, lx, f32(x1 * ly))));
      const prevY = f32(y3 + madd(y2, lz, madd(y0, lx, f32(y1 * ly))));
      const curX = f32(x3 + madd(x2, p.pz, madd(x0, p.px, f32(x1 * p.py))));
      const curY = f32(y3 + madd(y2, p.pz, madd(y0, p.px, f32(y1 * p.py))));
      vf1 = msub(w0inv, curX, f32(w1inv * prevX));
      vf2 = msub(w0inv, curY, f32(w1inv * prevY));
    } else return null;
    angle = Math.abs(vf2) < FLT_MIN ? (-vf1 >= 0 ? HALF_PI_F : -HALF_PI_F) : atan2f(-vf1, vf2);
    if (p.kind & K.DIRVEC) angle = f32(angle + p.rotate);
  } else angle = p.rotate;
  if (Math.abs(angle) > 0.01) {
    const c = cosf(angle), s = sinf(angle);
    const oax = ax, obx = bx;
    ax = msub(c, ax, f32(s * ay)); ay = madd(s, oax, f32(c * ay));
    bx = msub(c, bx, f32(s * by)); by = madd(s, obx, f32(c * by));
  }
  const cx = curV[0], cy = curV[1], cz = curV[2];
  const qx = trail ? prevV[0] : cx, qy = trail ? prevV[1] : cy, qz = trail ? prevV[2] : cz;
  out[0] = f32(qx - ax); out[1] = f32(qy - ay); out[2] = qz;
  out[3] = f32(cx - bx); out[4] = f32(cy - by); out[5] = cz;
  out[6] = f32(cx + ax); out[7] = f32(cy + ay); out[8] = cz;
  out[9] = f32(qx + bx); out[10] = f32(qy + by); out[11] = qz;
  return out;
}

/** the particles as quads, in the order the game draws them (psDispParticles: the lists' particles that
 *  write depth, TexEdge, in the edge pass, then the rest in the see-through pass, each in its list's order),
 *  one draw a quad in the game; here one batch for each run of quads whose texture, blend and depth writes
 *  are the same. Each in the plane of the camera whose right and up (world directions) are given; with its
 *  perspective projection (viewProj), a trail's or a direction particle's way across the picture is where
 *  the projection puts it and where it was, as the game's psDispSub measures it */
export function buildParticles(list: Particle[],
                               axes: { right: number[]; up: number[]; viewProj?: ArrayLike<number>; view?: ArrayLike<number>;
                                       gxProj?: ArrayLike<number> | null } = WORLD_AXES,
                               shift: ((p: Particle) => [number, number] | null) | null = null):
    { data: Float32Array; batches: Batch[] } {
  const R = axes.right, U = axes.up;
  const groups: Batch[] = [];
  if (order.length < list.length) { order = new Int32Array(list.length * 2); batchOf = new Int32Array(list.length * 2); }
  let kept = 0;
  let cur: Batch | null = null;
  // (with the camera's view, a follow-only transform's particles are placed as the game places them: in its
  // space, then back into the world for the renderer, which takes them through the view again)
  const haveView = !!axes.view && PSMTXInverse(mtxFromGL(axes.view, viewG, 0), viewInv) === 1;
  // (with a perspective camera's GX projection: psDispSub's pvmtx, for the trails' and direction particles' turn)
  const perspective = !!axes.gxProj && axes.gxProj[15] === 0;
  // (a particle under a transform, with the camera's view, as psDispSubAppSRT draws it: in the camera's space)
  const inView = (p: Particle) => !!p.srt && haveView && !shift && (perspective || !(p.kind & (K.TRAIL | K.DIRVEC)));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (((p.kind & K.TEXEDGE) !== 0) !== (pass === 0)) continue;
      if (p.dead || p.size < FLT_EPSILON || p.kind & K.POINT) continue;
      const sprite = p.kind & K.DISP_TEX ? p.bank.image(p.texGroup, p.pose) : null;
      const additive = ((p.kind >>> 22) & 3) === 1;
      const zwrite = pass === 0;
      const near = (p.kind & K.TEX_NEAR) !== 0;
      const view = inView(p);
      if (!cur || cur.sprite !== sprite || cur.additive !== additive || cur.zwrite !== zwrite || cur.near !== near ||
          !!cur.view !== view) {
        cur = pool[groups.length] ??= { sprite: null, additive: false, near: false, zwrite: false, nozcomp: false, first: 0, count: 0 };
        // (every particle tests depth: psDispParticles sets GX_LEQUAL whatever its kind)
        cur.sprite = sprite; cur.additive = additive; cur.near = near; cur.zwrite = zwrite; cur.nozcomp = false;
        cur.view = view;
        cur.first = kept; cur.count = 0;
        groups.push(cur);
      }
      cur.count++;
      batchOf[kept] = groups.length - 1;
      order[kept++] = i;
    }
  }
  const batches = groups;
  const need = kept * 4 * FLOATS;
  if (scratch.length < need) scratch = new Float32Array(need * 2);
  const out = scratch;
  let o = 0;
  if (haveView) {
    bbAxes[0] = f32(viewInv[0] + viewInv[1]); bbAxes[1] = f32(viewInv[0] - viewInv[1]);
    bbAxes[2] = f32(viewInv[4] + viewInv[5]); bbAxes[3] = f32(viewInv[4] - viewInv[5]);
    bbAxes[4] = f32(viewInv[8] + viewInv[9]); bbAxes[5] = f32(viewInv[8] - viewInv[9]);
  }
  // (with a perspective camera's GX projection: psDispSub's pvmtx, for the trails' and direction particles' turn)
  const cam = haveView && axes.gxProj && axes.gxProj[15] === 0 ? psCamera(viewG, axes.gxProj, psCam) : null;
  for (let qi = 0; qi < kept; qi++) {
    const p = list[order[qi]];
    const textured = groups[batchOf[qi]].sprite ? 1 : 0;
    // where it is, and how big, through its transform (psDispSubAppSRT): its matrix (HSD_MtxSRT, kept as made
    // once it is STILL), and a quad as wide as |the camera's view times it's first column| times the size and as
    // tall as |its second column| times it (appsrt.ts); under a generator's own transform that only
    // follows (its kind's 0x20000: the game's xA2), the quad is sized the same way but the particle's place
    // and motion are in the camera's axes from the transform's place, not turned or scaled by it
    // (its motion: its velocity, or a tornado's - whose velocity holds its angle round its generator, how far out
    // and how far along - from where it was a step back, calcTornadoLastPos)
    let lvx = p.vx, lvy = p.vy, lvz = p.vz;
    const tornado = (p.kind & K.TORNADO) !== 0;
    if (tornado) {
      tornadoLast(p, lastT);
      lvx = Math.fround(p.px - lastT[0]); lvy = Math.fround(p.py - lastT[1]); lvz = Math.fround(p.pz - lastT[2]);
    }
    let cx = p.px, cy = p.py, cz = p.pz, ex = p.size, ey = p.size;
    let wx = lvx, wy = lvy, wz = lvz;
    const srt = p.srt;
    let inSpace: Float32Array | null = null;
    if (srt && groups[batchOf[qi]].view) {
      // (psDispSubAppSRT: the draw matrix, vmtx mmtx or the follow matrix; the quad's size from vmtx mmtx either way)
      const m = appMatrix(srt);
      [ex, ey] = appExtents(m, p.size, axes.view);
      const ss = srt.view ? followMatrix(srt, viewG, followM) : PSMTXConcat(viewG, m, ssM);
      inSpace = appSrtCorners(p, ss, ex, ey, axes.gxProj ?? null, appV);
      // (a depth of 0, now or a step back: the game draws nothing - a quad of no size here)
      if (!inSpace) { appV.fill(0); inSpace = appV; }
    } else if (srt) {
      if (srt.view && haveView) {
        // psDispSubAppSRT's xA2 path: the quad sized by |vmtx mmtx| as any transform's, the particle placed by
        // the follow matrix (the transform's place through the view, that matrix's scale alone), where it was a
        // step of its velocity back the same way
        [ex, ey] = appExtents(appMatrix(srt), p.size, axes.view);
        followMatrix(srt, viewG, followM);
        drawPoint(followM, p.px, p.py, p.pz, curV);
        const dz = tornado ? lastT[2] : Math.fround(p.pz - p.vz), dx = tornado ? lastT[0] : Math.fround(p.px - p.vx);
        const dy = tornado ? lastT[1] : Math.fround(p.py - p.vy);
        drawPoint(followM, dx, dy, dz, prevV);
        PSMTXMultVec(viewInv, curV, curW);
        PSMTXMultVec(viewInv, prevV, prevW);
        cx = curW[0]; cy = curW[1]; cz = curW[2];
        wx = curW[0] - prevW[0]; wy = curW[1] - prevW[1]; wz = curW[2] - prevW[2];
      } else if (srt.view) {
        ex = p.size * Math.abs(srt.sx); ey = p.size * Math.abs(srt.sy);
        const B0 = R[1] * U[2] - R[2] * U[1], B1 = R[2] * U[0] - R[0] * U[2], B2 = R[0] * U[1] - R[1] * U[0];
        cx = srt.tx + p.px * R[0] + p.py * U[0] + p.pz * B0;
        cy = srt.ty + p.px * R[1] + p.py * U[1] + p.pz * B1;
        cz = srt.tz + p.px * R[2] + p.py * U[2] + p.pz * B2;
        wx = lvx * R[0] + lvy * U[0] + lvz * B0;
        wy = lvx * R[1] + lvy * U[1] + lvz * B1;
        wz = lvx * R[2] + lvy * U[2] + lvz * B2;
      } else {
        const m = appMatrix(srt);
        [ex, ey] = appExtents(m, p.size, axes.view);
        [cx, cy, cz] = mtxPoint(m, p.px, p.py, p.pz);
        [wx, wy, wz] = mtxDir(m, lvx, lvy, lvz);
      }
    }
    // (drawn somewhere else than the game has it: the HUD's, at this player's own HUD's place)
    const moved = shift ? shift(p) : null;
    if (moved) { cx += moved[0]; cy += moved[1]; }
    // its motion as the camera sees it (across and up the picture): with a perspective camera, from where it is
    // and where it was (one step of its velocity back) as the projection puts them (psDispSub); else its
    // velocity in the camera's plane
    let vx = wx * R[0] + wy * R[1] + wz * R[2], vy = wx * U[0] + wy * U[1] + wz * U[2];
    const P = axes.viewProj;
    if (P && (p.kind & (K.TRAIL | K.DIRVEC))) {
      const qx = cx - wx, qy = cy - wy, qz = cz - wz;
      const w0 = P[3] * cx + P[7] * cy + P[11] * cz + P[15], w1 = P[3] * qx + P[7] * qy + P[11] * qz + P[15];
      if (w0 !== 0 && w1 !== 0) {
        vx = (P[0] * cx + P[4] * cy + P[8] * cz + P[12]) / w0 - (P[0] * qx + P[4] * qy + P[8] * qz + P[12]) / w1;
        vy = (P[1] * cx + P[5] * cy + P[9] * cz + P[13]) / w0 - (P[1] * qx + P[5] * qy + P[9] * qz + P[13]) / w1;
      }
    }
    // The game turns a quad in the camera's plane, by its rotation or to point along its motion (plus its
    // rotation, a direction particle), when that is more than 0.01: without a transform clockwise (psDispSub:
    // about right x up, which points away from the camera), under one counterclockwise and by the motion's way
    // with its across part negated (psDispSubAppSRT) - the same turn for the motion, the other way for the
    // rotation. `angle`: counterclockwise
    const trail = (p.kind & K.TRAIL) !== 0;
    let angle: number;
    if (trail || p.kind & K.DIRVEC) {
      const ax = srt ? -vx : vx;
      angle = Math.abs(vy) < FLT_MIN ? (ax >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(ax, vy);
      if (p.kind & K.DIRVEC) angle += p.rotate;
    } else angle = p.rotate;
    if (!srt) angle = -angle;
    if (Math.abs(angle) <= 0.01) angle = 0;
    const c = Math.cos(angle), s = Math.sin(angle);
    // the corners' basis, turned: R = (ex, ey), U = (ex, -ey) - without a transform the game's diagonal one,
    // right + up and right - up, each the particle's size
    const rx = c * ex - s * ey, ry = s * ex + c * ey, ux = c * ex + s * ey, uy = s * ex - c * ey;
    // corners, across and up the picture from its middle: -R, -U, +R, +U
    // (a trail's first and last from where it was: one step of its velocity back, in the world - psDispSubMakePolygon)
    // (a plain one's as the game makes them, with the camera's view: psDispSubCorners)
    const exact = haveView && !srt && !moved ? psDispSubCorners(p, bbAxes, exactV, cam) : null;
    const corners = CORNERS;
    corners[0] = -rx; corners[1] = -ry; corners[2] = -ux; corners[3] = -uy;
    corners[4] = rx; corners[5] = ry; corners[6] = ux; corners[7] = uy;
    const uv = UV[((p.kind >>> 18) & 3)];
    const ms = p.kind & K.MIRROR_S ? 2 : 1, mt = p.kind & K.MIRROR_T ? 2 : 1, mtOff = p.kind & K.MIRROR_T ? 1 : 0;
    const pr = mixed(p.prim.r, p.primTarget.r, p.primRemain, p.primCount) / 255;
    const pg = mixed(p.prim.g, p.primTarget.g, p.primRemain, p.primCount) / 255;
    const pb = mixed(p.prim.b, p.primTarget.b, p.primRemain, p.primCount) / 255;
    const pa255 = mixed(p.prim.a, p.primTarget.a, p.primRemain, p.primCount);
    const pa = pa255 / 255;
    const primEnv = (p.kind & K.PRIMENV) !== 0;
    const er = primEnv ? mixed(p.env.r, p.envTarget.r, p.envRemain, p.envCount) / 255 : 0;
    const eg = primEnv ? mixed(p.env.g, p.envTarget.g, p.envRemain, p.envCount) / 255 : 0;
    const eb = primEnv ? mixed(p.env.b, p.envTarget.b, p.envRemain, p.envCount) / 255 : 0;
    const ea255 = primEnv ? mixed(p.env.a, p.envTarget.a, p.envRemain, p.envCount) : 0;
    const ea = ea255 / 255;
    const a1 = mixed(p.aCmp1, p.aCmp1Target, p.aCmpRemain, p.aCmpCount);
    const a2 = mixed(p.aCmp2, p.aCmp2Target, p.aCmpRemain, p.aCmpCount);
    for (let k = 0; k < 4; k++) {
      const a = corners[k * 2], b = corners[k * 2 + 1];
      const back = trail && (k === 0 || k === 3) ? 1 : 0;
      const ox = cx - back * wx, oy = cy - back * wy, oz = cz - back * wz;
      if (inSpace) { out[o++] = inSpace[k * 3]; out[o++] = inSpace[k * 3 + 1]; out[o++] = inSpace[k * 3 + 2]; }
      else if (exact) { out[o++] = exact[k * 3]; out[o++] = exact[k * 3 + 1]; out[o++] = exact[k * 3 + 2]; }
      else { out[o++] = ox + a * R[0] + b * U[0]; out[o++] = oy + a * R[1] + b * U[1]; out[o++] = oz + a * R[2] + b * U[2]; }
      out[o++] = uv[k * 2] * ms; out[o++] = uv[k * 2 + 1] * mt + mtOff;
      // (a trail's tail: its alpha times the particle's trail, kept to 8 bits as GXColor4u8 takes it)
      const tail = trail && (k === 0 || k === 3);
      out[o++] = pr; out[o++] = pg; out[o++] = pb; out[o++] = tail ? Math.trunc(pa255 * p.trail) / 255 : pa;
      out[o++] = er; out[o++] = eg; out[o++] = eb; out[o++] = tail ? Math.trunc(ea255 * p.trail) / 255 : ea;
      out[o++] = p.aCmpMode; out[o++] = a1; out[o++] = a2;
      out[o++] = textured;
    }
  }
  return { data: out.subarray(0, o), batches };
}
