// Where each player's HUD sits, per layout (src/render3d/hud.ts HudKit.placeOf: ifAll_802F343C's places by the match's number
// of places; src/common/hudslots.ts: the HUD Slots option). With a made-up layout table: which of the game's places each
// slot takes for one to six places, and the outer layout's two players in the four-place row's two ends. With your game
// files (MELEE_ASSETS, tests/game-files.ts): the four places run left to right along one line, mirrored about the middle.
//
//   deno test -A --no-check --sloppy-imports tests/hud-layout.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { HudKit } from "../src/render3d/hud.ts";
import { hudSlot, outerSlots } from "../src/common/hudslots.ts";
import { gameFiles, readGameFile, withGameFiles } from "./game-files.ts";

/** a kit with only a layout table: place j at (100 + j, -j) */
function kit(entries = 16): HudKit {
  const k = Object.create(HudKit.prototype) as HudKit;
  (k as unknown as { layout: [number, number][] }).layout = Array.from({ length: entries }, (_, j) => [100 + j, -j]);
  return k;
}

const settings = (ports: number[]) => ({
  playerSettings: [0, 1, 2, 3].map((i) => (ports.includes(i) ? { playerIndex: i } : undefined)),
}) as unknown as Parameters<typeof hudSlot>[0];

test("the game's places by the match's number of places (ifAll_802F343C)", () => {
  const k = kit();
  const at = (slot: number, places: number) => k.placeOf(slot, places);
  assert.deepEqual(at(0, 1), [109, -9]);
  assert.deepEqual([0, 1].map((s) => at(s, 2)), [[111, -11], [112, -12]]);
  assert.deepEqual([0, 1, 2].map((s) => at(s, 3)), [[108, -8], [109, -9], [110, -10]]);
  assert.deepEqual([0, 1, 2, 3].map((s) => at(s, 4)), [[102, -2], [103, -3], [104, -4], [105, -5]]);
  // five and six: their own order, drawn 0.65 as wide
  for (const places of [5, 6]) {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((s) => at(s, places)), [6, 2, 3, 4, 5, 7].map((j) => [(100 + j) * 0.65, -j]));
  }
  // a place the file does not have: the middle, low
  assert.deepEqual(kit(4).placeOf(3, 4), [0, -21]);
});

test("HUD Slots outer: two players at the four-place row's ends, whatever their ports; game: their port's place", () => {
  const k = kit();
  for (const ports of [[0, 1], [1, 2], [2, 3], [0, 3], [0, 2], [1, 3]]) {
    const s = settings(ports);
    assert.equal(outerSlots(s, "outer"), true);
    assert.equal(outerSlots(s, "game"), false);
    const outer = ports.map((p) => k.placeOf(hudSlot(s, p, "outer"), 4));
    assert.deepEqual(outer, [[102, -2], [105, -5]], `ports ${ports}: outer`);
    const game = ports.map((p) => k.placeOf(hudSlot(s, p, "game"), 4));
    assert.deepEqual(game, ports.map((p) => [102 + p, -2 - p]), `ports ${ports}: game`);
  }
  // three or four players keep their own places in both layouts
  for (const ports of [[0, 1, 2], [0, 1, 2, 3], [1, 2, 3]]) {
    const s = settings(ports);
    assert.equal(outerSlots(s, "outer"), false);
    for (const p of ports) assert.equal(hudSlot(s, p, "outer"), p);
  }
});

test("game files: the four places run left to right on one line, mirrored about the middle", withGameFiles, () => {
  let buf: ArrayBuffer;
  try { buf = readGameFile("IfAll.usd"); } catch { buf = readGameFile("IfAll.dat"); }
  const k = new HudKit(buf);
  const four = [0, 1, 2, 3].map((s) => k.placeOf(s, 4));
  for (let i = 1; i < 4; i++) assert.ok(four[i][0] > four[i - 1][0], `places ${JSON.stringify(four)}`);
  for (const p of four) assert.equal(p[1], four[0][1]);
  assert.ok(Math.abs(four[0][0] + four[3][0]) < 1e-3 && Math.abs(four[1][0] + four[2][0]) < 1e-3, `not mirrored: ${JSON.stringify(four)}`);
  // (two players in the outer layout: the row's two ends)
  const s = settings([1, 2]);
  assert.deepEqual([1, 2].map((p) => k.placeOf(hudSlot(s, p, "outer"), 4)), [four[0], four[3]]);
  assert.ok(gameFiles);
});
