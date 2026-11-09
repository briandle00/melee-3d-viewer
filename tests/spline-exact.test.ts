// A track's curves and a spline's points as the game works them out, bit for bit: hsd.ts's splGetHelmite (a curved
// key's value: FObjUpdateAnim), splArcLengthGetParameter and splGetSplinePoint (a PATH track's point, Fountain of
// Dreams' moving light) and gxmath.ts's MTXLightPerspective (the stage mirror's texture matrix), against
// tests/c/gxmath_ref.c's C versions of them (the decompilation's C, fmaf where the game's code fuses), on the same
// random inputs. Every result must be the same bits. Skipped without a C compiler.

import test from "node:test";
import assertNode from "node:assert/strict";
import { type Spline, sample, splArcLengthGetParameter, splGetHelmite, splGetSplinePoint } from "../src/render3d/hsd.ts";
import { MTXLightPerspective, madd } from "../src/render3d/gxmath.ts";
import { cSkip, runCFile } from "./cref.ts";

const skip = cSkip("gxmath_ref");

let seed = 0x2468ace;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const f = (lo: number, hi: number) => Math.fround(lo + (hi - lo) * rnd());
const bitsOf = (xs: number[]): number[] => Array.from(new Uint32Array(new Float32Array(xs).buffer));

function same(fn: string, inputs: number[][], ts: (a: number[]) => number[]) {
  const flat = new Float32Array(inputs.flat());
  const out = runCFile("gxmath_ref", new Uint8Array(flat.buffer), [fn]);
  const want = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
  const got = bitsOf(inputs.flatMap(ts));
  assertNode.equal(got.length, want.length, `${fn}: result count`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) {
      const per = got.length / inputs.length, k = Math.floor(i / per);
      const asF = (u: number) => new Float32Array(new Uint32Array([u]).buffer)[0];
      assertNode.fail(`${fn}: input ${k} result ${i % per}: ts ${asF(got[i])} c ${asF(want[i])}`);
    }
  }
}

test("splGetHelmite: a curved key's value", { skip }, () => {
  const ins: number[][] = [];
  for (let i = 0; i < 4000; i++) {
    const wait = 1 + Math.floor(rnd() * 300);
    ins.push([Math.fround(1 / wait), Math.floor(rnd() * wait), f(-200, 200), f(-200, 200), f(-3, 3), f(-3, 3)]);
  }
  same("helmite", ins, (a) => [splGetHelmite(a[0], a[1], a[2], a[3], a[4], a[5])]);
});

/** a random spline of 5 control points (the Bezier's 13), its segment table and its quartics */
function spline(type: number): { s: Spline; flat: number[] } {
  const n = 5;
  const cv = Array.from({ length: 39 }, () => f(-150, 150));
  const seg = [0, f(0.1, 0.3), f(0.35, 0.55), f(0.6, 0.8), 1];
  // (a speed squared that stays above 0: the sum of squares' shape)
  const poly = Array.from({ length: 20 }, (_, i) => (i % 5 === 4 ? f(100, 9000) : f(0, 2000)));
  const total = f(100, 1000), tension = f(0, 1);
  const s: Spline = { type, n, tension, cv: new Float32Array(cv), total, seg: new Float32Array(seg), poly: new Float32Array(poly) };
  return { s, flat: [type, n, tension, total, ...cv, ...seg, ...poly] };
}

test("splArcLengthGetParameter and splGetSplinePoint: a point a share of the way along each kind of spline", { skip }, () => {
  for (const type of [0, 1, 2, 3]) {
    const ins: number[][] = [], splines: Spline[] = [];
    for (let i = 0; i < 400; i++) {
      const { s, flat } = spline(type);
      // (the ends and the shares between)
      const share = i % 40 === 0 ? 0 : i % 40 === 1 ? 1 : f(0, 1);
      ins.push([...flat, share]);
      splines.push(s);
    }
    let k = 0;
    same("spline", ins, (a) => {
      const s = splines[k++], p = [0, 0, 0];
      const u = splArcLengthGetParameter(s, a[68]);
      splGetSplinePoint(p, s, u);
      return [...p, u];
    });
  }
});

test("MTXLightPerspective: the mirror's texture projection", { skip }, () => {
  const ins: number[][] = [];
  for (let i = 0; i < 2000; i++) ins.push([f(10, 120), f(0.5, 2), f(-1, 1), f(-1, 1), f(-1, 1), f(-1, 1)]);
  ins.push([30, Math.fround(1.2173333168029785), 0.49, -0.49, 0.5, 0.5]);
  same("lightpersp", ins, (a) => Array.from(MTXLightPerspective(new Float32Array(12), a[0], a[1], a[2], a[3], a[4], a[5])));
});

test("a straight key: (p1 - p0) / wait, then that times the time plus p0 in one rounding (FObjUpdateAnim)", () => {
  const keys = [{ time: 0, duration: 3, kind: 1 as const, p0: 0.1, p1: 0.7, d0: 0, d1: 0 }].map((k) =>
    ({ ...k, p0: Math.fround(k.p0), p1: Math.fround(k.p1) }));
  const slope = Math.fround(Math.fround(keys[0].p1 - keys[0].p0) / 3);
  for (const t of [0, 1, 2, 3]) assertNode.equal(sample(keys, t), madd(slope, t, keys[0].p0));
  // (not the double's p0 + (p1 - p0) t / wait: frame 1's differs in its last place)
  assertNode.notEqual(sample(keys, 1), Math.fround(keys[0].p0 + (keys[0].p1 - keys[0].p0) / 3));
});
