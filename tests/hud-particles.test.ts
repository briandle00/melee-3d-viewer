// The HUD's particles (a lost stock's burst, particle list 1) are drawn through the HUD's own camera, a perspective
// one: a direction or trail particle is turned by where that camera's projection puts it and where it was
// (psdisp.c psDispSub, prj[0] == 0), not by its velocity in the HUD's plane. Until 2026-11-09 the HUD handed the
// particles no projection: the bursts' quads a few degrees off, their boxes 2 to 10 pixels off the game's in every
// KO window.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Particle } from "../src/render3d/fx/particles.ts";
import { K } from "../src/render3d/fx/particles.ts";
import { buildParticles, FLOATS } from "../src/render3d/fx/draw.ts";
import { gameProjection, gameView } from "../src/render3d/camera.ts";
import { mul } from "../src/render3d/math.ts";

test("every HUD particle draw is through the HUD camera's projection", () => {
  const src = readFileSync(new URL("../src/render3d/hud.ts", import.meta.url), "utf8");
  const calls = src.match(/buildParticles\([^;]*\);/g) ?? [];
  assert.ok(calls.length >= 2, "the bursts, tracked and not");
  for (const c of calls) assert.match(c, /this\.particleAxes\(\)/, c);
});

test("a direction particle under the HUD's perspective camera turns as the projection puts its motion", () => {
  // (the HUD camera of IfAll: the eye 64 out, a narrow fov, the picture's 73:60)
  const proj = new Float32Array(16), gx = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  gameProjection(proj, gx, 49.6, 73 / 60, 1, 32768);
  gameView(view, [0, 0, 64], [0, 0, 0]);
  mul(vp, proj, view);
  const p = {
    kind: K.DIRVEC, px: -20, py: -14, pz: 2, vx: 0.75, vy: -1.0, vz: 0.5, size: 4, rotate: 0, dead: false, srt: null,
    prim: { r: 255, g: 255, b: 255, a: 255 }, primTarget: { r: 255, g: 255, b: 255, a: 255 }, primRemain: 0, primCount: 0,
    env: { r: 0, g: 0, b: 0, a: 0 }, envTarget: { r: 0, g: 0, b: 0, a: 0 }, envRemain: 0, envCount: 0,
    aCmpMode: 0, aCmp1: 0, aCmp2: 255, aCmp1Target: 0, aCmp2Target: 255, aCmpRemain: 0, aCmpCount: 0, trail: 1,
    texGroup: 0, pose: 0, bank: { image: () => null },
  } as unknown as Particle;
  const axes = { right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]] };
  const flat = buildParticles([p], axes).data.slice(0, 4 * FLOATS);
  const seen = buildParticles([p], { ...axes, viewProj: vp, view }).data.slice(0, 4 * FLOATS);
  // the corner's way from the middle: the projected motion's angle (psDispSub: atan2 of the motion's x and y as
  // the projection has them, each over its own depth)
  const angle = (d: Float32Array) => Math.atan2(d[1] - p.py, d[0] - p.px);
  const c = [p.px, p.py, p.pz], q = [p.px - p.vx, p.py - p.vy, p.pz - p.vz];
  const ndc = (x: number[]) => { const w = vp[3] * x[0] + vp[7] * x[1] + vp[11] * x[2] + vp[15];
    return [(vp[0] * x[0] + vp[4] * x[1] + vp[8] * x[2] + vp[12]) / w, (vp[1] * x[0] + vp[5] * x[1] + vp[9] * x[2] + vp[13]) / w]; };
  const [a, b] = [ndc(c), ndc(q)];
  const want = Math.atan2(a[0] - b[0], a[1] - b[1]);
  const plain = Math.atan2(p.vx, p.vy);
  assert.ok(Math.abs(want - plain) > 0.05, "the projection turns the motion");
  // (the quad's first corner is the turned basis's -R: its angle from the middle moves with the turn)
  assert.ok(Math.abs((angle(seen) - angle(flat)) - (plain - want)) < 1e-3 ||
            Math.abs((angle(seen) - angle(flat)) + (plain - want)) < 1e-3, `${angle(seen)} ${angle(flat)} ${want} ${plain}`);
});
