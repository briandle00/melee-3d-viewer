/* 3D replay viewer: the GameCube's matrix arithmetic, bit for bit.
 *
 * The game computes its matrices in single precision on the Gekko: the
 * Dolphin SDK's matrix and vector functions are paired-single assembly
 * (mtx.c, mtxvec.c, vec.c: PSMTXConcat, PSMTXMultVec, PSVECNormalize ...;
 * the release build's MTXConcat, VECNormalize and the rest are these), and
 * the game's own code is built with -fp_contract on, so a * b + c in one
 * expression is one fused multiply-add. This module does the same
 * operations in the same order, each rounded where the console rounds:
 *
 *  - every single-precision step is Math.fround of the exact double result
 *    (the product, sum or quotient of two floats is exact or correctly
 *    rounded in a double, so rounding it to a float is the console's);
 *  - a fused multiply-add (fmadds, ps_madd, ps_msub, ps_nmsub ...) is
 *    `madd`: the product of two floats is exact in a double, the double sum
 *    is rounded once, and where that rounding lands exactly on a float's
 *    half-way point the exact error of the sum (two-sum) says which way the
 *    single rounding goes;
 *  - the estimates frsqrte and fres are the Gekko's own tables (frsqrte,
 *    fres), and a single-precision multiply rounds its second operand to a
 *    25-bit significand first (f25: only a double operand - an estimate -
 *    is changed by it).
 *
 * Matrices are GX's Mtx: 3 rows of 4, row major (m[r * 4 + c]); mtxToGL and
 * mtxFromGL move them to and from the renderer's column-major 4 x 4s (a
 * copy: no arithmetic). Written from the Melee decompilation's sources and
 * the PowerPC's documented behavior; tests/gxmath.test.ts holds the C
 * versions of these functions next to them, compiled and run on the same
 * inputs, and every result must be the same bits.
 */
import { cosf, sinf, tanf } from "./fx/gamemath";

export const f32 = Math.fround;

/** GX's 3 x 4 matrix (row major) */
export type Mtx = Float32Array;
export type Vec = Float32Array | number[];

export const mtx = (): Mtx => PSMTXIdentity(new Float32Array(12));

// a double's two halves (little endian: [0] the low word)
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** a * b + c rounded once to single precision (fmadds, ps_madd); a and b
 *  floats, or a an estimate - their product exact in a double either way */
export function madd(a: number, b: number, c: number): number {
  const p = a * b;
  let s = p + c;
  F64[0] = s;
  const lo = U32[0];
  // (a tie at single precision: the low 29 bits of the double's fraction are
  // exactly one half of the float's last place)
  if ((lo & 0x1fffffff) === 0x10000000) {
    // the double sum's own error (two-sum; p is exact)
    const bb = s - p;
    const err = (p - (s - bb)) + (c - bb);
    if (err !== 0) {
      U32[0] = (err > 0) === (s > 0) ? lo + 1 : lo - 1;
      s = F64[0];
    }
  }
  return f32(s);
}
/** a * b - c, rounded once (fmsubs, ps_msub) */
export const msub = (a: number, b: number, c: number): number => madd(a, b, -c);
/** -(a * b + c) (fnmadds, ps_nmadd) */
export const nmadd = (a: number, b: number, c: number): number => -madd(a, b, c);
/** -(a * b - c) = c - a * b (fnmsubs, ps_nmsub) */
export const nmsub = (a: number, b: number, c: number): number => -madd(a, b, -c);

/** a double's significand rounded to 25 bits, as a single-precision
 *  multiply takes its second operand (a float is left as it is) */
export function f25(x: number): number {
  F64[0] = x;
  const lo = U32[0];
  const sum = ((lo & 0xf8000000) >>> 0) + (lo & 0x08000000);
  if (sum >= 0x100000000) { U32[0] = sum - 0x100000000; U32[1] = U32[1] + 1; } else U32[0] = sum;
  return F64[0];
}

/** a * b in single precision with b a double (an estimate): fmuls */
export const fmuls = (a: number, b: number): number => f32(a * f25(b));

// The Gekko's reciprocal square root estimate (frsqrte): by the input's
// exponent's parity and its top 4 fraction bits, a base and a step per unit
// of the next 11 bits. First the even exponents, then the odd.
const RSQRTE_BASE = [
  0x1a7e800, 0x17cb800, 0x1552800, 0x130c000, 0x10f2000, 0x0eff000, 0x0d2e000, 0x0b7c000,
  0x09e5000, 0x0867000, 0x06ff000, 0x05ab800, 0x046a000, 0x0339800, 0x0218800, 0x0105800,
  0x3ffa000, 0x3c29000, 0x38aa000, 0x3572000, 0x3279000, 0x2fb7000, 0x2d26000, 0x2ac0000,
  0x2881000, 0x2665000, 0x2468000, 0x2287000, 0x20c1000, 0x1f12000, 0x1d79000, 0x1bf4000,
];
const RSQRTE_STEP = [
  0x568, 0x4f3, 0x48d, 0x435, 0x3e7, 0x3a2, 0x365, 0x32e, 0x2fc, 0x2d0, 0x2a8, 0x283, 0x261, 0x243, 0x226, 0x20b,
  0x7a4, 0x700, 0x670, 0x5f2, 0x584, 0x524, 0x4cc, 0x47e, 0x43a, 0x3fa, 0x3c2, 0x38e, 0x35e, 0x332, 0x30a, 0x2e6,
];
// and its reciprocal estimate (fres): by the top 5 fraction bits, a base and
// a half step per unit of the next 10
const RES_BASE = [
  0x7ff800, 0x783800, 0x70ea00, 0x6a0800, 0x638800, 0x5d6200, 0x579000, 0x520800, 0x4cc800, 0x47ca00, 0x430800,
  0x3e8000, 0x3a2c00, 0x360800, 0x321400, 0x2e4a00, 0x2aa800, 0x272c00, 0x23d600, 0x209e00, 0x1d8800, 0x1a9000,
  0x17ae00, 0x14f800, 0x124400, 0x0fbe00, 0x0d3800, 0x0ade00, 0x088400, 0x065000, 0x041c00, 0x020c00,
];
const RES_STEP = [
  0x3e1, 0x3a7, 0x371, 0x340, 0x313, 0x2ea, 0x2c4, 0x2a0, 0x27f, 0x261, 0x245, 0x22a, 0x212, 0x1fb, 0x1e5, 0x1d1,
  0x1be, 0x1ac, 0x19b, 0x18b, 0x17c, 0x16e, 0x15b, 0x15b, 0x143, 0x143, 0x12d, 0x12d, 0x11a, 0x11a, 0x108, 0x106,
];

