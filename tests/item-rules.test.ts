// Items whose look their own code sets (itemrules.ts): Fox's and Falco's blaster's size.
//
//   deno test --no-check --sloppy-imports tests/item-rules.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { blasterScale } from "../src/render3d/itemrules.ts";

test("the blaster: 0.85 of its size from the neutral special, 0.85 of the fighter's in a throw, in float32", () => {
  const f = Math.fround;
  assert.equal(blasterScale(false, 1.1, 1), f(0.85));
  assert.equal(blasterScale(false, f(0.96), 1), f(0.85));
  assert.equal(blasterScale(true, f(1.1), 1), f(f(0.85) * f(1.1)));
  assert.equal(blasterScale(true, f(0.96), f(1.2)), f(f(f(0.85) * f(0.96)) * f(1.2)));
});
