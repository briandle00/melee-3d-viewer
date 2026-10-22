// gxmath.ts against the decompilation's C versions of the same functions (tests/c/gxmath_ref.c: float, fmaf where
// the paired-single assembly or the -fp_contract on game code fuses), compiled here with the system's C compiler and
// run on the same random inputs: every result must be the same bits. Skipped without a C compiler.

import test from "node:test";
import assertNode from "node:assert/strict";
import * as G from "../src/render3d/gxmath.ts";
import { cosf, sinf, tanf } from "../src/render3d/fx/gamemath.ts";
import { cSkip, cleanC, runCFile } from "./cref.ts";

/** the C reference's results for these inputs (groups of float32s) */
function runC(fn: string, inputs: number[][]): Uint32Array {
  const flat = new Float32Array(inputs.flat());
  const out = runCFile("gxmath_ref", new Uint8Array(flat.buffer), [fn]);
  return new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

const bitsOf = (xs: number[]): number[] => Array.from(new Uint32Array(new Float32Array(xs).buffer));

// a seeded random stream (the same inputs every run)
let seed = 0x1234567;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const f = (lo: number, hi: number) => Math.fround(lo + (hi - lo) * rnd());
const vec = (n: number, lo: number, hi: number) => Array.from({ length: n }, () => f(lo, hi));
/** a matrix that turns, scales a little and moves */
const mtx = () => [...vec(3, -2, 2), f(-300, 300), ...vec(3, -2, 2), f(-300, 300), ...vec(3, -2, 2), f(-300, 300)];

const N = 4000;

/** compare: the TS results for each input, flattened, with the C's */
function same(fn: string, inputs: number[][], ts: (a: number[]) => number[]) {
  const want = runC(fn, inputs);
  const got = bitsOf(inputs.flatMap(ts));
  assertNode.equal(got.length, want.length, `${fn}: result count`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) {
      const per = got.length / inputs.length, k = Math.floor(i / per);
      const asF = (u: number) => new Float32Array(new Uint32Array([u]).buffer)[0];
      assertNode.fail(`${fn}: input ${k} (${inputs[k]}) result ${i % per}: ts ${asF(got[i])} (${got[i].toString(16)}) c ${asF(want[i])} (${want[i].toString(16)})`);
    }
  }
}

const skip = cSkip("gxmath_ref");
const M = (a: number[], o = 0) => Float32Array.from(a.slice(o, o + 12));

test("madd rounds once, even where the double sum lands on a float's half-way point", { skip }, () => {
  const ins: number[][] = [];
  for (let i = 0; i < N; i++) ins.push(vec(3, -100, 100));
  // made to tie: c a float, a b a hair under half its last place ((1 + 2^-20)(1 - 2^-20) = 1 - 2^-40 of it), so
  // the double sum rounds to exactly the half-way point and only the exact sum says it is below
  for (let i = 0; i < N; i++) {
    const c = f(-1000, 1000), e = Math.floor(Math.log2(Math.abs(c)));
    const half = 2 ** (e - 24);
    ins.push([Math.fround(1 + 2 ** -20), Math.fround((1 - 2 ** -20) * half * (rnd() < 0.5 ? 1 : -1)), c]);
  }
  same("madd", ins, ([a, b, c]) => [G.madd(a, b, c)]);
  // (and some of those do tie in the double: the correction is what makes them agree)
  const ties = ins.filter(([a, b, c]) => { const s = a * b + c; return Math.fround(s) !== s && G.madd(a, b, c) !== Math.fround(s); });
  assertNode.ok(ties.length > 0, "no input tied: the test does not reach the correction");
});

test("frsqrte and fres are the Gekko's estimates", { skip }, () => {
  const ins = Array.from({ length: N }, () => [Math.fround(Math.exp(f(-30, 30)))]);
  const want = runC("frsqrte", ins);
  const F = new Float64Array(1), U = new Uint32Array(F.buffer);
  ins.forEach(([x], k) => {
    F[0] = G.frsqrte(x);
    assertNode.deepEqual([U[0], U[1]], [want[k * 2], want[k * 2 + 1]], `frsqrte(${x})`);
  });
  same("fres", ins.map(([x]) => [rnd() < 0.5 ? -x : x]), ([x]) => [G.fres(x)]);
});

test("MSL's sinf, cosf, tanf and sqrtf", { skip }, () => {
  const ang = Array.from({ length: N }, () => [f(-20, 20)]);
  same("sinf", ang, ([x]) => [sinf(x)]);
  same("cosf", ang, ([x]) => [cosf(x)]);
  same("tanf", ang.map(([x]) => [x / 16]), ([x]) => [tanf(x)]);
  same("sqrtf", Array.from({ length: N }, () => [Math.fround(Math.exp(f(-20, 20)))]), ([x]) => [G.sqrtf(x)]);
});