/** frsqrte: the Gekko's estimate of 1 / sqrt(x), a double */
export function frsqrte(x: number): number {
  F64[0] = x;
  let hi = U32[1];
  const neg = hi >>> 31;
  let exp = (hi >>> 20) & 0x7ff;
  let fracHi = hi & 0xfffff;
  if (exp === 0 && fracHi === 0 && U32[0] === 0) return neg ? -Infinity : Infinity;
  if (exp === 0x7ff) return fracHi === 0 && U32[0] === 0 ? (neg ? NaN : 0) : NaN;
  if (neg) return NaN;
  if (exp === 0) {
    // (a denormal double: normalized first)
    let lo = U32[0];
    exp = 1;
    while (!(fracHi & 0x100000)) { fracHi = ((fracHi << 1) | (lo >>> 31)) & 0x1fffff; lo = (lo << 1) >>> 0; exp--; }
    fracHi &= 0xfffff;
  }
  // the exponent halved and negated: ((0x3FF << 52) - ((e - 0x3FE) << 52) / 2), the division truncating
  // ((e - 0x3FE) << 52) is even, so its half is exact: the new exponent is (0x7FE - (e - 0x3FE)) / 2, rounded down
  const e2 = Math.floor((0x7fe - (exp - 0x3fe)) / 2) & 0x7ff;
  const i = ((exp & 1) << 15) | (fracHi >>> 5);
  const k = i >>> 11;
  const frac = RSQRTE_BASE[k] - RSQRTE_STEP[k] * (i & 2047);
  U32[1] = (e2 << 20) | (frac >>> 6);
  U32[0] = ((frac & 63) << 26) >>> 0;
  return F64[0];
}

/** fres: the Gekko's estimate of 1 / x (a float's worth of bits) */
export function fres(x: number): number {
  F64[0] = x;
  const hi = U32[1], lo = U32[0];
  const neg = hi >>> 31;
  const exp = (hi >>> 20) & 0x7ff;
  const fracHi = hi & 0xfffff;
  if (exp === 0 && fracHi === 0 && lo === 0) return neg ? -Infinity : Infinity;
  if (exp === 0x7ff) return fracHi === 0 && lo === 0 ? (neg ? -0 : 0) : NaN;
  if (exp < 895) return neg ? -3.4028234663852886e38 : 3.4028234663852886e38;
  if (exp >= 1149) return neg ? -0 : 0;
  const e2 = 0x7fd - exp;
  const i = fracHi >>> 5;
  const k = i >>> 10;
  const frac = RES_BASE[k] - ((RES_STEP[k] * (i & 1023) + 1) >>> 1);
  U32[1] = (neg << 31) | (e2 << 20) | (frac >>> 3);
  U32[0] = ((frac & 7) << 29) >>> 0;
  return F64[0];
}

// a double as an integer times a power of two, for fma64's exact sum
function parts(x: number): [bigint, number] {
  if (x === 0) return [0n, 0];
  F64[0] = x;
  const hi = U32[1], lo = U32[0];
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp) m |= 1n << 52n;
  if (hi >>> 31) m = -m;
  return [m, (exp || 1) - 1075];
}

/** a * b + c in double precision rounded once (fmadd, fnmsub in double):
 *  exactly, by integers (used by the few double-precision steps the game
 *  takes: sqrtf's) */
export function fma64(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  const [ma, ea] = parts(a), [mb, eb] = parts(b), [mc, ec] = parts(c);
  const mp = ma * mb, ep = ea + eb;
  if (mp === 0n) return a * b + c;
  if (mc === 0n) return a * b;
  const e = Math.min(ep, ec);
  const sum = (mp << BigInt(ep - e)) + (mc << BigInt(ec - e));
  if (sum === 0n) return 0;
  // (rounded to 53 bits here, then scaled: exact for results in the normal range)
  const neg = sum < 0n;
  let mag = neg ? -sum : sum, sh = 0;
  const bits = mag.toString(2).length;
  if (bits > 53) {
    sh = bits - 53;
    const half = 1n << BigInt(sh - 1), rest = mag & ((1n << BigInt(sh)) - 1n);
    mag >>= BigInt(sh);
    if (rest > half || (rest === half && (mag & 1n))) mag += 1n;
  }
  const v = Number(mag) * Math.pow(2, e + sh);
  return neg ? -v : v;
}

/** MSL's sqrtf (math_ppc.h, inlined into the game's code): frsqrte then
 *  three double-precision Newton steps, each 3 - x g^2 one fused fnmsub */
export function sqrtf(x: number): number {
  x = f32(x);
  if (!(x > 0)) return x;
  let g = frsqrte(x);
  for (let k = 0; k < 3; k++) g = (0.5 * g) * fma64(-x, g * g, 3.0);
  return f32(x * g);
}

