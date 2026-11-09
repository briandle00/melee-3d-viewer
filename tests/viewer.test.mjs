// Pure pieces of the 3D viewer: how many pixels it draws at
// (src/render3d/drawsize.ts), the HUD Slots option (src/common/hudslots.ts),
// and the percent's shake and KO scatter taking the game's own random draws
// when they are known (src/render3d/hudlogic.ts).
//
//   deno test --no-check tests/

import test from "node:test";
import assert from "node:assert/strict";
import { drawingSize, MAX_DPR, MAX_DRAW_PIXELS } from "../src/render3d/drawsize.ts";
import { hudSlot, hudSlotsMode, onHudSlots, outerSlots, setHudSlotsMode } from "../src/common/hudslots.ts";

const aspect = ([w, h]) => w / h;

test("the drawing follows the element: its CSS size times the pixel ratio", () => {
  assert.deepEqual(drawingSize(420, 345, 1), [420, 345]);
  assert.deepEqual(drawingSize(420, 345, 1.5), [630, 518]);
  assert.deepEqual(drawingSize(730, 600, 2), [1460, 1200]);
  // a small player made Full Window on a 1600 x 900 window: drawn at its new size
  assert.deepEqual(drawingSize(1095, 900, 1), [1095, 900]);
});

test("the pixel ratio counts up to MAX_DPR; none or a nonsense one is 1", () => {
  assert.equal(MAX_DPR, 2);
  assert.deepEqual(drawingSize(500, 411, 3), drawingSize(500, 411, 2));
  assert.deepEqual(drawingSize(500, 411, 0), [500, 411]);
  assert.deepEqual(drawingSize(500, 411, NaN), [500, 411]);
});

test("a 4K screen filled is under the cap; past it the picture is scaled down evenly", () => {
  const k4 = drawingSize(1752, 1440, 1.5);
  assert.deepEqual(k4, [2628, 2160]);
  const k8 = drawingSize(2628, 2160, 2);
  assert.ok(k8[0] * k8[1] <= MAX_DRAW_PIXELS, `past the cap: ${k8}`);
  assert.ok(k8[0] * k8[1] > MAX_DRAW_PIXELS * 0.995, `well under the cap: ${k8}`);
  assert.ok(Math.abs(aspect(k8) - 73 / 60) < 0.002, `the shape changed: ${k8}`);
});

test("neither side is more than the graphics card's largest; with a CRT, the screen's own pixels", () => {
  const s = drawingSize(5000, 4110, 1, { maxDim: 2048 });
  assert.ok(s[0] <= 2048 && s[1] <= 2048, `${s}`);
  assert.deepEqual(drawingSize(0, 0, 1), [1, 1]);
  assert.deepEqual(drawingSize(1095, 900, 1.25, { exact: true, device: [1369, 1125] }), [1369, 1125]);
  assert.deepEqual(drawingSize(1095, 900, 1.25, { exact: true, device: [0, 0] }), drawingSize(1095, 900, 1.25));
});

const settings = (...ports) => ({ playerSettings: ports.map((p) => ({ playerIndex: p })) });

test("HUD Slots: two players in the outer slots by default, as in the game when asked", () => {
  assert.equal(hudSlotsMode(), "outer");
  const s = settings(1, 2);
  assert.equal(hudSlot(s, 1), 0);
  assert.equal(hudSlot(s, 2), 3);
  assert.equal(outerSlots(s), true);
  assert.equal(hudSlot(s, 1, "game"), 1);
  assert.equal(outerSlots(s, "game"), false);
  // three or four players keep their own slots either way
  assert.equal(hudSlot(settings(0, 1, 2), 1, "outer"), 1);
  assert.equal(outerSlots(settings(0, 1, 2), "outer"), false);
});

test("HUD Slots: a change reaches every follower once, and the default reads it", () => {
  const seen = [];
  onHudSlots((m) => seen.push(m));
  setHudSlotsMode("game");
  setHudSlotsMode("game");
  assert.deepEqual(seen, ["game"]);
  assert.equal(hudSlot(settings(1, 2), 2), 2);
  setHudSlotsMode("outer");
  assert.deepEqual(seen, ["game", "outer"]);
  assert.equal(hudSlot(settings(1, 2), 2), 3);
});

test("the percent's shake and KO scatter take the game's draws when given", async () => {
  const { scatter, shakeOffset } = await import("../src/render3d/hudlogic.ts");
  const draws = [0, 1, 0.5, 0.25, 0.75, 0, 1, 0.5];
  // x then y for each piece: 0 is the most to the left, 1 the most to the right (damage 10: 1.014 either way; in
  // float32, as ifStatus_802F4B84 works them)
  const f = Math.fround;
  const [x0, y0] = shakeOffset(5, 5, 10, 0, 0, draws);
  assert.equal(x0, f(f(f(f(0.1014) * 10) * -1) - f(0.2028)));
  assert.equal(y0, f(f(f(0.1014) * 10) + f(0.2028)));
  // without draws, a stand-in: the same for the same frame and port
  assert.deepEqual(shakeOffset(5, 5, 10, 1, 0), shakeOffset(5, 5, 10, 1, 0));
  // the scatter's first step is its speed: sideways by the piece's x draw, up by its y draw
  const [sx, sy] = scatter(1, 0, 0, 100, draws);
  assert.equal(sx, f(0.3041));
  assert.ok(sy > 0);
});