test("the vector functions", { skip }, () => {
  const v6 = Array.from({ length: N }, () => vec(6, -50, 50));
  same("normalize", v6.map((v) => v.slice(0, 3)), (v) => Array.from(G.PSVECNormalize(v, [0, 0, 0])));
  same("mag", v6.map((v) => v.slice(0, 3)), (v) => [G.PSVECMag(v)]);
  same("cross", v6, (v) => Array.from(G.PSVECCrossProduct(v.slice(0, 3), v.slice(3), [0, 0, 0])));
  same("dot", v6, (v) => [G.PSVECDotProduct(v.slice(0, 3), v.slice(3))]);
});

test("PSMTXConcat, PSMTXMultVec, PSMTXMultVecSR, PSMTXInverse", { skip }, () => {
  const two = Array.from({ length: N }, () => [...mtx(), ...mtx()]);
  same("concat", two, (a) => Array.from(G.PSMTXConcat(M(a), M(a, 12), new Float32Array(12))));
  const mv = Array.from({ length: N }, () => [...mtx(), ...vec(3, -100, 100)]);
  same("multvec", mv, (a) => Array.from(G.PSMTXMultVec(M(a), a.slice(12), [0, 0, 0])));
  same("multvecsr", mv, (a) => Array.from(G.PSMTXMultVecSR(M(a), a.slice(12), [0, 0, 0])));
  same("inverse", two.map((a) => a.slice(0, 12)), (a) => {
    const inv = new Float32Array(12);
    const ok = G.PSMTXInverse(M(a), inv);
    return [ok, ...inv];
  });
});

test("PSMTXQuat and PSMTXRotAxisRad", { skip }, () => {
  same("quat", Array.from({ length: N }, () => vec(4, -1, 1)), (q) => Array.from(G.PSMTXQuat(new Float32Array(12), q)));
  same("rotaxis", Array.from({ length: N }, () => [...vec(3, -1, 1), f(-7, 7)]),
       (a) => Array.from(G.PSMTXRotAxisRad(new Float32Array(12), a.slice(0, 3), a[3])));
});

test("C_MTXLookAt, the camera's viewing matrix, and the projections", { skip }, () => {
  const look = Array.from({ length: N }, () => [...vec(3, -300, 300), ...vec(3, -1, 1), ...vec(3, -50, 50)]);
  same("lookat", look, (a) => Array.from(G.C_MTXLookAt(new Float32Array(12), a.slice(0, 3), a.slice(3, 6), a.slice(6))));
  // (the game's camera: an eye behind and above what it looks at, rolled or not)
  const cam = Array.from({ length: N }, () => [f(-100, 100), f(-50, 150), f(50, 600), f(-80, 80), f(-30, 60), f(-5, 5),
                                               rnd() < 0.5 ? 0 : f(-0.5, 0.5)]);
  same("view", cam, (a) => Array.from(G.cobjViewingMtx(new Float32Array(12), a.slice(0, 3), a.slice(3, 6), a[6])));
  same("perspective", Array.from({ length: N }, () => [f(10, 120), f(0.5, 2), f(0.05, 10), f(100, 20000)]),
       (a) => Array.from(G.C_MTXPerspective(new Float32Array(16), a[0], a[1], a[2], a[3])));
  const box = () => { const t = f(1, 500), l = f(-500, -1); return [t, -t * f(0.5, 1.5), l, -l * f(0.5, 1.5), f(0.01, 10), f(100, 30000)]; };
  same("ortho", Array.from({ length: N }, box), (a) => Array.from(G.C_MTXOrtho(new Float32Array(16), a[0], a[1], a[2], a[3], a[4], a[5])));
  same("frustum", Array.from({ length: N }, box), (a) => Array.from(G.C_MTXFrustum(new Float32Array(16), a[0], a[1], a[2], a[3], a[4], a[5])));
});

