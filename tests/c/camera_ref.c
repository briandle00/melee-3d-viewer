/* The reference for src/render3d/camera.ts's float32 camera steps: the Melee decompilation's C for them, in float,
 * each fused multiply-add of the -fp_contract on game code written as fmaf (the boundaries the matched build shows:
 * the first product fused, the second rounded first; a += b * c fused; squares of a struct's fields not fused).
 * Built with contraction off on top of tests/c/gxmath_ref.c (its frsqrte, MSL sqrtf and trigonometry):
 *
 *   cc -O1 -std=c99 -ffp-contract=off -fno-fast-math camera_ref.c -lm
 *
 * Used by tests/camera-f32.test.ts: `ref <function> <in> <out>`, float32s in groups, results' float32s out. */
#define GXMATH_REF_NO_MAIN
#include "gxmath_ref.c"

/* ---------------------------------------------------------------- MSL atanf, atan2f (the game's math library) */

static const float ATAN[46] = {
    1.0f, -0.3333333134651184f, 0.1999988704919815f, -0.14281649887561798f, 0.11041180044412613f,
    -0.08459755778312683f, 0.04714243486523628f, 6.828420162200928f, 3.239828109741211f, 2.0f, 1.4464620351791382f,
    1.1715729236602783f, 1.039566159248352f, 7.1350000325764995e-06f, 8.200000252145401e-07f, 0.0f,
    6.299999881775875e-07f, 0.0f, 0.0f, 0.0f, 0.3926900029182434f, 0.5890486240386963f, 0.7853981256484985f,
    0.9817469716072083f, 1.1780970096588135f, 1.3744460344314575f, 0.0f, 9.081698408408556e-06f,
    2.3000000126671694e-08f, 6.30000016599297e-08f, 7.040000014058023e-07f, 2.499999993688107e-07f,
    7.900000014160469e-07f, 2.414212942123413f, 1.4966057538986206f, 1.0f, 0.6681786179542542f,
    0.4142135679721832f, 0.1989123672246933f, 5.620000251838064e-07f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
};
static const float STRETCH[4] = { 0.534511148929596f, 0.8206787705421448f, 1.218503475189209f, 1.870868444442749f };

static float atanf_msl(float value)
{
    int neg = signbit(value) != 0, at = -1, over = 0, k;
    float x = fabsf(value), r, sq, poly, out;
    if (x >= 2.4142136573791504f) {
        over = 1;
        r = 1.0f / x;
    } else if (0.4142135679721832f < x) {
        at = 0;
        for (k = 0; k < 4; k++) at += x >= STRETCH[k];
        float a = ATAN[39 + at], b = ATAN[33 + at];
        r = 1.0f / (b + (x + a));
        r = -fmaf(r, ATAN[7 + at], -b) + -fmaf(r, ATAN[13 + at], -a);
    } else r = x;
    sq = r * r;
    poly = ATAN[6];
    for (k = 5; k >= 1; k--) poly = fmaf(sq, poly, ATAN[k]);
    out = fmaf(r * sq, poly, r);
    out = out + ATAN[27 + at];
    out = out + ATAN[20 + at];
    if (over) {
        out = out - 1.5707963267948966f;
        return neg ? out : -out;
    }
    return neg ? -out : out;
}

static float atan2f_msl(float y, float x)
{
    const float pi = 3.14159265358979f, half = 1.5707963267948966f;
    int nx = signbit(x) != 0, ny = signbit(y) != 0;
    if (nx == ny) {
        if (nx) return x == 0 ? -half : atanf_msl(y / x) - pi;
        return x != 0 ? atanf_msl(y / x) : half;
    }
    if (x < 0) return pi + atanf_msl(y / x);
    if (x != 0) return atanf_msl(y / x);
    return ny ? -half : half;
}

/* ---------------------------------------------------------------- lbvector.c */

static float lbVector_Sin(float angle)
{
    if (angle > M_PI) angle -= 2 * M_PI;
    else if (angle < -M_PI) angle += 2 * M_PI;
    float a3 = 0.15527099370956421f * angle * angle * angle;
    float a4 = 0.0056429998949170113f * angle * angle * angle * angle;
    return fmaf(angle, a4, fmaf(0.9878619909286499f, angle, -a3));
}

static float lbVector_Cos(float angle)
{
    angle += M_PI / 2;
    return lbVector_Sin(angle);
}

