// The HUD's timing (hudlogic.ts PlayerHud): the damage the HUD shows at a frame is the replay's percent of that
// frame - its color, its digits and the shake start with the frame whose percent has the hit; a launch's tag counts
// from that frame, held while the hitlag lasts.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { PlayerHud, percentColor } from "../src/render3d/hudlogic.ts";
import type { ReplayData } from "../src/common/types.ts";

/** a replay of one player standing (Wait) at a percent a frame */
function replay(percents: number[]): ReplayData {
  const frames = percents.map((percent, i) => ({
    players: [{ playerIndex: 0, state: { frameNumber: i - 123, actionStateId: 14, stocksRemaining: 4, percent,
                                         attackBasedXSpeed: 0, attackBasedYSpeed: 0 } }],
  }));
  return { frames, settings: { playerSettings: [{ startStocks: 4 }] } } as unknown as ReplayData;
}

test("a hit shows with the frame whose replay percent has it, not the frame before", () => {
  const pct = [...Array(20).fill(0), ...Array(20).fill(12)];
  const h = new PlayerHud(replay(pct), 0);
  assert.deepEqual(h.percentAt(19).color, percentColor(0));
  assert.deepEqual(h.percentAt(20).color, percentColor(12));
  // (the shake: from the hit's frame, nine frames)
  assert.equal(h.shakingAt(19), false);
  assert.equal(h.shakingAt(20), true);
  assert.equal(h.shakingAt(28), true);
  assert.equal(h.shakingAt(29), false);
  // (the digits' pictures a frame after: the tens digit's shown at once, its picture the 1 a frame on)
  assert.equal(h.percentAt(20).layout.shown[1], true);
  assert.equal(h.percentAt(20).layout.frame[1], 0);
  assert.equal(h.percentAt(21).layout.frame[1], 2);
});

test("a launch's tag: its count from the hit's frame, held through the hitlag", () => {
  const states = (hitlag: number[]) => {
    const data = replay(Array(30).fill(0));
    data.frames.forEach((f, i) => {
      const s = f.players[0]!.state as unknown as Record<string, number>;
      if (i >= 10) { s.actionStateId = 88; s.attackBasedXSpeed = 5; }
      s.hitlagRemaining = hitlag[i - 10] ?? 0;
    });
    return new PlayerHud(data, 0, { idle: 50, launch: 4, launchSpeed: 3 }, -200);
  };
  const first = (h: PlayerHud) => h.tag.findIndex((t, i) => i >= 10 && t === 1);
  assert.equal(first(states([])), 13);
  assert.equal(first(states([5, 4, 3, 2, 1])), 17);
});

test("Kirby's spat-out star shows its fighter's tag at once", () => {
  const data = replay(Array(30).fill(0));
  data.frames.forEach((f, i) => {
    const s = f.players[0]!.state as unknown as Record<string, number>;
    s.actionStateId = i < 10 ? 35 : 291;
  });
  const h = new PlayerHud(data, 0, { idle: 50, launch: 4, launchSpeed: 3 }, -200);
  assert.equal(h.tag[9], 0);
  assert.equal(h.tag[10], 1);
});

/** one player through these states (one a frame, from frame 0), launched hard at the DamageFly ones */
function through(seq: [number, number][], kind = 2): PlayerHud {
  const ids = seq.flatMap(([s, n]) => Array(n).fill(s) as number[]);
  const data = replay(Array(ids.length).fill(0));
  data.frames.forEach((f, i) => {
    const s = f.players[0]!.state as unknown as Record<string, number>;
    s.actionStateId = ids[i];
    s.internalCharacterId = kind;
    if (ids[i] >= 87 && ids[i] <= 91) s.attackBasedXSpeed = 5;
  });
  return new PlayerHud(data, 0, { idle: 50, launch: 4, launchSpeed: 3 }, -200);
}

test("a launch's tag stays through DamageFall and an aerial jump (Ft_MF_SkipNametagVis), not through a special", () => {
  // DamageFlyN 10 frames, DamageFall (ftCo_80090780: flags 0x18001), JumpAerialF (ftCo_800CBAC4)
  const h = through([[14, 5], [88, 10], [38, 10], [27, 5]]);
  assert.equal(h.tag[8], 1);
  assert.equal(h.tag[16], 1);
  assert.equal(h.tag[27], 1);
  // (a fighter's own special clears it: Fighter_ChangeMotionState with no flags)
  const g = through([[14, 5], [88, 10], [38, 5], [374, 5]], 24);
  assert.equal(g.tag[19], 1);
  assert.equal(g.tag[20], 0);
  // Jigglypuff's own aerial jumps keep it too (ftCo_800D74A4), another fighter's state of that number does not
  assert.equal(through([[14, 5], [88, 10], [38, 5], [342, 5]], 15).tag[22], 1);
  assert.equal(through([[14, 5], [88, 10], [38, 5], [342, 5]], 2).tag[22], 0);
});