// ---------------------------------------------------------------- vectors (vec.c)

/** PSVECNormalize: frsqrte and one single-precision Newton step */
export function PSVECNormalize(v: Vec, out: Vec): Vec {
  const x = v[0], y = v[1], z = v[2];
  const sq = f32(madd(z, z, f32(x * x)) + f32(y * y));
  const r = frsqrte(sq);
  const w0 = fmuls(r, r), w1 = f32(r * 0.5);
  const k = f32(nmsub(w0, sq, 3) * w1);
  out[0] = f32(x * k); out[1] = f32(y * k); out[2] = f32(z * k);
  return out;
}

/** PSVECMag: frsqrte and one Newton step, times the square */
export function PSVECMag(v: Vec): number {
  const xx = f32(v[0] * v[0]), yy = f32(v[1] * v[1]);
  const sq = f32(madd(v[2], v[2], xx) + yy);
  const r = frsqrte(sq);
  const w2 = fmuls(r, r), w0 = f32(r * 0.5);
  let k = f32(nmsub(w2, sq, 3) * w0);
  // (fsel: a NaN - the square 0 - takes the square itself)
  if (!(k >= 0)) k = sq;
  return f32(sq * k);
}

/** PSVECDotProduct */
export function PSVECDotProduct(a: Vec, b: Vec): number {
  return f32(madd(a[0], b[0], f32(a[1] * b[1])) + f32(a[2] * b[2]));
}

/** PSVECCrossProduct: a x b */
export function PSVECCrossProduct(a: Vec, b: Vec, out: Vec): Vec {
  const x = msub(a[1], b[2], f32(b[1] * a[2]));
  const y = -msub(a[0], b[2], f32(b[0] * a[2]));
  const z = -msub(a[1], b[0], f32(b[1] * a[0]));
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** PSVECAdd */
export function PSVECAdd(a: Vec, b: Vec, out: Vec): Vec {
  out[0] = f32(a[0] + b[0]); out[1] = f32(a[1] + b[1]); out[2] = f32(a[2] + b[2]);
  return out;
}

export function PSVECSubtract(a: Vec, b: Vec, out: Vec): Vec {
  out[0] = f32(a[0] - b[0]); out[1] = f32(a[1] - b[1]); out[2] = f32(a[2] - b[2]);
  return out;
}

// ---------------------------------------------------------------- matrices (mtx.c, mtxvec.c, mtx44.c)

export function PSMTXIdentity(m: Mtx): Mtx {
  m.fill(0);
  m[0] = m[5] = m[10] = 1;
  return m;
}

const tmpC = new Float32Array(12);

/** PSMTXConcat: ab = a b (ab may be a or b). Each entry a row of a down a
 *  column of b: ps_muls0 then ps_madds1 and ps_madds0 in turn, the
 *  translation's last a ps_madds1 by the constant 1 (the others by 0) */
export function PSMTXConcat(a: Mtx, b: Mtx, ab: Mtx): Mtx {
  const m = tmpC;
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
    for (let c = 0; c < 4; c++) {
      let v = f32(a0 * b[c]);
      v = madd(a1, b[4 + c], v);
      v = madd(a2, b[8 + c], v);
      v = madd(c === 3 ? 1 : 0, a3, v);
      m[r * 4 + c] = v;
    }
  }
  ab.set(m);
  return ab;
}

/** PSMTXMultVec: m (x, y, z, 1) */
export function PSMTXMultVec(m: Mtx, v: Vec, out: Vec): Vec {
  const x = v[0], y = v[1], z = v[2];
  let o0 = 0, o1 = 0, o2 = 0;
  for (let r = 0; r < 3; r++) {
    const s = f32(madd(m[r * 4 + 2], z, f32(m[r * 4] * x)) + madd(m[r * 4 + 3], 1, f32(m[r * 4 + 1] * y)));
    if (r === 0) o0 = s; else if (r === 1) o1 = s; else o2 = s;
  }
  out[0] = o0; out[1] = o1; out[2] = o2;
  return out;
}

/** PSMTXMultVecSR: m (x, y, z, 0) */
export function PSMTXMultVecSR(m: Mtx, v: Vec, out: Vec): Vec {
  const x = v[0], y = v[1], z = v[2];
  const o0 = madd(m[2], z, f32(f32(m[0] * x) + f32(m[1] * y)));
  const o1 = madd(m[6], z, f32(f32(m[4] * x) + f32(m[5] * y)));
  const o2 = madd(m[10], z, f32(f32(m[8] * x) + f32(m[9] * y)));
  out[0] = o0; out[1] = o1; out[2] = o2;
  return out;
}

/** PSMTXInverse: 0 (inv untouched) when the determinant is 0. The
 *  reciprocal of the determinant is fres and one Newton step */
