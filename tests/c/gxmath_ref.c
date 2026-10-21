/* The reference for src/render3d/gxmath.ts: the Melee decompilation's versions of the same functions in C, in
 * float, each fused multiply-add of the paired-single assembly (and of the -fp_contract on game code) written
 * as fmaf, every other step a plain float operation. Built with contraction off, so the compiler adds none:
 *
 *   cc -O1 -std=c99 -ffp-contract=off -fno-fast-math gxmath_ref.c -lm
 *
 * The estimates frsqrte and fres are the Gekko's tables, and a single-precision multiply by a double (an
 * estimate) rounds that operand to a 25-bit significand first (f25), as the hardware does.
 *
 * Used by tests/gxmath.test.ts: `ref <function> <in> <out>` reads float32s from <in> in groups (the
 * function's arguments) and writes the results' float32s to <out>. */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

typedef float Mtx[3][4];

static uint64_t bits64(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static double from64(uint64_t u) { double d; memcpy(&d, &u, 8); return d; }

static const int32_t RSQ_BASE[32] = {
    0x1a7e800, 0x17cb800, 0x1552800, 0x130c000, 0x10f2000, 0x0eff000, 0x0d2e000, 0x0b7c000,
    0x09e5000, 0x0867000, 0x06ff000, 0x05ab800, 0x046a000, 0x0339800, 0x0218800, 0x0105800,
    0x3ffa000, 0x3c29000, 0x38aa000, 0x3572000, 0x3279000, 0x2fb7000, 0x2d26000, 0x2ac0000,
    0x2881000, 0x2665000, 0x2468000, 0x2287000, 0x20c1000, 0x1f12000, 0x1d79000, 0x1bf4000,
};
static const int32_t RSQ_STEP[32] = {
    0x568, 0x4f3, 0x48d, 0x435, 0x3e7, 0x3a2, 0x365, 0x32e, 0x2fc, 0x2d0, 0x2a8, 0x283, 0x261, 0x243, 0x226, 0x20b,
    0x7a4, 0x700, 0x670, 0x5f2, 0x584, 0x524, 0x4cc, 0x47e, 0x43a, 0x3fa, 0x3c2, 0x38e, 0x35e, 0x332, 0x30a, 0x2e6,
};
static const int32_t RES_BASE[32] = {
    0x7ff800, 0x783800, 0x70ea00, 0x6a0800, 0x638800, 0x5d6200, 0x579000, 0x520800, 0x4cc800, 0x47ca00, 0x430800,
    0x3e8000, 0x3a2c00, 0x360800, 0x321400, 0x2e4a00, 0x2aa800, 0x272c00, 0x23d600, 0x209e00, 0x1d8800, 0x1a9000,
    0x17ae00, 0x14f800, 0x124400, 0x0fbe00, 0x0d3800, 0x0ade00, 0x088400, 0x065000, 0x041c00, 0x020c00,
};
static const int32_t RES_STEP[32] = {
    0x3e1, 0x3a7, 0x371, 0x340, 0x313, 0x2ea, 0x2c4, 0x2a0, 0x27f, 0x261, 0x245, 0x22a, 0x212, 0x1fb, 0x1e5, 0x1d1,
    0x1be, 0x1ac, 0x19b, 0x18b, 0x17c, 0x16e, 0x15b, 0x15b, 0x143, 0x143, 0x12d, 0x12d, 0x11a, 0x11a, 0x108, 0x106,
};

/* frsqrte (normal positive inputs: all the tests give it) */
static double frsqrte(double x)
{
    uint64_t u = bits64(x);
    int64_t e = (int64_t) ((u >> 52) & 0x7ff);
    uint64_t frac = u & ((1ULL << 52) - 1);
    if (x == 0) return INFINITY;
    int64_t e2 = ((0x3FFLL << 52) - (((e << 52) - (0x3FELL << 52)) / 2)) & (0x7FFLL << 52);
    int i = (int) ((((uint64_t) (e & 1)) << 52 | frac) >> 37);
    int k = i / 2048;
    uint64_t f = (uint64_t) (RSQ_BASE[k] - RSQ_STEP[k] * (i % 2048)) << 26;
    return from64((uint64_t) e2 | f);
}

static double fres(double x)
{
    uint64_t u = bits64(x);
    uint64_t sign = u & (1ULL << 63);
    int64_t e = (int64_t) (u & (0x7FFLL << 52));
    uint64_t frac = u & ((1ULL << 52) - 1);
    if (x == 0) return copysign(INFINITY, x);
    if (e < (895LL << 52)) return copysign(3.4028234663852886e38, x);
    if (e >= (1149LL << 52)) return copysign(0.0, x);
    e = (0x7FDLL << 52) - e;
    int i = (int) (frac >> 37);
    int k = i / 1024;
    uint64_t f = (uint64_t) (RES_BASE[k] - (RES_STEP[k] * (i % 1024) + 1) / 2) << 29;
    return from64(sign | (uint64_t) e | f);
}

static double f25(double d)
{
    uint64_t u = bits64(d);
    u = (u & 0xFFFFFFFFF8000000ULL) + (u & 0x8000000ULL);
    return from64(u);
}

/* a single-precision multiply by a double operand c */
static float fmuls_d(double a, double c) { return (float) (a * f25(c)); }

/* ---------------------------------------------------------------- MSL trigf.c, its tables (math_data.c) */

static const float QUADRANT[8] = { 0, 1, 1, 0, 0, -1, -1, 0 };
static const float POLY[10] = { 0.0000035287617f, 0.0000003089747f, -0.0003259365f, -0.00003657235f, 0.015854323f,
                                0.0024903931f, -0.30842513f, -0.08074551f, 1.0f, 0.7853982f };
static const float FOPM1[4] = { 0.25f, 0.0232393741608f, 1.70555722434e-7f, 1.86736494323e-11f };

static float reduce(float x, int* np)
{
    float z = (2.0f / (float) M_PI) * x;
    int n = signbit(x) ? (int) (z - 0.5f) : (int) (z + 0.5f);
    float y = x - (float) (n * 2);
    y = fmaf(FOPM1[0], x, y);
    y = fmaf(FOPM1[1], x, y);
    y = fmaf(FOPM1[2], x, y);
    y = fmaf(FOPM1[3], x, y);
    *np = n & 3;
    return y;
}

static float sinf_msl(float x)
{
    int n;
    float y = reduce(x, &n), ysq, z;
    if (fabsf(y) < 3.45266983e-4f) {
        n <<= 1;
        return fmaf(QUADRANT[n + 1] * y, POLY[9], QUADRANT[n]);
    }
    ysq = y * y;
    if (n & 1) {
        n <<= 1;
        z = fmaf(fmaf(fmaf(fmaf(POLY[0], ysq, POLY[2]), ysq, POLY[4]), ysq, POLY[6]), ysq, POLY[8]);
        return z * QUADRANT[n];
    }
    n <<= 1;
    z = fmaf(fmaf(fmaf(fmaf(POLY[1], ysq, POLY[3]), ysq, POLY[5]), ysq, POLY[7]), ysq, POLY[9]) * y;
    return z * QUADRANT[n + 1];
}

static float cosf_msl(float x)
{
    int n;
    float y = reduce(x, &n), ysq, z;
    if (fabsf(y) < 3.45266983e-4f) {
        n <<= 1;
        return QUADRANT[n + 1] - y * QUADRANT[n];
    }
    ysq = y * y;
    if (n & 1) {
        n <<= 1;
        z = -(fmaf(fmaf(fmaf(fmaf(POLY[1], ysq, POLY[3]), ysq, POLY[5]), ysq, POLY[7]), ysq, POLY[9]) * y);
        return z * QUADRANT[n];
    }
    n <<= 1;
    z = fmaf(fmaf(fmaf(fmaf(POLY[0], ysq, POLY[2]), ysq, POLY[4]), ysq, POLY[6]), ysq, POLY[8]);
    return z * QUADRANT[n + 1];
}

static float tanf_msl(float x) { return sinf_msl(x) / cosf_msl(x); }

/* MSL math_ppc.h's inline sqrtf */
static float sqrtf_msl(float x)
{
    if (x > 0.0f) {
        double g = frsqrte((double) x);
        g = (0.5 * g) * fma(-(double) x, g * g, 3.0);
        g = (0.5 * g) * fma(-(double) x, g * g, 3.0);
        g = (0.5 * g) * fma(-(double) x, g * g, 3.0);
        return (float) ((double) x * g);
    }
    return x;
}

/* ---------------------------------------------------------------- vec.c */

static void PSVECNormalize(const float* v, float* out)
{
    /* ps_mul xx_yy; ps_madd xx_zz = z*z + xx; ps_sum0 sqsum */
    float xx = v[0] * v[0], yy = v[1] * v[1];
    float sq = fmaf(v[2], v[2], xx) + yy;
    double r = frsqrte(sq);
    float w0 = fmuls_d(r, r);                  /* fmuls nwork0, rsqrt, rsqrt */
    float w1 = (float) (r * 0.5);              /* fmuls nwork1, rsqrt, c_half */
    w0 = -fmaf(w0, sq, -3.0f);                 /* fnmsubs nwork0, nwork0, sqsum, c_three */
    float k = w0 * w1;
    out[0] = v[0] * k; out[1] = v[1] * k; out[2] = v[2] * k;
}

static float PSVECMag(const float* v)
{
    float xx = v[0] * v[0], yy = v[1] * v[1];
    float sq = fmaf(v[2], v[2], xx) + yy;
    double r = frsqrte(sq);
    float f2 = fmuls_d(r, r);
    float f0 = (float) (r * 0.5);
    f2 = -fmaf(f2, sq, -3.0f);
    f0 = f2 * f0;
    if (!(f0 >= 0)) f0 = sq;                   /* fsel */
    return sq * f0;
}

static float PSVECDotProduct(const float* a, const float* b)
{
    float yy = a[1] * b[1], zz = a[2] * b[2];
    return fmaf(a[0], b[0], yy) + zz;
}

static void PSVECCrossProduct(const float* a, const float* b, float* out)
{
    float f4_0 = b[0] * a[2], f4_1 = b[1] * a[2]; /* ps_mul f4, f1, f2 */
    float f7_0 = b[0] * a[0], f7_1 = b[1] * a[0]; /* ps_muls0 f7, f1, f0 */
    float f5_0 = fmaf(a[0], b[2], -f4_0), f5_1 = fmaf(a[1], b[2], -f4_1);
    float f8_1 = fmaf(a[1], b[0], -f7_1);
    (void) f7_0;
    out[0] = f5_1; out[1] = -f5_0; out[2] = -f8_1;
}

/* ---------------------------------------------------------------- mtx.c, mtxvec.c */

static void PSMTXConcat(Mtx a, Mtx b, Mtx ab)
{
    Mtx m;
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 4; c++) {
            float v = a[r][0] * b[0][c];       /* ps_muls0 */
            v = fmaf(a[r][1], b[1][c], v);     /* ps_madds1 */
            v = fmaf(a[r][2], b[2][c], v);     /* ps_madds0 */
            v = fmaf(c == 3 ? 1.0f : 0.0f, a[r][3], v); /* ps_madds1 by Unit01 */
            m[r][c] = v;
        }
    memcpy(ab, m, sizeof(Mtx));
}

