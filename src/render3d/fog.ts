/* 3D replay viewer: GX's fog as the hardware has it.
 *
 * The game sets a stage's fog with HSD_FogSet, which hands GXSetFog the fog's
 * kind, start and end and the current camera's near and far
 * (HSD_CObjGetNear / HSD_CObjGetFar). GXSetFog does not send those numbers:
 * it works out the three of the hardware's formula and packs them into four
 * registers, truncating as it goes:
 *
 *   A = far near / ((far - near) (end - start)), sent divided by 2^(B's
 *       exponent + 1), as a float cut to 11 bits of mantissa
 *   B = far / (far - near), sent as a 24-bit magnitude (its mantissa in
 *       [0.5, 1] times 8388638, cut to a whole number) and a shift
 *   C = start / (end - start), cut to 11 bits of mantissa
 *
 * and the kind, whose field it ORs in unmasked (the perspective / orthographic
 * bit, bit 20, it always leaves 0: this SDK's GXSetFog takes every fog as a
 * perspective one). `gxSetFog` is that packing, step for step in single
 * precision as the SDK's C does it.
 *
 * The pixel engine then, at each pixel, from its 24-bit screen depth z:
 *
 *   ze  = A 2^24 / (B_mag - (z >> B_shift))       (perspective)
 *   ze  = A z / 2^24                              (orthographic)
 *   f   = clamp(ze - C, 0, 1), through the kind's curve (exp, exp2,
 *         reverse exp, reverse exp2: 2^(-8 f) and its kin)
 *   n   = f in 256ths, to the nearest
 *   rgb = (rgb (256 - n) + fog n) >> 8            (8-bit colors)
 *
 * `fogAmount8` and `fogBlend8` are that in TypeScript, FOG_GLSL is the same
 * for the fragment shader (renderer.ts), on the registers' own numbers. The
 * rules are the ones the GX documentation and Dolphin's pixel shader describe;
 * the code is our own.
 */

const f32 = Math.fround;

/** what GXSetFog writes: its five registers (fog0 A, fog1 B's magnitude, fog2 B's shift, fog3 C and the kind,
 *  the color), each with its register number in the top byte, and their fields as the hardware reads them */
export interface FogRegs {
  fog0: number; fog1: number; fog2: number; fog3: number; fogclr: number;
  /** A and C as the registers hold them (11-bit mantissas) */
  a: number; c: number;
  /** B's magnitude (24 bits) and shift (5 bits) */
  bMag: number; bShift: number;
  /** the projection bit (0 perspective) and the kind (GX_FOG_*, 3 bits; 0 none) */
  proj: number; fsel: number;
  /** the fog color, 0..255 */
  color: [number, number, number];
  /** the camera's near and far it was packed with (float32) */
  near: number; far: number;
}

const bits = new DataView(new ArrayBuffer(4));
const hexOf = (x: number) => { bits.setFloat32(0, x); return bits.getUint32(0); };
const floatOf = (h: number) => { bits.setUint32(0, h >>> 0); return bits.getFloat32(0); };

/** SET_REG_FIELD: the field's bits cleared, the value ORed in at its place, not masked (as __gx.h does it) */
const setField = (reg: number, size: number, shift: number, val: number) =>
  (((reg & ~(((1 << size) - 1) << shift)) | (val << shift)) >>> 0);

/** a register's 11-bit-mantissa float (fog0's A, fog3's C), as a float */
const regFloat = (reg: number) => floatOf((((reg >>> 19) & 1) << 31) | (((reg >>> 11) & 0xff) << 23) | ((reg & 0x7ff) << 12));

/** GXSetFog: the kind (GX_FOG_*), where it starts and ends, the camera's near and far, and its color (0..255),
 *  packed as the SDK packs them */
