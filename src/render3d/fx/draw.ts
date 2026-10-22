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
import { PSMTXInverse, PSMTXMultVec, mtxFromGL } from "../gxmath";

export const FLOATS = 17; // pos 3, uv 2, prim 4, env 4, alpha-compare 3, textured 1

export interface Batch {
  sprite: Sprite | null;
  additive: boolean;
  /** its texture sampled nearest (the particle's TexInterpNear), else bilinear */
  near: boolean;
  zwrite: boolean;
  nozcomp: boolean;
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

/** the particles as quads, in the order the game draws them (psDispParticles: the lists' particles that
 *  write depth, TexEdge, in the edge pass, then the rest in the see-through pass, each in its list's order),
 *  one draw a quad in the game; here one batch for each run of quads whose texture, blend and depth writes
 *  are the same. Each in the plane of the camera whose right and up (world directions) are given; with its
 *  perspective projection (viewProj), a trail's or a direction particle's way across the picture is where
 *  the projection puts it and where it was, as the game's psDispSub measures it */
export function buildParticles(list: Particle[],
                               axes: { right: number[]; up: number[]; viewProj?: ArrayLike<number>; view?: ArrayLike<number> } = WORLD_AXES,
                               shift: ((p: Particle) => [number, number] | null) | null = null):
    { data: Float32Array; batches: Batch[] } {
  const R = axes.right, U = axes.up;
  const groups: Batch[] = [];
  if (order.length < list.length) { order = new Int32Array(list.length * 2); batchOf = new Int32Array(list.length * 2); }
  let kept = 0;
  let cur: Batch | null = null;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (((p.kind & K.TEXEDGE) !== 0) !== (pass === 0)) continue;
      if (p.dead || p.size < FLT_EPSILON || p.kind & K.POINT) continue;
      const sprite = p.kind & K.DISP_TEX ? p.bank.image(p.texGroup, p.pose) : null;
      const additive = ((p.kind >>> 22) & 3) === 1;
      const zwrite = pass === 0;
      const near = (p.kind & K.TEX_NEAR) !== 0;
      if (!cur || cur.sprite !== sprite || cur.additive !== additive || cur.zwrite !== zwrite || cur.near !== near) {
        cur = pool[groups.length] ??= { sprite: null, additive: false, near: false, zwrite: false, nozcomp: false, first: 0, count: 0 };
        // (every particle tests depth: psDispParticles sets GX_LEQUAL whatever its kind)
        cur.sprite = sprite; cur.additive = additive; cur.near = near; cur.zwrite = zwrite; cur.nozcomp = false;
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
  // (with the camera's view, a follow-only transform's particles are placed as the game places them: in its
  // space, then back into the world for the renderer, which takes them through the view again)
  const haveView = !!axes.view && PSMTXInverse(mtxFromGL(axes.view, viewG, 0), viewInv) === 1;
  for (let qi = 0; qi < kept; qi++) {
    const p = list[order[qi]];
    const textured = groups[batchOf[qi]].sprite ? 1 : 0;
    // where it is, and how big, through its transform (psDispSubAppSRT): its matrix (HSD_MtxSRT, kept as made
    // once it is STILL), and a quad as wide as |the camera's view times it's first column| times the size and as
    // tall as |its second column| times it (appsrt.ts); under a generator's own transform that only
    // follows (its kind's 0x20000: the game's xA2), the quad is sized the same way but the particle's place
    // and motion are in the camera's axes from the transform's place, not turned or scaled by it
    let cx = p.px, cy = p.py, cz = p.pz, ex = p.size, ey = p.size;
    let wx = p.vx, wy = p.vy, wz = p.vz;
    const srt = p.srt;
    if (srt) {
      if (srt.view && haveView) {
        // psDispSubAppSRT's xA2 path: the quad sized by |vmtx mmtx| as any transform's, the particle placed by
        // the follow matrix (the transform's place through the view, that matrix's scale alone), where it was a
        // step of its velocity back the same way
        [ex, ey] = appExtents(appMatrix(srt), p.size, axes.view);
        followMatrix(srt, viewG, followM);
        drawPoint(followM, p.px, p.py, p.pz, curV);
        const dz = Math.fround(p.pz - p.vz), dx = Math.fround(p.px - p.vx), dy = Math.fround(p.py - p.vy);
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
        wx = p.vx * R[0] + p.vy * U[0] + p.vz * B0;
        wy = p.vx * R[1] + p.vy * U[1] + p.vz * B1;
        wz = p.vx * R[2] + p.vy * U[2] + p.vz * B2;
      } else {
        const m = appMatrix(srt);
        [ex, ey] = appExtents(m, p.size, axes.view);
        [cx, cy, cz] = mtxPoint(m, p.px, p.py, p.pz);
        [wx, wy, wz] = mtxDir(m, p.vx, p.vy, p.vz);
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
      out[o++] = ox + a * R[0] + b * U[0]; out[o++] = oy + a * R[1] + b * U[1]; out[o++] = oz + a * R[2] + b * U[2];
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
