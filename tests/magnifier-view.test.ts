// hud.ts: the magnifier camera's view carried from frame to frame (ifMagnify_802FBBDC sets the fighters' lights in its
// pictures through the view its last picture left): after a jump the player seeds it from the frames before, and a
// frame drawn again takes the view it began with.

import test from "node:test";
import assert from "node:assert/strict";
import { Hud, magnifierView } from "../src/render3d/hud.ts";
import { gameView } from "../src/render3d/camera.ts";

/** a HUD with only the magnifier camera's state (its constructor wants the game's files) */
function bareHud(): Hud {
  const h = Object.create(Hud.prototype) as Hud;
  const o = h as unknown as Record<string, unknown>;
  o.magView = gameView(new Float32Array(16), [0, 0, 300], [0, 0, 0]);
  o.magFrame = null;
  o.magBefore = null;
  return h;
}

test("a frame that does not follow the frames drawn asks for the view to be seeded; one that does, does not", () => {
  const h = bareHud();
  // (before the HUD is on, frame 123 = the match clock's start, nothing)
  assert.equal(h.magSeedWanted(100), false);
  assert.equal(h.magSeedWanted(4385), true);
  const bone = [290.5, -12.25, 0.75];
  h.seedMagView(magnifierView(new Float32Array(16), bone), 4385);
  assert.equal(h.magFrame, 4384);
  assert.equal(h.magSeedWanted(4385), false);
  // (the view: the bone's, the eye at z 300)
  const v = (h as unknown as { magView: Float32Array }).magView;
  assert.deepEqual(Array.from(v), Array.from(magnifierView(new Float32Array(16), bone)));
  // (none drawn before: the camera's own, its CObjDesc's)
  h.seedMagView(null, 5000);
  assert.deepEqual(Array.from(v), Array.from(gameView(new Float32Array(16), [0, 0, 300], [0, 0, 0])));
});
