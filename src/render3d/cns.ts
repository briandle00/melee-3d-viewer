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
 * The matrix is left so (no update makes it again from the pose): the joints under it are made on it.
 * In float32 in the game's order (gxmath.ts).
 */
import { HSD_MtxColMag, HSD_MtxInverseConcat, PSMTXConcat, PSVECMag, f32, mtxFromGL, type Mtx } from "./gxmath";
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
