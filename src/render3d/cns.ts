/* 3D replay viewer: a joint tied to another model's joint by HSD's constraints - an item a fighter holds.
 *
 * The game ties a held item's joint to the fighter's (lb_8000C2F8: a position and an orientation constraint, two
 * RObjs). Each time the item's joint's matrix is made (HSD_JObjSetupMatrixSub), HSD_JObjMakeMatrix makes it from
 * its own pose first, then HSD_RObjUpdateAll lays the constraints over it:
 *  - the position: its translation is the target's (HSD_RObjGetGlobalPosition: the one target's mtx[.][3], times
 *    1.0f / 1);
 *  - the orientation (resolveCnsOrientation): its three axes are the target's turn, each as long as the joint's
 *    own axis was. A target with JOBJ_CLASSICAL_SCALE and a parent - a fighter's joint - gives its turn without
 *    any scale on the way: its matrix against its parent's (HSD_MtxInverseConcat) with each column made a unit
 *    one and then the joint's own length, times every joint above it the same way (its matrix against its
 *    parent's, each column a unit one) up to the root, whose own matrix is taken. The fighter's joints are
 *    scaled unevenly on the way (ftData's scales), so this is not its world matrix's columns made unit ones;
 *    other targets give their world matrix's columns, unit ones times the joint's lengths.
 * The matrix is left so (no update makes it again from the pose): the joints under it are made on it. And the joint's
 * turn is taken back from it (JObjUpdateFunc's 0x37: HSD_MtxGetRotation of it against its parent's), which the next
 * frame's HSD_JObjMakeMatrix makes its matrix from - so each axis's length the constraint keeps next frame comes from
 * this frame's turn (heldTurn), and an item held from its pick-up on (it_802742F4 lays the file's rest pose first)
 * has its matrix from that whole run of frames. In float32 in the game's order (gxmath.ts, fx/gamemath.ts).
 */
import { HSD_MtxColMag, HSD_MtxInverseConcat, PSMTXConcat, PSVECMag, f32, fmuls, frsqrte, mtxFromGL, nmsub, sqrtf, type Mtx } from "./gxmath";
import { atan2f, atanf, cosf } from "./fx/gamemath";
import { JOBJ } from "./hsd";
import { partSkips, partToModelJoint } from "./parts";

/** the model a constraint's target joint is in: each joint's world matrix (a column-major 4 x 4), its parent (-1
 *  for the root) and its flags */
export interface CnsModel {
  world(j: number): ArrayLike<number> | null;
  parent(j: number): number;
  flags(j: number): number;
}

const T = new Float32Array(12), P = new Float32Array(12), m0 = new Float32Array(12), m1 = new Float32Array(12);
const v = [0, 0, 0], mags = [0, 0, 0];

/** a column made a unit one, times `k` when given (VECMag; 1.0f / it when over 1e-10, as resolveCnsOrientation) */
function unitColumn(m: Mtx, c: number, k?: number) {
  v[0] = m[c]; v[1] = m[4 + c]; v[2] = m[8 + c];
  let s = PSVECMag(v);
  if (s > f32(1e-10)) s = f32(1 / s);
  if (k !== undefined) s = f32(s * k);
  m[c] = f32(v[0] * s); m[4 + c] = f32(v[1] * s); m[8 + c] = f32(v[2] * s);
}

/** joint `j`'s matrix against its parent's (HSD_MtxInverseConcat), or its own for the root, into `out` */
function local(model: CnsModel, j: number, out: Mtx): boolean {
  const w = model.world(j);
  if (!w) return false;
  mtxFromGL(w, out, 0);
  const p = model.parent(j);
  if (p < 0) return true;
  const pw = model.world(p);
  if (!pw) return false;
  mtxFromGL(pw, P, 0);
  HSD_MtxInverseConcat(P, out, out);
  return true;
}

/** HSD_RObjUpdateAll's position and orientation constraints on `m` (the tied joint's matrix as
 *  HSD_JObjMakeMatrix made it), the target joint `target` of `model`; false (m left alone) without its matrices */
export function resolvePositionOrientation(m: Mtx, model: CnsModel, target: number): boolean {
  const w = model.world(target);
  if (!w) return false;
  mtxFromGL(w, T, 0);
  // (the joint's own lengths, as its matrix had them before)
  for (let c = 0; c < 3; c++) mags[c] = HSD_MtxColMag(m, c);
  const parent = model.parent(target);
  if (!(model.flags(target) & JOBJ.CLASSICAL_SCALE) || parent < 0) {
    for (let c = 0; c < 3; c++) unitColumn(T, c, mags[c]);
    for (let c = 0; c < 3; c++) { m[c] = T[c]; m[4 + c] = T[4 + c]; m[8 + c] = T[8 + c]; }
  } else {
    if (!local(model, target, m1)) return false;
    for (let c = 0; c < 3; c++) unitColumn(m1, c, mags[c]);
    for (let j = parent; j >= 0; j = model.parent(j)) {
      if (!local(model, j, m0)) return false;
      for (let c = 0; c < 3; c++) unitColumn(m0, c);
      PSMTXConcat(m0, m1, m1);
    }
    for (let c = 0; c < 3; c++) { m[c] = m1[c]; m[4 + c] = m1[4 + c]; m[8 + c] = m1[8 + c]; }
  }
  // (the position: the target's place)
  m[3] = T[3]; m[7] = T[7]; m[11] = T[11];
  return true;
}

