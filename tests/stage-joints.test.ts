// A stage part's joints from the viewer track ("sp"): the track counts from
// the joint the game puts above the file's root, so its joint 1 is the
// part's joint 0; a value not sent, and a joint not sent, keep the viewer's
// own pose, and a part the track moves is no longer still.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { ViewerTrack } from "../src/render3d/track.ts";
import { layStageJoints } from "../src/render3d/gr/joints.ts";
import type { Part } from "../src/render3d/stage.ts";

function part(n: number): Part {
  const joints = Array.from({ length: n }, (_, i) => ({ rot: [i, 0, 0], scale: [1, 1, 1], trans: [0, i * 10, 0] }));
  const skeleton = { n, rot: new Float32Array(n * 3).fill(7), scale: new Float32Array(n * 3).fill(7),
                     trans: new Float32Array(n * 3).fill(7) };
  return { index: 4, skeleton, joints, still: true } as unknown as Part;
}

test("a stage part's joints by the track's count, a value not sent the viewer's own", () => {
  const t = new ViewerTrack({
    version: 2, decoded: true,
    events: [
      // part 4: the file's root (track joint 1) moves up; then its joint 2 (track 3) turns about z
      [5, "sp", 4, 1, 1 << 7, 25],
      [9, "sp", 4, 3, 1 << 2, 1.5],
      // the joint above the file's root (0) is the part's place, and one past the part's joints is left out
      [9, "sp", 4, 0, 1 << 6, 3, 9, 1 << 6, 3],
    ],
  });
  assert.equal(t.pose("sp", "4", 4), null);
  const p = part(3);
  layStageJoints(p, t.pose("sp", "4", 9)!.joints);
  const sk = p.skeleton;
  assert.deepEqual([...sk.trans.subarray(0, 3)], [7, 25, 7]);
  assert.deepEqual([...sk.rot.subarray(0, 3)], [7, 7, 7]);
  assert.deepEqual([...sk.scale.subarray(0, 3)], [7, 7, 7]);
  // (joint 1 was never sent: the viewer's own)
  assert.deepEqual([...sk.rot.subarray(3, 6)], [7, 7, 7]);
  assert.deepEqual([...sk.rot.subarray(6, 9)], [7, 7, 1.5]);
  assert.deepEqual([...sk.trans.subarray(6, 9)], [7, 7, 7]);
  assert.equal(p.still, false);
});
