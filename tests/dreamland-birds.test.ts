// Dream Land's birds from the viewer track ("bird"): made by part 8's proc
// (grOldPupupu_80210D10), after the procs that play the stage's
// animations, a bird stands as the file has it on the frame it is made and
// plays from the next, each of a flight 40 frames further along.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { ViewerTrack } from "../src/render3d/track.ts";
import { Birds } from "../src/render3d/gr/dreamland.ts";
import type { Stage } from "../src/render3d/stage.ts";

test("a bird plays its animation from the frame after it is made", () => {
  const extras: unknown[] = [];
  const st = {
    file: { publics: new Map(), data: new DataView(new ArrayBuffer(4)) }, scale: 1, stageId: 28, extras,
    partOf: () => null, animSet: () => null, copyOf: (_p: number, name: string) => ({ name }),
    extraRuns: new Map<unknown, { from: number }[]>(),
  };
  // (game frame 100: a flight of three of kind 0)
  const tr = new ViewerTrack({ version: 2, decoded: true, events: [[100, "bird", 0, 3, -260, 20, -150]] });
  const birds = new Birds(st as unknown as Stage, { frames: new Array(1000) } as never, tr);
  const made = 100 + 123;
  birds.apply(st as unknown as Stage, made);
  assert.equal(st.extraRuns.size, 3);
  for (const runs of st.extraRuns.values()) assert.deepEqual(runs, []);
  st.extraRuns.clear();
  birds.apply(st as unknown as Stage, made + 1);
  assert.deepEqual([...st.extraRuns.values()].map((r) => made + 1 - r[0].from), [0, 40, 80]);
});