/** a posed fighter as a constraint's target model, by part (the game's parts: parts.ts): `world` its joints'
 *  matrices laid out by part (worldByPart), `parent` and `flags` its model's, by model joint */
export function fighterCnsModel(internalId: number, world: Float32Array, parent: ArrayLike<number>,
                                flags: ArrayLike<number>): CnsModel {
  const skips = partSkips(internalId);
  const sorted = [...skips].sort((a, b) => a - b);
  const toPart = (joint: number) => {
    let p = joint;
    for (const s of sorted) if (s <= p) p++;
    return p;
  };
  const joint = (part: number) => partToModelJoint(internalId, part, skips);
  return {
    world: (part) => {
      const j = joint(part);
      return j < 0 || (part + 1) * 16 > world.length ? null : world.subarray(part * 16, part * 16 + 16);
    },
    parent: (part) => {
      const j = joint(part);
      const p = j < 0 ? -1 : parent[j];
      return p === undefined || p < 0 ? -1 : toPart(p);
    },
    flags: (part) => {
      const j = joint(part);
      return j < 0 ? 0 : flags[j] ?? 0;
    },
  };
}

const FLT_MIN = f32(1.17549435e-38), HALF_PI = f32(Math.PI / 2);

/** lbRefract_80022DF8: 1 / sqrt(x) as the console makes it - frsqrte and three single-precision Newton steps */
function rsqrtSteps(x: number): number {
  if (!(x > 0)) return x ? NaN : Infinity;
  let g = frsqrte(x);
  for (let k = 0; k < 3; k++) g = f32(fmuls(0.5, g) * nmsub(fmuls(g, g), x, 3));
  return g;
}

/** the game's asinf: atanf(x / sqrt(1 - x * x)) */
function asinf(x: number): number {
  return atanf(f32(x * rsqrtSteps(nmsub(x, x, 1))));
}

/** HSD_MtxGetRotation's calcVal: atan2f, or a quarter turn when x is (next to) 0 */
function calcVal(x: number, y: number): number {
  if (Math.abs(x) <= FLT_MIN) return y >= 0 ? HALF_PI : -HALF_PI;
  return atan2f(y, x);
}

/** HSD_MtxGetRotation: the x, y, z turn of a matrix (its columns' lengths taken out) into `out` */
export function HSD_MtxGetRotation(m: Mtx, out: number[] | Float32Array): number[] | Float32Array {
  const len = (c: number) => sqrtf(f32(f32(f32(m[c] * m[c]) + f32(m[4 + c] * m[4 + c])) + f32(m[8 + c] * m[8 + c])));
  const l0 = len(0);
  if (!(l0 < FLT_MIN)) {
    const l1 = len(1);
    if (!(l1 < FLT_MIN)) {
      const l2 = len(2);
      if (!(l2 < FLT_MIN)) {
        const t = f32(f32(-m[8]) / l0);
        out[1] = t >= 1 ? HALF_PI : t <= -1 ? -HALF_PI : asinf(t);
        if (cosf(out[1]) >= FLT_MIN) {
          out[0] = calcVal(f32(m[10] / l2), f32(m[9] / l1));
          out[2] = calcVal(m[0], m[4]);
          return out;
        }
        out[0] = calcVal(m[5], m[1]);
        out[2] = 0;
        return out;
      }
    }
  }
  out[0] = out[1] = out[2] = 0;
  return out;
}

const L = new Float32Array(12), PW = new Float32Array(12);
/** the turn a tied joint is left with (JObjUpdateFunc's 0x37 after the constraints): HSD_MtxGetRotation of its matrix
 *  `world` against its parent's (`parent`, null for a root: the item's root has no parent in the game, its place being
 *  its own translate, which the turn does not see), both column-major 4 x 4s */
export function heldTurn(world: ArrayLike<number>, parent: ArrayLike<number> | null): Float32Array {
  mtxFromGL(world, L, 0);
  if (parent) {
    mtxFromGL(parent, PW, 0);
    HSD_MtxInverseConcat(PW, L, L);
  }
  return HSD_MtxGetRotation(L, new Float32Array(3)) as Float32Array;
}
