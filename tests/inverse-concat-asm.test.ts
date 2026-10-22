// gxmath.ts HSD_MtxInverseConcat against the game's own instruction stream for it: the old disassembly of
// sysdolphin/baselib/mtx.s (doldecomp/melee before the relink 8e5068d3), transcribed here instruction for
// instruction - each fmuls, fmadds, fmsubs, fnmsubs, fdivs and fadds on its registers - as a second, independent
// account of the operation order. Run on synthetic matrices; every result must be the same bits.

import test from "node:test";
import assertNode from "node:assert/strict";
import { HSD_MtxInverseConcat, f32, madd } from "../src/render3d/gxmath.ts";

// the PowerPC's single-precision instructions (fmadds frD, frA, frC, frB: A * C + B rounded once)
const fmuls = (a: number, c: number) => f32(a * c);
const fmadds = (a: number, c: number, b: number) => madd(a, c, b);
const fmsubs = (a: number, c: number, b: number) => madd(a, c, -b);
const fnmsubs = (a: number, c: number, b: number) => -madd(a, c, -b);
const fdivs = (a: number, b: number) => f32(a / b);
const fadds = (a: number, b: number) => f32(a + b);

/** HSD_MtxInverseConcat as its disassembly runs it (r3 inv, r4 src, r5 dest; offsets in floats) */
function asm(r3: Float32Array, r6: Float32Array): Float32Array | "copy" {
  const L = (m: Float32Array, byteOff: number) => m[byteOff / 4];
  let f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13;
  f10 = L(r3, 0x18); f1 = L(r3, 4); f2 = L(r3, 0x10);
  f0 = fmuls(f1, f10); f5 = L(r3, 0x20); f3 = L(r3, 0x14);
  f4 = fmuls(f2, f1); f9 = L(r3, 0); f1 = fmuls(f9, f3); f6 = L(r3, 8);
  f0 = fmuls(f5, f0); f7 = L(r3, 0x28); f2 = fmuls(f6, f2);
  f1 = fmadds(f7, f1, f0); f8 = L(r3, 0x24); f3 = fmuls(f5, f3);
  f5 = fmuls(f9, f8);
  f1 = fmadds(f8, f2, f1); f1 = fnmsubs(f6, f3, f1); f1 = fnmsubs(f7, f4, f1); f2 = fnmsubs(f10, f5, f1);
  // (its size against 1e-10, 0x2EDBE6FF: below it, or NaN, src is copied)
  if (!(Math.abs(f2) >= f32(1e-10))) return "copy";
  f1 = 1; f0 = L(r3, 0x14);
  const f31 = fdivs(f1, f2);
  let f30 = L(r3, 8); f5 = L(r3, 0x20); let f29 = L(r3, 0x24); f1 = L(r3, 0x18); f2 = L(r3, 4); f3 = L(r3, 0x10);
  let f26 = fmuls(f0, f30); f6 = fmuls(f5, f0); f12 = fmuls(f29, f1); f13 = L(r3, 0x28); f11 = fmuls(f29, f30);
  f4 = L(r3, 0); f10 = fmuls(f5, f1); f8 = fmuls(f5, f30); f7 = L(r3, 0x1c); f5 = fmuls(f5, f2); f9 = L(r3, 0xc);
  let f28 = fmsubs(f0, f13, f12); let f27 = fnmsubs(f2, f13, f11); f11 = L(r3, 0x2c);
  f10 = fnmsubs(f3, f13, f10); f8 = fmsubs(f4, f13, f8); f13 = fmsubs(f3, f29, f6); f12 = fnmsubs(f4, f29, f5);
  f6 = fmuls(f31, f28); f5 = fmuls(f31, f27); f10 = fmuls(f31, f10); f8 = fmuls(f31, f8);
  f27 = fmuls(f3, f30); f13 = fmuls(f31, f13); f12 = fmuls(f31, f12); f3 = fmuls(f3, f2);
  f26 = fmsubs(f2, f1, f26); f27 = fnmsubs(f4, f1, f27); f28 = fmsubs(f4, f0, f3);
  f29 = -f6; f1 = fmuls(f5, f7); f30 = -f10; f2 = fmuls(f8, f7); f4 = -f13; f3 = fmuls(f12, f7);
  f0 = fmuls(f31, f26); f29 = fmsubs(f29, f9, f1); f1 = fmuls(f31, f27); f30 = fmsubs(f30, f9, f2);
  f2 = fmuls(f31, f28); f7 = fmsubs(f4, f9, f3);
  f3 = fnmsubs(f0, f11, f29); f4 = fnmsubs(f1, f11, f30); f7 = fnmsubs(f2, f11, f7);
  // dest's rows: (f6, f5, f0) + f3, (f10, f8, f1) + f4, (f13, f12, f2) + f7
  const out = new Float32Array(12);
  const rows: [number, number, number, number][] = [[f6, f5, f0, f3], [f10, f8, f1, f4], [f13, f12, f2, f7]];
  rows.forEach(([a, b, c, t], r) => {
    for (let k = 0; k < 4; k++) {
      let v = fmuls(b, L(r6, 0x10 + k * 4));
      v = fmadds(a, L(r6, k * 4), v);
      v = fmadds(c, L(r6, 0x20 + k * 4), v);
      out[r * 4 + k] = k === 3 ? fadds(t, v) : v;
    }
  });
  return out;
}

let seed = 0x5eed;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const mtx = () => Float32Array.from({ length: 12 }, (_, i) => f32((i % 4 === 3 ? 400 : 4) * (rnd() - 0.5)));
const bits = (a: ArrayLike<number>) => Array.from(new Uint32Array(Float32Array.from(a).buffer));

test("HSD_MtxInverseConcat is the disassembly's instruction stream, bit for bit", () => {
  for (let n = 0; n < 20000; n++) {
    const inv = mtx(), src = mtx();
    const want = asm(inv, src), got = HSD_MtxInverseConcat(inv, src, new Float32Array(12));
    assertNode.deepEqual(bits(got), bits(want === "copy" ? src : want), `case ${n}`);
  }
});

test("a fixed vector from the asm: a turn, a scale and a move inverted onto another matrix", () => {
  const inv = Float32Array.of(0, -2, 0, 3, 1, 0, 0, -1, 0, 0, 0.5, 7);
  const src = Float32Array.of(1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30);
  const got = HSD_MtxInverseConcat(inv, src, new Float32Array(12));
  assertNode.deepEqual(bits(got), bits(asm(inv, src) as Float32Array));
  // (inverse(inv) maps inv's move back: x = y' + 1, y = -(x' - 3) / 2, z = 2 (z' - 7), then src's move)
  assertNode.deepEqual(Array.from(got), [0, 1, 0, 21, -0.5, 0, 0, -3.5, 0, 0, 2, 46]);
});

test("a determinant below 1e-10, or NaN, copies src (fcmpo, bge)", () => {
  const src = mtx();
  const flat = new Float32Array(12);
  assertNode.deepEqual(Array.from(HSD_MtxInverseConcat(flat, src, new Float32Array(12))), Array.from(src));
  const nan = mtx(); nan[0] = NaN;
  assertNode.deepEqual(Array.from(HSD_MtxInverseConcat(nan, src, new Float32Array(12))), Array.from(src));
});
