// Fountain of Dreams' water columns: one sunk to -1 (grIzumi_801CC358's
// sink) is hidden from the frame after it gets there to the frame before it
// comes back up, those two frames shown at the least height.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Fountain } from "../src/render3d/gr/fountain.ts";
import type { Stage } from "../src/render3d/stage.ts";

test("a column sunk to -1 is hidden between the frame it gets there and the frame it comes up", () => {
  // the left one: 5 at 10, -1 from 11 to 15, 2 at 16
  const h = (frame: number, side: 0 | 1) => side === 1 ? 20 : frame <= 10 ? 5 : frame <= 15 ? -1 : 2;
  const st = { scale: 1, partOf: () => null, extraRuns: new Map(), fountainStart: [20, 28] } as unknown as Stage;
  const f = new Fountain(st, h);
  const part = {};
  (f as unknown as { cols: unknown[] }).cols = [{ part, side: 0, tall: 45 }];
  const shown = (frame: number) => { st.extraRuns.clear(); f.apply(st, frame); return st.extraRuns.has(part as never); };
  assert.deepEqual([10, 11, 12, 13, 14, 15, 16].map(shown), [true, true, false, false, false, true, true]);
});

test("a column that comes back up starts its animation again, its frame 0 the next frame's", () => {
  // (grIzumi_801CC358: state 3 takes the animation away, state 4 starts it at 0 after the frame's HSD_JObjAnimAll)
  const h = (frame: number, side: 0 | 1) => side === 1 ? 20 : frame <= 10 ? 5 : frame <= 15 ? -1 : 2;
  const st = { scale: 1, partOf: () => null, extraRuns: new Map(), fountainStart: [20, 28] } as unknown as Stage;
  const f = new Fountain(st, h);
  const left = {}, right = {};
  (f as unknown as { cols: unknown[] }).cols = [{ part: left, side: 0, tall: 45 }, { part: right, side: 1, tall: 45 }];
  const from = (frame: number, part: object) => { st.extraRuns.clear(); f.apply(st, frame); return st.extraRuns.get(part as never)?.[0].from; };
  assert.deepEqual([5, 11, 15, 20, 30].map((t) => from(t, left)), [0, 0, 16, 16, 16]);
  // (asked again for an earlier frame: as it was then)
  assert.equal(from(8, left), 0);
  assert.equal(from(30, right), 0);
});