export function gxSetFog(type: number, startz: number, endz: number, nearz: number, farz: number,
                         color: [number, number, number]): FogRegs {
  startz = f32(startz); endz = f32(endz); nearz = f32(nearz); farz = f32(farz);
  let A: number, B: number, C: number;
  if (farz === nearz || endz === startz) {
    A = 0; B = 0.5; C = 0;
  } else {
    A = f32(f32(farz * nearz) / f32(f32(farz - nearz) * f32(endz - startz)));
    B = f32(farz / f32(farz - nearz));
    C = f32(startz / f32(endz - startz));
  }
  // B's mantissa into [0.5, 1] and its exponent (a u32 in the SDK)
  let bMant = B, bExpn = 0;
  while (bMant > 1.0) { bMant = f32(bMant * 0.5); bExpn = (bExpn + 1) >>> 0; }
  while (bMant > 0 && bMant < 0.5) { bMant = f32(bMant * 2); bExpn = (bExpn - 1) >>> 0; }
  // (1 << (B_expn + 1)) as the console shifts: slw takes the amount's low six bits, and 32 or more leaves 0
  const sh = ((bExpn + 1) >>> 0) & 63;
  const den = sh >= 32 ? 0 : (1 << sh) >>> 0;
  const a = f32(A / den);
  // (8.388638e6f * B_mant, then to a u32: fctiwz, toward zero)
  const bM = Math.trunc(f32(f32(8.388638e6) * bMant)) >>> 0;
  const bS = (bExpn + 1) >>> 0;
  let fog1 = setField(0, 24, 0, bM);
  fog1 = setField(fog1, 8, 24, 0xef);
  let fog2 = setField(0, 5, 0, bS);
  fog2 = setField(fog2, 8, 24, 0xf0);
  const aHex = hexOf(a), cHex = hexOf(C);
  let fog0 = setField(0, 11, 0, (aHex >>> 12) & 0x7ff);
  fog0 = setField(fog0, 8, 11, (aHex >>> 23) & 0xff);
  fog0 = setField(fog0, 1, 19, aHex >>> 31);
  fog0 = setField(fog0, 8, 24, 0xee);
  let fog3 = setField(0, 11, 0, (cHex >>> 12) & 0x7ff);
  fog3 = setField(fog3, 8, 11, (cHex >>> 23) & 0xff);
  fog3 = setField(fog3, 1, 19, cHex >>> 31);
  fog3 = setField(fog3, 1, 20, 0);
  fog3 = setField(fog3, 3, 21, type >>> 0);
  fog3 = setField(fog3, 8, 24, 0xf1);
  let fogclr = setField(0, 8, 0, color[2] & 0xff);
  fogclr = setField(fogclr, 8, 8, color[1] & 0xff);
  fogclr = setField(fogclr, 8, 16, color[0] & 0xff);
  fogclr = setField(fogclr, 8, 24, 0xf2);
  return {
    fog0, fog1, fog2, fog3, fogclr,
    a: regFloat(fog0), c: regFloat(fog3), bMag: fog1 & 0xffffff, bShift: fog2 & 0x1f,
    proj: (fog3 >>> 20) & 1, fsel: (fog3 >>> 21) & 7,
    color: [(fogclr >>> 16) & 0xff, (fogclr >>> 8) & 0xff, fogclr & 0xff],
    near: nearz, far: farz,
  };
}

/** A, B and C as the registers hold them (A: fog0's value times 2^B's shift; B: its magnitude over 8388638, times
 *  2^(shift - 1)), and the start and end they stand for with the camera's near: the range is near B / A, the start
 *  C times it (in double precision: what a reader of the registers works out, not what the hardware computes) */
export function fogDecoded(r: FogRegs): { a: number; b: number; c: number; start: number; end: number } {
  const a = r.a * 2 ** r.bShift, b = (r.bMag / 8388638) * 2 ** (r.bShift - 1), c = r.c;
  const range = a !== 0 ? (r.near * b) / a : 0;
  return { a, b, c, start: c * range, end: c * range + range };
}

