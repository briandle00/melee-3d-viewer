// A joint's shown or hidden is its JObj's flag, which only a NODE or BRANCH track (or the code) sets: a move whose
// animation has no such track for it leaves it as the animation before left it (Fighter_ChangeMotionState lays the
// new animation on with HSD_JObjAddAnimAll; nothing lays the file's flags back). Donkey Kong's joint 48 (meshes 35
// and 36): his wait hides it with a branch track, his headbutt (SpecialS) shows it, and his hand slap's loop and
// the throws he is thrown in have none. The player laid the file's flags (shown) for those: in bot-dk_bowser 1765
// and bot-tp_dk_bowser's throws it drew the two meshes the game had hidden.
//
//   MELEE_ASSETS=<folder> deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { readGameFile, withGameFiles } from "./game-files.ts";

const DK = 3, WAIT = 2, SPECIAL_S = 329, SPECIAL_LW_LOOP = 334, J48 = 48;

test("game files: Donkey Kong's joint 48 stays as the last animation with its track left it", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(DK, 0)!;
  const f = new Fighter(DK, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0,
                        motionTableFromDol(readGameFile("main.dol")), "test");
  // (twenty-five frames of one subaction, then the hand slap's loop; the headbutt shows the joint from its frame 19)
  const shownAt = (before: number, frame: number) => {
    const at = (fr: number) => fr < 0 ? null : fr < 25
      ? { since: 0, anim: before, kind: DK, frame: fr, rate: 1, blendFrames: 0, blendAt: 0 }
      : { since: 25, anim: SPECIAL_LW_LOOP, kind: DK, frame: fr - 25, rate: 1, blendFrames: 0, blendAt: 0 };
    f.pose({ actionStateId: 14, actionStateFrameCounter: 0, xPosition: 0, yPosition: 0, facingDirection: 1,
             game: { at, frame } });
    return f.skeleton.shown[J48];
  };
  assert.equal(shownAt(WAIT, 22), 0);
  assert.equal(shownAt(SPECIAL_S, 22), 1);
  // (the loop has no track for it: the wait's hidden, the headbutt's shown, carried on)
  assert.equal(shownAt(WAIT, 30), 0);
  assert.equal(shownAt(SPECIAL_S, 30), 1);
});
