// An item held by a fighter's joint (cns.ts resolvePositionOrientation: lb_8000C2F8's position and orientation
// constraints, HSD's resolveCnsOrientation): the tied joint takes the target's place, and its turn - for a fighter's
// joint (JOBJ_CLASSICAL_SCALE, with a parent) the turns of the joints on the way with no scale in them - each axis as
// long as the tied joint's own was.
//
//   deno test --no-check --sloppy-imports tests/held-constraint.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { type CnsModel, fighterCnsModel, resolvePositionOrientation } from "../src/render3d/cns.ts";
import { HSD_MtxSRT, PSMTXConcat, mtxToGL } from "../src/render3d/gxmath.ts";
import { JOBJ } from "../src/render3d/hsd.ts";
import { setPartSkips } from "../src/render3d/parts.ts";

const f = Math.fround;

// a chain of three joints: a root (turned, sized 1.1), a joint sized unevenly (as ftData's scales do), and the target
const SRT = [
  { s: [1.1, 1.1, 1.1], r: [0, 1.3, 0], t: [10, 5, 0] },
  { s: [1, 1.7, 0.6], r: [0.4, -0.2, 0.9], t: [0, 3, 0] },
  { s: [1, 1, 1], r: [-0.7, 0.5, 1.2], t: [0.5, 2, -1] },
];
function chain(flags: number): { model: CnsModel; worlds: Float32Array[]; locals: Float32Array[] } {
  const worlds: Float32Array[] = [], locals: Float32Array[] = [];
  let parent: Float32Array | null = null;
  for (const j of SRT) {
    const L = HSD_MtxSRT(new Float32Array(12), j.s.map(f), j.r.map(f), j.t.map(f), null);
    locals.push(L);
    const W = parent ? PSMTXConcat(parent, L, new Float32Array(12)) : L.slice();
    worlds.push(W);
    parent = W;
  }
  const gl = worlds.map((w) => mtxToGL(w, new Float32Array(16)));
  return { worlds, locals, model: { world: (j) => gl[j] ?? null, parent: (j) => j - 1, flags: () => flags } };
}
const col = (m: Float32Array, c: number) => [m[c], m[4 + c], m[8 + c]];
const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: number[]) => v.map((x) => x / len(v));
/** in doubles: a 3 x 3's product */
function mul3(a: number[][], b: number[][]): number[][] {
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c]));
}
const rows = (cols: number[][]) => [0, 1, 2].map((r) => cols.map((c) => c[r]));

test("a fighter's joint: the turns on the way, no scale, each axis the tied joint's own length", () => {
  const { model, worlds, locals } = chain(JOBJ.SKELETON | JOBJ.CLASSICAL_SCALE);
  // (the tied joint's matrix as made: an item at 0.85 of its size, unturned)
  const m = new Float32Array([0.85, 0, 0, 1, 0, 0.85, 0, 2, 0, 0, 0.85, 3]);
  assert.ok(resolvePositionOrientation(m, model, 2));
  // the place is the target's, exactly
  assert.deepEqual([m[3], m[7], m[11]], [worlds[2][3], worlds[2][7], worlds[2][11]]);
  // the turn: each joint's local matrix with unit columns, multiplied root first
  let R = rows([0, 1, 2].map((c) => unit(col(locals[0], c))));
  for (const L of locals.slice(1)) R = mul3(R, rows([0, 1, 2].map((c) => unit(col(L, c)))));
  for (let c = 0; c < 3; c++) {
    const got = col(m, c);
    assert.ok(Math.abs(len(got) - 0.85) < 1e-5, `axis ${c} length ${len(got)}`);
    for (let r = 0; r < 3; r++) assert.ok(Math.abs(got[r] - R[r][c] * 0.85) < 1e-5, `axis ${c} row ${r}: ${got[r]} vs ${R[r][c] * 0.85}`);
  }
  // (not the world matrix's columns made unit ones: the uneven scale on the way skews those)
  const worldTurn = unit(col(worlds[2], 0)).map((x) => x * 0.85);
  assert.ok(Math.max(...col(m, 0).map((x, r) => Math.abs(x - worldTurn[r]))) > 0.01);
});

test("a target without classical scale: its world matrix's columns, unit ones times the tied joint's lengths", () => {
  const { model, worlds } = chain(JOBJ.SKELETON);
  const m = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0]);
  assert.ok(resolvePositionOrientation(m, model, 2));
  [2, 3, 4].forEach((k, c) => {
    const want = unit(col(worlds[2], c));
    col(m, c).forEach((x, r) => assert.ok(Math.abs(x - want[r] * k) < 1e-5));
  });
  assert.deepEqual([m[3], m[7], m[11]], [worlds[2][3], worlds[2][7], worlds[2][11]]);
});

test("a target the model does not have leaves the matrix alone", () => {
  const { model } = chain(JOBJ.CLASSICAL_SCALE);
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const before = m.slice();
  assert.equal(resolvePositionOrientation(m, model, 7), false);
  assert.deepEqual(m, before);
});

test("a fighter's parts with a gap in its part list (Kirby's hats) map to its model's joints and back", () => {
  // (part 1 is room the model leaves out: parts 0, 2, 3 are its joints 0, 1, 2)
  setPartSkips({ 99: [1] });
  try {
    const world = new Float32Array(4 * 16);
    for (let p = 0; p < 4; p++) world.set(mtxToGL(new Float32Array([1, 0, 0, p, 0, 1, 0, 0, 0, 0, 1, 0]), new Float32Array(16)), p * 16);
    const m = fighterCnsModel(99, world, [-1, 0, 1], [0, JOBJ.SKELETON, JOBJ.CLASSICAL_SCALE]);
    assert.equal(m.parent(3), 2);
    assert.equal(m.parent(2), 0);
    assert.equal(m.parent(0), -1);
    assert.equal(m.flags(3), JOBJ.CLASSICAL_SCALE);
    assert.equal(m.flags(2), JOBJ.SKELETON);
    assert.equal(m.world(3)![12], 3);
    assert.equal(m.world(1), null);
    assert.equal(m.world(4), null);
  } finally {
    setPartSkips({});
  }
});