static void lbVector_Rotate(float* v, int axis, float angle)
{
    float s = lbVector_Sin(angle), c = lbVector_Cos(angle), x = v[0], y = v[1], z = v[2];
    switch (axis) {
    case 1: y = fmaf(v[1], c, -(v[2] * s)); z = fmaf(v[1], s, v[2] * c); break;
    case 2: x = fmaf(v[0], c, v[2] * s); z = fmaf(v[2], c, -(v[0] * s)); break;
    case 4: x = fmaf(v[0], c, -(v[1] * s)); y = fmaf(v[0], s, v[1] * c); break;
    }
    v[0] = x; v[1] = y; v[2] = z;
}

static float lbVector_Normalize(float* v)
{
    float len = sqrtf_msl(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len == 0.0f) return 0.0f;
    float inv = 1.0f / len;
    v[0] *= inv; v[1] *= inv; v[2] *= inv;
    return len;
}

/* ---------------------------------------------------------------- cm/camera.c */

static const float DEG = 0.017453292f, ASPECT = 1.2173333f;

/* Camera_80029CF8 with get_pitch_angle; the stage's numbers given: cx, cy, near (zoom rate), far (max depth),
 * pitchK (InfoX24), yawK (InfoX20), pan (degrees) */
static void Camera_80029CF8(const float* p, float x0, float x1, float y0, float y1, float fov, float* out)
{
    float cx = p[0], cy = p[1], nearz = p[2], farz = p[3], k24 = p[4], k20 = p[5], pan = p[6] * DEG;
    float dx = x1 - x0, dy = y1 - y0, len = dx > dy ? dx : dy, bias;
    if (len > 120.0f) bias = 0.0682f;
    else if (len < 60.0f) bias = 0.0f;
    else bias = fmaf(0.0682f - 0.0f, (len - 60.0f) / (120.0f - 60.0f), 0.0f);
    float pitch = fmaf((y0 - cy) + (y1 - cy), 0.5f - bias, cy);
    pitch += -30.0f;
    pitch = -(DEG * (pitch * k24));
    float vmax = DEG * 5.0f;
    if (pitch > vmax) pitch = vmax;
    float vmin = DEG * -7.0f;
    if (pitch < vmin) pitch = vmin;
    pitch = pitch + pan;
    float fovr = DEG * fov;
    float fu = fmaf(0.5f, fovr, pitch), fd = fmaf(0.5f, fovr, -pitch);
    float tu = tanf_msl(fu);
    float vdist = dy / (tu + tanf_msl(fd));
    float voff = vdist * tanf_msl(pitch);
    float tiy = voff + -fmaf(vdist, tu, -y1);
    float mid = 0.5f * (x0 + x1);
    float hmax = DEG * 17.5f;
    float yaw = -(DEG * ((mid - cx) * k20));
    if (yaw > hmax) yaw = hmax;
    float hmin = DEG * -17.5f;
    if (yaw < hmin) yaw = hmin;
    float fr = fmaf(0.5f, fovr, -yaw), fl = fmaf(0.5f, fovr, yaw);
    float tr = ASPECT * tanf_msl(fr), tl = ASPECT * tanf_msl(fl);
    float hdist = dx / (tr + tl);
    float hoff = ASPECT * (hdist * tanf_msl(yaw));
    float tix = -fmaf(hdist, tr, -x1) - hoff;
    float tiz = 0.0f;
    float d = vdist > hdist ? vdist : hdist;
    if (d < nearz) d = nearz;
    if (d > farz) d = farz;
    out[0] = tix; out[1] = tiy; out[2] = tix + hoff; out[3] = tiy - voff; out[4] = tiz + d;
}

