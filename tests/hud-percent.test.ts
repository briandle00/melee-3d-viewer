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
