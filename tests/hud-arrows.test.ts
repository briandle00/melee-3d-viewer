// The edge arrows' table (if_2FD9.c, hudlogic.ts): the first unused arrow for a port, a CPU's none, a held
// arrow keeping its kind, a let-go one sent back where it was in its last color.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { arrowTable, arrowsAssign, arrowsPlace } from "../src/render3d/hudlogic.ts";

const RED: [number, number, number] = [1, 0, 0], BLUE: [number, number, number] = [0, 0, 1];

test("arrows go to the first unused entry, not the port's own, and never to a CPU", () => {
  const t = arrowTable();
  arrowsAssign(t, 2, 1, false, RED);
  arrowsAssign(t, 1, 0, true, BLUE);
  arrowsAssign(t, 3, 1, true, BLUE);
  assert.deepEqual(t.kind, [1, 0, 0, 0]);
  assert.deepEqual(t.port[0], 2);
  assert.deepEqual(t.color[0], RED);
});

test("a held arrow keeps its kind until it is let go; let go, it stays where it was, 10000 back", () => {
  const t = arrowTable();
  arrowsAssign(t, 0, 1, false, RED);
  arrowsAssign(t, 1, 1, false, BLUE);
  assert.deepEqual(arrowsPlace(t), [0, 0, 10000, 10000]);
  assert.deepEqual([t.x[0], t.y[0], t.x[1], t.y[1]], [-25, Math.fround(-1.3), -25, Math.fround(Math.fround(2.6) + Math.fround(-1.3))]);
  arrowsAssign(t, 0, 2, false, RED);
  assert.equal(t.kind[0], 1);
  arrowsAssign(t, 0, 0, false, RED);
  assert.deepEqual(arrowsPlace(t), [10000, 0, 10000, 10000]);
  assert.deepEqual([t.x[0], t.color[0]], [-25, RED]);
  // (alone on its edge now: at the top)
  assert.equal(t.y[1], 0);
  // a right one: turned half round
  arrowsAssign(t, 3, 2, false, BLUE);
  arrowsPlace(t);
  assert.deepEqual([t.x[0], t.rot[0]], [25, Math.fround(3.1415927)]);
});