/* Camera_8002A768, as the match calls it (arg1 0): the stage's camera range given (left, right, top, bottom) */
static void Camera_8002A768(const float* b, float* pos, float* interest, float half_fov)
{
    float dist[3] = { interest[0] - pos[0], interest[1] - pos[1], interest[2] - pos[2] };
    lbVector_Normalize(dist);
    float pitch = atan2f_msl(dist[1], -dist[2]), yaw = atan2f_msl(-dist[0], -dist[2]);
    float c[4][3];
    const int sy[4] = { 1, 1, -1, -1 }, sx[4] = { 1, -1, 1, -1 };
    int miss = 0, hit = 0, k;
    for (k = 0; k < 4; k++) {
        c[k][0] = 0; c[k][1] = 0; c[k][2] = -1;
        lbVector_Rotate(c[k], 1, sy[k] > 0 ? half_fov : -half_fov);
        lbVector_Rotate(c[k], 2, sx[k] > 0 ? half_fov : -half_fov);
        c[k][0] *= ASPECT;
        lbVector_Normalize(c[k]);
        lbVector_Rotate(c[k], 1, pitch);
        lbVector_Rotate(c[k], 2, yaw);
        if (c[k][2] < -0.001f) {
            float t = -pos[2] / c[k][2];
            c[k][0] *= t; c[k][1] *= t; c[k][2] *= t;
            c[k][0] += pos[0]; c[k][1] += pos[1]; c[k][2] += pos[2];
        } else miss |= 1 << k;
    }
    float lo = 0, ro = 0, to = 0, bo = 0, t;
    if (!(miss & 1)) {
        if (c[0][0] < b[0]) { t = b[0] - c[0][0]; if (t > lo) { lo = t; hit |= 4; } }
        if (c[0][1] > b[2]) { t = b[2] - c[0][1]; if (t < to) { to = t; hit |= 1; } }
    }
    if (!(miss & 2)) {
        if (c[1][0] > b[1]) { t = b[1] - c[1][0]; if (t < ro) { ro = t; hit |= 8; } }
        if (c[1][1] > b[2]) { t = b[2] - c[1][1]; if (t < to) { to = t; hit |= 1; } }
    }
    if (!(miss & 4)) {
        if (c[2][0] < b[0]) { t = b[0] - c[2][0]; if (t > lo) { lo = t; hit |= 4; } }
        if (c[2][1] < b[3]) { t = b[3] - c[2][1]; if (t > bo) { bo = t; hit |= 2; } }
    }
    if (!(miss & 8)) {
        if (c[3][0] > b[1]) { t = b[1] - c[3][0]; if (t < ro) { ro = t; hit |= 8; } }
        if (c[3][1] < b[3]) { t = b[3] - c[3][1]; if (t > bo) { bo = t; hit |= 2; } }
    }
    if (hit) {
        float cc[3] = { 0, 0, 0 };
        if ((hit & 4) && (hit & 8)) cc[0] = 0.5f * (lo + ro);
        else if (hit & 4) cc[0] = lo;
        else if (hit & 8) cc[0] = ro;
        if ((hit & 1) && (hit & 2)) cc[1] = 0.5f * (bo + to);
        else if (hit & 1) cc[1] = to;
        else if (hit & 2) cc[1] = bo;
        for (k = 0; k < 3; k++) { cc[k] *= 1.0f; pos[k] += cc[k]; interest[k] += cc[k]; }
    }
}

int main(int argc, char** argv)
{
    if (argc != 4) return 2;
    const char* fn = argv[1];
    FILE* in = fopen(argv[2], "rb");
    FILE* out = fopen(argv[3], "wb");
    if (!in || !out) return 2;
    float a[32], r[32];
    struct { const char* name; int nin, nout; } F[] = {
        { "lbsin", 1, 1 }, { "rotate", 5, 3 }, { "normalize", 3, 3 }, { "atan2", 2, 1 }, { "aim", 12, 5 }, { "correct", 11, 6 },
    };
    int k = -1;
    for (int i = 0; i < (int) (sizeof F / sizeof F[0]); i++) if (!strcmp(F[i].name, fn)) k = i;
    if (k < 0) return 3;
    while (fread(a, 4, F[k].nin, in) == (size_t) F[k].nin) {
        memset(r, 0, sizeof r);
        switch (k) {
        case 0: r[0] = lbVector_Sin(a[0]); break;
        case 1: memcpy(r, a, 12); lbVector_Rotate(r, (int) a[3], a[4]); break;
        case 2: memcpy(r, a, 12); lbVector_Normalize(r); break;
        case 3: r[0] = atan2f_msl(a[0], a[1]); break;
        case 4: Camera_80029CF8(a, a[7], a[8], a[9], a[10], a[11], r); break;
        case 5: memcpy(r, a + 4, 24); Camera_8002A768(a, r, r + 3, a[10]); break;
        }
        fwrite(r, 4, F[k].nout, out);
    }
    fclose(out);
    return 0;
}
