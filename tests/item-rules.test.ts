// Items whose look their own code sets frame by frame (itemrules.ts): PK Thunder's trails shown and hidden by turns,
// Mr. Game & Watch's sausage blinking as its life runs out, Fox's and Falco's blaster's size.
//
//   deno test --no-check --sloppy-imports tests/item-rules.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { blasterScale, sausageShown, trailShown } from "../src/render3d/itemrules.ts";

test("PK Thunder's trail: shown the frame it is made, then hidden and shown by turns", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(trailShown), [true, false, true, false, true, false]);
});

test("the sausage, down: shown while its life's bit 2 is set (bot-kirby_gnw 832-835: lives 24, 23, 22, 21)", () => {
  // (the game hid it at 832 and drew it at 833 and 834)
  assert.deepEqual([24, 23, 22, 21, 20, 19, 18].map(sausageShown), [false, true, true, false, false, true, true]);
  // ((s32): a life with a fraction counts by its whole part)
  assert.equal(sausageShown(22.5), true);
  assert.equal(sausageShown(1.5), false);
});

test("the blaster: 0.85 of its size from the neutral special, 0.85 of the fighter's in a throw, in float32", () => {
  const f = Math.fround;
  assert.equal(blasterScale(false, 1.1, 1), f(0.85));
  assert.equal(blasterScale(false, f(0.96), 1), f(0.85));
  assert.equal(blasterScale(true, f(1.1), 1), f(f(0.85) * f(1.1)));
  assert.equal(blasterScale(true, f(0.96), f(1.2)), f(f(f(0.85) * f(0.96)) * f(1.2)));
});
