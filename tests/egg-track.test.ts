// The shield Yoshi's code set his egg's colors from, the simulator's track's "egg" (ftYs_Init_8012B8A4; the full
// shield's for his egg roll's ftYs_Init_8012B918). Which shield the code reads depends on where in the frame its
// callback runs - the hold's wear before it, the regain and a hit's damage after it (Fighter_procCollResolve) - and
// on frames like a hit on his shield (his state GuardDamage by the frame's end) or a roll's last (Wait) the replay
// cannot tell: bot-pichu_yoshi's track and the replay's rules differ on 1709 frames (a dodge in place sets nothing,
// GuardOn_1 reads the frame before's on some frames, the egg roll's first frames set nothing yet).
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { ViewerTrack } from "../src/render3d/track.ts";
import { eggShield } from "../src/render3d/yoshiroll.ts";

test("the egg's shield holds until the next; the track's word over the replay's", () => {
  const t = new ViewerTrack({
    version: 3, decoded: true,
    events: [[20, "egg", 1, 0, 52.5], [25, "egg", 1, 0, 51.25]],
  });
  assert.equal(t.hasAt("egg", 5), true);
  assert.equal(t.at("egg", "1:0", 19), null);
  assert.deepEqual(t.at("egg", "1:0", 24), [52.5]);
  assert.deepEqual(t.at("egg", "1:0", 30), [51.25]);
  // (the track's word over the replay's; none yet: the file's colors; a track without the type: the replay's)
  assert.equal(eggShield(t.at("egg", "1:0", 24), 40), 52.5);
  assert.equal(eggShield(t.at("egg", "1:0", 19), 40), null);
  assert.equal(eggShield(undefined, 40), 40);
});