static void PSMTXMultVec(Mtx m, const float* v, float* out)
{
    float o[3];
    for (int r = 0; r < 3; r++) {
        float s0 = fmaf(m[r][2], v[2], m[r][0] * v[0]);
        float s1 = fmaf(m[r][3], 1.0f, m[r][1] * v[1]);
        o[r] = s0 + s1;
    }
    memcpy(out, o, sizeof o);
}

static void PSMTXMultVecSR(Mtx m, const float* v, float* out)
{
    float o[3];
    for (int r = 0; r < 3; r++) {
        float s = m[r][0] * v[0] + m[r][1] * v[1]; /* ps_mul, ps_sum0 */
        o[r] = fmaf(m[r][2], v[2], s);
    }
    memcpy(out, o, sizeof o);
}

static int PSMTXInverse(Mtx s, Mtx inv)
{
    float f11_0 = fmaf(s[0][1], s[1][2], -(s[1][1] * s[0][2])), f11_1 = fmaf(s[0][2], s[1][0], -(s[1][2] * s[0][0]));
    float f13_0 = fmaf(s[1][1], s[2][2], -(s[2][1] * s[1][2])), f13_1 = fmaf(s[1][2], s[2][0], -(s[2][2] * s[1][0]));
    float f12_0 = fmaf(s[2][1], s[0][2], -(s[0][1] * s[2][2])), f12_1 = fmaf(s[2][2], s[0][0], -(s[0][2] * s[2][0]));
    float f10 = fmaf(s[1][0], s[2][1], -(s[1][1] * s[2][0]));
    float f9 = fmaf(s[0][1], s[2][0], -(s[0][0] * s[2][1]));
    float f8 = fmaf(s[0][0], s[1][1], -(s[0][1] * s[1][0]));
    float det = s[0][0] * f13_0;
    det = fmaf(s[1][0], f12_0, det);
    det = fmaf(s[2][0], f11_0, det);
    if (det == 0) return 0;
    float e = (float) fres(det);
    float r = -fmaf(det, e * e, -(e + e));     /* ps_nmsub f0, f7, f5, f6 */
    f13_0 *= r; f13_1 *= r; f12_0 *= r; f12_1 *= r; f11_0 *= r; f11_1 *= r; f10 *= r; f9 *= r; f8 *= r;
    inv[0][0] = f13_0; inv[0][1] = f12_0; inv[0][2] = f11_0;
    inv[0][3] = -fmaf(f11_0, s[2][3], fmaf(f12_0, s[1][3], f13_0 * s[0][3]));
    inv[1][0] = f13_1; inv[1][1] = f12_1; inv[1][2] = f11_1;
    inv[1][3] = -fmaf(f11_1, s[2][3], fmaf(f12_1, s[1][3], f13_1 * s[0][3]));
    inv[2][0] = f10; inv[2][1] = f9; inv[2][2] = f8;
    inv[2][3] = -fmaf(f8, s[2][3], fmaf(f9, s[1][3], f10 * s[0][3]));
    return 1;
}

