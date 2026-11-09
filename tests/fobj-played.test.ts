// An animation track played as the game plays it (src/render3d/fobj.ts): the clock stepped a frame at a time in
// float32 (HSD_AObjInterpretAnim, HSD_FObjInterpretAnim), the value worked out by the one float32 FObjUpdateAnim the
// player has (hsd.ts segmentValue / splGetHelmite, which sample() uses too; main.dol 8036AE70, 80378A34), the AObj
// stopping at its end or going back to its start.
//
//   deno test --no-check --sloppy-imports -A tests/fobj-played.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { playedValue } from "../src/render3d/fobj.ts";
import { sample, segmentValue, splGetHelmite, type Key } from "../src/render3d/hsd.ts";
import { madd } from "../src/render3d/gxmath.ts";

const f = Math.fround;
const spl = (time: number, duration: number, p0: number, p1: number, d0: number, d1: number): Key =>
  ({ time, duration, kind: 2, p0: f(p0), p1: f(p1), d0: f(d0), d1: f(d1) });

test("splGetHelmite: main.dol's float32 steps, the last three fmadds; its ends are the keys' values", () => {
  // (the HUD percent's ones digit, IfAll DmgNum anim 0, y: its last key, 2.2607421875 -> 2.25 over 8 frames)
  const k = spl(22, 8, 2.2607421875, 2.25, -0.001220703125, -0.00054931640625);
  for (let t = 0; t <= 8; t++) {
    const fterm = f(1 / 8), time = t;
    const tt = f(time * time), t2 = f(fterm * fterm), ttt = f(tt * time);
    const t2T = f(tt * fterm), t3T2 = f(t2 * ttt), _3t2T2 = f(f(3 * tt) * t2), _2t3T3 = f(f(2 * t3T2) * fterm);
    const a9 = f(t3T2 - t2T), a8 = f(a9 - t2T);
    const want = madd(k.d1, a9, madd(k.d0, f(time + a8), madd(k.p0, f(1 + f(_2t3T3 - _3t2T2)), f(k.p1 * f(-_2t3T3 + _3t2T2)))));
    assert.equal(splGetHelmite(fterm, time, k.p0, k.p1, k.d0, k.d1), want, `t ${t}`);
    assert.equal(segmentValue(k, t), want);
  }
  assert.equal(segmentValue(k, 0), k.p0);
  assert.equal(segmentValue(k, 8), k.p1);
  // (sample() looks the same segment up: the one float32 implementation)
  for (let t = 0; t <= 8; t++) assert.equal(sample([{ ...k, time: 0 }], t), segmentValue(k, t));
});

test("a line: (p1 - p0) / fterm, then one fmadds", () => {
  const k: Key = { time: 0, duration: 3, kind: 1, p0: f(0.1), p1: f(1.7), d0: 0, d1: 0 };
  const d0 = f(f(k.p1 - k.p0) / 3);
  for (const t of [0, 1, 2, f(2.5)]) assert.equal(segmentValue(k, t), madd(d0, t, k.p0));
});

test("played: the frame's value at speed 1 is the key's at that frame; past the AObj's end the last step's holds", () => {
  const keys = [spl(0, 4, 0, 1, 0, 0.5), spl(4, 4, 1, 3, 0.5, 0)];
  for (let s = 0; s <= 8; s++) {
    const want = s < 4 ? segmentValue(keys[0], s) : segmentValue(keys[1], s - 4);
    assert.equal(playedValue(keys, s, 1, 0), s === 8 ? keys[1].p1 : want, `step ${s}`);
  }
  // (an AObj that ends at 6: its 6th step is made and no later one - the value of frame 6 from then on)
  for (const s of [6, 7, 20]) assert.equal(playedValue(keys, s, 1, 6), segmentValue(keys[1], 2));
  // (a track whose clock starts below 0 writes nothing until it comes to 0: decodeKeys puts its first key later)
  assert.equal(playedValue([spl(2, 4, 5, 6, 0, 0)], 1, 1, 0), null);
  assert.equal(playedValue([spl(2, 4, 5, 6, 0, 0)], 2, 1, 0), f(5));
});

test("played at a speed that is not a whole number: each clock is its own float32 sum, a key's wait taken off", () => {
  const rate = f(1 / 0.85);
  const keys: Key[] = [{ time: 0, duration: 5, kind: 1, p0: 0, p1: f(5), d0: 0, d1: 0 },
                       { time: 5, duration: 7, kind: 1, p0: f(5), p1: f(-2), d0: 0, d1: 0 }];
  let time = 0, seg = 0;
  for (let s = 1; s <= 9; s++) {
    time = f(time + rate);
    if (seg === 0 && time >= 5) { time = f(time - 5); seg = 1; }
    assert.equal(playedValue(keys, s, rate, 0), segmentValue(keys[seg], time), `step ${s}`);
  }
});

test("a loop goes back to its start at its end (fmodf, the tracks asked for there, no step that time)", () => {
  const keys = [spl(0, 4, 0, 1, 0, 0.5), spl(4, 4, 1, 0, 0.5, 0)];
  for (const s of [0, 1, 5, 7]) assert.equal(playedValue(keys, s + 8, 1, 8, true), playedValue(keys, s, 1, 8, true));
  assert.equal(playedValue(keys, 8, 1, 8, true), playedValue(keys, 0, 1, 8, true));
  // (at another speed: the clock past the end comes back by the end, the tracks asked for at that frame)
  const rate = f(1.5);
  let curr = 0;
  for (let s = 1; s <= 6; s++) { curr = f(curr + rate); if (curr >= 8) curr = f(curr % 8); }
  const back = curr; // 9 % 8 = 1
  assert.equal(back, 1);
  assert.equal(playedValue(keys, 6, rate, 8, true), segmentValue(keys[0], 1));
});

test("at speed 1 the stepped clock and sample()'s lookup give the same value: one float32 FObjUpdateAnim", () => {
  const keys = [spl(0, 4, 0, 1, 0, 0.5), spl(4, 4, 1, 3, 0.5, 0),
                { time: 8, duration: 5, kind: 1 as const, p0: f(3), p1: f(-1.7), d0: 0, d1: 0 }];
  for (let s = 0; s <= 12; s++) assert.equal(playedValue(keys, s, 1, 0), sample(keys, s), `step ${s}`);
  // (at another speed the stepped clock is its own float32 sum: not always the frame times the speed)
  const rate = f(1 / 0.85);
  let drift = 0, curr = 0;
  for (let s = 1; s <= 12; s++) {
    curr = f(curr + rate);
    if (playedValue(keys, s, rate, 0) !== sample(keys, curr)) drift++;
  }
  assert.ok(drift > 0);
});
