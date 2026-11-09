// A pose made only for its joints (the effects' world stepping through frames nothing draws: Viewer3D actorsAt's
// jointsOnly) gets the joints' world matrices a full update makes, and leaves the envelopes' and the drawables'
// matrices; the next update that draws makes them all, the same to the bit as if every update had been full - also
// when that pose is the joints-only one's (the matrices it skipped are made then, not taken as unchanged).
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { readGameFile, withGameFiles } from "./game-files.ts";

const LINK = 6;

test("game files: a joints-only update makes the same joints, and the next full one the same matrices", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(LINK, 0)!;
  const dol = motionTableFromDol(readGameFile("main.dol"));
  const make = () => new Fighter(LINK, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, dol, "test");
  const state = (action: number, counter: number, x: number) =>
    ({ actionStateId: action, actionStateFrameCounter: counter, xPosition: x, yPosition: 3, facingDirection: 1, transN: 1, root2: -1 });
  // (everything an update makes: the joints, the envelopes' joints, each drawable's matrices)
  // deno-lint-ignore no-explicit-any
  const made = (f: any) => ({ world: Array.from(f.skeleton.world as Float32Array), skin: Array.from(f.skeleton.skin as Float32Array),
                              mats: (f.skeleton.drawables as { mats: Float32Array }[]).map((d) => Array.from(d.mats)) });
  const a = state(14, 10, 0), b = state(20, 7, 12);

  const full = make();
  full.pose(b);
  const fullB = made(full);
  full.pose(a);
  const fullA = made(full);
  assert.notDeepEqual(fullA.world, fullB.world);

  const f = make();
  f.pose(a);
  assert.deepEqual(made(f), fullA);
  // (joints only: b's joints, a's envelopes and drawables left as they were)
  f.skeleton.jointsOnly = true;
  f.pose(b);
  f.skeleton.jointsOnly = false;
  const jo = made(f);
  assert.deepEqual(jo.world, fullB.world);
  assert.deepEqual(jo.skin, fullA.skin);
  // (drawn again at a: all of it a's)
  f.pose(a);
  assert.deepEqual(made(f), fullA);
  // (joints only at b, then drawn at b - the same pose: made, not kept as unchanged)
  f.skeleton.jointsOnly = true;
  f.pose(b);
  f.skeleton.jointsOnly = false;
  f.pose(b);
  assert.deepEqual(made(f), fullB);
  // (and a joints-only update of the pose already made changes nothing)
  f.skeleton.jointsOnly = true;
  f.pose(b);
  f.skeleton.jointsOnly = false;
  assert.deepEqual(made(f), fullB);
});