export function PSMTXInverse(s: Mtx, inv: Mtx): number {
  const s00 = s[0], s01 = s[1], s02 = s[2], s03 = s[3], s10 = s[4], s11 = s[5], s12 = s[6], s13 = s[7];
  const s20 = s[8], s21 = s[9], s22 = s[10], s23 = s[11];
  let a0 = msub(s01, s12, f32(s11 * s02)), a1 = msub(s02, s10, f32(s12 * s00));     // f11
  let b0 = msub(s11, s22, f32(s21 * s12)), b1 = msub(s12, s20, f32(s22 * s10));     // f13
  let c0 = msub(s21, s02, f32(s01 * s22)), c1 = msub(s22, s00, f32(s02 * s20));     // f12
  let d = msub(s10, s21, f32(s11 * s20));                                            // f10
  let e = msub(s01, s20, f32(s00 * s21));                                            // f9
  let g = msub(s00, s11, f32(s01 * s10));                                            // f8
  const det = madd(s20, a0, madd(s10, c0, f32(s00 * b0)));
  if (det === 0) return 0;
  const est = fres(det);
  const r = nmsub(det, f32(est * est), f32(est + est));
  b0 = f32(b0 * r); b1 = f32(b1 * r); c0 = f32(c0 * r); c1 = f32(c1 * r); a0 = f32(a0 * r); a1 = f32(a1 * r);
  d = f32(d * r); e = f32(e * r); g = f32(g * r);
  inv[0] = b0; inv[1] = c0; inv[2] = a0; inv[3] = nmadd(a0, s23, madd(c0, s13, f32(b0 * s03)));
  inv[4] = b1; inv[5] = c1; inv[6] = a1; inv[7] = nmadd(a1, s23, madd(c1, s13, f32(b1 * s03)));
  inv[8] = d; inv[9] = e; inv[10] = g; inv[11] = nmadd(g, s23, madd(e, s13, f32(d * s03)));
  return 1;
}

/** PSMTXQuat: a rotation from a quaternion (x, y, z, w); its norm's
 *  reciprocal is fres and one Newton step */
export function PSMTXQuat(m: Mtx, q: Vec): Mtx {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = f32(x * x), yy = f32(y * y), zz = f32(z * z);
  const zzxx = madd(z, z, xx), wwyy = madd(w, w, yy);
  const norm = f32(zzxx + wwyy);
  const est = fres(norm);
  let scale = f32(est * nmsub(norm, est, 2));
  scale = f32(scale * 2);
  const yw = f32(y * w), xw = f32(x * w), zw = f32(z * w);
  const xyzw = madd(x, y, zw), xymzw = msub(x, y, zw);
  const xzyw = madd(x, z, yw), yzxw = madd(y, z, xw);
  const xzmyw = nmsub(yw, 2, xzyw), yzmxw = nmsub(xw, 2, yzxw);
  m[0] = nmsub(f32(zz + yy), scale, 1); m[1] = f32(xymzw * scale); m[2] = f32(xzyw * scale); m[3] = 0;
  m[4] = f32(xyzw * scale); m[5] = nmsub(zzxx, scale, 1); m[6] = f32(yzmxw * scale); m[7] = 0;
  m[8] = f32(xzmyw * scale); m[9] = f32(yzxw * scale); m[10] = nmsub(f32(xx + yy), scale, 1); m[11] = 0;
  return m;
}

const rotN = [0, 0, 0];

/** PSMTXRotAxisRad: a turn of `rad` about an axis (normalized first) */
export function PSMTXRotAxisRad(m: Mtx, axis: Vec, rad: number): Mtx {
  const s = sinf(rad), c = cosf(rad), t = f32(1 - c);
  const n = PSVECNormalize(axis, rotN);
  const nx = n[0], ny = n[1], nz = n[2];
  const tx = f32(nx * t), ty = f32(ny * t), tz = f32(nz * t);
  const xs = f32(nx * s), ys = f32(ny * s);
  const txny = f32(tx * ny), tyny = f32(ty * ny), txnx = f32(tx * nx);
  const txnz = f32(tx * nz), tynz = f32(ty * nz);
  m[0] = f32(txnx + c); m[1] = nmsub(nz, s, txny); m[2] = f32(txnz + ys); m[3] = 0;
  m[4] = madd(nz, s, txny); m[5] = f32(c + tyny); m[6] = f32(-xs + tynz); m[7] = 0;
  m[8] = f32(txnz + -ys); m[9] = f32(xs + tynz); m[10] = f32(f32(tz * nz) + c); m[11] = 0;
  return m;
}

export function PSMTXScale(m: Mtx, x: number, y: number, z: number): Mtx {
  m.fill(0);
  m[0] = f32(x); m[5] = f32(y); m[10] = f32(z);
  return m;
}

export function PSMTXTrans(m: Mtx, x: number, y: number, z: number): Mtx {
  PSMTXIdentity(m);
  m[3] = f32(x); m[7] = f32(y); m[11] = f32(z);
  return m;
}

/** C_MTXLookAt: the view from camPos toward target, camUp up (the SDK's C,
 *  without fused operations, around PSVECNormalize and PSVECCrossProduct) */
const lkLook = [0, 0, 0], lkRight = [0, 0, 0], lkUp = [0, 0, 0];
export function C_MTXLookAt(m: Mtx, camPos: Vec, camUp: Vec, target: Vec): Mtx {
  const look = lkLook, right = lkRight;
  look[0] = f32(camPos[0] - target[0]); look[1] = f32(camPos[1] - target[1]); look[2] = f32(camPos[2] - target[2]);
  PSVECNormalize(look, look);
  PSVECCrossProduct(camUp, look, right);
  PSVECNormalize(right, right);
  const up = PSVECCrossProduct(look, right, lkUp);
  const dot = (v: Vec) => -f32(f32(camPos[2] * v[2]) + f32(f32(camPos[0] * v[0]) + f32(camPos[1] * v[1])));
  m[0] = right[0]; m[1] = right[1]; m[2] = right[2]; m[3] = dot(right);
  m[4] = up[0]; m[5] = up[1]; m[6] = up[2]; m[7] = dot(up);
  m[8] = look[0]; m[9] = look[1]; m[10] = look[2]; m[11] = dot(look);
  return m;
}

/** C_MTXPerspective (mtx44.c's MTXPerspective): GX's 4 x 4 projection, row
 *  major, from the vertical field of view in degrees */
