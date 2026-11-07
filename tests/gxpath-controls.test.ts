// The GX player's controls (src/render3d/gxpath/playback.ts, what gx.html's buttons and keys call: Space toggles, the right
// arrow steps a frame, the left arrow steps back, the speed buttons, the seek bar) on a stand-in session and a made-up
// clock: play and pause, a frame forward drawn and paused, a frame back by playing the match again to the frame before,
// seeks held to the replay, the end, the speeds, and an error reaching the page.
//
//   deno test -A --no-check --sloppy-imports tests/gxpath-controls.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { GxPlayback, PACES, SPEEDS, isPace, paceFps } from "../src/render3d/gxpath/playback.ts";
import type { GxSession } from "../src/render3d/gxpath/session.ts";

/** a match of `frames` rows: step plays the next row (drawn or not), a row behind the last one played needs the match
 *  played again from a checkpoint (here: from the start) */
class Stand {
  index = 0;
  picturedRow = -1;
  wantsRetry = false;
  onPicture: unknown = null;
  rewinds: number[] = [];
  drawn: number[] = [];
  failAt: number | null = null;
  constructor(readonly frameCount: number) {}
  get shown() { return this.picturedRow; }
  step(draw: boolean) {
    if (this.index === this.failAt) throw new Error(`row ${this.index} could not be played`);
    if (draw) { this.picturedRow = this.index; this.drawn.push(this.index); }
    this.index++;
    return true;
  }
  needsRestart(row: number) { return row < this.index - 1; }
  rewindFor(row: number) { this.rewinds.push(row); this.index = 0; this.picturedRow = -1; return Promise.resolve(); }
  seekStep(row: number) {
    const end = Math.min(row, this.frameCount - 1);
    while (this.index <= end) this.step(this.index === end);
    return true;
  }
}

function player(frames = 1000) {
  let now = 0;
  const s = new Stand(frames);
  const events = { state: 0, shown: 0, errors: [] as unknown[] };
  const p = new GxPlayback(s as unknown as GxSession, {
    onPicture() {}, onState() { events.state++; }, onShown() { events.shown++; }, onError(e) { events.errors.push(e); },
  }, () => now);
  /** the page's display ticking for `ms` at 60 Hz */
  const run = (ms: number) => { for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; p.tick(); } };
  /** ticks until the seek under way is done (a rewind resolves between ticks) */
  const settle = async () => { for (let i = 0; i < 20 && p.seeking !== null; i++) { p.tick(); await Promise.resolve(); } };
  return { p, s, events, run, settle };
}

test("Space: play, then pause where it is; each change told to the page", () => {
  const { p, s, events, run } = player();
  assert.equal(p.playing, false);
  p.toggle();
  assert.equal(p.playing, true);
  run(500);
  const at = s.index;
  assert.ok(at >= 29 && at <= 31, `half a second: ${at} frames`);
  p.toggle();
  assert.equal(p.playing, false);
  run(500);
  assert.equal(s.index, at, "paused, it stays");
  assert.ok(events.state >= 2);
});

test("right arrow: one frame forward, drawn, and paused", () => {
  const { p, s, events, run } = player();
  p.play();
  run(100);
  const before = s.shown, shown = events.shown;
  p.stepForward();
  assert.equal(p.playing, false);
  assert.equal(s.shown, before + 1);
  assert.equal(s.drawn.at(-1), before + 1);
  assert.equal(events.shown, shown + 1);
  p.stepForward();
  assert.equal(s.shown, before + 2);
});

test("left arrow: one frame back (the match played again to the frame before), never before the first", async () => {
  const { p, s, settle } = player();
  for (let i = 0; i <= 10; i++) p.stepForward();
  assert.equal(s.shown, 10);
  const back = p.stepBack();
  assert.equal(p.playing, false);
  assert.equal(p.seeking, 9);
  await settle();
  await back;
  assert.equal(s.shown, 9);
  assert.deepEqual(s.rewinds, [9]);
  // (at the first frame it stays there)
  const { p: q, s: t, settle: settle2 } = player();
  q.stepForward();
  assert.equal(t.shown, 0);
  const b2 = q.stepBack();
  assert.equal(q.seeking, 0);
  await settle2();
  await b2;
  assert.equal(t.shown, 0);
});

test("the seek bar: a seek before the first frame is the first, past the last is the last; ahead plays on, behind rewinds", async () => {
  const { p, s, settle } = player(500);
  const ahead = p.seek(300);
  await settle();
  await ahead;
  assert.equal(s.shown, 300);
  assert.deepEqual(s.rewinds, [], "ahead: no rewind");
  const behind = p.seek(-50);
  assert.equal(p.seeking, 0);
  await settle();
  await behind;
  assert.equal(s.shown, 0);
  assert.deepEqual(s.rewinds, [0]);
  const end = p.seek(1e9);
  assert.equal(p.seeking, 499);
  await settle();
  await end;
  assert.equal(s.shown, 499);
});

test("played to the end it stops there; Play then starts again from the first frame", async () => {
  const { p, s, run, settle } = player(60);
  p.play();
  run(2000);
  assert.equal(p.ended, true);
  assert.equal(p.playing, false);
  assert.equal(s.shown, 59);
  p.play();
  await settle();
  assert.equal(p.ended, false);
  assert.equal(p.playing, true);
  assert.ok(s.shown <= 1, `from the start: ${s.shown}`);
});

test("the speeds: 1 among them, slowest first; 2 plays twice the frames of 1, a tenth a tenth", () => {
  assert.deepEqual([...SPEEDS].sort((a, b) => a - b), SPEEDS);
  assert.ok(SPEEDS.includes(1));
  const frames = (speed: number) => { const { p, s, run } = player(1e6); p.setSpeed(speed); p.play(); run(10000); return s.index; };
  const one = frames(1);
  assert.ok(Math.abs(one - 600) <= 2, `1: ${one}`);
  assert.ok(Math.abs(frames(2) - 1200) <= 3);
  assert.ok(Math.abs(frames(0.1) - 60) <= 2);
  // (every frame stepped is drawn at any speed)
  const { p, s, run } = player(1e6);
  p.setSpeed(4);
  p.play();
  run(1000);
  assert.equal(s.drawn.length, s.index);
});

test("the paces: 60, or the console's 60000/1001", () => {
  assert.deepEqual(PACES, ["60", "console"]);
  assert.equal(paceFps("60"), 60);
  assert.equal(paceFps("console"), 60000 / 1001);
  assert.equal(isPace("console"), true);
  assert.equal(isPace("59.94"), false);
});

test("a frame that cannot be played stops the playing and reaches the page", () => {
  const { p, s, events, run } = player();
  s.failAt = 20;
  p.play();
  run(1000);
  assert.equal(p.playing, false);
  assert.equal(events.errors.length, 1);
  assert.match(String(events.errors[0]), /row 20 could not be played/);
});
