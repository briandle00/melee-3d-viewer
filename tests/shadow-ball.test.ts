// shadow-ball.ts and Prop.setGrandchildScale: Shadow Ball's size by its charge. The test marked withGameFiles
// reads your game files (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { chargeShotScale, isShadowBall, shadowBallScale } from "../src/render3d/shadow-ball.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

const MEWTWO = 16;

test("the ball's size is its recorded charge's, held or thrown, not its state's number", () => {
  assert.equal(isShadowBall(0x70), true);
  assert.equal(isShadowBall(0x90), true);
  assert.equal(isShadowBall(0x5e), false);
  for (const charge of [0, 1, 3, 7]) {
    const scale = 0.5 + 1.5 * charge / 7;
    assert.equal(shadowBallScale(0, charge, 7, 0.5, 2), scale);
    assert.equal(shadowBallScale(charge + 1, charge, 7, 0.5, 2), scale);
  }
  assert.equal(shadowBallScale(9, 7, 7, 0.5, 2), null);
  assert.equal(shadowBallScale(0, 0, 0, 0.5, 2), null);
});

test("the charge shot's size: whole charges of the most, in float32, between its two sizes", () => {
  const f = Math.fround;
  assert.equal(chargeShotScale(0, 7, 0.5, 2), f(0.5));
  assert.equal(chargeShotScale(7, 7, 0.5, 2), f(f(7 * f(f(1.5) / 7)) + 0.5));
  assert.equal(chargeShotScale(3, 7, 0.5, 2), f(f(3 * f(f(1.5) / 7)) + 0.5));
  // (past the most, the most; a charge not whole, its whole part; no most, 7)
  assert.equal(chargeShotScale(9, 7, 0.5, 2), chargeShotScale(7, 7, 0.5, 2));
  assert.equal(chargeShotScale(3.9, 7, 0.5, 2), chargeShotScale(3, 7, 0.5, 2));
  assert.equal(chargeShotScale(3, 0, 0.5, 2), chargeShotScale(3, 7, 0.5, 2));
  assert.equal(chargeShotScale(3, 7.5, 0.5, 2), chargeShotScale(3, 7, 0.5, 2));
  assert.equal(chargeShotScale(3, 7, 0, 2), null);
  assert.equal(chargeShotScale(3, 7, 0.5, 60), null);
});

test("game files: only the ball's first grandchild is scaled, after each pose", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const files = fighterFiles(MEWTWO, 0)!;
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const f = new Fighter(MEWTWO, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, motion, "test");
  for (const state of [0, 1, 8]) {
    const art = f.article(1, state)!;
    assert.ok(art?.special);
    const p = art.prop;
    const sk = p.skeleton;
    const child = sk.parent.findIndex((j) => j === 0);
    const grandchild = sk.parent.findIndex((j) => j === child);
    assert.ok(grandchild >= 0);
    const posed = (charge: number) => {
      p.pose(20, 10, 20, 0, art.scale);
      const root = Array.from(sk.scale.slice(0, 3));
      const scale = shadowBallScale(state, charge, f.specialAttr(0), art.special!(0x18), art.special!(0x1c))!;
      const place = Array.from(sk.trans.slice(grandchild * 3, grandchild * 3 + 3));
      // (held, state 0: its place the file's the other way, at Mewtwo's size)
      p.setGrandchildScale(scale, state === 0 ? f.modelScale : undefined);
      if (state === 0) {
        assert.deepEqual(Array.from(sk.trans.slice(grandchild * 3, grandchild * 3 + 3)), place.map((v) => Math.fround(-v * f.modelScale)));
      }
      assert.deepEqual(Array.from(sk.scale.slice(0, 3)), root);
      assert.deepEqual(Array.from(sk.scale.slice(grandchild * 3, grandchild * 3 + 3)), [Math.fround(scale), Math.fround(scale), Math.fround(scale)]);
      return Array.from(sk.world);
    };
    // (the same picture at full charge after a pose at none: nothing carried over from the draw before)
    const full = posed(7);
    posed(0);
    assert.deepEqual(posed(7), full);
  }
});
