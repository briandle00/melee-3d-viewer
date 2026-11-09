// A plain particle's corners as psDispSub makes them (fx/draw.ts psDispSubCorners): its size times the billboard
// axes, turned about right x up by its rotation past 0.01, its place less right, less up, plus right, plus up - in
// float32 and the game's order, so corners the camera sees almost edge on (Battlefield's stars by the camera) land
// where the game's do.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { psDispSubCorners } from "../src/render3d/fx/draw.ts";
import { madd, msub, PSMTXRotAxisRad } from "../src/render3d/gxmath.ts";

const f = Math.fround;

test("a plain particle's corners: its place less and plus its size along the billboard axes", () => {
  const axes = Float32Array.from([f(0.98), f(1.02), f(0.13), f(-0.11), f(-0.2), f(0.19)]);
  const p = { px: f(12.5), py: f(-3.25), pz: f(170.1), size: f(1.7), rotate: 0 } as never;
  const c = psDispSubCorners(p, axes, new Float32Array(12));
  const r = [f(axes[0] * f(1.7)), f(axes[2] * f(1.7)), f(axes[4] * f(1.7))];
  const u = [f(axes[1] * f(1.7)), f(axes[3] * f(1.7)), f(axes[5] * f(1.7))];
  assert.deepEqual(Array.from(c), [f(f(12.5) - r[0]), f(f(-3.25) - r[1]), f(f(170.1) - r[2]),
    f(f(12.5) - u[0]), f(f(-3.25) - u[1]), f(f(170.1) - u[2]), f(f(12.5) + r[0]), f(f(-3.25) + r[1]), f(f(170.1) + r[2]),
    f(f(12.5) + u[0]), f(f(-3.25) + u[1]), f(f(170.1) + u[2])]);
});

test("a turned particle's axes: turned about right x up by PSMTXRotAxisRad, with the game's fused multiply-adds", () => {
  const axes = Float32Array.from([1, 1, 1, -1, 0, 0]);
  const p = { px: 0, py: 0, pz: 0, size: 1, rotate: f(0.5) } as never;
  const c = psDispSubCorners(p, axes, new Float32Array(12));
  const m = PSMTXRotAxisRad(new Float32Array(12), [msub(1, 0, 0), msub(0, 1, 0), msub(1, -1, f(1 * 1))], f(0.5));
  const rx = madd(m[2], 0, madd(m[0], 1, f(m[1] * 1)));
  assert.equal(c[6], rx);
  // (and a turn of 0.01 or less is none)
  const q = { px: 0, py: 0, pz: 0, size: 1, rotate: 0.01 } as never;
  assert.equal(psDispSubCorners(q, axes, new Float32Array(12))[6], 1);
});
