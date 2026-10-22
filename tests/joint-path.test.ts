// A joint on a PATH track (Yoshi's Story's Randall) stands at the spline's
// point: JObjUpdateFunc's HSD_A_J_PATH sets the translate to
// splArcLengthPoint's point as it is, and HSD_JObjMakeMatrix then carries it
// through the spline joint's matrix (turned half round and moved, a sibling)
// into the joint's matrix's translation.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton } from "../src/render3d/skeleton.ts";
import type { AObj, Archive, JObj, Spline } from "../src/render3d/hsd.ts";

test("a PATH track's point is the joint's translate, not carried through the spline joint", () => {
  // straight segments (0, 0, 0) -> (10, 0, 0) -> (10, 20, 0), a third and two thirds of the length
  const spline: Spline = { type: 0, n: 3, tension: 0, cv: new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]), total: 30,
                           seg: new Float32Array([0, 1 / 3, 1]), poly: new Float32Array(0) };
  // joint 0 the root, joint 1 the spline (turned half round about z, moved), joint 2 on the path
  const sk = Object.create(Skeleton.prototype);
  Object.assign(sk, {
    n: 3, parent: [-1, 0, 0],
    joints: [{ index: 0, offset: 100 }, { index: 1, offset: 200, spline }, { index: 2, offset: 300 }],
    rot: new Float32Array([0, 0, 0, 0, 0, Math.PI, 0, 0, 0]), scale: new Float32Array(9).fill(1),
    trans: new Float32Array([0, 0, 0, 37, -50, 0, 0, 0, 0]),
  });
  const path: AObj = { tracks: [{ type: 4, keys: [{ time: 0, duration: 10, kind: 1, p0: 0, p1: 1, d0: 0, d1: 0 }] }],
                       end: 10, loop: false, obj: 200 };
  sk.applyAObjs([null, null, path], 5, false);
  const t = [...sk.trans.subarray(6, 9)];
  assert.ok(Math.abs(t[0] - 10) < 1e-4 && Math.abs(t[1] - 5) < 1e-4 && t[2] === 0, `${t}`);
});

test("a PATH joint's matrix has its translate carried through the spline joint's matrix, its turn its own", () => {
  // (HSD_JObjMakeMatrix: MTXMultVec(spline joint's mtx, translate) into the matrix's translation column)
  const spline: Spline = { type: 0, n: 3, tension: 0, cv: new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]), total: 30,
                           seg: new Float32Array([0, 1 / 3, 1]), poly: new Float32Array(0) };
  const joint = (index: number, parent: number, offset: number, rot: [number, number, number],
                 trans: [number, number, number], s?: Spline): JObj =>
    ({ offset, index, parent, flags: 0, rot, scale: [1, 1, 1], trans, invBind: null, children: [], dobjs: [], spline: s });
  // joint 0 the root (moved up 100), joint 1 on the path, joint 2 its child (1 to the right),
  // joint 3 the spline (turned half round about z, moved), after them as Randall's is
  const joints = [
    joint(0, -1, 100, [0, 0, 0], [0, 100, 0]),
    joint(1, 0, 200, [0, 0, 0], [0, 0, 0]),
    joint(2, 1, 300, [0, 0, 0], [1, 0, 0]),
    joint(3, 0, 400, [0, 0, Math.PI], [37, -50, 0], spline),
  ];
  const sk = new Skeleton(null as unknown as Archive, joints, [], "path");
  const path: AObj = { tracks: [{ type: 4, keys: [{ time: 0, duration: 10, kind: 1, p0: 0, p1: 1, d0: 0, d1: 0 }] }],
                       end: 10, loop: false, obj: 400 };
  sk.applyAObjs([null, path], 5, false);
  sk.update();
  const W = sk.world;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  // the point (10, 5) through the spline joint: (37 - 10, -50 - 5) under the root's (0, 100)
  assert.ok(near(W[16 + 12], 27) && near(W[16 + 13], 45) && near(W[16 + 14], 0), `${W.subarray(28, 31)}`);
  // not turned: its own (and its parent's) turn
  assert.ok(near(W[16], 1) && near(W[16 + 5], 1), `${W.subarray(16, 32)}`);
  // its child made on it
  assert.ok(near(W[32 + 12], 28) && near(W[32 + 13], 45), `${W.subarray(44, 47)}`);
});
