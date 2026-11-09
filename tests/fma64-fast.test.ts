// fma64's quick way (gxmath.ts: Dekker's exact product, Knuth's exact sums, used when t + e is exact) gives the same
// double as its exact integer way (fma64Exact) - sqrtf's Newton steps run on it, and a last-bit difference there moves
// every vector's length.
//
//   deno test --no-check --sloppy-imports -A tests/fma64-fast.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fma64, fma64Exact, frsqrte } from "../src/render3d/gxmath.ts";

const f = Math.fround;
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const rdbl = () => (rnd() < 0.5 ? -1 : 1) * (1 + rnd()) * Math.pow(2, Math.floor(rnd() * 120 - 60)) + (rnd() < 0.3 ? rnd() * 1e-9 : 0);

test("fma64: the quick way is the exact way, on random triples and cancellations", () => {
  let n = 0;
  for (let i = 0; i < 300000; i++) {
    let a = rdbl(), b = rdbl(), c = rdbl();
    if (i % 4 === 1) c = -a * b * (1 + (rnd() - 0.5) * 1e-12);
    if (i % 4 === 2) { a = f(a); b = f(b) * f(b); c = 3.0; }
    if (i % 7 === 3) c = -(a * b);
    assert.ok(Object.is(fma64(a, b, c), fma64Exact(a, b, c)), `${a} * ${b} + ${c}`);
    n++;
  }
  // (and the edges: zeros, infinities, tiny and huge)
  for (const [a, b, c] of [[0, 3, 1], [-0, 3, 0], [2, 3, 0], [1e-300, 1e-10, 1e-300], [1e200, 1e200, 1], [Infinity, 1, 1],
                           [1, 1, -1], [3, f(1 / 3), -1], [1e-160, 1e-160, 0]]) {
    assert.ok(Object.is(fma64(a, b, c), fma64Exact(a, b, c)), `${a} * ${b} + ${c}`);
  }
  assert.equal(n, 300000);
});

test("fma64: sqrtf's three Newton steps the same either way", () => {
  for (let i = 0; i < 200000; i++) {
    const x = f(Math.pow(2, rnd() * 80 - 40) * (1 + rnd()));
    let g = frsqrte(x), h = g;
    for (let k = 0; k < 3; k++) { g = (0.5 * g) * fma64(-x, g * g, 3.0); h = (0.5 * h) * fma64Exact(-x, h * h, 3.0); }
    assert.ok(Object.is(g, h), `sqrtf(${x})`);
  }
});
