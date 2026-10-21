/* 3D replay viewer: the game's own sine and cosine.
 *
 * The game's single-precision sinf and cosf are not the exact functions:
 * they reduce the angle to an eighth of a turn and run a short polynomial,
 * and within 0.00035 of a quarter turn they take a straight line instead -
 * cosf's without the factor a straight line there needs, so it is off by up
 * to 0.00007. A particle sent out "straight up" by the game therefore
 * drifts a little sideways, and one made with the exact cosine does not:
 * to be the game's particles, the particle system (particles.ts) uses
 * these. Written after the Melee decompilation's MSL trigf.c (sinf, cosf)
 * and its tables (math_data.c), step for step, each operation rounded to
 * single precision as the console's is.
 */
import { madd } from "../gxmath";

const f32 = Math.fround;

const QUADRANT = [0, 1, 1, 0, 0, -1, -1, 0];
const POLY = [0.0000035287617, 0.0000003089747, -0.0003259365, -0.00003657235, 0.015854323, 0.0024903931,
              -0.30842513, -0.08074551, 1, 0.7853982].map(f32);
const FOUR_OVER_PI_M1 = [0.25, 0.0232393741608, 1.70555722434e-7, 1.86736494323e-11].map(f32);
const EPSILON = f32(3.45266983e-4);
const TWO_OVER_PI = f32(2 / f32(Math.PI));

/** a * b + c, rounded once to single precision (the console's fmadds: gxmath's madd) */
const fmadd = madd;

/** the angle as eighths of a turn from the nearest quarter turn, and which quarter */
function reduce(x: number): [number, number] {
  const z = f32(TWO_OVER_PI * x);
  const n = x < 0 || Object.is(x, -0) ? Math.trunc(f32(z - 0.5)) : Math.trunc(f32(z + 0.5));
  const y = fmadd(FOUR_OVER_PI_M1[3], x, fmadd(FOUR_OVER_PI_M1[2], x, fmadd(FOUR_OVER_PI_M1[1], x,
            fmadd(FOUR_OVER_PI_M1[0], x, f32(x - n * 2)))));
  return [y, n & 3];
}

const odd = (y: number, ysq: number) =>
  f32(fmadd(ysq, fmadd(ysq, fmadd(ysq, fmadd(POLY[1], ysq, POLY[3]), POLY[5]), POLY[7]), POLY[9]) * y);
const even = (ysq: number) => fmadd(ysq, fmadd(ysq, fmadd(ysq, fmadd(POLY[0], ysq, POLY[2]), POLY[4]), POLY[6]), POLY[8]);

/** the game's sinf */
export function sinf(angle: number): number {
  const x = f32(angle);
  const [y, n] = reduce(x);
  const q = n << 1;
  if (Math.abs(y) < EPSILON) return fmadd(POLY[9], f32(QUADRANT[q + 1] * y), QUADRANT[q]);
  const ysq = f32(y * y);
  return n & 1 ? f32(even(ysq) * QUADRANT[q]) : f32(odd(y, ysq) * QUADRANT[q + 1]);
}

/** the game's cosf */
export function cosf(angle: number): number {
  const x = f32(angle);
  const [y, n] = reduce(x);
  const q = n << 1;
  if (Math.abs(y) < EPSILON) return f32(-(y * QUADRANT[q] - QUADRANT[q + 1]));
  const ysq = f32(y * y);
  return n & 1 ? f32(-odd(y, ysq) * QUADRANT[q]) : f32(even(ysq) * QUADRANT[q + 1]);
}

/** the game's tanf: its sine over its cosine */
export function tanf(angle: number): number {
  return f32(sinf(angle) / cosf(angle));
}

// The game's atanf (the decompilation's runtime math): the value folded
// into one of six stretches by a table, then a short polynomial. Its tables,
// as they are in the game.
const ATAN = [
  1.0, -0.3333333134651184, 0.1999988704919815, -0.14281649887561798, 0.11041180044412613, -0.08459755778312683,
  0.04714243486523628, 6.828420162200928, 3.239828109741211, 2.0, 1.4464620351791382, 1.1715729236602783,
  1.039566159248352, 7.1350000325764995e-06, 8.200000252145401e-07, 0.0, 6.299999881775875e-07, 0.0, 0.0, 0.0,
  0.3926900029182434, 0.5890486240386963, 0.7853981256484985, 0.9817469716072083, 1.1780970096588135,
  1.3744460344314575, 0.0, 9.081698408408556e-06, 2.3000000126671694e-08, 6.30000016599297e-08,
  7.040000014058023e-07, 2.499999993688107e-07, 7.900000014160469e-07, 2.414212942123413, 1.4966057538986206, 1.0,
  0.6681786179542542, 0.4142135679721832, 0.1989123672246933, 5.620000251838064e-07, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
].map(f32);
const SILVER = f32(2.4142136573791504), SILVER_CONJUGATE = f32(0.4142135679721832);
const STRETCH = [0.534511148929596, 0.8206787705421448, 1.218503475189209, 1.870868444442749].map(f32);
const PI_F = f32(Math.PI), HALF_PI_F = f32(Math.PI / 2);
const negative = (x: number) => x < 0 || Object.is(x, -0);

/** the game's atanf */
export function atanf(value: number): number {
  const neg = negative(value);
  const x = f32(Math.abs(value));
  let at = -1, over = false, r: number;
  if (x >= SILVER) {
    over = true;
    r = f32(1 / x);
  } else if (SILVER_CONJUGATE < x) {
    at = STRETCH.reduce((n, t) => n + (x >= t ? 1 : 0), 0);
    const a = ATAN[39 + at], b = ATAN[33 + at];
    r = f32(1 / f32(b + f32(x + a)));
    // (c - a * b, each rounded once: the console's fnmsubs)
    r = f32(-madd(r, ATAN[7 + at], -b) + -madd(r, ATAN[13 + at], -a));
  } else r = x;
  const sq = f32(r * r);
  let poly = ATAN[6];
  for (const k of [5, 4, 3, 2, 1]) poly = fmadd(sq, poly, ATAN[k]);
  let out = fmadd(f32(r * sq), poly, r);
  out = f32(out + ATAN[27 + at]);
  out = f32(out + ATAN[20 + at]);
  if (over) {
    out = f32(out - HALF_PI_F);
    return neg ? out : -out;
  }
  return neg ? -out : out;
}

/** the game's atan2f */
export function atan2f(y: number, x: number): number {
  y = f32(y);
  x = f32(x);
  if (negative(x) === negative(y)) {
    if (negative(x)) return x === 0 ? -HALF_PI_F : f32(atanf(f32(y / x)) - PI_F);
    return x ? atanf(f32(y / x)) : HALF_PI_F;
  }
  if (x < 0) return f32(PI_F + atanf(f32(y / x)));
  if (x) return atanf(f32(y / x));
  return negative(y) ? -HALF_PI_F : HALF_PI_F;
}
