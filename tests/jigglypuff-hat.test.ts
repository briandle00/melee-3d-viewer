// Jigglypuff's costume hats have model parts of their own: ftPr_Init_8013C360 lays her articles list's second
// entry's parts lookups on the hat (ftParts_8007487C hides every lookup's meshes) and her draw shows all of lookup
// 0's (ftDrawCommon_80080E18 -> ftPr_Init_UnkIntBoolFunc0 -> ftParts_80074CA0), her low-detail draw (a stage's
// mirror, the magnifier: ftDrawCommon_80080C28) lookup 1's. The player drew every mesh of the hat: in
// diamond-platinum-682b9c84 13067 the blue bow's low-detail meshes 0 to 9 and the flower's 2 and 3 over the game's.
//
//   MELEE_ASSETS=<folder> deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { readGameFile, withGameFiles } from "./game-files.ts";

const PURIN = 15;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

test("game files: each costume's hat shows its lookup 0, its low-detail draw lookup 1", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const hat = (costume: number) => {
    const files = fighterFiles(PURIN, costume)!;
    const f = new Fighter(PURIN, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), costume, motion, "test");
    return f.hat;
  };
  assert.equal(hat(0), null);
  // (the flower: 0 and 1, low 2 and 3)
  const red = hat(1)!;
  assert.deepEqual([...red.hidden].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...red.lowHidden].sort((a, b) => a - b), [0, 1]);
  assert.deepEqual([...red.prop.skeleton.hidden].sort((a, b) => a - b), [2, 3]);
  // (the bow: 10 to 14, low 0 to 4, metal 5 to 9)
  const blue = hat(2)!;
  assert.deepEqual([...blue.hidden].sort((a, b) => a - b), range(0, 10));
  assert.deepEqual([...blue.lowHidden].sort((a, b) => a - b), range(5, 15));
});