test("HSD_MtxSRT, HSD_MtxSRTQuat, HSD_MtxScaledAdd, HSD_MtxGetScale, HSD_MtxInverseConcat", { skip }, () => {
  const srt = Array.from({ length: N }, () => [...vec(3, 0.2, 3), ...vec(3, -7, 7), ...vec(3, -50, 50), ...vec(3, 0.2, 3),
                                               rnd() < 0.5 ? 1 : 0]);
  same("srt", srt, (a) => Array.from(G.HSD_MtxSRT(new Float32Array(12), a.slice(0, 3), a.slice(3, 6), a.slice(6, 9),
                                                   a[12] ? a.slice(9, 12) : null)));
  const sq = Array.from({ length: N }, () => [...vec(3, 0.2, 3), ...vec(4, -1, 1), ...vec(3, -50, 50), ...vec(3, 0.2, 3),
                                              rnd() < 0.5 ? 1 : 0]);
  same("srtquat", sq, (a) => Array.from(G.HSD_MtxSRTQuat(new Float32Array(12), a.slice(0, 3), a.slice(3, 7), a.slice(7, 10),
                                                         a[13] ? a.slice(10, 13) : null)));
  same("scaledadd", Array.from({ length: N }, () => [...mtx(), ...mtx(), f(0, 1)]),
       (a) => Array.from(G.HSD_MtxScaledAdd(M(a), M(a, 12), new Float32Array(12), a[24])));
  same("invxpose", Array.from({ length: N }, () => mtx()), (a) => Array.from(G.HSD_MtxInverseTranspose(M(a), new Float32Array(12))));
  same("getscale", Array.from({ length: N }, () => mtx()), (a) => Array.from(G.HSD_MtxGetScale(M(a), [0, 0, 0])));
  same("invconcat", Array.from({ length: N }, () => [...mtx(), ...mtx()]),
       (a) => Array.from(G.HSD_MtxInverseConcat(M(a), M(a, 12), new Float32Array(12))));
});

test("HSD_MkRotationMtx and MakeTextureMtx (a texture's matrix)", { skip }, () => {
  same("mkrot", Array.from({ length: N }, () => vec(3, -7, 7)), (a) => Array.from(G.HSD_MkRotationMtx(new Float32Array(12), a)));
  // (scales near 0 too, repeats 1 to 8, wrap clamp, repeat or mirror)
  const tex = Array.from({ length: N }, () => [...vec(3, -3, 3), f(-4, 4), rnd() < 0.05 ? 0 : f(-4, 4), f(0.5, 2), ...vec(3, -7, 7),
                                               1 + Math.floor(rnd() * 8), 1 + Math.floor(rnd() * 8), Math.floor(rnd() * 3)]);
  same("texmtx", tex, (a) => Array.from(G.MakeTextureMtx(new Float32Array(12), a.slice(0, 3), a.slice(3, 6), a.slice(6, 9), a[9], a[10], a[11])));
});

test("the billboards: mkBillBoardMtx, mkVBillBoardMtx, mkHBillBoardMtx, mkRBillBoardMtx", { skip }, () => {
  // (a modelview: the joint in front of the camera, z negative)
  const ins = Array.from({ length: N }, () => {
    const m = mtx();
    m[11] = f(-500, -20);
    return [...m, [0x200, 0x400, 0x600, 0x800][Math.floor(rnd() * 4)], rnd() < 0.5 ? 1 : 0, f(-7, 7)];
  });
  same("billboard", ins, (a) => Array.from(G.mkBillBoardMtx(a[12], !!a[13], a[14], M(a), new Float32Array(12))));
});

test("the matrices move to and from GL's column-major 4 x 4s unchanged", () => {
  const m = Float32Array.from(mtx());
  const gl = G.mtxToGL(m, new Float32Array(16));
  assertNode.deepEqual(Array.from(gl.slice(12, 16)), [m[3], m[7], m[11], 1]);
  assertNode.deepEqual(Array.from(G.mtxFromGL(gl, new Float32Array(12))), Array.from(m));
  // a GX projection's depth row, as GL takes it: 2 z + w
  const p = G.C_MTXPerspective(new Float32Array(16), 30, 1.2173333, 0.1, 16384);
  const g = G.projectionToGL(p, new Float32Array(16));
  assertNode.equal(g[11], -1);
  assertNode.equal(g[10], Math.fround(2 * p[10] - 1));
});

test.after?.(cleanC);

test("PSMTXConcat's zero signs: Unit01's 0 times the translation goes into column 2 alone", () => {
  // (a facing turn's row (-0.97, -0, ~0, 0) down an identity: column 1 is -0 + -0 + -0, with nothing after it;
  // column 2 of a row with a positive translation ends -0 + 0 * 5 = +0, as ps_madds1 by Unit01 makes it)
  const a = new Float32Array([-1, -0, -0, 5, 0, 1, 0, 0, -0.97, -0, -5.4e-8, 0]);
  const id = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const m = G.PSMTXConcat(a, id, new Float32Array(12));
  assertNode.ok(Object.is(m[9], -0), "row 2 column 1");
  assertNode.ok(Object.is(m[1], -0), "row 0 column 1");
  assertNode.ok(Object.is(m[2], 0), "row 0 column 2");
});
