// Yoshi's egg's colors follow his shield: his code holds the egg's materials' animation still (ftYs_Init_8012B6E8:
// rate 0) and sets it to its length times the share of the shield lost (ftYs_Init_8012B8A4) on each frame of his
// shield coming up and held and of his rolls in the egg, the egg darker as the shield goes; his egg roll sets it to
// 0 (ftYs_Init_8012B918). The player drew the file's colors: in bot-pichu_yoshi 1394 and 1484 the egg 26 to 29 of
// 255 off.
//
//   deno test --no-check --sloppy-imports -A tests/   (the second test needs MELEE_ASSETS)

import test from "node:test";
import assert from "node:assert/strict";
import { eggShields } from "../src/render3d/yoshiroll.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

const YS = 14;
const st = (actionStateId: number, shieldSize: number, internalCharacterId = YS) => ({ internalCharacterId, actionStateId, shieldSize });

test("the shield on the last frame his code set the egg's colors", () => {
  assert.deepEqual(eggShields([
    st(14, 60),        // waiting: nothing set yet
    st(341, 59.5),     // GuardOn
    st(342, 59),       // GuardHold
    st(343, 58),       // GuardOff: kept
    undefined,
    st(14, 60),
    st(233, 40),       // a roll in the egg
    st(357, 12),       // his egg roll: the full shield's
    st(14, 30, 2),     // (another fighter's frame)
  ]), [null, 59.5, 59, 59, 59, 59, 40, 60, 60]);
});

test("game files: the egg's diffuse at bot-pichu_yoshi 1394's shield", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(YS, 0)!;
  const f = new Fighter(YS, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0,
                        motionTableFromDol(readGameFile("main.dol")), "test");
  const egg = f.skeleton.states[35];
  const bytes = (c: ArrayLike<number>) => [0, 1, 2].map((k) => Math.round(c[k] * 255));
  assert.deepEqual(bytes(egg.diffuse), [255, 255, 255]);
  // (the game's: its TEV's konst color 236, 231, 231 - 53.56 of 60 left, frame 10.73 of 100)
  f.eggShade(53.560028076171875);
  assert.deepEqual(bytes(egg.diffuse), [236, 231, 231]);
  assert.deepEqual(bytes(f.skeleton.states[34].diffuse), [236, 231, 231]);
  f.eggShade(null);
  assert.deepEqual(bytes(egg.diffuse), [255, 255, 255]);
});