static void PSMTXQuat(Mtx m, const float* q)
{
    float x = q[0], y = q[1], z = q[2], w = q[3];
    float xx = x * x, yy = y * y, zz = z * z;
    float zzxx = fmaf(z, z, xx), wwyy = fmaf(w, w, yy);
    float norm = zzxx + wwyy;                  /* ps_sum0 scale */
    float e = (float) fres(norm);
    float scale = e * -fmaf(norm, e, -2.0f);   /* ps_nmsub, ps_mul */
    scale = scale * 2.0f;
    float yw = y * w, xw = x * w, zw = z * w;
    float xyzw = fmaf(x, y, zw), xymzw = fmaf(x, y, -zw);
    float xzyw = fmaf(x, z, yw), yzxw = fmaf(y, z, xw);
    float xzmyw = -fmaf(yw, 2.0f, -xzyw), yzmxw = -fmaf(xw, 2.0f, -yzxw);
    m[0][0] = -fmaf(zz + yy, scale, -1.0f); m[0][1] = xymzw * scale; m[0][2] = xzyw * scale; m[0][3] = 0;
    m[1][0] = xyzw * scale; m[1][1] = -fmaf(zzxx, scale, -1.0f); m[1][2] = yzmxw * scale; m[1][3] = 0;
    m[2][0] = xzmyw * scale; m[2][1] = yzxw * scale; m[2][2] = -fmaf(xx + yy, scale, -1.0f); m[2][3] = 0;
}

