// An effect model whose dispatch sets its root's scale (efLib_Create_Attach_Scale: HSD_JObjSetScale on the root,
// the fighter's root scale y on all three axes) has that scale in place of the file's rest scale of the root, not
// times it (prop.ts rootScaleSet). Bowser's Whirling Fortress (efsync.c 0x4DA: EfKpData models 1 and 2), whose
// model 1's root rests at 1.25, 1, 1.25, is drawn at his 0.69 all round. The test marked withGameFiles reads your
// game files (tests/game-files.ts).
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { effectBanks, withGameFiles } from "./game-files.ts";

const KOOPA = 12;

test("game files: a root whose scale the dispatch set takes that scale, not times its own", withGameFiles, () => {
  const bank = effectBanks([KOOPA]).get(KOOPA)!;
  const pr = bank.prop(1, 0, true)!;
  const col = (m: Float32Array, c: number) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
  const s = Math.fround(0.69);
  pr.rootScaleSet = true;
  pr.pose(10, 34, 0, 0, s, 0, false, 0, 0, true);
  pr.rootScaleSet = false;
  const w = pr.skeleton.world;
  assert.ok(Math.abs(col(w, 0) - s) < 1e-6, `root x scale ${col(w, 0)}`);
  assert.ok(Math.abs(col(w, 1) - s) < 1e-6);
  assert.ok(Math.abs(col(w, 2) - s) < 1e-6);
  // (without it, the file's own scale of the root under the place's: what a dispatch that leaves it gives)
  pr.pose(10, 34, 0, 0, 1, 0, false, 0, 0, true);
  assert.ok(Math.abs(col(pr.skeleton.world, 0) - 1.25) < 1e-6);
  assert.ok(Math.abs(col(pr.skeleton.world, 1) - 1) < 1e-6);
});
