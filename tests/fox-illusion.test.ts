// Fox's Illusion's copy (illusion.ts, itfoxillusion.c): made once the dash's script has set command variable 2 to 2
// - its last command, on the frame the dash's animation ends, the end's first frame - and placed each frame at
// ghostEffectPos[3], where its owner stood four frames back: the dash's places move along through the end too.
// Numbers as Fox's Illusion in the gate's bot-fox_falco (game frames 892-900).
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { FOX_S, FOX_S_END, FOX_S_START, illusionCopyAt, type IllusionOwnerState } from "../src/render3d/illusion.ts";

const xs: Record<number, [number, number, number]> = {
  // frame: state, counter, x
  891: [FOX_S_START, 18, -64.26], 892: [FOX_S_START, 19, -64.26],
  893: [FOX_S, 0, -64.26], 894: [FOX_S, 1, -45.53], 895: [FOX_S, 2, -26.81], 896: [FOX_S, 3, -8.08],
  897: [FOX_S_END, 0, -6.1], 898: [FOX_S_END, 1, -4.2], 899: [FOX_S_END, 2, -2.3], 900: [FOX_S_END, 3, -0.4],
};
const owner = (g: number): IllusionOwnerState | undefined =>
  xs[g] ? { actionStateId: xs[g][0], actionStateFrameCounter: xs[g][1], xPosition: xs[g][2], yPosition: 0 } : undefined;
// (the item: made by the dash's script at its frame 2, states 0 and 1 until its life runs out, then 2)
const itemState = (g: number) => (g < 895 || g > 900 ? undefined : g < 899 ? 0 : 2);
const script = (s: number) => s === FOX_S
  ? [{ kind: "cmdVar", index: 2, frame: 2, value: 1 }, { kind: "cmdVar", index: 2, frame: 4, value: 2 }] : [];

test("the Illusion's copy is made on the dash end's first frame, and stands where Fox was four frames back", () => {
  // (before: the variable is 1 through the dash)
  assert.equal(illusionCopyAt(owner, itemState, script, 896), null);
  assert.deepEqual(illusionCopyAt(owner, itemState, script, 897), [-64.26, 0]);
  assert.deepEqual(illusionCopyAt(owner, itemState, script, 898), [-45.53, 0]);
  // (in the item's state 2 too, catching up through the end)
  assert.deepEqual(illusionCopyAt(owner, itemState, script, 899), [-26.81, 0]);
  assert.deepEqual(illusionCopyAt(owner, itemState, script, 900), [-8.08, 0]);
});

test("the copy's places start as the dash's entry: all four where Fox stood as it began", () => {
  const made = (g: number) => (g < 893 ? undefined : 0);
  const at2 = (s: number) => s === FOX_S ? [{ kind: "cmdVar", index: 2, frame: 1, value: 2 }] : [];
  assert.deepEqual(illusionCopyAt(owner, made, at2, 894), [-64.26, 0]);
  assert.deepEqual(illusionCopyAt(owner, made, at2, 895), [-64.26, 0]);
  assert.deepEqual(illusionCopyAt(owner, made, at2, 896), [-64.26, 0]);
  assert.deepEqual(illusionCopyAt(owner, made, at2, 897), [-64.26, 0]);
  assert.deepEqual(illusionCopyAt(owner, made, at2, 898), [-45.53, 0]);
});
