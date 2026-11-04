/* GX renderer: 32-bit floating point in whole numbers, for the pixel shader (GLSL ES 3.00).
 *
 * The raster spec rounds every float operation to binary32, in the order written, without fusing a multiply and an add. A GPU's own
 * float arithmetic may fuse them, and its division and square root are not required to round correctly, so the shader does these
 * operations in 32-bit unsigned integers on the IEEE bit patterns: a float is a `uint`. Results are correctly rounded (ties to even);
 * numbers below the smallest normal number are flushed to zero (the spec: "treat denormals as zero"); infinities and not-a-numbers are
 * carried through the way IEEE has them.
 *
 * The functions are written without early returns and without short-circuit branches (every special case is a select at the end):
 * a shader compiler that inlines them everywhere (Direct3D's does) takes minutes over the branching version and seconds over this one.
 */
export const SOFT_FLOAT_GLSL = /* glsl */ `
// run-time loop bounds (the program sets uK to (4, 25, 3, 2)): a loop the compiler cannot unroll keeps the shader small
uniform ivec4 uK;
const uint F_NAN = 0x7fc00000u;
const uint F_ONE = 0x3f800000u;
const uint F_INF = 0x7f800000u;

// index of the highest set bit of m (m != 0); GLSL ES 3.00 has no findMSB
int f_msb(uint m) {
  int r = 0;
  bool c16 = m >= 0x10000u; r += c16 ? 16 : 0; m = c16 ? m >> 16 : m;
  bool c8 = m >= 0x100u; r += c8 ? 8 : 0; m = c8 ? m >> 8 : m;
  bool c4 = m >= 0x10u; r += c4 ? 4 : 0; m = c4 ? m >> 4 : m;
  bool c2 = m >= 4u; r += c2 ? 2 : 0; m = c2 ? m >> 2 : m;
  r += m >= 2u ? 1 : 0;
  return r;
}

// pack a rounded result: sign, biased exponent e, 24-bit mantissa m (bit 23 set), guard bit and sticky (0 or 1)
uint f_pack(uint s, int e, uint m, uint guard, uint sticky) {
  uint up = guard & (sticky | (m & 1u));
  m += up;
  bool carry = m == 0x1000000u;
  m = carry ? 0x800000u : m;
  e += carry ? 1 : 0;
  uint r = (uint(clamp(e, 0, 255)) << 23) | (m & 0x7fffffu);
  r = e >= 255 ? F_INF : r;
  r = e <= 0 ? 0u : r;
  return (s << 31) | r;
}

uint f_neg(uint a) { return a ^ 0x80000000u; }
uint f_abs(uint a) { return a & 0x7fffffffu; }

uint f_add(uint a, uint b) {
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  bool sw = aa < ab;
  uint x = sw ? b : a, y = sw ? a : b;
  uint ax = sw ? ab : aa, ay = sw ? aa : ab;
  uint sx = x >> 31, sy = y >> 31;
  int ex = int(ax >> 23), ey = int(ay >> 23);
  uint mx = ex == 0 ? 0u : (((ax & 0x7fffffu) | 0x800000u) << 3);
  uint my = ey == 0 ? 0u : (((ay & 0x7fffffu) | 0x800000u) << 3);
  uint sh = uint(min(ex - ey, 31));
  uint lost = my & ((1u << sh) - 1u);
  my = (my >> sh) | (lost != 0u ? 1u : 0u);
  uint m = sx == sy ? mx + my : mx - my;
  bool ov = m >= 0x8000000u;
  int lz = (ov || m == 0u) ? 0 : max(0, 26 - f_msb(m));
  uint mn = ov ? ((m >> 1) | (m & 1u)) : (m << uint(lz));
  int e = ex + (ov ? 1 : 0) - lz;
  uint r = f_pack(sx, e, mn >> 3, (mn >> 2) & 1u, (mn & 3u) != 0u ? 1u : 0u);
  r = m == 0u ? 0u : r;
  r = ex == 0 ? (a & b & 0x80000000u) : r;
  // infinities and not-a-numbers
  uint sp = (ax > F_INF || (ay == F_INF && sx != sy)) ? F_NAN : x;
  return ex == 255 ? sp : r;
}

uint f_sub(uint a, uint b) { return f_add(a, f_neg(b)); }

uint f_mul(uint a, uint b) {
  uint s = (a ^ b) >> 31;
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  int ea = int(aa >> 23), eb = int(ab >> 23);
  int e = ea + eb - 127;
  uint ma = (aa & 0x7fffffu) | 0x800000u, mb = (ab & 0x7fffffu) | 0x800000u;
  uint ah = ma >> 12, al = ma & 0xfffu, bh = mb >> 12, bl = mb & 0xfffu;
  uint ll = al * bl, mid = al * bh + ah * bl, hh = ah * bh;
  uint lo = ll + ((mid & 0xfffu) << 12);
  uint hi = hh + (mid >> 12) + (lo >> 24);
  lo &= 0xffffffu;
  // the 48-bit product is hi * 2^24 + lo; its top bit is bit 47 or 46
  bool top = hi >= 0x800000u;
  uint m = top ? hi : ((hi << 1) | (lo >> 23));
  uint guard = top ? (lo >> 23) : ((lo >> 22) & 1u);
  uint sticky = top ? ((lo & 0x7fffffu) != 0u ? 1u : 0u) : ((lo & 0x3fffffu) != 0u ? 1u : 0u);
  uint r = f_pack(s, e + (top ? 1 : 0), m, guard, sticky);
  bool za = ea == 0, zb = eb == 0, ia = aa == F_INF, ib = ab == F_INF;
  bool nan = aa > F_INF || ab > F_INF || (ia && zb) || (ib && za);
  r = (za || zb) ? (s << 31) : r;
  r = (ia || ib) ? ((s << 31) | F_INF) : r;
  return nan ? F_NAN : r;
}

uint f_div(uint a, uint b) {
  uint s = (a ^ b) >> 31;
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  int ea = int(aa >> 23), eb = int(ab >> 23);
  int e = ea - eb + 127;
  uint ma = (aa & 0x7fffffu) | 0x800000u, mb = (ab & 0x7fffffu) | 0x800000u;
  // q = floor(r0 * 2^24 / mb) for r0 = ma, or twice ma when that is below mb (so r0 / mb is in [1, 2)): 25 bits, and the remainder says whether the quotient is exact.
  // The GPU's own division gives the quotient to within a few units; the exact remainder, taken modulo 2^32 (it is far smaller than that), then corrects it.
  bool less = ma < mb;
  uint r0 = less ? ma << 1 : ma;
  e -= less ? 1 : 0;
  int q = int(float(r0) / float(mb) * 16777216.0);
  int imb = int(mb);
  int rem = int((r0 << 24) - uint(q) * mb);
  int dq = int(floor(float(rem) / float(mb)));
  q += dq; rem -= dq * imb;
  for (int i = 0; i < 2; i++) {
    if (rem < 0) { q -= 1; rem += imb; }
    else if (rem >= imb) { q += 1; rem -= imb; }
  }
  uint qu = uint(q);
  uint res = f_pack(s, e, qu >> 1, qu & 1u, rem != 0 ? 1u : 0u);
  bool za = ea == 0, zb = eb == 0, ia = aa == F_INF, ib = ab == F_INF;
  bool nan = aa > F_INF || ab > F_INF || (ia && ib) || (za && zb);
  res = (ib || za) ? (s << 31) : res;
  res = (ia || zb) ? ((s << 31) | F_INF) : res;
  return nan ? F_NAN : res;
}

// float(n) for |n| < 2^24
uint f_from_int(int n) {
  uint s = n < 0 ? 1u : 0u;
  uint m = uint(n < 0 ? -n : n);
  int msb = f_msb(m | 1u);
  uint r = (s << 31) | (uint(msb + 127) << 23) | ((m << uint(23 - msb)) & 0x7fffffu);
  return n == 0 ? 0u : r;
}

// the spec's trunc: toward zero; -2^31 when |x| >= 2^31 or not a number
int f_trunc(uint a) {
  int e = int((a >> 23) & 255u) - 127;
  uint m = (a & 0x7fffffu) | 0x800000u;
  uint v = e >= 23 ? (m << uint(clamp(e - 23, 0, 31))) : (m >> uint(clamp(23 - e, 0, 31)));
  int r = (a >> 31) == 1u ? -int(v) : int(v);
  r = e < 0 ? 0 : r;
  return e >= 31 ? -2147483647 - 1 : r;
}

// ordered key: integers compare like the floats (zeros equal); not-a-numbers must be excluded by the caller
uint f_key(uint a) {
  uint k = (a >> 31) == 1u ? ~a : (a | 0x80000000u);
  return (a << 1) == 0u ? 0x80000000u : k;
}
bool f_isnan(uint a) { return (a & 0x7fffffffu) > F_INF; }
bool f_lt(uint a, uint b) { return (f_key(a) < f_key(b)) && !f_isnan(a) && !f_isnan(b); }
bool f_gt(uint a, uint b) { return f_lt(b, a); }
bool f_le(uint a, uint b) { return (f_key(a) <= f_key(b)) && !f_isnan(a) && !f_isnan(b); }
bool f_ge(uint a, uint b) { return f_le(b, a); }
bool f_eq(uint a, uint b) { return (f_key(a) == f_key(b)) && !f_isnan(a) && !f_isnan(b); }
bool f_iszero(uint a) { return (a << 1) == 0u; }
`;

