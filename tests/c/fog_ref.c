/* GXSetFog's packing (the Melee decompilation's libs/dolphin/src/dolphin/gx/GXPixel.c), as plain C in single
 * precision, for tests/fog.test.ts: for each line of its input file "type startz endz nearz farz r g b" (the floats as
 * their hex bits) the five registers it writes, one line of hex into its output file. Built with -ffp-contract=off: the SDK is
 * compiled -fp_contract off. The one change from the SDK's text: its (1 << (B_expn + 1)) shifts as the
 * console's slw does (an amount of 32 or more makes 0), which C leaves undefined. */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

typedef float f32;
typedef uint32_t u32;

/* __gx.h's SET_REG_FIELD: the field cleared, the value ORed in unmasked */
#define SET_REG_FIELD(reg, size, shift, val) \
    ((reg) = ((u32) (reg) & ~(((1u << (size)) - 1) << (shift))) | ((u32) (val) << (shift)))

static u32 slw(u32 v, u32 n)
{
    n &= 63;
    return n >= 32 ? 0 : v << n;
}

static void GXSetFog(u32 type, f32 startz, f32 endz, f32 nearz, f32 farz, u32 r, u32 g, u32 b, u32 out[5])
{
    u32 fogclr, fog0, fog1, fog2, fog3;
    f32 A, B, B_mant, C, a, c;
    u32 B_expn, b_m, b_s, a_hex, c_hex;

    if (farz == nearz || endz == startz) {
        A = 0.0f;
        B = 0.5f;
        C = 0.0f;
    } else {
        A = (farz * nearz) / ((farz - nearz) * (endz - startz));
        B = farz / (farz - nearz);
        C = startz / (endz - startz);
    }

    B_mant = B;
    B_expn = 0;
    while (B_mant > 1.0) {
        B_mant *= 0.5f;
        B_expn++;
    }
    while (B_mant > 0.0f && B_mant < 0.5) {
        B_mant *= 2.0f;
        B_expn--;
    }

    a = A / (f32) slw(1, B_expn + 1);
    b_m = (u32) (8.388638e6f * B_mant);
    b_s = B_expn + 1;
    c = C;

    fog1 = 0;
    SET_REG_FIELD(fog1, 24, 0, b_m);
    SET_REG_FIELD(fog1, 8, 24, 0xEF);

    fog2 = 0;
    SET_REG_FIELD(fog2, 5, 0, b_s);
    SET_REG_FIELD(fog2, 8, 24, 0xF0);

    memcpy(&a_hex, &a, 4);
    memcpy(&c_hex, &c, 4);

    fog0 = 0;
    SET_REG_FIELD(fog0, 11, 0, (a_hex >> 12) & 0x7FF);
    SET_REG_FIELD(fog0, 8, 11, (a_hex >> 23) & 0xFF);
    SET_REG_FIELD(fog0, 1, 19, (a_hex >> 31));
    SET_REG_FIELD(fog0, 8, 24, 0xEE);

    fog3 = 0;
    SET_REG_FIELD(fog3, 11, 0, (c_hex >> 12) & 0x7FF);
    SET_REG_FIELD(fog3, 8, 11, (c_hex >> 23) & 0xFF);
    SET_REG_FIELD(fog3, 1, 19, (c_hex >> 31));
    SET_REG_FIELD(fog3, 1, 20, 0);
    SET_REG_FIELD(fog3, 3, 21, type);
    SET_REG_FIELD(fog3, 8, 24, 0xF1);

    fogclr = 0;
    SET_REG_FIELD(fogclr, 8, 0, b);
    SET_REG_FIELD(fogclr, 8, 8, g);
    SET_REG_FIELD(fogclr, 8, 16, r);
    SET_REG_FIELD(fogclr, 8, 24, 0xF2);

    out[0] = fog0;
    out[1] = fog1;
    out[2] = fog2;
    out[3] = fog3;
    out[4] = fogclr;
}

static f32 fromHex(u32 h)
{
    f32 f;
    memcpy(&f, &h, 4);
    return f;
}

int main(int argc, char** argv)
{
    u32 type, s, e, n, f, r, g, b, out[5];
    FILE* in = argc > 1 ? fopen(argv[1], "r") : stdin;
    FILE* to = argc > 2 ? fopen(argv[2], "w") : stdout;
    if (!in || !to) return 1;
    while (fscanf(in, "%u %x %x %x %x %u %u %u", &type, &s, &e, &n, &f, &r, &g, &b) == 8) {
        GXSetFog(type, fromHex(s), fromHex(e), fromHex(n), fromHex(f), r, g, b, out);
        fprintf(to, "%08x %08x %08x %08x %08x\n", out[0], out[1], out[2], out[3], out[4]);
    }
    fclose(to);
    return 0;
}
