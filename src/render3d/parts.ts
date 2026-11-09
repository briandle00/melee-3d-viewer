/* 3D replay viewer: the game's part numbers and the model's joints.
 *
 * The game numbers a fighter's joints as its parts (fp->parts): the model's
 * joints in tree order, except that a few fighters' part lists keep room for
 * joints their model does not have (PlCo.dat's table, ftParts_8007506C):
 * Kirby's for the extra joints of three of his copies' hats (Jigglypuff's,
 * Mewtwo's, Falco's), Link's and Young Link's for one of theirs. The game's
 * code, its move scripts and its data (hurtboxes, the joints items are held
 * by) name parts, so for those fighters a part number past a gap is a joint
 * further back in the model. The table is read with PlCo.dat (effects3d.ts).
 */

let SKIPS: Record<number, number[]> = {};

export function setPartSkips(table: Record<number, number[]>) {
  SKIPS = table;
}

/** the parts a fighter's model leaves out (internal id) */
export function partSkips(internalId: number): number[] {
  return SKIPS[internalId] ?? [];
}

/** the model's joint for a part, or -1 for one the model leaves out */
export function partToModelJoint(internalId: number, part: number, skips = partSkips(internalId)): number {
  if (!skips.length) return part;
  if (skips.includes(part)) return -1;
  let j = part;
  for (const s of skips) if (s < part) j--;
  return j;
}

/** the part whose world matrix a model joint's is in a by-part layout (worldByPart): the first part that maps to
 *  it, or -1 */
export function modelJointToPart(internalId: number, joint: number, parts: number, skips = partSkips(internalId)): number {
  for (let p = joint; p < parts; p++) if (partToModelJoint(internalId, p, skips) === joint) return p;
  return -1;
}

/** a posed model's joint matrices (16 floats each) laid out by part: a part
 *  the model leaves out takes its parent's place (the joint 0 when unknown) */
export function worldByPart(internalId: number, world: Float32Array): Float32Array {
  const skips = partSkips(internalId);
  if (!skips.length) return world.slice();
  const joints = world.length / 16, parts = joints + skips.length;
  const out = new Float32Array(parts * 16);
  for (let p = 0; p < parts; p++) {
    const j = partToModelJoint(internalId, p, skips);
    const from = j >= 0 && j < joints ? j : 0;
    for (let q = 0, o = p * 16, f = from * 16; q < 16; q++) out[o + q] = world[f + q];
  }
  return out;
}

/** A copy's move animated for Kirby wearing a hat with joints of its own
 *  (Jigglypuff's, Mewtwo's, Falco's) has tracks for those too, where his
 *  part list keeps room for them: Jigglypuff's 4 extra (parts 7-10), Falco's
 *  2 (15, 16), Mewtwo's 7 (28-34), going by PlCo.dat's table in its order.
 *  For each of such an animation's tracks: his model's joint it moves, or -1
 *  for one of the hat's own. Null when the animation has his model's count */
export function kirbyTrackJoints(tracks: number, modelJoints: number): number[] | null {
  const extra = tracks - modelJoints;
  if (extra <= 0) return null;
  const skips = partSkips(4);
  // (the copies' runs of room, in the table's order: the one this many long)
  const runs: number[][] = [];
  for (const s of skips) {
    const last = runs[runs.length - 1];
    if (last && s === last[last.length - 1] + 1) last.push(s); else runs.push([s]);
  }
  const mine = runs.find((r) => r.length === extra);
  if (!mine) return null;
  const out: number[] = [];
  for (let p = 0; out.length < tracks && p < tracks + skips.length; p++) {
    if (mine.includes(p)) out.push(-1);
    else if (!skips.includes(p)) out.push(partToModelJoint(4, p, skips));
  }
  return out.length === tracks ? out : null;
}
