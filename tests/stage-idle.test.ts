// A stage part whose setup starts no animation (Dream Land's flowers:
// grOldPupupu_80211C10 is empty) stands as the file has it until the code
// starts one, where the other parts play their first set from the stage's
// building.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Stage, STAGES } from "../src/render3d/stage.ts";

function fake(idle: number[]) {
  const calls: string[] = [];
  const st = Object.create(Stage.prototype);
  Object.assign(st, { info: { ...STAGES[28], idle }, runs: new Map(), animFrom: new Map(), matsSet: new Set(), fod: null, formUpOf: () => null });
  const part = (index: number) => ({
    index, still: false, anim: [null], matAnim: null,
    skeleton: { resetPose: () => calls.push(`${index} rest`), applyAObjs: (_a: unknown, t: number) => calls.push(`${index} at ${t}`) },
  });
  return { st, calls, part };
}

test("Dream Land's flowers stand at rest until Whispy blows", () => {
  assert.ok(STAGES[28].idle?.includes(6));
  const { st, calls, part } = fake([6]);
  st.posePart(part(6), 300, undefined);
  st.posePart(part(7), 300, undefined);
  assert.deepEqual(calls, ["6 rest", "7 rest", "7 at 301"]);
  assert.deepEqual(st.playing(6), []);
  // (once the code starts a set on them, they play it)
  calls.length = 0;
  st.runs.set(6, [{ anim: 1, joint: 0, deep: true, from: 290, rate: 1 }]);
  st.sparse = () => ({ anim: [null], mat: null });
  st.posePart(part(6), 300, undefined);
  assert.deepEqual(calls, ["6 rest", "6 at 10"]);
});
