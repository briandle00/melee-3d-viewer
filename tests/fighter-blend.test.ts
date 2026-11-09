// A fighter's blend into a new animation as the game makes it (fighter.ts blendToward, lb_8000C490Turn; gxmath.ts
// EulerToQuat, HSD_QuatLib_8037EF28): float32 steps, each turn a quaternion the joint keeps, at the speed the frame
// stepped at. The parts the viewer track does not carry (a hand's fingers, a cape's hem) are posed so: the test marked
// withGameFiles reads your game files (tests/game-files.ts) and poses Marth into his walk as a public replay has it.

import test from "node:test";
import assert from "node:assert/strict";
import { blendStep } from "../src/render3d/fighter.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

const f32 = Math.fround;

test("a blend's step is rate / (rate + frames left), in float32, and whole once there (ftAnim_8006E9B4)", () => {
  assert.equal(blendStep(6, 6, 1), 1);
  assert.equal(blendStep(6, 7, 1), 1);
  assert.equal(blendStep(6, 1, 1), f32(1 / 6));
  const rate = f32(1.3299232721328735);
  assert.equal(blendStep(6, f32(4.329923), rate), f32(rate / f32(rate + f32(6 - f32(4.329923)))));
});

const MARTH = 18;
// (the replay's animation lines for Marth, port 1, as the simulator's track has them: [game frame, subaction, frame,
// rate, blend frames, how far in] - his landing at three times speed, then his walk, blended in over 6 frames from
// frame 1170, its speed set to 1.33 a frame into it)
const ANIMS: [number, number, number, number, number, number][] = [
  [1160, 36, 0, 3.009999990463257, 0, 0], [1161, 36, 3.009999990463257, 3.009999990463257, 0, 0],
  [1169, 36, 27.09000015258789, 3.009999990463257, 0, 0],
  [1170, 9, 1, 1, 6, 2], [1171, 9, 2, 1.3299232721328735, 6, 3],
];
// the game's joints at the end of game frame 1171 (its memory): quaternion x, y, z, w
const GAME_1171: Record<number, number[]> = {
  10: [2.5397878289368236e-07, 0, -0.16232916712760925, 0.9867367148399353],
  11: [0.3547913730144501, -0.5274688005447388, 0.4979354739189148, 0.5898815393447876],
  24: [-0.007558515761047602, 0, 0, 0.999971330165863],
};

test("game files: Marth's walk blended in from his landing turns his fingers and hips as the game does", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(MARTH, 0)!;
  const f = new Fighter(MARTH, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0,
                        motionTableFromDol(readGameFile("main.dol")), "test");
  const at = (g: number) => {
    let e = null;
    for (const a of ANIMS) if (a[0] <= g) e = a;
    if (!e || g > 1171) return null;
    return { since: e[0], anim: e[1], kind: MARTH, frame: e[2], rate: e[3], blendFrames: e[4], blendAt: e[5] };
  };
  f.pose({ actionStateId: 17, actionStateFrameCounter: 2, xPosition: 0, yPosition: 0, facingDirection: 1, transN: 1, root2: -1,
           game: { at, frame: 1171 } });
  const sk = f.skeleton;
  for (const [j, q] of Object.entries(GAME_1171)) {
    assert.equal(sk.quatOn[+j], 1, `joint ${j} turned by a quaternion`);
    const ours = Array.from(sk.quat.slice(+j * 4, +j * 4 + 4));
    // (within 3e-7: the animation's own values, sampled by hsd.ts, can be an ulp from the game's)
    ours.forEach((v, k) => assert.ok(Math.abs(v - q[k]) < 3e-7, `joint ${j}: ${ours} against the game's ${q}`));
  }
});
