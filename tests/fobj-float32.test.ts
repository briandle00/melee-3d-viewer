// An animation track's value as HSD_FObj makes it, in float32 (hsd.ts sample): a line's slope (p1 - p0) / fterm once,
// then d0 * time + p0 fused (FObjUpdateAnim); a curve by splGetHelmite (spline.c). A double-precision lerp or Hermite
// lands a few ulps off the game's, which a joint's sinf/cosf carries into every matrix under it.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { sample, splGetHelmite } from "../src/render3d/hsd.ts";

const f = Math.fround;

test("a line: its slope in float32, times the time and plus its start fused", () => {
  const keys = [{ time: 0, duration: 7, kind: 1 as const, p0: f(3.0910001), p1: f(-1.25), d0: 0, d1: 0 }];
  const slope = f(f(f(-1.25) - f(3.0910001)) / 7);
  // (fused: the product exact, one rounding with the sum)
  assert.equal(sample(keys, 3), f(slope * 3 + f(3.0910001)));
});

test("a curve: splGetHelmite's terms in float32", () => {
  const k = { time: 10, duration: 6, kind: 2 as const, p0: f(1.5), p1: f(-0.75), d0: f(0.125), d1: f(-0.5) };
  assert.equal(sample([k], 13), splGetHelmite(f(1 / 6), 3, k.p0, k.p1, k.d0, k.d1));
  // (its ends: the start at time 0)
  assert.equal(splGetHelmite(f(1 / 6), 0, k.p0, k.p1, k.d0, k.d1), k.p0);
});
