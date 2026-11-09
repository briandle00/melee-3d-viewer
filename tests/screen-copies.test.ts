// Pokemon Stadium's screen copies (screencopies.ts): a buffer each, as the game keeps them - the screen shows the last
// copy made into its mode's buffer before the frame, an old one when it comes back to a buffer it left, and after a
// seek the copies the buffers hold there, made again (primes).
//
//   deno test --no-check --sloppy-imports -A tests/screen-copies.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { type Prime, ScreenCopies } from "../src/render3d/screencopies.ts";
import { StadiumScreen } from "../src/render3d/gr/stadium.ts";

const MATCH: [number, number] = [640, 406], CLOSE: [number, number] = [124, 80];
const size = (m: number) => (m === 7 ? MATCH : CLOSE);
/** what the screen shows: "text", "black" or "<w>@<copy frame>" */
const what = (s: ScreenCopies<string>) =>
  s.shown.kind === "copy" ? `${s.shown.w}@${s.shown.copyFrame}` : s.shown.kind;

/** the copies a seek to `frame` finds in the buffers: for each copy mode, the last frame before it whose frame before
 *  was in that mode (StadiumScreen.copiesBefore's rule, on a plain map) */
const historyOf = (modes: Record<number, number>) => (frame: number): Prime[] => {
  const out: Prime[] = [];
  for (const m of [7, 8]) {
    for (let f = frame - 1; f >= 0; f--) if (modes[f - 1] === m) { out.push({ w: size(m)[0], h: size(m)[1], frame: f }); break; }
  }
  return out;
};

/** draw a frame as Viewer3D does: advance, the primes (each frame drawn and copied into its buffer), the frame's own
 *  copy (the frame before's mode's: grStadium's copy gobjs) */
function drawFrame(s: ScreenCopies<string>, modes: Record<number, number>, f: number): string {
  const m = modes[f], before = modes[f - 1];
  if (s.advance(f, m === 7 || m === 8, ...size(m), historyOf(modes))) {
    for (const p of s.primes.slice()) {
      s.priming = p;
      s.copyInto(p.w, p.h, p.frame);
      s.primed(p);
    }
  }
  const out = what(s);
  if (before === 7 || before === 8) s.copyInto(...size(before), f);
  return out;
}
const play = (s: ScreenCopies<string>, modes: Record<number, number>, from: number, to: number) => {
  const out: string[] = [];
  for (let f = from; f <= to; f++) out.push(drawFrame(s, modes, f));
  return out;
};
const fill = (modes: Record<number, number>, from: number, to: number, m: number) => { for (let f = from; f < to; f++) modes[f] = m; };

test("the match: each frame shows the copy of the frame before, the first after a seek too", () => {
  const s = new ScreenCopies<string>(() => "t");
  const modes: Record<number, number> = {};
  fill(modes, 0, 200, 7);
  const shown = play(s, modes, 100, 103);
  assert.deepEqual(shown, ["640@99", "640@100", "640@101", "640@102"]);
});

test("back from a close-up, the match's buffer shows the copy it held (bot-falcon_ganon-3744's frames)", () => {
  const s = new ScreenCopies<string>((w, h) => `${w}x${h}`);
  const modes: Record<number, number> = {};
  fill(modes, 0, 110, 7);     // the match, its last copy at 110 (the frame before is 109)
  fill(modes, 110, 120, 8);   // a close-up
  fill(modes, 120, 125, 7);   // the match again
  const shown = play(s, modes, 100, 124);
  // the close-up: its buffer holds nothing yet - the copy at 110 is still the match's, the first close-up copy 111
  assert.deepEqual(shown.slice(10, 13), ["black", "black", "124@111"]);
  // the match again at 120: the copy at 120 is the close-up's; the screen shows the match buffer's copy of 110 at 120
  // and 121, the copy of 121 from 122 on
  assert.deepEqual(shown.slice(20, 23), ["640@110", "640@110", "640@121"]);
});

test("a seek finds each buffer's last copy, however long ago, and makes it again", () => {
  const s = new ScreenCopies<string>((w, h) => `${w}x${h}`);
  const modes: Record<number, number> = {};
  fill(modes, 0, 1643, 1);
  fill(modes, 1643, 2341, 7);   // the match, its last copy at 2341
  fill(modes, 2341, 2943, 1);
  fill(modes, 2943, 3620, 8);   // a close-up, its last copy at 3620
  fill(modes, 3620, 3700, 7);
  // (the gate's start: a seek to 60 frames before the window, then frame by frame)
  const shown = play(s, modes, 3560, 3623);
  assert.equal(shown[0], "124@3559");
  assert.deepEqual(shown.slice(60, 64), ["640@2341", "640@2341", "640@3621", "640@3622"]);
  // a seek straight to 3620: the same
  const t = new ScreenCopies<string>(() => "t");
  assert.equal(drawFrame(t, modes, 3620), "640@2341");
  // (a seek to before any copy: nothing to make again)
  const u = new ScreenCopies<string>(() => "t");
  assert.equal(drawFrame(u, modes, 1644), "black");
});

test("a redraw of a frame shows the same copy", () => {
  const s = new ScreenCopies<string>(() => "t");
  const modes: Record<number, number> = {};
  fill(modes, 0, 10, 7);
  play(s, modes, 0, 2);
  assert.equal(s.advance(2, true, ...MATCH), false);
  assert.equal(what(s), "640@1");
});

test("StadiumScreen.copiesBefore: each buffer's last copy before a frame, by the screen's modes", () => {
  const sc = Object.create(StadiumScreen.prototype) as StadiumScreen & { shown: { at: number; mode: number; player: number }[] };
  sc.shown = [{ at: 0, mode: 10, player: -1 }, { at: 1643, mode: 7, player: -1 }, { at: 2341, mode: 1, player: -1 },
              { at: 2943, mode: 8, player: 1 }, { at: 3620, mode: 7, player: -1 }];
  assert.deepEqual(sc.copiesBefore(3621), [{ w: 640, h: 406, frame: 2341 }, { w: 124, h: 80, frame: 3620 }]);
  assert.deepEqual(sc.copiesBefore(3700), [{ w: 640, h: 406, frame: 3699 }, { w: 124, h: 80, frame: 3620 }]);
  assert.deepEqual(sc.copiesBefore(1643), []);
  assert.deepEqual(sc.copiesBefore(1645), [{ w: 640, h: 406, frame: 1644 }]);
});