export function C_MTXPerspective(m: Float32Array, fovY: number, aspect: number, n: number, f: number): Float32Array {
  fovY = f32(fovY); aspect = f32(aspect); n = f32(n); f = f32(f);
  let angle = f32(0.5 * fovY);
  angle = f32(angle * f32(0.017453293));
  const cot = f32(1 / tanf(angle));
  m.fill(0);
  m[0] = f32(cot / aspect);
  m[5] = cot;
  const tmp = f32(1 / f32(f - n));
  m[10] = f32(-n * tmp);
  m[11] = f32(tmp * -f32(f * n));
  m[14] = -1;
  return m;
}

/** C_MTXFrustum (MTXFrustum) */
export function C_MTXFrustum(m: Float32Array, t: number, b: number, l: number, r: number, n: number, f: number): Float32Array {
  [t, b, l, r, n, f] = [t, b, l, r, n, f].map(f32);
  m.fill(0);
  let tmp = f32(1 / f32(r - l));
  m[0] = f32(f32(2 * n) * tmp);
  m[2] = f32(tmp * f32(r + l));
  tmp = f32(1 / f32(t - b));
  m[5] = f32(f32(2 * n) * tmp);
  m[6] = f32(tmp * f32(t + b));
  tmp = f32(1 / f32(f - n));
  m[10] = f32(-n * tmp);
  m[11] = f32(tmp * -f32(f * n));
  m[14] = -1;
  return m;
}

/** C_MTXOrtho (MTXOrtho) */
export function C_MTXOrtho(m: Float32Array, t: number, b: number, l: number, r: number, n: number, f: number): Float32Array {
  [t, b, l, r, n, f] = [t, b, l, r, n, f].map(f32);
  m.fill(0);
  let tmp = f32(1 / f32(r - l));
  m[0] = f32(2 * tmp);
  m[3] = f32(tmp * -f32(r + l));
  tmp = f32(1 / f32(t - b));
  m[5] = f32(2 * tmp);
  m[7] = f32(tmp * -f32(t + b));
  tmp = f32(1 / f32(f - n));
  m[10] = -tmp;
  m[11] = f32(-f * tmp);
  m[15] = 1;
  return m;
}

// ---------------------------------------------------------------- sysdolphin (baselib/mtx.c: built -fp_contract on)

/** HSD_MtxSRT: scale, then turn (z y x), then move; `parentScale` (the
 *  parent's accumulated scale, jobj->scl) takes the parent's non-uniform
 *  scale back out of the turn, as HSD_JObjMakeMatrix asks */
export function HSD_MtxSRT(m: Mtx, scale: Vec, rot: Vec, trans: Vec, parentScale: Vec | null): Mtx {
  const sinX = sinf(rot[0]), cosX = cosf(rot[0]);
  const sinY = sinf(rot[1]), cosY = cosf(rot[1]);
  const sinZ = sinf(rot[2]), cosZ = cosf(rot[2]);
  let x2 = f32(scale[0]), y2 = f32(scale[1]), z2 = f32(scale[2]);
  let x1 = x2, y1 = y2, z1 = z2, x0 = x2, y0 = y2, z0 = z2;
  if (parentScale) {
    // (1.0 / s: a double quotient, rounded to a float)
    const t1 = f32(1 / parentScale[0]), t2 = f32(1 / parentScale[1]), t3 = f32(1 / parentScale[2]);
    y2 = f32(y2 * f32(parentScale[1] * t1));
    z2 = f32(z2 * f32(parentScale[2] * t1));
    x1 = f32(x1 * f32(parentScale[0] * t2));
    z1 = f32(z1 * f32(parentScale[2] * t2));
    x0 = f32(x0 * f32(parentScale[0] * t3));
    y0 = f32(y0 * f32(parentScale[1] * t3));
  }
  const sxsy = f32(sinX * sinY), cxsy = f32(cosX * sinY);
  m[0] = f32(cosZ * f32(x2 * cosY));
  m[4] = f32(sinZ * f32(x1 * cosY));
  m[8] = f32(-x0 * sinY);
  m[1] = f32(y2 * msub(cosZ, sxsy, f32(cosX * sinZ)));
  m[5] = f32(y1 * madd(sinZ, sxsy, f32(cosX * cosZ)));
  m[9] = f32(cosY * f32(y0 * sinX));
  m[2] = f32(z2 * madd(cosZ, cxsy, f32(sinX * sinZ)));
  m[6] = f32(z1 * msub(sinZ, cxsy, f32(sinX * cosZ)));
  m[10] = f32(cosY * f32(z0 * cosX));
  m[3] = f32(trans[0]); m[7] = f32(trans[1]); m[11] = f32(trans[2]);
  return m;
}

const srtA = new Float32Array(12), srtB = new Float32Array(12);

/** HSD_MtxSRTQuat: a joint turned by a quaternion (JOBJ_USE_QUATERNION) */
export function HSD_MtxSRTQuat(m: Mtx, scale: Vec, q: Vec, trans: Vec, parentScale: Vec | null): Mtx {
  PSMTXScale(m, scale[0], scale[1], scale[2]);
  if (parentScale) PSMTXConcat(PSMTXScale(srtA, parentScale[0], parentScale[1], parentScale[2]), m, m);
  PSMTXConcat(PSMTXQuat(srtB, q), m, m);
  if (parentScale) PSMTXConcat(PSMTXScale(srtA, 1 / parentScale[0], 1 / parentScale[1], 1 / parentScale[2]), m, m);
  PSMTXConcat(PSMTXTrans(srtA, trans[0], trans[1], trans[2]), m, m);
  return m;
}

