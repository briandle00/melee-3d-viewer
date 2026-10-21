// camera.ts's float32 camera steps against the decompilation's C for them (tests/c/camera_ref.c: float, fmaf where
// the -fp_contract on game code fuses), compiled here and run on the same random inputs: every result the same
// bits. Skipped, with the reason, without a C compiler that builds it.

import test from "node:test";
import assertNode from "node:assert/strict";
import { cameraAim, cameraCorrect, lbSin, lbVectorNormalize, lbVectorRotate, type StageCamera } from "../src/render3d/camera.ts";
import { atan2f } from "../src/render3d/fx/gamemath.ts";
import { madd, msub } from "../src/render3d/gxmath.ts";
import { cSkip, cleanC, runCFile } from "./cref.ts";

const f32 = Math.fround;
const skip = cSkip("camera_ref");

function runC(fn: string, inputs: number[][]): Uint32Array {
  const flat = new Float32Array(inputs.flat());
  const out = runCFile("camera_ref", new Uint8Array(flat.buffer), [fn]);
  return new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}
const bitsOf = (xs: number[]) => Array.from(new Uint32Array(new Float32Array(xs).buffer));
function same(fn: string, inputs: number[][], ts: (a: number[]) => number[]) {
  const want = runC(fn, inputs), got = bitsOf(inputs.flatMap(ts));
  assertNode.equal(got.length, want.length, `${fn}: result count`);
  const per = got.length / inputs.length;
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) assertNode.fail(`${fn}: input ${Math.floor(i / per)} (${inputs[Math.floor(i / per)]}) result ${i % per}: ts ${got[i].toString(16)} c ${want[i].toString(16)}`);
  }
}

let seed = 0x2468ace;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const f = (lo: number, hi: number) => f32(lo + (hi - lo) * rnd());
const N = 3000;

const stageOf = (p: number[]): StageCamera => ({
  left: p[0], right: p[1], top: p[2], bottom: p[3], cx: p[4], cy: p[5], near: p[6], far: p[7], pitchK: p[8], yawK: p[9],
  pan: p[10], blast: { left: 0, right: 0, top: 0, bottom: 0 }, quakes: [], trackRatio: 1, smooth: 1, fixedZoom: 1, fov: 30,
});

test("lbvector's sine, turns and normalize, and MSL's atan2f", { skip }, () => {
  same("lbsin", Array.from({ length: N }, () => [f(-7, 7)]), ([a]) => [lbSin(a)]);
  same("rotate", Array.from({ length: N }, () => [f(-2, 2), f(-2, 2), f(-2, 2), [1, 2, 4][Math.floor(rnd() * 3)], f(-3.1, 3.1)]),
       (a) => lbVectorRotate(a.slice(0, 3), a[3] as 1 | 2 | 4, a[4]));
  same("normalize", Array.from({ length: N }, () => [f(-50, 50), f(-50, 50), f(-50, 50)]), (a) => { const v = a.slice(); lbVectorNormalize(v); return v; });
  same("atan2", Array.from({ length: N }, () => [f(-5, 5), f(-5, 5)]), ([y, x]) => [atan2f(y, x)]);
});

test("Camera_80029CF8: the target the box asks for", { skip }, () => {
  const ins = Array.from({ length: N }, () => {
    const x0 = f(-150, 100), y0 = f(-80, 80);
    return [f(-20, 20), f(-10, 40), f(100, 150), f(600, 900), f(0.01, 0.03), f(0.005, 0.02), rnd() < 0.5 ? 0 : f(-3, 3),
            x0, f32(x0 + f(1, 250)), y0, f32(y0 + f(1, 200)), f(25, 45)];
  });
  same("aim", ins, (a) => {
    const ti = [0, 0, 0], tp = [0, 0, 0];
    cameraAim(stageOf([0, 0, 0, 0, a[0], a[1], a[2], a[3], a[4], a[5], a[6]]), a[7], a[8], a[9], a[10], a[11], ti, tp);
    return [ti[0], ti[1], tp[0], tp[1], tp[2]];
  });
});

test("Camera_8002A768: the picture's corners held in the camera range", { skip }, () => {
  const ins = Array.from({ length: N }, () => {
    const px = f(-120, 120), py = f(-20, 120);
    return [f(-200, -60), f(60, 200), f(80, 200), f(-120, -20), px, py, f(100, 700), f32(px + f(-30, 30)), f32(py - f(0, 60)), 0,
            f(0.2, 0.35)];
  });
  same("correct", ins, (a) => {
    const pos = a.slice(4, 7), it = a.slice(7, 10);
    cameraCorrect(stageOf([a[0], a[1], a[2], a[3], 0, 0, 0, 0, 0, 0, 0]), pos, it, a[10]);
    return [...pos, ...it];
  });
  // (and some of them are moved: the test reaches the correction)
  const moved = ins.filter((a) => { const p = a.slice(4, 7), it = a.slice(7, 10);
    cameraCorrect(stageOf([a[0], a[1], a[2], a[3], 0, 0, 0, 0, 0, 0, 0]), p, it, a[10]); return p[0] !== a[4] || p[1] !== a[5]; });
  assertNode.ok(moved.length > N / 10, `moved ${moved.length}`);
});

test("the operation order of lbVector_Sin, by hand: the cubic term subtracted from the fused linear one, the quintic fused in", () => {
  const a = f32(0.75);
  const a3 = f32(f32(f32(f32(0.15527099370956421) * a) * a) * a);
  const a4 = f32(f32(f32(f32(f32(0.0056429998949170113) * a) * a) * a) * a);
  // (0.98786199 a - a3, rounded once; then a a4 + that, rounded once)
  const lin = msub(f32(0.9878619909286499), a, a3);
  assertNode.equal(lbSin(a), madd(a, a4, lin));
  // the turn about x by a quarter: (0, 1, 0) to about (0, 0, 1) - about: the quintics are the game's, a part in
  // fifty off at a quarter turn (cos 0.25 turn -0.016, sin 1.0039)
  const v = lbVectorRotate([0, 1, 0], 1, f32(Math.PI / 2));
  assertNode.equal(v[1], msub(1, lbSin(f32(f32(Math.PI / 2) + Math.PI / 2)), f32(0 * lbSin(f32(Math.PI / 2)))));
  assertNode.ok(Math.abs(v[2] - 1) < 0.005 && Math.abs(v[1]) < 0.02, `${v}`);
});

test.after?.(cleanC);
