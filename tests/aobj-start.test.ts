// A stage, item or effect animation's track whose first key comes later than
// the animation's frame 0 (its FObj's start frame below 0) writes nothing
// until then: HSD_FObjInterpretAnim returns while the FObj's time is below 0,
// so the joint keeps its rest value - a joint hidden at rest stays hidden
// until its branch key (Donkey Kong's Giant Punch, EfDkData model 2).
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton } from "../src/render3d/skeleton.ts";
import type { AObj } from "../src/render3d/hsd.ts";

test("a branch track whose first key is at 19 leaves its joint hidden before then", () => {
  const sk = Object.create(Skeleton.prototype);
  Object.assign(sk, { n: 2, joints: [{ index: 0, offset: 0 }, { index: 1, offset: 1 }], rot: new Float32Array(6),
                      scale: new Float32Array(6).fill(1), trans: new Float32Array(6), shown: new Uint8Array(2),
                      subEnd: new Int32Array([2, 2]) });
  const branch: AObj = { tracks: [{ type: 12, keys: [{ time: 19, duration: 21, kind: 0, p0: 1, p1: 1, d0: 0, d1: 0 },
                                                    { time: 40, duration: 5, kind: 0, p0: 0, p1: 0, d0: 0, d1: 0 }] }],
                         end: 45, loop: false, obj: null };
  const at = (t: number) => { sk.shown.fill(0); sk.applyAObjs([null, branch], t, false); return sk.shown[1]; };
  assert.deepEqual([0, 18, 19, 39, 40].map(at), [0, 0, 1, 1, 0]);
});