/** HSD_MkRotationMtx: a turn by x, then y, then z (a texture's), no move */
export function HSD_MkRotationMtx(m: Mtx, rot: Vec): Mtx {
  const sinX = sinf(rot[0]), cosX = cosf(rot[0]);
  const sinY = sinf(rot[1]), cosY = cosf(rot[1]);
  const sinZ = sinf(rot[2]), cosZ = cosf(rot[2]);
  const t1 = f32(sinX * sinY);
  m[0] = f32(cosY * cosZ);
  m[4] = f32(cosY * sinZ);
  m[8] = -sinY;
  const t2 = f32(cosX * sinY);
  m[1] = msub(cosZ, t1, f32(cosX * sinZ));
  m[5] = madd(sinZ, t1, f32(cosX * cosZ));
  m[9] = f32(sinX * cosY);
  m[2] = madd(cosZ, t2, f32(sinX * sinZ));
  m[6] = msub(sinZ, t2, f32(sinX * cosZ));
  m[10] = f32(cosX * cosY);
  m[3] = 0; m[7] = 0; m[11] = 0;
  return m;
}

const FLT_EPSILON = 1.1920928955078125e-7;
const tmR = new Float32Array(12), tmS = new Float32Array(12), tmRot = [0, 0, 0];

/** MakeTextureMtx (tobj.c): a texture's matrix, scale (repeat over scale) times turn (z negated) times move
 *  (minus the translation, and a mirrored-in-t texture's one repeat more), each step PSMTXConcat's */
export function MakeTextureMtx(m: Mtx, translate: Vec, scale: Vec, rotate: Vec, repeatS: number, repeatT: number,
                               wrapT: number): Mtx {
  const sx = f32(scale[0]), sy = f32(scale[1]);
  const kx = Math.abs(sx) < FLT_EPSILON ? 0 : f32(repeatS / sx);
  const ky = Math.abs(sy) < FLT_EPSILON ? 0 : f32(repeatT / sy);
  tmRot[0] = f32(rotate[0]); tmRot[1] = f32(rotate[1]); tmRot[2] = -f32(rotate[2]);
  const tx = -f32(translate[0]);
  // (GX_MIRROR: 1.0F / (repeat_t / scale.y), a float32 quotient each)
  const ty = -f32(f32(translate[1]) + (wrapT === 2 ? f32(1 / f32(repeatT / sy)) : 0));
  PSMTXTrans(m, tx, ty, translate[2]);
  HSD_MkRotationMtx(tmR, tmRot);
  PSMTXConcat(tmR, m, m);
  PSMTXScale(tmS, kx, ky, scale[2]);
  PSMTXConcat(tmS, m, m);
  return m;
}

/** HSD_MtxScaledAdd: out = acc + k * m, each one fused multiply-add (an envelope's weighted sum) */
export function HSD_MtxScaledAdd(m: Mtx, acc: Mtx, out: Mtx, k: number): Mtx {
  for (let i = 0; i < 12; i++) out[i] = madd(k, m[i], acc[i]);
  return out;
}

/** the determinant of a 3 x 4's turn (HSD_CalcDeterminantMatrix3x4 as
 *  HSD_MtxInverse inlines it: each term's first two factors rounded, the
 *  third fused into the sum) */
function det3x4(m: Mtx): number {
  let d = f32(m[8] * f32(m[1] * m[6]));
  d = madd(m[10], f32(m[0] * m[5]), d);
  d = madd(m[9], f32(m[2] * m[4]), d);
  d = nmsub(m[2], f32(m[8] * m[5]), d);
  d = nmsub(m[10], f32(m[4] * m[1]), d);
  d = nmsub(m[6], f32(m[0] * m[9]), d);
  return d;
}

const itC = new Float32Array(12);

/** HSD_MtxInverseTranspose: the inverse of the turn, transposed - the normal matrix HSD loads with a modelview
 *  (SetupRigidModelMtx, SetupEnvelopeModelMtx) - its move 0; the matrix copied when it cannot be inverted. Each
 *  entry's p * q - r * s with the left product fused (this build's contraction), then times 1 / det */
export function HSD_MtxInverseTranspose(src: Mtx, dest: Mtx): Mtx {
  const det0 = det3x4(src);
  if (Math.abs(det0) < f32(1e-10)) { if (src !== dest) dest.set(src); return dest; }
  const m = src, det = f32(1 / det0), o = itC;
  o[0] = f32(msub(m[5], m[10], f32(m[9] * m[6])) * det);
  o[4] = f32(-msub(m[1], m[10], f32(m[9] * m[2])) * det);
  o[8] = f32(msub(m[1], m[6], f32(m[5] * m[2])) * det);
  o[1] = f32(-msub(m[4], m[10], f32(m[8] * m[6])) * det);
  o[5] = f32(msub(m[0], m[10], f32(m[8] * m[2])) * det);
  o[9] = f32(-msub(m[0], m[6], f32(m[4] * m[2])) * det);
  o[2] = f32(msub(m[4], m[9], f32(m[8] * m[5])) * det);
  o[6] = f32(-msub(m[0], m[9], f32(m[8] * m[1])) * det);
  o[10] = f32(msub(m[0], m[5], f32(m[4] * m[1])) * det);
  o[3] = 0; o[7] = 0; o[11] = 0;
  dest.set(o);
  return dest;
}

/** a GX Mtx's turn as GL's column-major 3 x 3 (a normal matrix's upload), at an offset */
export function mtxToGL3(m: Mtx, out: Float32Array, o = 0): Float32Array {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[o + c * 3 + r] = m[r * 4 + c];
  return out;
}

const invC = new Float32Array(12);

/** HSD_MtxInverseConcat: out = inverse(inv) src (src copied when inv cannot
 *  be inverted). Its contractions are the ones the game's matched code shows
 *  for this build's expressions (HSD_MtxSRT, the determinant above): in
 *  p * q +- r the left product is fused, the right one rounded first */