static void PSMTXRotAxisRad(Mtx m, const float* axis, float rad)
{
    float s = sinf_msl(rad), c = cosf_msl(rad), t = 1.0f - c, n[3];
    PSVECNormalize(axis, n);
    float tx = n[0] * t, ty = n[1] * t, tz = n[2] * t;
    float xs = n[0] * s, ys = n[1] * s;
    float txny = tx * n[1], tyny = ty * n[1], txnx = tx * n[0], txnz = tx * n[2], tynz = ty * n[2];
    m[0][0] = txnx + c; m[0][1] = -fmaf(n[2], s, -txny); m[0][2] = txnz + ys; m[0][3] = 0;
    m[1][0] = fmaf(n[2], s, txny); m[1][1] = c + tyny; m[1][2] = -xs + tynz; m[1][3] = 0;
    m[2][0] = txnz + -ys; m[2][1] = xs + tynz; m[2][2] = tz * n[2] + c; m[2][3] = 0;
}

/* C_MTXLookAt: the SDK's C (contraction off), its vectors through the paired-single functions */
static void C_MTXLookAt(Mtx m, const float* camPos, const float* camUp, const float* target)
{
    float look[3], right[3], up[3];
    look[0] = camPos[0] - target[0]; look[1] = camPos[1] - target[1]; look[2] = camPos[2] - target[2];
    PSVECNormalize(look, look);
    PSVECCrossProduct(camUp, look, right);
    PSVECNormalize(right, right);
    PSVECCrossProduct(look, right, up);
    m[0][0] = right[0]; m[0][1] = right[1]; m[0][2] = right[2];
    m[0][3] = -((camPos[2] * right[2]) + ((camPos[0] * right[0]) + (camPos[1] * right[1])));
    m[1][0] = up[0]; m[1][1] = up[1]; m[1][2] = up[2];
    m[1][3] = -((camPos[2] * up[2]) + ((camPos[0] * up[0]) + (camPos[1] * up[1])));
    m[2][0] = look[0]; m[2][1] = look[1]; m[2][2] = look[2];
    m[2][3] = -((camPos[2] * look[2]) + ((camPos[0] * look[0]) + (camPos[1] * look[1])));
}

/* mtx44.c */
static void MTXPerspective(float m[4][4], float fovY, float aspect, float n, float f)
{
    float angle = 0.5f * fovY;
    angle = angle * 0.017453293f;
    float cot = 1 / tanf_msl(angle);
    memset(m, 0, 64);
    m[0][0] = cot / aspect;
    m[1][1] = cot;
    float tmp = 1 / (f - n);
    m[2][2] = -n * tmp;
    m[2][3] = tmp * -(f * n);
    m[3][2] = -1;
}

static void MTXFrustum(float m[4][4], float t, float b, float l, float r, float n, float f)
{
    memset(m, 0, 64);
    float tmp = 1 / (r - l);
    m[0][0] = 2 * n * tmp;
    m[0][2] = tmp * (r + l);
    tmp = 1 / (t - b);
    m[1][1] = 2 * n * tmp;
    m[1][2] = tmp * (t + b);
    tmp = 1 / (f - n);
    m[2][2] = -n * tmp;
    m[2][3] = tmp * -(f * n);
    m[3][2] = -1;
}

static void MTXOrtho(float m[4][4], float t, float b, float l, float r, float n, float f)
{
    memset(m, 0, 64);
    float tmp = 1 / (r - l);
    m[0][0] = 2 * tmp;
    m[0][3] = tmp * -(r + l);
    tmp = 1 / (t - b);
    m[1][1] = 2 * tmp;
    m[1][3] = tmp * -(t + b);
    tmp = 1 / (f - n);
    m[2][2] = -1 * tmp;
    m[2][3] = -f * tmp;
    m[3][3] = 1;
}

/* ---------------------------------------------------------------- sysdolphin baselib/mtx.c (-fp_contract on) */

static void HSD_MtxSRT(Mtx m, const float* v1, const float* v2, const float* v3, const float* v4)
{
    float sinX = sinf_msl(v2[0]), cosX = cosf_msl(v2[0]);
    float sinY = sinf_msl(v2[1]), cosY = cosf_msl(v2[1]);
    float sinZ = sinf_msl(v2[2]), cosZ = cosf_msl(v2[2]);
    float x2, y2, z2, x1, y1, z1, x0, y0, z0;
    x2 = x1 = x0 = v1[0];
    y2 = y1 = y0 = v1[1];
    z2 = z1 = z0 = v1[2];
    if (v4 != NULL) {
        float t1 = 1.0 / v4[0];
        float t2 = 1.0 / v4[1];
        float t3 = 1.0 / v4[2];
        y2 *= v4[1] * t1;
        z2 *= v4[2] * t1;
        x1 *= v4[0] * t2;
        z1 *= v4[2] * t2;
        x0 *= v4[0] * t3;
        y0 *= v4[1] * t3;
    }
    m[0][0] = cosZ * (x2 * cosY);
    m[1][0] = sinZ * (x1 * cosY);
    m[2][0] = -x0 * sinY;
    m[0][1] = y2 * fmaf(cosZ, sinX * sinY, -(cosX * sinZ));
    m[1][1] = y1 * fmaf(sinZ, sinX * sinY, cosX * cosZ);
    m[2][1] = cosY * (y0 * sinX);
    m[0][2] = z2 * fmaf(cosZ, cosX * sinY, sinX * sinZ);
    m[1][2] = z1 * fmaf(sinZ, cosX * sinY, -(sinX * cosZ));
    m[2][2] = cosY * (z0 * cosX);
    m[0][3] = v3[0];
    m[1][3] = v3[1];
    m[2][3] = v3[2];
}