/** no fog (HSD_FogSet with none: GXSetFog(GX_FOG_NONE, 0, 0, 0, 0, black)) */
export const NO_FOG: FogRegs = gxSetFog(0, 0, 0, 0, 0, [0, 0, 0]);

/** the camera's near and far from a GL projection (column major): a perspective one's, or an orthographic one's */
export function nearFar(p: ArrayLike<number>): [number, number] {
  if (p[11] === -1) return [f32(p[14] / (p[10] - 1)), f32(p[14] / (p[10] + 1))];
  return [f32((p[14] + 1) / p[10]), f32((p[14] - 1) / p[10])];
}

/** the fog's share at a pixel of 24-bit screen depth z, in 256ths (0..256): the pixel engine's formula on the
 *  registers' numbers, in single precision as a shader has it */
export function fogAmount8(r: FogRegs, z: number): number {
  if (r.fsel === 0) return 0;
  const ze = r.proj === 0 ? f32(f32(r.a * 16777216) / (r.bMag - (z >> r.bShift)))
    : f32(f32(r.a * z) / 16777216);
  let f = Math.min(Math.max(f32(ze - r.c), 0), 1);
  if (Number.isNaN(f)) f = 0;
  switch (r.fsel) {
    case 4: f = f32(1 - f32(2 ** f32(-8 * f))); break;
    case 5: f = f32(1 - f32(2 ** f32(f32(-8 * f) * f))); break;
    case 6: f = f32(2 ** f32(-8 * f32(1 - f))); break;
    case 7: { const g = f32(1 - f); f = f32(2 ** f32(f32(-8 * g) * g)); break; }
  }
  return Math.floor(f32(f * 256) + 0.5);
}

/** an 8-bit color with the fog laid on by its share n (0..256) */
export function fogBlend8(r: FogRegs, rgb: number[], n: number): number[] {
  return [0, 1, 2].map((i) => (rgb[i] * (256 - n) + r.color[i] * n) >> 8);
}

/** the fragment shader's fog (renderer.ts): the registers' fields as uniforms and the pixel engine's formula.
 *  gxFogAmount(z) is the share in 256ths at screen depth z; gxFog(c) lays it on the color (0..1) at the pixel */
export const FOG_GLSL = `// GX fog as GXSetFog packs it (fog.ts): the kind (0 none), B's magnitude, B's shift, the projection bit; A and C
uniform ivec4 uFogI;
uniform vec2 uFogF;
uniform ivec3 uFogColor;
int gxFogAmount(int z) {
  int fsel = uFogI.x;
  if (fsel == 0) return 0;
  float ze = uFogI.w == 0 ? (uFogF.x * 16777216.0) / float(uFogI.y - (z >> uFogI.z)) : (uFogF.x * float(z)) / 16777216.0;
  float f = clamp(ze - uFogF.y, 0.0, 1.0);
  if (fsel == 4) f = 1.0 - exp2(-8.0 * f);
  else if (fsel == 5) f = 1.0 - exp2(-8.0 * f * f);
  else if (fsel == 6) f = exp2(-8.0 * (1.0 - f));
  else if (fsel == 7) { float g = 1.0 - f; f = exp2(-8.0 * g * g); }
  return int(floor(f * 256.0 + 0.5));
}
// (the pixel's 24-bit depth: GL's depth range is GX's, 0 at near and 1 at far)
int gxDepth24() { return int(clamp(gl_FragCoord.z, 0.0, 1.0) * 16777215.0 + 0.5); }
// (on the color's bytes, as the TEV leaves them)
ivec3 gxFogI(ivec3 p) {
  if (uFogI.x == 0) return p;
  int n = gxFogAmount(gxDepth24());
  return (p * (256 - n) + uFogColor * n) >> 8;
}
vec3 gxFog(vec3 c) {
  if (uFogI.x == 0) return c;
  return vec3(gxFogI(ivec3(floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5)))) / 255.0;
}`;
