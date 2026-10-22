// thunder.ts: the bolt of Pikachu's and Pichu's Thunder shrinking where it struck.

import test from "node:test";
import assert from "node:assert/strict";
import { thunderScaleY } from "../src/render3d/thunder.ts";

test("the bolt keeps its size the frame it strikes, then loses its speed's share of its length each frame", () => {
  assert.equal(thunderScaleY(0, -5, 40), 1);
  // (35 of 40: 8750 ten-thousandths, one more for the cut)
  assert.equal(thunderScaleY(1, -5, 40), Math.fround(0.8751));
  assert.equal(thunderScaleY(6, -5, 40), Math.fround(0.2501));
  assert.equal(thunderScaleY(7, -5, 40), Math.fround(0.1251));
});

test("once its length is used up the bolt keeps the last size it had", () => {
  assert.equal(thunderScaleY(8, -5, 40), Math.fround(0.1251));
  assert.equal(thunderScaleY(20, -5, 40), Math.fround(0.1251));
});
