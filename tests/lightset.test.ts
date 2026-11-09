// lightset.ts: a light's animations as the game plays them - the clock each set stands at, a set whose
// animations all loop, and a place along a spline taken through the spline joint's matrix.

import test from "node:test";
import assert from "node:assert/strict";
import type { AObj, Light, Spline } from "../src/render3d/hsd.ts";
import { LOBJ } from "../src/render3d/gx.ts";
import { LightSet } from "../src/render3d/lightset.ts";
import { srt } from "../src/render3d/math.ts";

// a key from 0 to 1 over 100 frames
const ramp = (type: number): AObj["tracks"][number] => ({ type, keys: [{ time: 0, duration: 100, kind: 1, p0: 0, p1: 1, d0: 0, d1: 0 }] });
const aobj = (tracks: AObj["tracks"]): AObj => ({ tracks, end: 100, loop: false, obj: null });

function light(anim: Light["anim"]): Light {
  return { desc: 1, kind: "point", flags: LOBJ.POINT | LOBJ.DIFFUSE, color: [0, 0, 0, 1], position: [0, 0, 0], interest: null,
           raw: [1, 0, 0, 1, 0, 0], spot: null, dist: null, anim };
}

// (an animated color is kept as a byte: the red one, 0..255)
const red = (set: LightSet, f: number) => Math.round(set.at(f).color[0] * 255);

test("a light's color: held at its end, looping when its set loops, and on the set's clock", () => {
  const l = light({ offset: 10, aobj: aobj([ramp(9)]), position: null, interest: null });
  // (the ramp at 40 is FObjUpdateAnim's 0.01f x 40 + 0, one fused multiply-add: 0.39999998, and 255 x that is
  // 101.99, kept as 101; 255 x 0.5 = 127.5, kept as 127; 255 x 0.43 = 109.65, kept as 109)
  assert.equal(red(new LightSet([l]), 40), 101);
  assert.equal(red(new LightSet([l]), 150), 255);
  assert.equal(red(new LightSet([l], 1, new Set(), { loopAll: true }), 150), 127);
  assert.equal(red(new LightSet([l], 1, new Set([10])), 150), 127);
  assert.equal(red(new LightSet([l], 1, new Set(), { ahead: 3 }), 40), 109);
});

test("a place along a spline is in the spline joint's space", () => {
  // a straight spline from the origin to (10, 0, 0), its joint turned a quarter round z and moved up 5
  const spline: Spline = { type: 0, n: 2, tension: 0, cv: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0]), total: 10,
                           seg: new Float32Array([0, 1]), poly: new Float32Array(5) };
  const mtx = srt(new Float32Array(16), 1, 1, 1, 0, 0, Math.PI / 2, 0, 5, 0);
  const l = light({ offset: 10, aobj: null, position: { aobj: aobj([ramp(4)]), spline, mtx }, interest: null });
  const p = new LightSet([l]).at(50).pos;
  assert.deepEqual(Array.from(p.slice(0, 4)).map((v) => Math.round(v * 1000) / 1000), [0, 10, 0, 1]);
  // (without a joint's matrix: the point as the curve has it)
  const bare = light({ offset: 10, aobj: null, position: { aobj: aobj([ramp(4)]), spline, mtx: null }, interest: null });
  assert.deepEqual(Array.from(new LightSet([bare]).at(50).pos.slice(0, 3)).map((v) => Math.round(v * 1000) / 1000), [5, 0, 0]);
});