test("crouching counts the tag up from Squat; SquatWait after Squat keeps the count, after a landing sets it", () => {
  // Squat 6 frames then SquatWait: the count runs from Squat's first frame (ftCo_Squat_Enter)
  const h = through([[20, 5], [39, 6], [40, 60]]);
  assert.equal(h.tag[5 + 48], 0);
  assert.equal(h.tag[5 + 49], 1);
  // SquatWait from a landing (ftCo_SquatWait_CheckInput -> fn_800D62C4): the count from SquatWait's start
  const l = through([[20, 5], [42, 6], [40, 60]]);
  assert.equal(l.tag[11 + 48], 0);
  assert.equal(l.tag[11 + 49], 1);
});

test("after a shake that ends once the digits' animation has, they stand at their stored places", async () => {
  const { digitRest } = await import("../src/render3d/hudlogic.ts");
  // (ifStatus_802F4EDC stores the digits' places while lb_8000B09C says the animation runs - its last frame 29 of
  // 30 - and ifStatus_802F4B84 puts them back there as its shake ends)
  assert.equal(digitRest(100, null, 30), false);          // no hit: where the animation left them
  assert.equal(digitRest(25, 20, 30), false);             // shaking while it runs: on its own frame's places
  assert.equal(digitRest(29, 15, 30), false);             // a shake over before it ends (15 + 9 = 24): its end's places
  assert.equal(digitRest(40, 15, 30), false);
  assert.equal(digitRest(31, 25, 30), true);              // a shake still going as it ends: the stored places
  assert.equal(digitRest(34, 25, 30), true);              // put back there (25 + 9)
  assert.equal(digitRest(500, 25, 30), true);             // and there they stay
  assert.equal(digitRest(500, 400, 30), true);
});

test("a KO's scatter flies each digit from where its joint stood, in float32, as ifStatus_PercentOnDeathAnimationThink", async () => {
  const { scatterFrom, scatterSpeed } = await import("../src/render3d/hudlogic.ts");
  const f = Math.fround;
  const [vx, vy] = scatterSpeed(1, 0, 0, [0, 0, 0.25, 0.5]);
  // (foo: the second piece goes left; 0.811f * r + 1.2165f fused)
  assert.equal(vx, -f(f(0.6083) * f(0.25) + f(0.3041)));
  assert.equal(vy, f(f(0.811) * 0.5 + f(1.2165)));
  // the joint's own translation is added to, a frame at a time, rounded each time
  const [x, y] = scatterFrom(-18.75, 2.2507486, 3, [vx, vy]);
  let ex = f(-18.75), ey = f(2.2507486), evy = vy;
  for (let k = 0; k < 3; k++) { ex = f(ex + vx); ey = f(ey + evy); evy = f(evy - f(0.2028)); }
  assert.deepEqual([x, y], [ex, ey]);
  // (across, it stops once the joint is 100 out, wherever it began)
  assert.equal(scatterFrom(99.9, 0, 5, [1, 0])[0], f(f(99.9) + 1));
});

// ---------------------------------------------------------------- the percent's pieces, in float32 (ifstatus.c)

import { digitLayout, scatterFrom, scatterSpeed, shakeOffset } from "../src/render3d/hudlogic.ts";
import { madd } from "../src/render3d/gxmath.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

const f = Math.fround;

test("the shake's step: mag x (2 x (HSD_Randf - 0.5)), then 0.2028 away from 0, each a float32 op (ifStatus_802F4B84)", () => {
  const draws = [0.25, 0.75, 0.5, 0.0078125, 0.99998474, 0.123, 0.4999, 0.6];
  for (const damage of [0, 1, 7, 15, 40, 255]) {
    let mag = f(f(0.1014) * damage);
    if (mag < f(0.1014)) mag = f(0.1014);
    else if (mag > f(1.5207)) mag = f(1.5207);
    for (let p = 0; p < 4; p++) {
      const step = (r: number) => { const v = f(mag * f(2 * f(f(r) - 0.5))); return v < 0 ? f(v - f(0.2028)) : f(v + f(0.2028)); };
      assert.deepEqual(shakeOffset(5, 3, damage, p, 0, draws), [step(draws[2 * p]), step(draws[2 * p + 1])]);
    }
  }
  // (an r of 0.5 is a step of +0.2028, the float32 0.2028)
  assert.deepEqual(shakeOffset(0, 0, 9, 1, 0, draws)![0], f(0.2028));
});