static void PSMTXScale(Mtx m, float x, float y, float z)
{
    memset(m, 0, sizeof(Mtx));
    m[0][0] = x; m[1][1] = y; m[2][2] = z;
}

static void PSMTXTrans(Mtx m, float x, float y, float z)
{
    memset(m, 0, sizeof(Mtx));
    m[0][0] = m[1][1] = m[2][2] = 1;
    m[0][3] = x; m[1][3] = y; m[2][3] = z;
}

/* baselib/mtx.c HSD_MkRotationMtx (-fp_contract on: in a * b +- c * d the right product is rounded first) */
static void HSD_MkRotationMtx(Mtx m, const float* r)
{
    float sinX = sinf_msl(r[0]), cosX = cosf_msl(r[0]);
    float sinY = sinf_msl(r[1]), cosY = cosf_msl(r[1]);
    float sinZ = sinf_msl(r[2]), cosZ = cosf_msl(r[2]);
    float t1 = sinX * sinY;
    m[0][0] = cosY * cosZ;
    m[1][0] = cosY * sinZ;
    m[2][0] = -sinY;
    float t2 = cosX * sinY;
    m[0][1] = fmaf(cosZ, t1, -(cosX * sinZ));
    m[1][1] = fmaf(sinZ, t1, cosX * cosZ);
    m[2][1] = sinX * cosY;
    m[0][2] = fmaf(cosZ, t2, sinX * sinZ);
    m[1][2] = fmaf(sinZ, t2, -(sinX * cosZ));
    m[2][2] = cosX * cosY;
    m[0][3] = m[1][3] = m[2][3] = 0;
}

/* tobj.c MakeTextureMtx: translate, scale, rotate (x y z), repeat_s, repeat_t, wrap_t */
static void MakeTextureMtx(Mtx out, const float* tr, const float* sc, const float* rot, int rs, int rt, int wrapT)
{
    float scale[3], r[3], t[3];
    Mtx m;
    scale[0] = fabsf(sc[0]) < 1.1920928955078125e-7f ? 0.0f : (float) rs / sc[0];
    scale[1] = fabsf(sc[1]) < 1.1920928955078125e-7f ? 0.0f : (float) rt / sc[1];
    scale[2] = sc[2];
    r[0] = rot[0]; r[1] = rot[1]; r[2] = -rot[2];
    t[0] = -tr[0];
    t[1] = -(tr[1] + (wrapT == 2 ? 1.0f / ((float) rt / sc[1]) : 0.0f));
    t[2] = tr[2];
    PSMTXTrans(out, t[0], t[1], t[2]);
    HSD_MkRotationMtx(m, r);
    PSMTXConcat(m, out, out);
    PSMTXScale(m, scale[0], scale[1], scale[2]);
    PSMTXConcat(m, out, out);
}

static void HSD_MtxSRTQuat(Mtx m, const float* s, const float* q, const float* t, const float* ps)
{
    Mtx temp;
    PSMTXScale(m, s[0], s[1], s[2]);
    if (ps != NULL) {
        PSMTXScale(temp, ps[0], ps[1], ps[2]);
        PSMTXConcat(temp, m, m);
    }
    PSMTXQuat(temp, q);
    PSMTXConcat(temp, m, m);
    if (ps != NULL) {
        PSMTXScale(temp, 1.0 / ps[0], 1.0 / ps[1], 1.0 / ps[2]);
        PSMTXConcat(temp, m, m);
    }
    PSMTXTrans(temp, t[0], t[1], t[2]);
    PSMTXConcat(temp, m, m);
}

static void HSD_MtxScaledAdd(const float* a0, const float* a1, float* a2, float k)
{
    for (int i = 0; i < 12; i++) a2[i] = fmaf(k, a0[i], a1[i]);
}

static float det3x4(Mtx m)
{
    float d = m[2][0] * (m[0][1] * m[1][2]);
    d = fmaf(m[2][2], m[0][0] * m[1][1], d);
    d = fmaf(m[2][1], m[0][2] * m[1][0], d);
    d = -fmaf(m[0][2], m[2][0] * m[1][1], -d);
    d = -fmaf(m[2][2], m[1][0] * m[0][1], -d);
    d = -fmaf(m[1][2], m[0][0] * m[2][1], -d);
    return d;
}

static void HSD_MtxInverseTranspose(Mtx src, Mtx dest)
{
    float det = det3x4(src);
    Mtx o;
    if (fabsf(det) < 0.0000000001f) {
        memcpy(dest, src, sizeof(Mtx));
        return;
    }
    det = 1.0f / det;
    o[0][0] = fmaf(src[1][1], src[2][2], -(src[2][1] * src[1][2])) * det;
    o[1][0] = -fmaf(src[0][1], src[2][2], -(src[2][1] * src[0][2])) * det;
    o[2][0] = fmaf(src[0][1], src[1][2], -(src[1][1] * src[0][2])) * det;
    o[0][1] = -fmaf(src[1][0], src[2][2], -(src[2][0] * src[1][2])) * det;
    o[1][1] = fmaf(src[0][0], src[2][2], -(src[2][0] * src[0][2])) * det;
    o[2][1] = -fmaf(src[0][0], src[1][2], -(src[1][0] * src[0][2])) * det;
    o[0][2] = fmaf(src[1][0], src[2][1], -(src[2][0] * src[1][1])) * det;
    o[1][2] = -fmaf(src[0][0], src[2][1], -(src[2][0] * src[0][1])) * det;
    o[2][2] = fmaf(src[0][0], src[1][1], -(src[1][0] * src[0][1])) * det;
    o[0][3] = 0; o[1][3] = 0; o[2][3] = 0;
    memcpy(dest, o, sizeof(Mtx));
}