export function HSD_MtxInverseConcat(inv: Mtx, src: Mtx, out: Mtx): Mtx {
  const det0 = det3x4(inv);
  if (Math.abs(det0) < f32(1e-10)) { if (src !== out) out.set(src); return out; }
  const det = f32(1 / det0);
  const i = inv;
  const t1 = f32(msub(i[5], i[10], f32(i[9] * i[6])) * det);
  const t2 = f32(-msub(i[1], i[10], f32(i[9] * i[2])) * det);
  const t3 = f32(-msub(i[4], i[10], f32(i[8] * i[6])) * det);
  const t7 = f32(msub(i[1], i[6], f32(i[5] * i[2])) * det);
  const t4 = f32(msub(i[0], i[10], f32(i[8] * i[2])) * det);
  const t8 = f32(-msub(i[0], i[6], f32(i[4] * i[2])) * det);
  const t5 = f32(msub(i[4], i[9], f32(i[8] * i[5])) * det);
  const t6 = f32(-msub(i[0], i[9], f32(i[8] * i[1])) * det);
  const t9 = f32(msub(i[0], i[5], f32(i[4] * i[1])) * det);
  const t10 = -msub(t7, i[11], msub(-t1, i[3], f32(t2 * i[7])));
  const t11 = -msub(t8, i[11], msub(-t3, i[3], f32(t4 * i[7])));
  const t12 = -msub(t9, i[11], msub(-t5, i[3], f32(t6 * i[7])));
  const rows: [number, number, number, number][] = [[t1, t2, t7, t10], [t3, t4, t8, t11], [t5, t6, t9, t12]];
  for (let r = 0; r < 3; r++) {
    const [a, b, c, t] = rows[r];
    for (let k = 0; k < 4; k++) {
      const v = madd(c, src[8 + k], madd(a, src[k], f32(b * src[4 + k])));
      invC[r * 4 + k] = k === 3 ? f32(v + t) : v;
    }
  }
  out.set(invC);
  return out;
}

// ---------------------------------------------------------------- billboards (displayfunc.c)

/** HSD_MtxColMag: a column's length (its squares as the entries are read: not fused) */
export function HSD_MtxColMag(m: Mtx, col: number): number {
  const a = m[col], b = m[4 + col], c = m[8 + col];
  return sqrtf(f32(f32(f32(a * a) + f32(b * b)) + f32(c * c)));
}

const bbAx = [0, 0, 0], bbAy = [0, 0, 0], bbAz = [0, 0, 0], bbPos = [0, 0, 0], bbUy = [0, 0, 0];
const Z_ONE = [0, 0, 1], Y_ONE = [0, 1, 0];
const bbRot = new Float32Array(12), bbScl = new Float32Array(12);
const colOf = (m: Mtx, c: number, v: number[]) => { v[0] = m[c]; v[1] = m[4 + c]; v[2] = m[8 + c]; return v; };
const setCol = (m: Mtx, c: number, v: Vec, k?: number) => {
  if (k === undefined) { m[c] = v[0]; m[4 + c] = v[1]; m[8 + c] = v[2]; }
  else { m[c] = f32(k * v[0]); m[4 + c] = f32(k * v[1]); m[8 + c] = f32(k * v[2]); }
};

/** HSD_JObjMakePositionMtx's billboards on src (the view times the joint's matrix: a modelview) into dst: kind
 *  JOBJ_BILLBOARD 0x200 (mkBillBoardMtx), VBILLBOARD 0x400 (mkVBillBoardMtx), HBILLBOARD 0x600
 *  (mkHBillBoardMtx), RBILLBOARD 0x800 (mkRBillBoardMtx: turned by the joint's z rotation `rotZ`); `persp`:
 *  JOBJ_PBILLBOARD (facing the eye, not the screen) */
export function mkBillBoardMtx(kind: number, persp: boolean, rotZ: number, src: Mtx, dst: Mtx): Mtx {
  const ax = bbAx, ay = bbAy, pos = bbPos;
  if (kind === 0x200) {
    let sx = HSD_MtxColMag(src, 0), sz = HSD_MtxColMag(src, 2);
    colOf(src, 1, ay);
    let sy = PSVECMag(ay);
    colOf(src, 3, pos);
    let az: number[];
    if (persp) {
      PSVECCrossProduct(pos, ay, ax);
      PSVECCrossProduct(ax, pos, ay);
      az = pos;
      sz = f32(sz / -PSVECMag(az));
    } else {
      PSVECCrossProduct(ay, Z_ONE, ax);
      PSVECCrossProduct(Z_ONE, ax, ay);
      az = Z_ONE;
      sz = f32(sz / PSVECMag(Z_ONE));
    }
    sx = f32(sx / PSVECMag(ax));
    sy = f32(sy / PSVECMag(ay));
    setCol(dst, 0, ax, sx); setCol(dst, 1, ay, sy); setCol(dst, 2, az, sz); setCol(dst, 3, pos);
  } else if (kind === 0x400) {
    const az = bbAz;
    colOf(src, 3, pos);
    colOf(src, 1, ay);
    let sx = HSD_MtxColMag(src, 0), sz = HSD_MtxColMag(src, 2);
    if (persp) PSVECCrossProduct(pos, ay, ax);
    else PSVECCrossProduct(ay, Z_ONE, ax);
    PSVECCrossProduct(ax, ay, az);
    sx = f32(sx / PSVECMag(ax));
    sz = f32(sz / PSVECMag(az));
    setCol(dst, 0, ax, sx); setCol(dst, 1, ay); setCol(dst, 2, az, sz); setCol(dst, 3, pos);
  } else if (kind === 0x600) {
    const az = bbAz, uy = bbUy;
    colOf(src, 3, pos);
    colOf(src, 0, ax);
    let sy = HSD_MtxColMag(src, 1), sz = HSD_MtxColMag(src, 2);
    if (persp) {
      // (the struct's fields squared as read: not fused)
      uy[1] = sqrtf(f32(f32(pos[0] * pos[0]) + f32(pos[2] * pos[2])));
      uy[0] = f32(f32(-pos[1] / uy[1]) * pos[0]);
      uy[2] = f32(f32(-pos[1] / uy[1]) * pos[2]);
      PSVECCrossProduct(ax, uy, az);
    } else PSVECCrossProduct(ax, Y_ONE, az);
    PSVECCrossProduct(az, ax, ay);
    sy = f32(sy / PSVECMag(ay));
    sz = f32(sz / PSVECMag(az));
    setCol(dst, 0, ax); setCol(dst, 1, ay, sy); setCol(dst, 2, az, sz); setCol(dst, 3, pos);
  } else {
    const sx = HSD_MtxColMag(src, 0), sy = HSD_MtxColMag(src, 1), sz = HSD_MtxColMag(src, 2);
    PSMTXScale(bbScl, sx, sy, sz);
    // (MTXRotRad about z: PSMTXRotTrig with MSL's sinf and cosf)
    const sn = sinf(rotZ), cs = cosf(rotZ);
    PSMTXIdentity(bbRot);
    bbRot[0] = cs; bbRot[1] = -sn; bbRot[4] = sn; bbRot[5] = cs;
    bbRot[3] = src[3]; bbRot[7] = src[7]; bbRot[11] = src[11];
    PSMTXConcat(bbRot, bbScl, dst);
  }
  return dst;
}

