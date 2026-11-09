// stage.ts stadiumForms: Pokemon Stadium's transformation steps in float32, as grStadium_801D4548's disassembly runs
// them - the constants 0.95f, 0.05f and -10.0f (not the doubles), the frame counts as floats, and a step down one
// fused fnmsubs.

import test from "node:test";
import assert from "node:assert/strict";
import { stadiumForms, STADIUM_TIMES } from "../src/render3d/stage.ts";
import { nmsub } from "../src/render3d/gxmath.ts";

const f = Math.fround;
const T = STADIUM_TIMES;

test("a form coming up: (0.95f * frames / change + 0.05f) * scale, and its rise and the old one's fall", () => {
  const scale = f(0.9375), ev = [{ frame: 100, event: 5, type: 6 }];
  let differs = 0;
  for (let n = 1; n <= T.change; n++) {
    const [old, nw] = stadiumForms(ev, 100 + n, T, scale);
    // (case 5: fmuls 0.95f by the count, fdivs by the change, fadds 0.05f, fmuls the scale)
    assert.equal(nw.scaleY, f(f(f(0.05) + f(f(f(0.95) * n) / T.change)) * scale), `frame ${n}`);
    const half = Math.trunc(T.change / 2), ten = f(-10 * scale);
    assert.equal(nw.y, n < half ? f(ten * f(1 - f(n / half))) : 0);
    assert.equal(old.y, n > half ? f(ten * f(1 - f((T.change - n) / (T.change - half)))) : 0);
    if (nw.scaleY !== f(f(f(0.95 * n) / T.change + 0.05) * scale)) differs++;
  }
  // (the doubles 0.95 and 0.05 give other floats on some of the frames: the game's are the float constants)
  assert.ok(differs > 0);
});

test("a form going flat: each frame scaleY - scale * (0.95f / change) in one rounding, down to 0.05f", () => {
  const scale = f(0.9375), ev = [{ frame: 50, event: 4, type: 6 }];
  let sy = scale;
  const step = f(f(0.95) / T.change), least = f(f(0.05) * scale);
  for (let k = 1; k <= 140; k++) {
    if (sy !== f(0.05)) { const s = nmsub(scale, step, sy); sy = s > least ? s : f(0.05); }
    assert.equal(stadiumForms(ev, 50 + k, T, scale)[0].scaleY, sy, `frame ${k}`);
  }
  assert.equal(sy, f(0.05));
});
