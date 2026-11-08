// shyguy.ts: the clock of a Shy Guy's card (itheiho.c).

import test from "node:test";
import assert from "node:assert/strict";
import type { ItemUpdate, ReplayData } from "../src/common/types.ts";
import { shyGuyAnim, shyGuyClock } from "../src/render3d/shyguy.ts";

const game = (states: number[], xVelocity = (_: number) => 1) => {
  const frames = states.map((state, i) => ({ items: [{ spawnId: 1, typeId: 0xd2, state, xVelocity: xVelocity(i) }] }));
  return { data: { frames } as unknown as ReplayData, at: (i: number) => frames[i].items[0] as unknown as ItemUpdate };
};
const walk = (g: ReturnType<typeof game>, n: number) => Array.from({ length: n }, (_, i) => shyGuyClock(g.data, i, g.at(i)));

test("its flight plays at the item's rate from 0", () => {
  const g = game([0, 0, 1, 1, 1, 1]);
  assert.deepEqual(walk(g, 6), [0, 0, 0, 1, 2, 3]);
  assert.equal(shyGuyAnim(g.data, 1), 0);
});

test("a flight away begun in the item's physics steps 1 before its callback sets the rate to 2", () => {
  // (bot-mario_luigi 1316: state 4 from state 3, the card one frame behind a clock stepped by 2 from its start)
  const g = game([3, 3, 4, 4, 4, 4]);
  assert.deepEqual(walk(g, 6), [0, 0, 0, 1, 3, 5]);
  assert.equal(shyGuyAnim(g.data, 1), 2);
});

test("at its end the callback starts it again and sets the rate at once: 0, 2, 4", () => {
  const n = 132;
  const g = game([3, ...Array(n - 1).fill(4)]);
  const t = walk(g, n);
  assert.equal(t[128], 253);
  assert.equal(t[129], 255);
  assert.deepEqual(t.slice(130), [0, 2]);
});

test("a landing starts it again at the item's rate", () => {
  const g = game([4, 4, 4, 4, 4, 4], (i) => (i === 3 ? 0 : 1));
  assert.deepEqual(walk(g, 6), [0, 1, 3, 0, 1, 3]);
});