/* p * q +- r: the left product fused, the right one rounded first */
#define MSUB(p, q, r) fmaf((p), (q), -(r))
#define MADD(p, q, r) fmaf((p), (q), (r))

static void HSD_MtxInverseConcat(Mtx inv, Mtx src, Mtx dest)
{
    float det = det3x4(inv);
    if (fabsf(det) < 0.0000000001f) {
        memcpy(dest, src, sizeof(Mtx));
        return;
    }
    det = 1.0f / det;
    float t1 = MSUB(inv[1][1], inv[2][2], inv[2][1] * inv[1][2]) * det;
    float t2 = (-MSUB(inv[0][1], inv[2][2], inv[2][1] * inv[0][2])) * det;
    float t3 = (-MSUB(inv[1][0], inv[2][2], inv[2][0] * inv[1][2])) * det;
    float t7 = MSUB(inv[0][1], inv[1][2], inv[1][1] * inv[0][2]) * det;
    float t4 = MSUB(inv[0][0], inv[2][2], inv[2][0] * inv[0][2]) * det;
    float t8 = (-MSUB(inv[0][0], inv[1][2], inv[1][0] * inv[0][2])) * det;
    float t5 = MSUB(inv[1][0], inv[2][1], inv[2][0] * inv[1][1]) * det;
    float t6 = (-MSUB(inv[0][0], inv[2][1], inv[2][0] * inv[0][1])) * det;
    float t9 = MSUB(inv[0][0], inv[1][1], inv[1][0] * inv[0][1]) * det;
    float t10 = -MSUB(t7, inv[2][3], MSUB(-t1, inv[0][3], t2 * inv[1][3]));
    float t11 = -MSUB(t8, inv[2][3], MSUB(-t3, inv[0][3], t4 * inv[1][3]));
    float t12 = -MSUB(t9, inv[2][3], MSUB(-t5, inv[0][3], t6 * inv[1][3]));
    float rows[3][4] = { { t1, t2, t7, t10 }, { t3, t4, t8, t11 }, { t5, t6, t9, t12 } };
    Mtx m;
    for (int r = 0; r < 3; r++)
        for (int k = 0; k < 4; k++) {
            float v = MADD(rows[r][2], src[2][k], MADD(rows[r][0], src[0][k], rows[r][1] * src[1][k]));
            m[r][k] = k == 3 ? v + rows[r][3] : v;
        }
    memcpy(dest, m, sizeof(Mtx));
}

static void PSVECScale(const float* v, float* out, float k) { out[0] = v[0] * k; out[1] = v[1] * k; out[2] = v[2] * k; }
static void PSVECSubtract(const float* a, const float* b, float* out) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; }

/* baselib/mtx.c HSD_MtxGetScale */
static void HSD_MtxGetScale(Mtx m, float* out)
{
    float v1[3] = { m[0][0], m[1][0], m[2][0] }, v2[3] = { m[0][1], m[1][1], m[2][1] }, v3[3] = { m[0][2], m[1][2], m[2][2] }, v4[3];
    out[0] = PSVECMag(v1);
    PSVECNormalize(v1, v1);
    PSVECScale(v1, v4, PSVECDotProduct(v1, v2));
    PSVECSubtract(v2, v4, v2);
    out[1] = PSVECMag(v2);
    PSVECNormalize(v2, v2);
    PSVECScale(v2, v4, PSVECDotProduct(v2, v3));
    PSVECSubtract(v3, v4, v3);
    PSVECScale(v1, v4, PSVECDotProduct(v1, v3));
    PSVECSubtract(v3, v4, v3);
    out[2] = PSVECMag(v3);
    PSVECNormalize(v3, v3);
    PSVECCrossProduct(v2, v3, v4);
    if (PSVECDotProduct(v1, v4) < 0.0) {
        double scale = -1.0;
        out[0] *= scale; out[1] *= scale; out[2] *= scale;
    }
}

/* ---------------------------------------------------------------- displayfunc.c's billboards */

static float HSD_MtxColMag(Mtx m, int col)
{
    return sqrtf_msl((m[0][col] * m[0][col]) + (m[1][col] * m[1][col]) + (m[2][col] * m[2][col]));
}

static void colvec(Mtx m, int c, float* v) { v[0] = m[0][c]; v[1] = m[1][c]; v[2] = m[2][c]; }
static void setcol(Mtx m, int c, const float* v) { m[0][c] = v[0]; m[1][c] = v[1]; m[2][c] = v[2]; }

