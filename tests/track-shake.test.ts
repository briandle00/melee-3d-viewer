// A fighter's draw offset from the viewer track ("shake": the sum ftCommon_8008021C makes of a hit's shake,
// a held one's mash wobble and a smash attack's charge): the track's value on each frame it holds, nothing
// once it stops, and no say at all without shake lines or past where the track holds.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { ViewerTrack } from "../src/render3d/track.ts";
import { trackShake } from "../src/render3d/hitlag.ts";

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
