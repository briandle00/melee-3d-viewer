// Pokemon Stadium's screen copies (screencopies.ts): a buffer each, as the game keeps them - the screen shows the last
// copy made into its mode's buffer before the frame, an old one when it comes back to a buffer it left.
//
//   deno test --no-check --sloppy-imports -A tests/screen-copies.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { ScreenCopies } from "../src/render3d/screencopies.ts";

const MATCH: [number, number] = [640, 406], CLOSE: [number, number] = [124, 80];
/** what the screen shows: "text", "black" or "<w>@<copy frame>" */
const what = (s: ScreenCopies<string>) =>
  s.shown.kind === "copy" ? `${s.shown.w}@${s.shown.copyFrame}` : s.shown.kind;

/** play frames from..to: the mode a frame shows (7 match, 8 close-up, 1 text) and the mode its copy follows (the
 *  frame before's: grStadium's copy gobjs), drawing a frame again when asked */
function play(s: ScreenCopies<string>, modes: Record<number, number>, from: number, to: number): string[] {
  const out: string[] = [];
  const size = (m: number) => (m === 7 ? MATCH : CLOSE);
  for (let f = from; f <= to; f++) {
    const m = modes[f], before = modes[f - 1] ?? m;
    const draw = () => {
      if (before === 7 || before === 8) { s.copyInto(...size(before), f); s.copied(...size(before), f); }
    };
    if (s.advance(f, m === 7 || m === 8, ...size(m))) { draw(); s.advance(f, m === 7 || m === 8, ...size(m)); }
    out.push(what(s));
    draw();
  }
  return out;
}

test("the match: each frame shows the copy of the frame before", () => {
  let n = 0;
  const s = new ScreenCopies<string>(() => `t${n++}`);
  const modes: Record<number, number> = {};
  for (let f = 100; f <= 110; f++) modes[f] = 7;
  const shown = play(s, modes, 100, 110);
  // (the first frame is a jump: drawn twice, its own copy for the frame before's)
  assert.equal(shown[0], "640@100");
  assert.deepEqual(shown.slice(1, 4), ["640@100", "640@101", "640@102"]);
});

test("back from a close-up, the match's buffer shows the copy it held (bot-falcon_ganon-3744's frames)", () => {
  const s = new ScreenCopies<string>((w, h) => `${w}x${h}-${Math.random()}`);
  const modes: Record<number, number> = {};
  for (let f = 100; f < 110; f++) modes[f] = 7;    // the match, its last copy at 109
  for (let f = 110; f < 120; f++) modes[f] = 8;    // a close-up
  for (let f = 120; f < 125; f++) modes[f] = 7;    // the match again
  const shown = play(s, modes, 100, 124);
  // the close-up: its buffer holds nothing yet (black) - the copy at 110 is still the match's (the frame before's
  // mode), the first close-up copy is made at 111
  assert.equal(shown[10], "black");
  assert.equal(shown[11], "black");
  assert.equal(shown[12], "124@111");
  // the match again at 120: the copy at 120 is the close-up's; the screen shows the match buffer's old copy, made at
  // 110, at 120 and 121, and the copy of 121 from 122 on
  assert.deepEqual(shown.slice(20, 23), ["640@110", "640@110", "640@121"]);
});

test("the text page between: the buffer keeps its copy", () => {
  const s = new ScreenCopies<string>(() => "t");
  const modes: Record<number, number> = {};
  for (let f = 0; f < 5; f++) modes[f] = 7;
  for (let f = 5; f < 9; f++) modes[f] = 1;
  for (let f = 9; f < 12; f++) modes[f] = 7;
  const shown = play(s, modes, 0, 11);
  assert.deepEqual(shown.slice(5, 9), ["text", "text", "text", "text"]);
  // (the copy at 5 was the match's: the frame before showed it)
  assert.deepEqual(shown.slice(9, 12), ["640@5", "640@5", "640@10"]);
});

test("a redraw of a frame shows the same copy; a jump forgets every copy", () => {
  const s = new ScreenCopies<string>(() => "t");
  const modes: Record<number, number> = { 0: 7, 1: 7, 2: 7, 50: 7, 51: 7 };
  play(s, modes, 0, 2);
  assert.equal(s.advance(2, true, ...MATCH), false);
  assert.equal(what(s), "640@1");
  // a jump: black, drawn again with its own copy
  assert.equal(s.advance(50, true, ...MATCH), true);
  assert.equal(what(s), "black");
  s.copyInto(...MATCH, 50);
  s.copied(...MATCH, 50);
  assert.equal(what(s), "640@50");
  assert.equal(s.advance(50, true, ...MATCH), false);
  assert.equal(what(s), "640@50");
});