test("the narrow 1's spacing in float32 and the game's order (ifStatus_802F4EDC)", () => {
  const g = f(0.5069);
  assert.deepEqual(digitLayout(111).dx, [f(f(g + g) + f(g + g)), f(g + g), 0, -g]);
  assert.deepEqual(digitLayout(11).dx, [f(f(g + g) + g), f(g + g), 0, -g]);
  assert.deepEqual(digitLayout(10).dx, [f(g + g), g, 0, -0]);
  assert.deepEqual(digitLayout(1).dx, [g, g, 0, -g]);
});

test("a KO's scatter speeds: 0.6083 x r, then + 0.3041 (not fused), right and left in turn; 0.811 x r + 1.2165 fused", () => {
  // (r = 357/65536: the fused and the unfused sideways speed differ in their last bit - main.dol has fmuls, fadds)
  const draws = [357 / 65536, 0.9, 466 / 65536, 0.2, 0.7, 0.5, 486 / 65536, 0.95].map(f);
  for (let p = 0; p < 4; p++) {
    const a = f(f(0.6083) * draws[2 * p]);
    const vx = p % 2 === 0 ? f(a + f(0.3041)) : f(-a - f(0.3041));
    assert.deepEqual(scatterSpeed(p, 0, 100, draws), [vx, madd(f(0.811), draws[2 * p + 1], f(1.2165))]);
  }
  assert.notEqual(scatterSpeed(0, 0, 100, draws)[0], madd(f(0.6083), draws[0], f(0.3041)));
  // (it moves across while its own x is within 100, up while its own y is above -100, its up speed falling then)
  const [vx, vy] = scatterSpeed(0, 0, 100, draws);
  let x = f(-4.68), y = f(2.25), v = vy;
  for (let k = 0; k < 3; k++) { x = f(x + vx); y = f(y + v); v = f(v - f(0.2028)); }
  assert.deepEqual(scatterFrom(f(-4.68), f(2.25), 3, [vx, vy]), [x, y]);
  assert.deepEqual(scatterFrom(f(99.9), f(-100), 2, [f(0.5), f(1)]), [f(f(99.9) + f(0.5)), f(-100)]);
});

test("the shake's frames on the animation's clock: from the hit's frame, put back on its tenth", () => {
  const pct = [...Array(60).fill(0), ...Array(40).fill(12)];
  const h = new PlayerHud(replay(pct), 0);
  assert.equal(h.percentAt(59).hitAnimFrame, null);
  assert.equal(h.percentAt(60).hitAnimFrame, 60);
  assert.equal(h.percentAt(90).hitAnimFrame, 60);
  assert.equal(h.percentAt(68).spaced, false);
  assert.equal(h.percentAt(69).spaced, false);
  assert.deepEqual(h.percentAt(69).offset[0], [0, 0]);
  assert.equal(h.percentAt(70).spaced, true);
});

test("game files: after the entry, a shake leaves the ones digit at the entry's frame 29, not its last key", withGameFiles, async () => {
  const { HudKit, posePercent } = await import("../src/render3d/hud.ts");
  const kit = new HudKit(readGameFile("IfAll.dat"));
  // deno-lint-ignore no-explicit-any
  const m = (kit as any).model(kit.num, "hud:num");
  assert.equal(m.animLength(0), 30);
  // (no hit since the entry: the entry's last frame, 2.25; a hit at 40, put back at 49: frame 29's 2.2507486)
  const h = new PlayerHud(replay([...Array(40).fill(0), ...Array(60).fill(3)]), 0);
  const ones = () => m.trans(3) as number[];
  posePercent(m, h.percentAt(35));
  assert.equal(ones()[1], 2.25);
  const at29 = (() => { m.begin(); m.anim(0, 29); return m.trans(3)[1]; })();
  posePercent(m, h.percentAt(80));
  assert.equal(ones()[1], at29);
  assert.ok(Math.abs(at29 - 2.2507486) < 1e-6);
  // (the tens, at 2.25 from frame 28, keeps its last key's place either way)
  assert.equal(m.trans(2)[1], 2.25);
  // (shaking: the stored place plus the step, a float32 add)
  const v = h.percentAt(43);
  posePercent(m, v);
  assert.equal(ones()[1], f(at29 + v.offset[2][1]));
  assert.equal(ones()[0], f(f(1.61993408203125) + v.offset[2][0]));
});
