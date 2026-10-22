// ftLib_UpdateScreenVisibility as hud.ts fighterShown makes it: a bone on the screen, one just off it whose box
// reaches back in, and one well off it.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { fighterShown } from "../src/render3d/hud.ts";
import { lookAt, mul, perspective } from "../src/render3d/math.ts";

test("fighterShown: on the screen, off it but its box reaching in, and well off it", () => {
  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  perspective(proj, (38 * Math.PI) / 180, 1.2173333, 1, 1000);
  lookAt(view, [0, 0, 100], [0, 0, 0]);
  mul(vp, proj, view);
  // (the screen's half width at z 0: 100 tan 19 deg x 1.2173 = 41.9)
  assert.equal(fighterShown(vp, view, [0, 0, 0], 23), true);
  assert.equal(fighterShown(vp, view, [50, 0, 0], 23), true);
  assert.equal(fighterShown(vp, view, [50, 0, 0], 5), false);
  assert.equal(fighterShown(vp, view, [200, 0, 0], 23), false);
  // (on the line of sight behind the eye: lbVector_8000E838 measures from the whole line, so the game counts it)
  assert.equal(fighterShown(vp, view, [0, 0, 200], 5), true);
});