static void mkBillBoard(int kind, int persp, float rotZ, Mtx src, Mtx dst)
{
    static const float zOne[3] = { 0, 0, 1 }, yOne[3] = { 0, 1, 0 };
    float ax[3], ay[3], az[3], pos[3], uy[3];
    if (kind == 0x200) {
        const float* pz;
        float sx = HSD_MtxColMag(src, 0), sz = HSD_MtxColMag(src, 2), sy;
        colvec(src, 1, ay);
        sy = PSVECMag(ay);
        colvec(src, 3, pos);
        if (persp) {
            PSVECCrossProduct(pos, ay, ax);
            PSVECCrossProduct(ax, pos, ay);
            pz = pos;
            sz /= -PSVECMag(pz);
        } else {
            PSVECCrossProduct(ay, zOne, ax);
            PSVECCrossProduct(zOne, ax, ay);
            pz = zOne;
            sz /= PSVECMag(zOne);
        }
        sx /= PSVECMag(ax);
        sy /= PSVECMag(ay);
        dst[0][0] = sx * ax[0]; dst[1][0] = sx * ax[1]; dst[2][0] = sx * ax[2];
        dst[0][1] = sy * ay[0]; dst[1][1] = sy * ay[1]; dst[2][1] = sy * ay[2];
        dst[0][2] = sz * pz[0]; dst[1][2] = sz * pz[1]; dst[2][2] = sz * pz[2];
        setcol(dst, 3, pos);
    } else if (kind == 0x400) {
        float sx, sz;
        colvec(src, 3, pos);
        colvec(src, 1, ay);
        sx = HSD_MtxColMag(src, 0);
        sz = HSD_MtxColMag(src, 2);
        if (persp) PSVECCrossProduct(pos, ay, ax);
        else PSVECCrossProduct(ay, zOne, ax);
        PSVECCrossProduct(ax, ay, az);
        sx /= PSVECMag(ax);
        sz /= PSVECMag(az);
        dst[0][0] = sx * ax[0]; dst[1][0] = sx * ax[1]; dst[2][0] = sx * ax[2];
        setcol(dst, 1, ay);
        dst[0][2] = sz * az[0]; dst[1][2] = sz * az[1]; dst[2][2] = sz * az[2];
        setcol(dst, 3, pos);
    } else if (kind == 0x600) {
        float sy, sz;
        colvec(src, 3, pos);
        colvec(src, 0, ax);
        sy = HSD_MtxColMag(src, 1);
        sz = HSD_MtxColMag(src, 2);
        if (persp) {
            uy[1] = sqrtf_msl(pos[0] * pos[0] + pos[2] * pos[2]);
            uy[0] = -pos[1] / uy[1] * pos[0];
            uy[2] = -pos[1] / uy[1] * pos[2];
            PSVECCrossProduct(ax, uy, az);
        } else {
            PSVECCrossProduct(ax, yOne, az);
        }
        PSVECCrossProduct(az, ax, ay);
        sy /= PSVECMag(ay);
        sz /= PSVECMag(az);
        setcol(dst, 0, ax);
        dst[0][1] = sy * ay[0]; dst[1][1] = sy * ay[1]; dst[2][1] = sy * ay[2];
        dst[0][2] = sz * az[0]; dst[1][2] = sz * az[1]; dst[2][2] = sz * az[2];
        setcol(dst, 3, pos);
    } else {
        Mtx rot, scl;
        float sx = HSD_MtxColMag(src, 0), sy = HSD_MtxColMag(src, 1), sz = HSD_MtxColMag(src, 2);
        float sn = sinf_msl(rotZ), cs = cosf_msl(rotZ);
        PSMTXScale(scl, sx, sy, sz);
        memset(rot, 0, sizeof rot);
        rot[0][0] = cs; rot[0][1] = -sn; rot[1][0] = sn; rot[1][1] = cs; rot[2][2] = 1;
        rot[0][3] = src[0][3]; rot[1][3] = src[1][3]; rot[2][3] = src[2][3];
        PSMTXConcat(rot, scl, dst);
    }
}

/* ---------------------------------------------------------------- cobj.c's roll2upvec and the viewing matrix */

static void cobjViewingMtx(Mtx m, const float* eye, const float* interest, float roll)
{
    float e[3] = { interest[0] - eye[0], interest[1] - eye[1], interest[2] - eye[2] }, up[3];
    if (fabsf(e[0]) <= 1.1754943508222875e-38f && fabsf(e[1]) <= 1.1754943508222875e-38f &&
        fabsf(e[2]) <= 1.1754943508222875e-38f) {
        up[0] = 0; up[1] = 1; up[2] = 0;
    } else {
        float v0[3], v1[3];
        Mtx r;
        PSVECNormalize(e, e);
        if (1.0 - fabsf(e[1]) < 0.0001) {
            v0[0] = sqrtf_msl(e[1] * e[1] + e[2] * e[2]);
            v0[1] = e[1] * (-e[0] / v0[0]);
            v0[2] = e[2] * (-e[0] / v0[0]);
        } else {
            v0[1] = sqrtf_msl(e[0] * e[0] + e[2] * e[2]);
            v0[0] = e[0] * (-e[1] / v0[1]);
            v0[2] = e[2] * (-e[1] / v0[1]);
        }
        PSMTXRotAxisRad(r, e, -roll);
        PSMTXMultVecSR(r, v0, v1);
        PSVECNormalize(v1, up);
    }
    C_MTXLookAt(m, eye, up, interest);
}

/* ---------------------------------------------------------------- the driver */

