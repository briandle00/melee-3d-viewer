/* 3D replay viewer: a particle transform's matrix and the size of a particle drawn under it, as
 * psDispSubAppSRT (sysdolphin/baselib/psdisp.c) makes them.
 *
 * Each frame the transform is first drawn in (its frameNum), its matrix is made from its scale, turn and place
 * (HSD_MtxSRT) - unless its status is STILL - and a transform made ONCE (psAddGeneratorAppSRT's status 1) is
 * STILL from then on: its matrix kept as that first draw made it, whatever its place or scale do after. The
 * matrix the particles are drawn by is the camera's times it (S = vmtx mmtx), and a particle's quad is
 * |S's first column| times its size across and |S's second column| times it up.
 *
 * In float32 as the console has it, through gxmath.ts (HSD_MtxSRT, PSMTXConcat, MSL's sqrtf, HSD_MtxGetScale).
 */
import type { AppSRT } from "./particles";
import { HSD_MtxGetScale, HSD_MtxSRT, PSMTXConcat, mtxFromGL, sqrtf } from "../gxmath";

const f32 = Math.fround;
const srtS = [0, 0, 0], srtR = [0, 0, 0], srtT = [0, 0, 0];
const viewM = new Float32Array(12), ssM = new Float32Array(12), gsM = new Float32Array(12), gsOut = [0, 0, 0];

/** psAddGeneratorAppSRT's status: made again each frame, made once (then still), kept as it is */
export const APP_DYNAMIC = 0, APP_ONCE = 1, APP_STILL = 2;

/** HSD_MtxSRT with no parent scale: a 3 x 4, row major (sysdolphin/baselib/mtx.c) */
export function mtxSRT(out: Float32Array, s: AppSRT): Float32Array {
  srtS[0] = s.sx; srtS[1] = s.sy; srtS[2] = s.sz;
  srtR[0] = s.rx; srtR[1] = s.ry; srtR[2] = s.rz;
  srtT[0] = s.tx; srtT[1] = s.ty; srtT[2] = s.tz;
  return HSD_MtxSRT(out, srtS, srtR, srtT, null);
}

/** the transform's matrix as the frame's draw has it (psDispSubAppSRT's first half): made again unless STILL,
 *  a ONCE one made STILL */
export function appMatrix(s: AppSRT): Float32Array {
  const m = (s.mmtx ??= new Float32Array(12));
  if (s.status !== APP_STILL) mtxSRT(m, s);
  if (s.status === APP_ONCE) s.status = APP_STILL;
  return m;
}

/** a point through a 3 x 4 */
export function mtxPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[3] + m[2] * z + (m[0] * x + m[1] * y), m[7] + m[6] * z + (m[4] * x + m[5] * y),
          m[11] + m[10] * z + (m[8] * x + m[9] * y)];
}

/** a direction through a 3 x 4 (no move) */
export function mtxDir(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
}

/** a particle's half-extents under a transform: |S col 0| size and |S col 1| size, S the camera's view
 *  (column-major 4 x 4, GL's) times the transform's matrix (PSMTXConcat), or the matrix alone without a view */
export function appExtents(m: Float32Array, size: number, view?: ArrayLike<number> | null): [number, number] {
  let S = m;
  if (view) { mtxFromGL(view, viewM, 0); S = PSMTXConcat(viewM, m, ssM); }
  // (each column's squares as the struct's fields: not fused; then MSL's sqrtf)
  const sx = sqrtf(f32(f32(f32(S[0] * S[0]) + f32(S[4] * S[4])) + f32(S[8] * S[8])));
  const sy = sqrtf(f32(f32(f32(S[1] * S[1]) + f32(S[5] * S[5])) + f32(S[9] * S[9])));
  return [f32(sx * size), f32(sy * size)];
}

/** HSD_MtxGetScale of a column-major 4 x 4 (a joint's world matrix): the first column's length, the second's
 *  once the first is taken out of it, the third's once both are, all negative when the three turn the other
 *  way (a generator of type 0x1000 takes its joint's this way each update: generator.c) */
export function mtxGetScale(w: ArrayLike<number>): [number, number, number] {
  HSD_MtxGetScale(mtxFromGL(w, gsM, 0), gsOut);
  return [gsOut[0], gsOut[1], gsOut[2]];
}