// ---------------------------------------------------------------- the camera (cobj.c)

/** HSD_CObjGetUpVector of a camera given its roll (roll2upvec): the eye
 *  vector's up, turned about it by -roll */
const upE = [0, 0, 0], upV0 = [0, 0, 0], upV1 = [0, 0, 0], upM = new Float32Array(12);
export function cobjUpVector(eye: Vec, interest: Vec, roll: number, out: Vec): Vec {
  const e = PSVECSubtract(interest, eye, upE);
  if (Math.abs(e[0]) <= 1.1754943508222875e-38 && Math.abs(e[1]) <= 1.1754943508222875e-38 && Math.abs(e[2]) <= 1.1754943508222875e-38) {
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }
  PSVECNormalize(e, e);
  // (squares of a struct's fields read directly: not fused, in this build)
  const v0 = upV0;
  if (1.0 - Math.abs(e[1]) < 0.0001) {
    v0[0] = sqrtf(f32(f32(e[1] * e[1]) + f32(e[2] * e[2])));
    v0[1] = f32(e[1] * f32(-e[0] / v0[0]));
    v0[2] = f32(e[2] * f32(-e[0] / v0[0]));
  } else {
    v0[1] = sqrtf(f32(f32(e[0] * e[0]) + f32(e[2] * e[2])));
    v0[0] = f32(e[0] * f32(-e[1] / v0[1]));
    v0[2] = f32(e[2] * f32(-e[1] / v0[1]));
  }
  const m = PSMTXRotAxisRad(upM, e, -roll);
  const v1 = PSMTXMultVecSR(m, v0, upV1);
  return PSVECNormalize(v1, out);
}

/** HSD_CObjSetupViewingMtx: the view matrix of a camera at `eye` looking at
 *  `interest`, rolled by `roll` */
const vwE = [0, 0, 0], vwAt = [0, 0, 0], vwUp = [0, 0, 0];
export function cobjViewingMtx(m: Mtx, eye: Vec, interest: Vec, roll = 0): Mtx {
  const e = vwE, at = vwAt;
  for (let i = 0; i < 3; i++) { e[i] = f32(eye[i]); at[i] = f32(interest[i]); }
  const up = cobjUpVector(e, at, roll, vwUp);
  return C_MTXLookAt(m, e, up, at);
}

// ---------------------------------------------------------------- to and from the renderer's matrices

/** a GX Mtx as a column-major 4 x 4 (its fourth row 0 0 0 1) */
export function mtxToGL(m: Mtx, out: Float32Array, o = 0): Float32Array {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[o + c * 4 + r] = m[r * 4 + c];
  out[o + 3] = 0; out[o + 7] = 0; out[o + 11] = 0; out[o + 15] = 1;
  return out;
}

/** a column-major 4 x 4's top three rows as a GX Mtx */
export function mtxFromGL(g: ArrayLike<number>, out: Mtx, o = 0): Mtx {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = g[o + c * 4 + r];
  return out;
}

/** PSMTXConcat on column-major 4 x 4s inside bigger arrays: out[o] = a[ao] b[bo]
 *  (their fourth rows taken as 0 0 0 1; out may be a or b) */
const glA = new Float32Array(12), glB = new Float32Array(12);
export function concatGL(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number) {
  mtxFromGL(a, glA, ao);
  mtxFromGL(b, glB, bo);
  PSMTXConcat(glA, glB, glA);
  mtxToGL(glA, out, o);
}

/** a GX 4 x 4 projection (row major, as C_MTXPerspective makes it) as GL's
 *  column-major one: GX's clip depth runs -w..0 (its third row), GL's -w..w,
 *  so GL's third row is twice GX's plus its fourth */
export function projectionToGL(p: Float32Array, out: Float32Array): Float32Array {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = p[r * 4 + c];
  for (let c = 0; c < 4; c++) out[c * 4 + 2] = 2 * p[8 + c] + p[12 + c];
  return out;
}
