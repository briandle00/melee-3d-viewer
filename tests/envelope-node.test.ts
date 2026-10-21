// skeleton.ts envelopeNodeMtx: an envelope mesh's node matrix, on synthetic joints, in the order the game's draws
// show in its recordings: the skeleton joint's matrix (with its envelope matrix when it is a SKELETON joint) times
// the inverse of the mesh joint's.

import test from "node:test";
import assertNode from "node:assert/strict";
import { envelopeNodeMtx } from "../src/render3d/skeleton.ts";
import { invert, mul, srt } from "../src/render3d/math.ts";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-4) =>
  Array.from(a).every((v, i) => Math.abs(v - b[i]) <= eps * Math.max(1, Math.abs(b[i])));

const joint = (s: number[], r: number[], t: number[]) => srt(new Float32Array(16), s[0], s[1], s[2], r[0], r[1], r[2], t[0], t[1], t[2]);

test("under the skeleton root: the root times the inverse of the mesh's joint", () => {
  const x = joint([1, 1.2, 0.9], [0.3, -0.7, 1.1], [4, -2, 7]), m = joint([0.8, 1, 1.1], [-1.2, 0.4, 0.2], [-3, 5, 1]);
  const W = new Float32Array(32);
  W.set(x, 0); W.set(m, 16);
  const got = envelopeNodeMtx(new Float32Array(16), W, 0, W, 16, null);
  const want = mul(new Float32Array(16), x, invert(new Float32Array(16), m));
  assertNode.ok(close(got, want), `${Array.from(got)} vs ${Array.from(want)}`);
  // (and it is not the reverse order)
  const reverse = mul(new Float32Array(16), invert(new Float32Array(16), x), m);
  assertNode.ok(!close(got, reverse), "the reverse order");
  assertNode.deepEqual([got[3], got[7], got[11], got[15]], [0, 0, 0, 1]);
});

test("under a SKELETON joint: its envelope matrix taken with it first", () => {
  const x = joint([1, 1, 1], [0.5, 0.1, -0.4], [1, 2, 3]), m = joint([1.1, 0.9, 1], [0.2, -0.3, 0.9], [6, -1, 2]);
  const env = joint([1, 1, 1], [-0.2, 0.6, 0.3], [-1, 0.5, 4]);
  const got = envelopeNodeMtx(new Float32Array(16), x, 0, m, 0, env);
  const want = mul(new Float32Array(16), mul(new Float32Array(16), x, env), invert(new Float32Array(16), m));
  assertNode.ok(close(got, want), `${Array.from(got)} vs ${Array.from(want)}`);
  // (in float32: every number one)
  assertNode.ok(Array.from(got).every((v) => Math.fround(v) === v));
});
