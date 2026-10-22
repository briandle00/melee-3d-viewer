// fx/world.ts: an effect model's turn as the dispatch gives it (efSync 0x4CF, an egg's shell: HSD_JObjSetRotationY
// and HSD_JObjSetRotationX on each piece), from a viewer track's pieces - a made-up bank and model, no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { EffectBank } from "../src/render3d/fx/bank.ts";
import type { Prop } from "../src/render3d/prop.ts";
import { FxWorld } from "../src/render3d/fx/world.ts";

test("a model the track's piece turns about x and y is posed turned both ways", () => {
  const posed: number[][] = [];
  const prop = { length: 50, pose: (...a: number[]) => { posed.push(a); } } as unknown as Prop;
  const bank = { id: 0, cmds: [], texGroups: [], models: { 0x1e: { life: 0, joint: 0, animJoint: null, matAnimJoint: null } },
                 prop: () => prop, ptclKeys: () => [] } as unknown as EffectBank;
  const w = new FxWorld(bank, (_c, part) => part);
  w.trackFx = () => [];
  // [frame, "fxp", gfx, owner kind, owner, index, "m", id, how, part, tx, ty, tz, rx, ry, rz, sx, sy, sz, callback,
  //  lifetime, p0, p1, p2, mirrored]
  const piece = [0, "fxp", 0x4cf, "n", 0, 0, "m", 0x1e, "place", -1, 4, 5, 6, 0.75, 1.25, 0, 2, 2, 2,
                 "SetOffset_FromParams", 0x32, 0, 0, 0, 0];
  w.trackOrdered = (f) => (f === 123 ? [piece] : []) as never;
  w.step(123, []);
  assert.equal(w.models.length, 1);
  const m = w.models[0];
  assert.equal(m.rotX, 0.75);
  assert.equal(m.rotY, 1.25);
  w.poseModel(m, prop, m.age);
  // (pose(frame, x, y, z, scale, rotY, loop, rotZ, rotX, ...))
  const [, , , , scale, rotY, , rotZ, rotX] = posed.at(-1)!;
  assert.deepEqual([scale, rotY, rotZ, rotX], [2, 1.25, 0, 0.75]);
});

test("Final Cutter's attached models face the fighter's side by their root's turn; its child does not", () => {
  const prop = { length: 70, pose: () => {}, setRootRotationY: () => {} } as unknown as Prop;
  const bank = { id: 5, cmds: [], texGroups: [], models: { 0: { life: 0, joint: 0, animJoint: null, matAnimJoint: null },
                                                            2: { life: 0, joint: 0, animJoint: null, matAnimJoint: null } },
                 prop: () => prop, ptclKeys: () => [] } as unknown as EffectBank;
  const w = new FxWorld(bank, (_c, part) => part);
  w.trackFx = () => [];
  const piece = (index: number, id: number, how: string) =>
    [0, "fxp", 0x494, "n", 0, index, "m", id, how, -1, 0, 0, 0, 0, 0, 0, 1, 1, 1, "SetRotYAndTransition", 0x41, 0, 0, 0, 0];
  w.trackOrdered = (f) => (f === 123 ? [piece(0, 5000, "child"), piece(1, 5002, "attach")] : []) as never;
  w.step(123, []);
  const [child, attached] = w.models;
  assert.ok(!child.rootRotationY && child.rotY === 0);
  // (no fighter to face here: the side faced is right)
  assert.ok(attached.rootRotationY);
  assert.equal(attached.rotY, Math.PI / 2);
});

test("Screw Attack's model takes its fighter's model scale (efLib_Cb_SetScaleRotY_FromFighter)", () => {
  const prop = { length: 30, pose: () => {} } as unknown as Prop;
  const bank = { id: 2, cmds: [], texGroups: [], models: { 0: { life: 0, joint: 0, animJoint: null, matAnimJoint: null } },
                 prop: () => prop, ptclKeys: () => [] } as unknown as EffectBank;
  const w = new FxWorld(bank, (_c, part) => part);
  w.trackFx = () => [];
  const piece = [0, "fxp", 0x482, "f", 0, 0, "m", 2000, "attach", -1, 0, 0, 0, 0, 0, 0, 1, 1, 1,
                 "SetScaleRotY_FromFighter", 0, 0, 0, 0, 0];
  const actor = { key: "0:0", st: { facingDirection: -1 }, fighter: { modelScale: Math.fround(0.88) }, world: new Float32Array(16) };
  // (the pieces alone, placed as a frame's step places them: the rest of a fighter's step wants a whole fighter)
  const inner = w as unknown as { sts: Map<string, unknown>; placePieces(f: number, a: unknown[], e: unknown[]): void };
  inner.sts.set(actor.key, actor.st);
  inner.placePieces(123, [actor], [piece]);
  const [m] = w.models;
  assert.equal(m.scale, Math.fround(0.88));
  assert.equal(m.rotY, -Math.PI / 2);
});

test("Mario's Tornado model shows its root's first child's next only in motion 349 (efLib_Cb_ftMr_SpecialLw)", () => {
  const prop = { length: 87, pose: () => {} } as unknown as Prop;
  const bank = { id: 1, cmds: [], texGroups: [], models: { 1: { life: 160, joint: 0, animJoint: null, matAnimJoint: null } },
                 prop: () => prop, ptclKeys: () => [] } as unknown as EffectBank;
  const w = new FxWorld(bank, (_c, part) => part);
  w.trackFx = () => [];
  const piece = [0, "fxp", 0x47c, "f", 0, 0, "m", 1001, "attach", -1, 0, 0, 0, 0, 0, 0, 1, 1, 1,
                 "ftMr_SpecialLw", 0, 0, 0, 0, 0];
  const actor = { key: "0:0", st: { facingDirection: 1, actionStateId: 349 }, fighter: { modelScale: 1 }, world: new Float32Array(16) };
  const inner = w as unknown as { sts: Map<string, unknown>; placePieces(f: number, a: unknown[], e: unknown[]): void };
  inner.sts.set(actor.key, actor.st);
  inner.placePieces(123, [actor], [piece]);
  const [m] = w.models;
  m.turn?.(m);
  assert.equal(m.secondChildOff, false);
  actor.st.actionStateId = 350;
  m.turn?.(m);
  assert.equal(m.secondChildOff, true);
});