/* The graphics card's own float addition and multiplication, made to give exactly the bits of f_add and f_mul above (the spec's
 * rounding); `floatGlsl("fast")` puts them in their place. What the card's own arithmetic leaves open is closed here, the same way on
 * every card:
 * - fusing: a product is never fused into a following addition (nor anything reordered across operations): every result goes through
 *   an exclusive-or with uFence, a uniform the program never sets (it reads zero), so no compiler can see through it;
 * - numbers below the smallest normal number: operands are flushed to signed zeros first (the spec's "treat denormals as zero"),
 *   whatever the card does with them; a sum that small is exact (both operands are multiples of the smallest denormal), so flushing it
 *   gives the spec's signed zero (by the spec's sign rules, taken from the operands, not from the card); a product that small is
 *   rounded by the spec to 24 bits before the flush, which can reach the smallest normal number: the same product scaled by 2^24 (exact,
 *   one operand is below 2 there) is a normal number rounded to those 24 bits and says which;
 * - not-a-numbers: always the one pattern f_add and f_mul give (0x7fc00000).
 * Rounding to nearest even of one addition or multiplication of normal numbers is what WebGL's back ends ask of the card; the renderer
 * checks it, and all of the above, on the card when it starts (gl.ts floatCheck) and uses f_add and f_mul above if anything differs. */
