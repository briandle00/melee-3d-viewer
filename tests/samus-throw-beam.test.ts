// Samus's throw beam (fighter.ts throwAccessory, Prop.poseConstrained's jointFrame, animtime.ts steppedFrame, hsd.ts
// loadJoint's instance joints): the model
// she throws with, her articles' slot 4 with the throw's own animation. The test marked withGameFiles reads your game
// files (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { steppedFrame } from "../src/render3d/animtime.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

const SAMUS = 13;

test("the beam's frame is t + 1 steps of the throw's speed, each added in float32", () => {
  const f = Math.fround;
  const rate = f(1 / 0.85);
  assert.equal(steppedFrame(0, rate), rate);
  assert.equal(steppedFrame(2, rate), f(f(rate + rate) + rate));
  let sum = 0;
  for (let k = 0; k < 40; k++) sum = f(sum + rate);
  assert.equal(steppedFrame(39, rate), sum);
  // (at the speed 1 the materials' frame: t + 1)
  for (const t of [0, 1, 17]) assert.equal(steppedFrame(t, 1), t + 1);
});

test("game files: each throw's beam plays its own animation, held where it is put", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(SAMUS, 0)!;
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const f = new Fighter(SAMUS, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, motion, "test");
  const on = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, -3, 1]);
  const worlds: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const beam = f.throwAccessory(4, k)!;
    assert.ok(beam, `throw ${k}`);
    assert.equal(f.throwAccessory(4, k), beam);
    assert.equal(beam.length, 42);
    assert.ok(beam.hasMatAnim);
    // (its 25 links are instance joints of three link models: each draws one again, HSD_JObjDispAll - 28 links
    // and the two ends, every one a mesh of its own)
    assert.equal(beam.skeleton.drawables.length, 30);
    assert.equal(beam.skeleton.joints.filter((j) => j.instance).length, 50);
    beam.poseConstrained(6, on, 1, false, 6);
    const sk = beam.skeleton;
    // (its root on the joint it is held to)
    assert.deepEqual(Array.from(sk.world.slice(12, 15)), [10, 20, -3]);
    worlds.push(Array.from(sk.world));
    // (a link drawn through its instance joint sits where the instance is: its copy's matrix is the instance's
    // times the inverse of the link model's root, times the joint it copies)
    for (const j of sk.joints) {
      if (!j.instance || j.instance.source !== j.instance.template) continue;
      const at = (k: number) => Array.from(sk.world.slice(k * 16 + 12, k * 16 + 15));
      at(j.index).forEach((v, c) => assert.ok(Math.abs(v - at(j.instance!.joint)[c]) < 1e-3));
    }
    // (the joints follow jointFrame alone: the materials' frame moves no joint)
    beam.poseConstrained(11, on, 1, false, 6);
    assert.deepEqual(Array.from(sk.world), worlds[k]);
    beam.poseConstrained(6, on, 1, false, 20);
    assert.notDeepEqual(Array.from(sk.world), worlds[k]);
  }
  // (four throws, four animations)
  assert.equal(new Set(worlds.map((w) => w.join())).size, 4);
});

test("game files: the beam's root as lb_8000C2F8's constraints leave it, its joints played at the throw's speed", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const { resolvePositionOrientation } = await import("../src/render3d/cns.ts");
  const files = fighterFiles(SAMUS, 0)!;
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const f = new Fighter(SAMUS, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, motion, "test");
  // (a target joint turned a little about z and y, scaled, at (10, 20, -3): a model of one joint)
  const c = Math.fround(Math.cos(0.3)), s = Math.fround(Math.sin(0.3));
  const world = new Float32Array([c * 1.1, s * 1.1, 0, 0, -s * 1.1, c * 1.1, 0, 0, 0, 0, 1.1, 0, 10, 20, -3, 1].map(Math.fround));
  const model = { world: () => world, parent: () => -1, flags: () => 0 };
  const resolve = (m: Float32Array) => { resolvePositionOrientation(m, model, 0); };
  const beam = f.throwAccessory(4, 1)!;
  const rate = Math.fround(1 / 0.85);
  beam.poseTied(7, resolve, 1, 7, rate);
  const sk = beam.skeleton;
  // (the root: at the target's place, along its axes, each as long as the root's own was - its scale 1 here)
  assert.deepEqual(Array.from(sk.world.slice(12, 15)), [10, 20, -3]);
  for (let col = 0; col < 3; col++) {
    const len = Math.hypot(sk.world[col * 4], sk.world[col * 4 + 1], sk.world[col * 4 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, `column ${col}: ${len}`);
    for (let r = 0; r < 3; r++) assert.ok(Math.abs(sk.world[col * 4 + r] - world[col * 4 + r] / 1.1) < 1e-5);
  }
  // (the root's scale: the fighter's, unless its animation sets it)
  beam.poseTied(7, resolve, 1.25, 7, rate);
  assert.ok(Math.abs(Math.hypot(sk.world[0], sk.world[1], sk.world[2]) - 1.25) < 1e-5);
  // (the joints at the throw's speed: another speed, another pose; the materials' frame moves no joint)
  beam.poseTied(7, resolve, 1, 7, rate);
  const at = Array.from(sk.world);
  beam.poseTied(9, resolve, 1, 7, rate);
  assert.deepEqual(Array.from(sk.world), at);
  beam.poseTied(7, resolve, 1, 7, 1);
  assert.notDeepEqual(Array.from(sk.world), at);
});
