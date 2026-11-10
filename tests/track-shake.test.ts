// A fighter's draw offset from the viewer track ("shake": the sum ftCommon_8008021C makes of a hit's shake,
// a held one's mash wobble and a smash attack's charge): the track's value on each frame it holds, nothing
// once it stops, and no say at all without shake lines or past where the track holds.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { ViewerTrack } from "../src/render3d/track.ts";
import { shakenView, trackShake } from "../src/render3d/hitlag.ts";
import { madd, mtxToGL } from "../src/render3d/gxmath.ts";

const f = Math.fround;

test("the track's offset, frame by frame, and none once it stops", () => {
  const t = new ViewerTrack({
    version: 2, decoded: true,
    events: [
      // port 1: a charge's trembling, then still
      [100, "shake", 1, 0, f(-0.16), 0, 0],
      [101, "shake", 1, 0, f(0.16), 0, 0],
      [103, "shake", 1, 0, 0, 0, 0],
      // port 2's Nana: a mash wobble
      [101, "shake", 2, 1, 0, f(2.4), 0],
    ],
  });
  assert.equal(trackShake(t, "1:0", 99), null);
  assert.deepEqual(trackShake(t, "1:0", 100), [f(-0.16), 0]);
  assert.deepEqual(trackShake(t, "1:0", 101), [f(0.16), 0]);
  // (a state holds until its next change)
  assert.deepEqual(trackShake(t, "1:0", 102), [f(0.16), 0]);
  assert.equal(trackShake(t, "1:0", 103), null);
  assert.deepEqual(trackShake(t, "2:1", 101), [0, f(2.4)]);
  // (a fighter the track never shook: still, the track says so)
  assert.equal(trackShake(t, "0:0", 101), null);
});

test("no say without shake lines, without a track, or past where the track holds", () => {
  const none = new ViewerTrack({ version: 2, decoded: true, events: [[100, "cns", 1, 0, 1]] });
  assert.equal(trackShake(none, "1:0", 100), undefined);
  assert.equal(trackShake(null, "1:0", 100), undefined);
  const parted = new ViewerTrack({ version: 2, decoded: true, diverged_at: 150, events: [[100, "shake", 1, 0, 1, 0, 0]] });
  assert.deepEqual(trackShake(parted, "1:0", 149), [1, 0]);
  assert.equal(trackShake(parted, "1:0", 150), undefined);
});

test("the shaken view is the game's PSMTXConcat(view, offset), a rounding each fused step", () => {
  // bot-pichu_yoshi, game frame 2349 (the window's frame 2472): the match camera's view (its quake's 0.3018 up in
  // it) as 12 float32 words, row major, and Pichu in hitlag drawn moved 3 to the right. Summed whole and rounded
  // once, the view's x translation came out -66.76693; the game's (Pichu's every mesh, by its captured draws) is
  // -66.76692: a(0, 0) 3 rounded, then + a(0, 1) 0, + a(0, 2) 0, + a(0, 3), each fused (ftDrawCommon_8008051C)
  const words = [0x3f767eea, 0xb021b750, 0x3e8a36f8, 0xc28b4fa4, 0x3d042d13, 0x3f7e2a11, 0xbdebb9ed, 0xc1645026,
    0xbe893942, 0x3df4d0b6, 0x3f74ba71, 0xc28e474b];
  const view = mtxToGL(new Float32Array(new Uint32Array(words).buffer), new Float32Array(16));
  const out = shakenView(view, 3, 0, new Float32Array(16));
  const bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
  assert.deepEqual([12, 13, 14].map((i) => bits(out[i])), [0xc28588aa, 0xc162c39f, 0xc28fe2f7]);
  assert.notEqual(bits(out[12]), bits(view[12] + 3 * view[0]));
  // (the rest of the view as it was, its last row 0 0 0 1)
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) assert.equal(out[i], view[i]);
  assert.deepEqual([out[3], out[7], out[11], out[15]], [0, 0, 0, 1]);
  // (both ways: an offset up and down too, each entry of the translation its own fused sequence)
  const both = shakenView(view, f(-1.5), f(0.75), new Float32Array(16));
  for (let r = 0; r < 3; r++) {
    const step = madd(view[4 + r], f(0.75), Math.fround(view[r] * f(-1.5)));
    assert.equal(both[12 + r], madd(1, view[12 + r], madd(view[8 + r], 0, step)));
  }
});