const FAST_ADD_MUL = /* glsl */ `
uniform uint uFence;
uint f_ftz(uint a) { return (a & 0x7f800000u) == 0u ? (a & 0x80000000u) : a; }
uint f_fence(float x) { return floatBitsToUint(x) ^ uFence; }
uint f_add(uint a, uint b) {
  uint A = f_ftz(a), B = f_ftz(b);
  uint r = f_fence(uintBitsToFloat(A) + uintBitsToFloat(B));
  uint mA = A & 0x7fffffffu, mB = B & 0x7fffffffu;
  uint z = (mA | mB) == 0u ? (A & B & 0x80000000u) : (A == (B ^ 0x80000000u) ? 0u : ((mA >= mB ? A : B) & 0x80000000u));
  r = (r & 0x7f800000u) == 0u ? z : r;
  return (r & 0x7fffffffu) > F_INF ? F_NAN : r;
}
uint f_mul(uint a, uint b) {
  uint A = f_ftz(a), B = f_ftz(b);
  float fa = uintBitsToFloat(A), fb = uintBitsToFloat(B);
  uint r = f_fence(fa * fb);
  uint p2 = f_fence(uintBitsToFloat(f_fence(fa * 16777216.0)) * fb) & 0x7fffffffu;
  bool zero = (A & 0x7fffffffu) == 0u || (B & 0x7fffffffu) == 0u;
  uint tiny = ((A ^ B) & 0x80000000u) | (!zero && p2 >= 0x0c800000u ? 0x00800000u : 0u);
  r = (r & 0x7fffffffu) <= 0x00800000u ? tiny : r;
  return (r & 0x7fffffffu) > F_INF ? F_NAN : r;
}
`;

const ADD_FROM = "uint f_add(uint a, uint b) {", ADD_TO = "uint f_sub(uint a, uint b)";
const MUL_FROM = "uint f_mul(uint a, uint b) {", MUL_TO = "uint f_div(uint a, uint b)";
const cutOut = (s: string, from: string, to: string): [string, string] => {
  const a = s.indexOf(from), b = s.indexOf(to);
  if (a < 0 || b < a) throw new Error("glsl-float: no " + from);
  return [s.slice(0, a) + s.slice(b), s.slice(a, b)];
};

/** How the pixel shader does float addition and multiplication: "soft" in whole numbers (SOFT_FLOAT_GLSL as it is), "fast" with the card's
 *  own arithmetic made exact (FAST_ADD_MUL), "dual" both (a check: the soft result is used, and any operation whose two results differ
 *  sets gFloatMismatch) */
export type FloatOps = "soft" | "fast" | "dual";
export function floatGlsl(mode: FloatOps): string {
  if (mode === "soft") return SOFT_FLOAT_GLSL;
  const [noAdd, softAdd] = cutOut(SOFT_FLOAT_GLSL, ADD_FROM, ADD_TO);
  const [rest, softMul] = cutOut(noAdd, MUL_FROM, MUL_TO);
  // (f_sub, the first user of f_add, follows where f_add was: the replacements go there)
  const at = rest.indexOf(ADD_TO);
  if (mode === "fast") return rest.slice(0, at) + FAST_ADD_MUL + rest.slice(at);
  const ren = (s: string, p: string) => s.replace(/\bf_(add|mul)\(/g, p + "_$1(");
  const dual = ren(softAdd, "sf") + ren(softMul, "sf") + ren(FAST_ADD_MUL, "ff") + `
bool gFloatMismatch = false;
uint f_add(uint a, uint b) { uint s = sf_add(a, b); gFloatMismatch = gFloatMismatch || s != ff_add(a, b); return s; }
uint f_mul(uint a, uint b) { uint s = sf_mul(a, b); gFloatMismatch = gFloatMismatch || s != ff_mul(a, b); return s; }
`;
  return rest.slice(0, at) + dual + rest.slice(at);
}