#ifndef GXMATH_REF_NO_MAIN
int main(int argc, char** argv)
{
    if (argc != 4) return 2;
    const char* fn = argv[1];
    FILE* in = fopen(argv[2], "rb");
    FILE* out = fopen(argv[3], "wb");
    if (!in || !out) return 2;
    float a[32], r[32];
    struct { const char* name; int nin, nout; } F[] = {
        { "madd", 3, 1 }, { "concat", 24, 12 }, { "multvec", 15, 3 }, { "multvecsr", 15, 3 }, { "inverse", 12, 13 },
        { "quat", 4, 12 }, { "rotaxis", 4, 12 }, { "normalize", 3, 3 }, { "mag", 3, 1 }, { "cross", 6, 3 }, { "dot", 6, 1 },
        { "lookat", 9, 12 }, { "perspective", 4, 16 }, { "frustum", 6, 16 }, { "ortho", 6, 16 }, { "srt", 13, 12 },
        { "srtquat", 14, 12 }, { "scaledadd", 25, 12 }, { "invconcat", 24, 12 }, { "sqrtf", 1, 1 }, { "sinf", 1, 1 },
        { "cosf", 1, 1 }, { "tanf", 1, 1 }, { "frsqrte", 1, 2 }, { "fres", 1, 1 }, { "view", 7, 12 }, { "mkrot", 3, 12 }, { "texmtx", 12, 12 }, { "billboard", 15, 12 },
        { "invxpose", 12, 12 }, { "getscale", 12, 3 },
    };
    int k = -1;
    for (int i = 0; i < (int) (sizeof F / sizeof F[0]); i++) if (!strcmp(F[i].name, fn)) k = i;
    if (k < 0) return 3;
    while (fread(a, 4, F[k].nin, in) == (size_t) F[k].nin) {
        memset(r, 0, sizeof r);
        Mtx A, B, C;
        switch (k) {
        case 0: r[0] = fmaf(a[0], a[1], a[2]); break;
        case 1: memcpy(A, a, 48); memcpy(B, a + 12, 48); PSMTXConcat(A, B, C); memcpy(r, C, 48); break;
        case 2: memcpy(A, a, 48); PSMTXMultVec(A, a + 12, r); break;
        case 3: memcpy(A, a, 48); PSMTXMultVecSR(A, a + 12, r); break;
        case 4: memcpy(A, a, 48); memset(C, 0, 48); r[0] = (float) PSMTXInverse(A, C); memcpy(r + 1, C, 48); break;
        case 5: PSMTXQuat(C, a); memcpy(r, C, 48); break;
        case 6: PSMTXRotAxisRad(C, a, a[3]); memcpy(r, C, 48); break;
        case 7: PSVECNormalize(a, r); break;
        case 8: r[0] = PSVECMag(a); break;
        case 9: PSVECCrossProduct(a, a + 3, r); break;
        case 10: r[0] = PSVECDotProduct(a, a + 3); break;
        case 11: C_MTXLookAt(C, a, a + 3, a + 6); memcpy(r, C, 48); break;
        case 12: MTXPerspective((float(*)[4]) r, a[0], a[1], a[2], a[3]); break;
        case 13: MTXFrustum((float(*)[4]) r, a[0], a[1], a[2], a[3], a[4], a[5]); break;
        case 14: MTXOrtho((float(*)[4]) r, a[0], a[1], a[2], a[3], a[4], a[5]); break;
        case 15: HSD_MtxSRT(C, a, a + 3, a + 6, a[12] != 0 ? a + 9 : NULL); memcpy(r, C, 48); break;
        case 16: HSD_MtxSRTQuat(C, a, a + 3, a + 7, a[13] != 0 ? a + 10 : NULL); memcpy(r, C, 48); break;
        case 17: HSD_MtxScaledAdd(a, a + 12, r, a[24]); break;
        case 18: memcpy(A, a, 48); memcpy(B, a + 12, 48); HSD_MtxInverseConcat(A, B, C); memcpy(r, C, 48); break;
        case 19: r[0] = sqrtf_msl(a[0]); break;
        case 20: r[0] = sinf_msl(a[0]); break;
        case 21: r[0] = cosf_msl(a[0]); break;
        case 22: r[0] = tanf_msl(a[0]); break;
        case 23: { double d = frsqrte(a[0]); uint64_t u = bits64(d); uint32_t w[2] = { (uint32_t) u, (uint32_t) (u >> 32) };
                   memcpy(r, w, 8); break; }
        case 24: r[0] = (float) fres(a[0]); break;
        case 25: cobjViewingMtx(C, a, a + 3, a[6]); memcpy(r, C, 48); break;
        case 26: HSD_MkRotationMtx(C, a); memcpy(r, C, 48); break;
        case 27: MakeTextureMtx(C, a, a + 3, a + 6, (int) a[9], (int) a[10], (int) a[11]); memcpy(r, C, 48); break;
        case 28: memcpy(A, a, 48); memset(C, 0, 48); mkBillBoard((int) a[12], (int) a[13], a[14], A, C); memcpy(r, C, 48); break;
        case 29: memcpy(A, a, 48); HSD_MtxInverseTranspose(A, C); memcpy(r, C, 48); break;
        case 30: memcpy(A, a, 48); HSD_MtxGetScale(A, r); break;
        }
        fwrite(r, 4, F[k].nout, out);
    }
    fclose(out);
    return 0;
}
#endif
