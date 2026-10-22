// A stage animation's scale nearer 0 than 1e-3 is set as 1e-3
// (JObjUpdateFunc's HSD_A_J_SCAX..Z): Fountain of Dreams' shrunk joints keep
// a matrix 0.001 wide, not 0.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton } from "../src/render3d/skeleton.ts";
import type { AObj } from "../src/render3d/hsd.ts";

test("an animated scale under 1e-3 is 1e-3", () => {
  const sk = Object.create(Skeleton.prototype);
  Object.assign(sk, { n: 1, joints: [{ index: 0, offset: 0 }], rot: new Float32Array(3), scale: new Float32Array(3).fill(1),
                      trans: new Float32Array(3) });
  const k = (v: number) => [{ time: 0, duration: 0, kind: 0 as const, p0: v, p1: v, d0: 0, d1: 0 }];
  const ao: AObj = { tracks: [{ type: 8, keys: k(0) }, { type: 9, keys: k(-0.0005) }, { type: 10, keys: k(0.5) }], end: 1, loop: false,
                     obj: null };
  sk.applyAObjs([ao], 0, false);
  assert.deepEqual([...sk.scale], [Math.fround(1e-3), Math.fround(1e-3), 0.5]);
});
