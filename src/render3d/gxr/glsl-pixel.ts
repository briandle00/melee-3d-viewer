/* GX renderer: the pixel stage as a fragment shader (GLSL ES 3.00).
 *
 * One pass draws a run of triangles into the EFB. Every EFB pixel is one fragment: it reads its own color and depth, then walks the
 * triangles that cover its 16 x 16 tile in draw order, and for each one that covers it runs the pixel pipeline of the raster spec
 * (sections 7.3 to 11): coverage, the planes, depth, texture unit, TEV, alpha test, fog, depth test, blend. Because a pixel walks its
 * triangles in order, blending and depth tests see exactly what the hardware order gives, and no read-modify-write between draws is
 * needed. The float parts use the integer float of glsl-float.ts.
 *
 * Data (all unsigned integer textures read with texelFetch):
 *  - uMem: bytes of main memory (4096 per row), then TMEM and the palettes (see MEM_*);
 *  - uData: texels of 4 words; a triangle is HEADER_TEXELS texels, then one texel per plane (f0, dfdx, dfdy, unused). The header texels hold
 *    (minx, maxx, miny, maxy), (DX12, DY12, DX23, DY23), (DX31, DY31, C1, C2), (C3, xi, yi, ox), (oy, state, plane count, unused);
 *  - uTiles: (first, count) into uList for every tile; uList: word offsets of triangles in uData;
 *  - uStates: STATE_WORDS words per state: BP registers 0..255, the constant colors K0..K3 (words 256..263), the palette address of
 *    each of the 8 texture maps (264..271), the texgen projection flags (272), the viewport half width as float bits (273), the byte length of each map's palette (274..281);
 *  - uEfb: (color word, depth) per pixel of the previous pass.
 */
import { floatGlsl, type FloatOps } from "./glsl-float";
import { TILE, TILE_SHIFT } from "./bin";

export const MEM_TMEM = 0x1800000;
export const MEM_PAL = 0x1900000;
export const MEM_PAL_SIZE = 0x40000;
export const MEM_BYTES = MEM_PAL + MEM_PAL_SIZE;
export const MEM_ROW = 4096;
import { HEADER_TEXELS } from "./front";
export { HEADER_TEXELS };
export const STATE_WORDS = 288;
/** the pixel tiles the triangle lists are binned in: 1 << TILE_SHIFT pixels on a side; each list entry also says which of the tile's four 8 x 8 quarters
 *  the triangle can reach (bits 24..27 of the entry, bit 2 * (y >> 3 & 1) + (x >> 3 & 1)), so a pixel skips the triangles that miss its quarter after one read */
export { TILE, TILE_SHIFT };

/** the pixel shader; `indirect` adds the indirect texture unit (spec 10.5) and `fogExtra` the exponential fog forms and the range adjustment (11.3), compiled only for draws that use them */
/** the correctly rounded 2^x for binary32 x in [-8, 0] (fog shaping), GLSL ES 3.00 */
export const EXP2_GLSL = /* glsl */ `// 2^x for a binary32 x in [-8, 0], correctly rounded to binary32 (spec 11.3: the reference rounds a double-precision power once). The GPU's own exp2 is an
// approximation that is off in the last bit for about one argument in 300,000, which can move a fog level, so the power is computed in 64-bit fixed point
// from 16-bit limbs: |x| = n + t (t in [0, 1)); 2^-t is the product of 2^(-2^-k) for the first six bits of t, and of 2^-b for the rest b (< 2^-6), a Taylor
// series in z = b ln 2. The error is about 2^-60 of 1; the result's 24 bits and the 40 bits after them decide the rounding.
uniform uvec4 uExpC[8];     // 2^(-2^-k) for k = 1..6, ln 2, and in [7].x the number of Taylor terms (8); each a fraction of four 16-bit limbs, most significant first

// the high 64 bits of the product of two such fractions
uvec4 fxMul(uvec4 A, uvec4 B) {
  uint h0 = (A.x * B.x) >> 16;
  uint l0 = (A.x * B.x) & 0xffffu;
  uint p01 = A.x * B.y, p10 = A.y * B.x;
  uint h1 = (p01 >> 16) + (p10 >> 16), l1 = (p01 & 0xffffu) + (p10 & 0xffffu);
  uint p02 = A.x * B.z, p11 = A.y * B.y, p20 = A.z * B.x;
  uint h2 = (p02 >> 16) + (p11 >> 16) + (p20 >> 16), l2 = (p02 & 0xffffu) + (p11 & 0xffffu) + (p20 & 0xffffu);
  uint p03 = A.x * B.w, p12 = A.y * B.z, p21 = A.z * B.y, p30 = A.w * B.x;
  uint h3 = (p03 >> 16) + (p12 >> 16) + (p21 >> 16) + (p30 >> 16), l3 = (p03 & 0xffffu) + (p12 & 0xffffu) + (p21 & 0xffffu) + (p30 & 0xffffu);
  uint p13 = A.y * B.w, p22 = A.z * B.z, p31 = A.w * B.y;
  uint h4 = (p13 >> 16) + (p22 >> 16) + (p31 >> 16);
  uint a4 = l3 + h4;
  uint a3 = l2 + h3 + (a4 >> 16);
  uint a2 = l1 + h2 + (a3 >> 16);
  uint a1 = l0 + h1 + (a2 >> 16);
  uint a0 = h0 + (a1 >> 16);
  return uvec4(a0 & 0xffffu, a1 & 0xffffu, a2 & 0xffffu, a3 & 0xffffu);
}

uvec4 fxAdd(uvec4 A, uvec4 B) {
  uint s3 = A.w + B.w; uint s2 = A.z + B.z + (s3 >> 16); uint s1 = A.y + B.y + (s2 >> 16); uint s0 = A.x + B.x + (s1 >> 16);
  return uvec4(s0 & 0xffffu, s1 & 0xffffu, s2 & 0xffffu, s3 & 0xffffu);
}

// A - B for A >= B
uvec4 fxSub(uvec4 A, uvec4 B) {
  int d3 = int(A.w) - int(B.w); int c3 = d3 < 0 ? 1 : 0; d3 += c3 << 16;
  int d2 = int(A.z) - int(B.z) - c3; int c2 = d2 < 0 ? 1 : 0; d2 += c2 << 16;
  int d1 = int(A.y) - int(B.y) - c2; int c1 = d1 < 0 ? 1 : 0; d1 += c1 << 16;
  int d0 = int(A.x) - int(B.x) - c1;
  return uvec4(uint(d0) & 0xffffu, uint(d1), uint(d2), uint(d3));
}

uvec4 fxDiv(uvec4 A, uint k) {
  uint c = A.x; uint x = c / k; uint r = c - x * k;
  c = (r << 16) | A.y; uint y = c / k; r = c - y * k;
  c = (r << 16) | A.z; uint z = c / k; r = c - z * k;
  c = (r << 16) | A.w; uint w = c / k;
  return uvec4(x, y, z, w);
}

uint f_exp2(uint x) {
  uint ex = (x >> 23) & 255u;
  // |x| < 2^-25 (and zero): the power rounds to 1
  if (ex < 102u) return 0x3f800000u;
  uint m = (x & 0x7fffffu) | 0x800000u;
  int q = 150 - int(ex);                       // |x| = m * 2^-q
  uint n = ex >= 127u ? (m >> uint(q)) : 0u;   // the whole part
  uint mf = m & (q >= 32 ? 0xffffffffu : ((1u << uint(q)) - 1u));
  uint hi = q <= 32 ? (mf << uint(32 - q)) : (mf >> uint(q - 32));
  uint lo = q <= 32 ? 0u : (mf << uint(64 - q));
  if (hi == 0u && lo == 0u) return (127u - n) << 23;
  uint top6 = hi >> 26;
  uint hb = hi & 0x03ffffffu;
  uvec4 b = uvec4(hb >> 16, hb & 0xffffu, lo >> 16, lo & 0xffffu);
  uvec4 P = uvec4(0xffffu);
  for (int k = 0; k < 6; k++) if (((top6 >> uint(5 - k)) & 1u) == 1u) P = fxMul(P, uExpC[k]);
  uvec4 z = fxMul(b, uExpC[6]);
  uvec4 p = z, D = z;
  for (uint k = 2u; k <= uExpC[7].x; k++) {
    p = fxDiv(fxMul(p, z), k);
    D = (k & 1u) == 0u ? fxSub(D, p) : fxAdd(D, p);
  }
  uvec4 V = fxSub(P, fxMul(P, D));
  uint mant = (V.x << 8) | (V.y >> 8);                 // 24 bits, the top one set
  uint rest = ((V.y & 0xffu) << 24) | (V.z << 8) | (V.w >> 8);   // the next 32 bits (the last 8 of the 64 do not matter for the rounding)
  if (rest > 0x80000000u || (rest == 0x80000000u && (mant & 1u) == 1u)) mant += 1u;
  uint ee = 126u - n;
  if (mant == 0x1000000u) { mant = 0x800000u; ee += 1u; }
  return (ee << 23) | (mant & 0x7fffffu);
}
`;

export function pixelShader(opts: { indirect?: boolean; fogExtra?: boolean; floatOps?: FloatOps; debugRegs?: [number, number]; mutate?: (source: string) => string } = {}): string {
  const src = /* glsl */ `#version 300 es
${opts.indirect ? "#define INDIRECT 1" : ""}
${opts.fogExtra ? "#define FOG_EXTRA 1" : ""}
${opts.debugRegs ? `#define DEBUG_REGS 1
#define DEBUG_A ${opts.debugRegs[0]}
#define DEBUG_B ${opts.debugRegs[1]}` : ""}
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D uMem;
uniform usampler2D uData;   // RGBA32UI, 1024 texels wide
uniform usampler2D uTiles;
uniform usampler2D uList;
uniform usampler2D uStates;
uniform usampler2D uEfb;
uniform int uTilesX;
out uvec4 o;

#define TMEM_BASE ${MEM_TMEM}u
#define HEADER_TEXELS ${HEADER_TEXELS}u
#define STATE_WORDS ${STATE_WORDS}u
#define NO_PAL 0xffffffffu

${floatGlsl(opts.floatOps ?? "soft")}

uint wd(usampler2D t, uint i) { return texelFetch(t, ivec2(int(i & 4095u), int(i >> 12)), 0).r; }
// texel t of the triangle data (4 words)
uvec4 td(uint t) { return texelFetch(uData, ivec2(int(t & 1023u), int(t >> 10)), 0); }
uint mbyte(uint a) { return texelFetch(uMem, ivec2(int(a & 4095u), int(a >> 12)), 0).r; }
uint bf(uint v, int s, int n) { return (v >> uint(s)) & ((1u << uint(n)) - 1u); }
int bfi(uint v, int s, int n) { return int(bf(v, s, n)); }
int sx11(uint v) { return int(v << 21) >> 21; }
int idiv(int a, int b) { int q = abs(a) / b; return a < 0 ? -q : q; }

uint sbase;
uint S(uint k) { return wd(uStates, sbase + k); }

// ---------------------------------------------------------------------------------------------------------------------
// texture unit (spec 9)

struct MapI {
  uint fmt; int W; int H; int ws; int wt; uint pf; bool tmem; uint base; uint l1; uint l2; uint pal; uint palLen; uint mode0; uint mode1;
};

MapI loadMap(uint m) {
  bool hi = m >= 4u;
  uint k = m & 3u;
  uint img0 = S((hi ? 0xa8u : 0x88u) + k), img1 = S((hi ? 0xacu : 0x8cu) + k), img2 = S((hi ? 0xb0u : 0x90u) + k);
  uint img3 = S((hi ? 0xb4u : 0x94u) + k), tl = S((hi ? 0xb8u : 0x98u) + k);
  MapI mp;
  mp.fmt = bf(img0, 20, 4);
  mp.W = bfi(img0, 0, 10);
  mp.H = bfi(img0, 10, 10);
  uint m0 = S((hi ? 0xa0u : 0x80u) + k);
  mp.mode0 = m0;
  mp.mode1 = S((hi ? 0xa4u : 0x84u) + k);
  mp.ws = bfi(m0, 0, 2);
  mp.wt = bfi(m0, 2, 2);
  mp.pf = bf(tl, 10, 2);
  mp.tmem = bf(img1, 21, 1) == 1u;
  mp.base = (img3 & 0xffffffu) * 32u;
  mp.l1 = bf(img1, 0, 15) * 32u;
  mp.l2 = bf(img2, 0, 15) * 32u;
  mp.pal = S(264u + m);
  mp.palLen = S(274u + m);
  return mp;
}

// address in uMem of byte i of the image (TMEM images live in the TMEM area; an RGBA8 image keeps its green/blue halves in the other bank)
uint tAddr(MapI mp, uint i) {
  if (mp.tmem) {
    if (mp.fmt == 6u) {
      uint blk = i >> 6, r = i & 63u;
      return TMEM_BASE + ((r < 32u ? mp.l1 + blk * 32u + r : mp.l2 + blk * 32u + r - 32u) & 0xfffffu);
    }
    return TMEM_BASE + ((mp.l1 + i) & 0xfffffu);
  }
  return (mp.base + i) & 0x1ffffffu;
}
uint tb(MapI mp, uint i) { return mbyte(tAddr(mp, i)); }

int w3(int v) { return (v << 5) | (v << 2) | (v >> 1); }
int w4(int v) { return v * 17; }
int w5(int v) { return (v << 3) | (v >> 2); }
int w6(int v) { return (v << 2) | (v >> 4); }

ivec4 rgb5a3(uint v) {
  if ((v & 0x8000u) != 0u) return ivec4(w5(bfi(v, 10, 5)), w5(bfi(v, 5, 5)), w5(bfi(v, 0, 5)), 255);
  return ivec4(w4(bfi(v, 8, 4)), w4(bfi(v, 4, 4)), w4(bfi(v, 0, 4)), w3(bfi(v, 12, 3)));
}

void finfo(uint fmt, out int kw, out int kh, out uint bytes) {
  bytes = 32u;
  if (fmt == 0u || fmt == 8u || fmt == 14u) { kw = 3; kh = 3; }
  else if (fmt == 1u || fmt == 2u || fmt == 9u) { kw = 3; kh = 2; }
  else if (fmt == 6u) { kw = 2; kh = 2; bytes = 64u; }
  else { kw = 2; kh = 2; }
}

// half bytes per texel, for the mip offsets (spec 9.3)
int nibblesOf(uint fmt) {
  if (fmt == 0u || fmt == 8u || fmt == 14u) return 1;
  if (fmt == 1u || fmt == 2u || fmt == 9u) return 2;
  if (fmt == 6u) return 8;
  return 4;
}

// one texel of a level (wrapped coordinates s, t), spec 9.2. Every format reads at most five bytes through the same five reads.
ivec4 fetchTexel(MapI mp, uint off, int W, int s, int t) {
  int kw, kh; uint bytes;
  finfo(mp.fmt, kw, kh, bytes);
  int bpr = (W >> kw) + 1;
  int blk = (t >> kh) * bpr + (s >> kw);
  uint base = off + uint(blk) * bytes;
  int tx = s & ((1 << kw) - 1), ty = t & ((1 << kh) - 1);
  uint fmt = mp.fmt;
  uint a0 = base, d2 = 2u, a4 = 0u;
  if (fmt == 0u || fmt == 8u) a0 = base + uint((ty * 8 + tx) >> 1);
  else if (fmt == 1u || fmt == 9u || fmt == 2u) a0 = base + uint(ty * 8 + tx);
  else if (fmt == 6u) { a0 = base + uint((ty * 4 + tx) * 2); d2 = 32u; }
  else if (fmt == 14u) { a0 = base + uint(((ty >> 2) << 1) + (tx >> 2)) * 8u; a4 = a0 + 4u + uint(ty & 3); }
  else a0 = base + uint((ty * 4 + tx) * 2);
  uint b0 = tb(mp, a0), b1 = tb(mp, a0 + 1u), b2 = 0u, b3 = 0u, b4 = 0u;
  if (fmt == 6u || fmt == 14u) { b2 = tb(mp, a0 + d2); b3 = tb(mp, a0 + d2 + 1u); }
  if (fmt == 14u) b4 = tb(mp, a4);
  uint v16 = (b0 << 8) | b1;
  // the indexed formats (C4, C8, C14X2) read their palette entry, which is then decoded as the direct format it has: IA8 (palette
  // format 0), RGB565 (1), RGB5A3 (2 and 3); one copy of each decode serves both (a D3D compiler inlines every copy, at a cost in time)
  bool indexed = fmt == 8u || fmt == 9u || fmt == 10u;
  if (indexed) {
    uint pidx = fmt == 8u ? ((tx & 1) == 1 ? (b0 & 15u) : (b0 >> 4)) : (fmt == 9u ? b0 : (v16 & 0x3fffu));
    uint pe = 0u;
    if (mp.pal != NO_PAL && pidx * 2u + 1u < mp.palLen) pe = (mbyte(mp.pal + pidx * 2u) << 8) | mbyte(mp.pal + pidx * 2u + 1u);
    v16 = pe;
  }
  uint kind = indexed ? 3u + min(mp.pf, 2u) : fmt;
  ivec4 r = ivec4(0);
  if (kind == 0u) { int v = w4((tx & 1) == 1 ? int(b0 & 15u) : int(b0 >> 4)); r = ivec4(v); }
  else if (kind == 1u) r = ivec4(int(b0));
  else if (kind == 2u) { int i = w4(int(b0 & 15u)); r = ivec4(i, i, i, w4(int(b0 >> 4))); }
  else if (kind == 3u) { int i = int(v16 & 255u); r = ivec4(i, i, i, int(v16 >> 8)); }
  else if (kind == 4u) r = ivec4(w5(bfi(v16, 11, 5)), w6(bfi(v16, 5, 6)), w5(bfi(v16, 0, 5)), 255);
  else if (kind == 5u) r = rgb5a3(v16);
  else if (kind == 6u) r = ivec4(int(b1), int(b2), int(b3), int(b0));
  else if (kind == 14u) {
    uint c1 = v16, c2 = (b2 << 8) | b3;
    int sel = int((b4 >> uint(6 - 2 * (tx & 3))) & 3u);
    ivec3 a = ivec3(w5(bfi(c1, 11, 5)), w6(bfi(c1, 5, 6)), w5(bfi(c1, 0, 5)));
    ivec3 b = ivec3(w5(bfi(c2, 11, 5)), w6(bfi(c2, 5, 6)), w5(bfi(c2, 0, 5)));
    if (sel == 0) r = ivec4(a, 255);
    else if (sel == 1) r = ivec4(b, 255);
    else if (c1 > c2) {
      uvec3 du = uvec3(b - a);
      ivec3 th = ivec3((du >> 1) - (du >> 3));
      r = sel == 2 ? ivec4((a + th) & 255, 255) : ivec4((b - th) & 255, 255);
    } else r = ivec4((a + b + 1) >> 1, sel == 2 ? 255 : 0);
  }
  return r;
}

int wrapC(int c, int Sz, int mode) {
  if (mode == 0) return min(max(c, 0), Sz);
  int n = Sz + 1;
  if (mode == 1) { int q = idiv(c, n); int r = c - q * n; return r < 0 ? Sz + r : r; }
  int q = idiv(c, n);
  int r = abs(c - q * n);
  return (q & 1) != 0 ? Sz - r : r;
}

uint levelOffset(uint fmt, int W, int H, int L) {
  int kw, kh; uint bytes;
  finfo(fmt, kw, kh, bytes);
  int bw = 1 << kw, bh = 1 << kh;
  int nib = nibblesOf(fmt);
  uint off = 0u;
  int w = W + 1, h = H + 1;
  for (int l = 1; l <= L; l++) {
    off += uint((max(w, bw) * max(h, bh) * nib) >> 1);
    w >>= 1; h >>= 1;
  }
  return off;
}

// the unit's sample (spec 9.3). Loops over the mip levels and the filter taps have run-time bounds so that the compiler keeps one
// copy of the texel fetch.
ivec4 sampleMap(MapI mp, int s, int t, int lod, bool linear) {
  uint mf = bf(mp.mode0, 5, 3);
  int fract = lod & 15;
  int mip = 0;
  bool mixl = false;
  if (lod > 0 && (mf & 3u) != 0u) {
    mip = lod >> 4;
    mixl = fract != 0 && (mf & 2u) != 0u;
    mip += (fract >> 3) & int(mf & 1u);
  }
  int nlev = mixl ? 2 : 1;
  int ntaps = linear ? 4 : 1;
  ivec4 acc0 = ivec4(0), acc1 = ivec4(0);
  for (int li = 0; li < uK.w; li++) {
    if (li >= nlev) break;
    int L = mip + li;
    uint off = L > 0 ? levelOffset(mp.fmt, mp.W, mp.H, L) : 0u;
    int W = mp.W >> L, H = mp.H >> L;
    int sl = s >> L, tl = t >> L;
    int s0 = linear ? (sl - 64) >> 7 : sl >> 7, t0 = linear ? (tl - 64) >> 7 : tl >> 7;
    int fs = (sl - 64) & 127, ft = (tl - 64) & 127;
    ivec4 sum = ivec4(0);
    for (int k = 0; k < uK.x; k++) {
      if (k >= ntaps) break;
      int dx = k & 1, dy = k >> 1;
      int wgt = linear ? ((dx == 1 ? fs : 128 - fs) * (dy == 1 ? ft : 128 - ft)) : 1;
      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;
    }
    if (linear) sum = sum >> 14;
    if (li == 0) acc0 = sum; else acc1 = sum;
  }
  return mixl ? (acc0 * (16 - fract) + acc1 * fract) >> 4 : acc0;
}

// ---------------------------------------------------------------------------------------------------------------------
// planes and texture coordinates (spec 7.4, 8.3, 8.4)

uint gTri;      // word offset of the current triangle in uData
uint gNp;       // number of planes of the current triangle
uint gState;    // its draw state
uint gOx, gOy;  // float bits
int gXi, gYi;

uint planeAt(uint k, uint dx, uint dy) {
  // a plane the triangle does not carry (a generator past BP's count) reads zero
  if (k >= gNp) return 0u;
  uvec4 p = td(gTri + HEADER_TEXELS + k);
  // a plane with no slope (both differences zero) is its own constant: adding the zero products changes nothing in a finite non-zero value
  uint ex = (p.x >> 23) & 255u;
  if ((p.y & 0x7f800000u) == 0u && (p.z & 0x7f800000u) == 0u && ex != 0u && ex != 255u) return p.x;
  return f_add(f_add(p.x, f_mul(p.y, dx)), f_mul(p.z, dy));
}

// s and t of generator n at pixel (px, py)
void genST(uint n, int px, int py, out uint s, out uint t) {
  uint dx = f_add(gOx, f_from_int(px - gXi)), dy = f_add(gOy, f_from_int(py - gYi));
  // the four planes (1/w, u, v, w) through one copy of the evaluation
  uint pv[4];
  bool projective = ((S(272u) >> n) & 1u) == 1u;
  int nPlanes = projective ? uK.x : uK.x - 1;
  for (int k = 0; k < nPlanes; k++) pv[k] = planeAt(k == 0 ? 0u : 9u + n * 3u + uint(k), dx, dy);
  // 1/w, then (projective, q not zero) (1/w) / q, through one copy of the division (a loop with a run-time bound)
  uint iw = 0u, proj = 0u, dn = F_ONE, dd = pv[0];
  for (int i = 0; i < uK.w; i++) {
    uint r = f_div(dn, dd);
    if (i == 0) {
      iw = r; proj = r;
      if (!projective) break;
      uint q = f_mul(pv[3], iw);
      if (f_iszero(q)) break;
      dn = iw; dd = q;
    } else proj = r;
  }
  s = f_mul(pv[1], proj);
  t = f_mul(pv[2], proj);
}

uint f_max(uint a, uint b) { return f_lt(a, b) ? b : a; }

int log2fix(uint d) { return int(((d & 0x7f800000u) >> 19) + ((d & 0x007fffffu) >> 19)) - 2032; }

// the texture stage's coordinates: the pixel's s and t of generator n (7 fractional bits) and the level of detail map mp gives (8.3, 8.4)
void stageCoords(MapI mp, uint n, int x, int y, out int S24, out int T24, out int lod, out bool linear) {
  int bx = x & ~1, by = y & ~1;
  int me = (x & 1) + ((y & 1) << 1);
  int maxl = bfi(mp.mode1, 8, 8), minl = bfi(mp.mode1, 0, 8);
  bool magLin = bf(mp.mode0, 4, 1) == 1u;
  uint mf = bf(mp.mode0, 5, 3);
  // When the clamp range of the level of detail is one value and the magnification and minification filters agree on linear or not, neither the level of
  // detail nor the filter depends on the differences across the block (the clamp gives that one value for every lod, and 'linear' is the same on both
  // sides of lod 0): the pixel's own coordinates are all there is to compute.
  bool constLod = maxl == minl && magLin == ((mf & 4u) != 0u);
  uint sv[4], tv[4];
  for (int j = 0; j < uK.x; j++) {
    sv[j] = 0u; tv[j] = 0u;
    if (!constLod || j == me) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);
  }
  if (constLod) {
    lod = minl; linear = magLin;
  } else {
    // the largest change of s and of t across the block: one copy of the differences for both and for the three neighbors
    uint dm[2];
    bool diag = bf(mp.mode0, 8, 1) == 1u;
    for (int m = 0; m < uK.w; m++) {
      uint c0 = m == 0 ? sv[0] : tv[0];
      uint dd[3];
      for (int k = 0; k < uK.x - 1; k++) {
        uint ck = m == 0 ? (k == 0 ? sv[1] : (k == 1 ? sv[2] : sv[3])) : (k == 0 ? tv[1] : (k == 1 ? tv[2] : tv[3]));
        dd[k] = f_abs(f_sub(c0, ck));
      }
      dm[m] = diag ? dd[2] : f_max(dd[0], dd[1]);
    }
    uint d = f_max(dm[0], dm[1]);
    int bias = int(bf(mp.mode0, 9, 8) << 24) >> 24;
    lod = log2fix(d) + (bias >> 1);
    linear = (lod > 0 && (mf & 4u) != 0u) || (lod <= 0 && magLin);
    if (lod > maxl) lod = maxl; else if (lod < minl) lod = minl;
  }
  int st[2];
  for (int c = 0; c < uK.w; c++) st[c] = (f_trunc(f_mul(c == 0 ? sv[me] : tv[me], 0x43000000u)) << 8) >> 8;
  S24 = st[0];
  T24 = st[1];
}

#ifdef INDIRECT
// the offsets and the alpha bump an indirect sample gives a TEV stage (spec 10.5): (cs, ct) are the stage's own coordinates, tx the
// indirect texture's sample; the stage's coordinates become (oS, oT)
void indirectOffsets(uint ind, ivec4 tx, int cs, int ct, int prevS, int prevT, out int oS, out int oT, out int bump) {
  int fmt = bfi(ind, 2, 2), biasBits = bfi(ind, 4, 3), bs = bfi(ind, 7, 2), mid = bfi(ind, 9, 4);
  int sw = bfi(ind, 13, 3), tw = bfi(ind, 16, 3);
  ivec3 i = ivec3(tx.a, tx.b, tx.g);
  int mask = fmt == 1 ? 0xe0 : (fmt == 2 ? 0xf0 : 0xf8);
  bump = bs == 0 ? 0 : (i[bs - 1] & mask);
  int vmask = fmt == 0 ? 0xff : (fmt == 1 ? 0x1f : (fmt == 2 ? 0x0f : 0x07));
  ivec3 v = i & vmask;
  for (int k = 0; k < 3; k++) if (((biasBits >> k) & 1) == 1) v[k] += fmt == 0 ? -128 : 1;
  int o0 = 0, o1 = 0;
  bool keep = false;
  int m = mid & 3;
  if (m != 0) {
    uint A = S(0x06u + 3u * uint(m - 1)), B = S(0x07u + 3u * uint(m - 1)), C = S(0x08u + 3u * uint(m - 1));
    int ma = sx11(A & 0x7ffu), mb = sx11((A >> 11) & 0x7ffu), mc = sx11(B & 0x7ffu), md = sx11((B >> 11) & 0x7ffu), me = sx11(C & 0x7ffu), mf = sx11((C >> 11) & 0x7ffu);
    int ex = bfi(A, 22, 2) | (bfi(B, 22, 2) << 2) | (bfi(C, 22, 2) << 4);
    int shift = 17 - ex;
    int type = mid & 12;
    // matrix type 12 is not defined: the stage's coordinate stays what the previous stage left (spec 10.5)
    if (type == 12) keep = true;
    else if (type == 0) { o0 = (ma * v.x + mc * v.y + me * v.z) >> 3; o1 = (mb * v.x + md * v.y + mf * v.z) >> 3; }
    else if (type == 4) { o0 = idiv(cs * v.x, 256); o1 = idiv(ct * v.x, 256); }
    else if (type == 8) { o0 = idiv(cs * v.y, 256); o1 = idiv(ct * v.y, 256); }
    // shift counts are taken modulo 32 (as the CPU reference's shifts do)
    if (shift >= 0) { o0 >>= (shift & 31); o1 >>= (shift & 31); } else { o0 <<= ((-shift) & 31); o1 <<= ((-shift) & 31); }
  }
  int ws = sw == 0 ? cs : (sw >= 6 ? 0 : (cs & (((256 >> (sw - 1)) << 7) - 1)));
  int wt = tw == 0 ? ct : (tw >= 6 ? 0 : (ct & (((256 >> (tw - 1)) << 7) - 1)));
  int rs = ws + o0, rt = wt + o1;
  if (bf(ind, 20, 1) == 1u) { rs += prevS; rt += prevT; }
  oS = keep ? prevS : (rs << 8) >> 8;
  oT = keep ? prevT : (rt << 8) >> 8;
}
#endif

// ---------------------------------------------------------------------------------------------------------------------
// TEV (spec 10)

int gRegs[16];
int gKk[16];
int gTex[4];
int gRas[4];
int gRasCh[8];
int gLastTex[4];

int clampTev(int r, int clampBit) {
  r = (r << 16) >> 16;
  if (clampBit == 1) return r < 0 ? 0 : (r > 255 ? 255 : r);
  return r < -1024 ? -1024 : (r > 1023 ? 1023 : r);
}

int tevRegular(bool isAlpha, int a, int b, int c, int d, int bias, int op, int scale, int clampBit) {
  int ls = scale == 1 ? 1 : (scale == 2 ? 2 : 0), rs = scale == 3 ? 1 : 0;
  int B = bias == 1 ? 128 : (bias == 2 ? -128 : 0);
  int cw = c + (c >> 7);
  int t = a * (256 - cw) + b * cw;
  t = t << ls;
  if (!isAlpha) {
    t = t + (scale == 3 ? 0 : (op == 1 ? 127 : 128));
    t = t >> 8;
    t = op == 1 ? -t : t;
  } else {
    t = t + (scale != 3 ? 0 : (op == 1 ? 127 : 128));
    t = op == 1 ? ((-t) >> 8) : (t >> 8);
  }
  int r = ((d + B) << ls) + t;
  r = r >> rs;
  return clampTev(r, clampBit);
}

ivec3 clampTev3(ivec3 r, int clampBit) {
  r = (r << 16) >> 16;
  return clampBit == 1 ? clamp(r, 0, 255) : clamp(r, -1024, 1023);
}

// the color combiner's regular arithmetic (10.4) on all three components at once
ivec3 tevColor3(ivec3 a, ivec3 b, ivec3 c, ivec3 d, int bias, int op, int scale, int clampBit) {
  int ls = scale == 1 ? 1 : (scale == 2 ? 2 : 0), rs = scale == 3 ? 1 : 0;
  int B = bias == 1 ? 128 : (bias == 2 ? -128 : 0);
  ivec3 cw = c + (c >> 7);
  ivec3 t = (a * (256 - cw) + b * cw) << ls;
  t = (t + (scale == 3 ? 0 : (op == 1 ? 127 : 128))) >> 8;
  t = op == 1 ? -t : t;
  return clampTev3((((d + B) << ls) + t) >> rs, clampBit);
}

// the compare modes (10.4) of the color combiner: a result per component
bvec3 compare3(int mode, ivec3 A, ivec3 B) {
  if (mode == 6) return greaterThan(A, B);
  if (mode == 7) return equal(A, B);
  bool r;
  if (mode == 0) r = A.x > B.x;
  else if (mode == 1) r = A.x == B.x;
  else if (mode == 2) r = ((A.y << 8) | A.x) > ((B.y << 8) | B.x);
  else if (mode == 3) r = ((A.y << 8) | A.x) == ((B.y << 8) | B.x);
  else if (mode == 4) r = ((A.z << 16) | (A.y << 8) | A.x) > ((B.z << 16) | (B.y << 8) | B.x);
  else r = ((A.z << 16) | (A.y << 8) | A.x) == ((B.z << 16) | (B.y << 8) | B.x);
  return bvec3(r);
}

bool compareCond(int mode, ivec3 A, ivec3 B, int k) {
  if (mode == 0) return A.x > B.x;
  if (mode == 1) return A.x == B.x;
  if (mode == 2) return ((A.y << 8) | A.x) > ((B.y << 8) | B.x);
  if (mode == 3) return ((A.y << 8) | A.x) == ((B.y << 8) | B.x);
  if (mode == 4) return ((A.z << 16) | (A.y << 8) | A.x) > ((B.z << 16) | (B.y << 8) | B.x);
  if (mode == 5) return ((A.z << 16) | (A.y << 8) | A.x) == ((B.z << 16) | (B.y << 8) | B.x);
  if (mode == 6) return A[k] > B[k];
  return A[k] == B[k];
}

const int KSEL8[8] = int[8](255, 223, 191, 159, 128, 96, 64, 32);
int ksel8(int i) { return KSEL8[i]; }

ivec3 konstColor(int ks) {
  if (ks < 8) return ivec3(ksel8(ks));
  if (ks < 12) return ivec3(0);
  if (ks < 16) { int k = (ks - 12) * 4; return ivec3(gKk[k], gKk[k + 1], gKk[k + 2]); }
  int comp = (ks - 16) >> 2, k = (ks & 3) * 4;
  return ivec3(gKk[k + comp]);
}

int konstAlpha(int ks) {
  if (ks < 8) return ksel8(ks);
  if (ks < 16) return 0;
  int comp = (ks - 16) >> 2, k = (ks & 3) * 4;
  return gKk[k + comp];
}

void swz(uint t, int v[4], out int o4[4]) {
  uint w0 = S(0xf6u + 2u * t), w1 = S(0xf7u + 2u * t);
  o4[0] = v[bfi(w0, 0, 2)]; o4[1] = v[bfi(w0, 2, 2)]; o4[2] = v[bfi(w1, 0, 2)]; o4[3] = v[bfi(w1, 2, 2)];
}

void loadColorRegs() {
  for (uint r = 0u; r < 4u; r++) {
    uint ra = S(0xe0u + 2u * r), bg = S(0xe1u + 2u * r);
    gRegs[int(r) * 4] = sx11(ra & 0x7ffu); gRegs[int(r) * 4 + 3] = sx11((ra >> 12) & 0x7ffu);
    gRegs[int(r) * 4 + 2] = sx11(bg & 0x7ffu); gRegs[int(r) * 4 + 1] = sx11((bg >> 12) & 0x7ffu);
    uint ka = S(256u + 2u * r), kb = S(257u + 2u * r);
    gKk[int(r) * 4] = sx11(ka & 0x7ffu); gKk[int(r) * 4 + 3] = sx11((ka >> 12) & 0x7ffu);
    gKk[int(r) * 4 + 2] = sx11(kb & 0x7ffu); gKk[int(r) * 4 + 1] = sx11((kb >> 12) & 0x7ffu);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// fog, blend

uint fogFloat(uint w) {
  return (((w >> 19) & 1u) << 31) | (((w >> 11) & 255u) << 23) | ((w & 0x7ffu) << 12);
}

#ifdef FOG_EXTRA
// correctly rounded square root of a non-negative float (the fog range adjustment): the integer square root of the mantissa scaled to
// 48 bits, found from the GPU's own estimate and corrected against exact products
uint f_sqrt(uint a) {
  int e = int(a >> 23) - 127;
  uint m = (a & 0x7fffffu) | 0x800000u;
  bool odd = (e & 1) != 0;
  uint M = odd ? m << 1 : m;
  e = odd ? e - 1 : e;
  // N = M * 2^23 as (hi, lo) of 24 bits each
  uint nh = M >> 1, nl = (M & 1u) << 23;
  uint s = uint(sqrt(float(M) * 8388608.0));
  s = clamp(s, 0x800000u, 0xffffffu);
  for (int i = 0; i < uK.z; i++) {
    // s * s as (hi, lo)
    uint sh = s >> 12, sl = s & 0xfffu;
    uint mid = 2u * sh * sl;
    uint lo = sl * sl + ((mid & 0xfffu) << 12);
    uint hi = sh * sh + (mid >> 12) + (lo >> 24);
    lo &= 0xffffffu;
    bool tooBig = hi > nh || (hi == nh && lo > nl);
    s = tooBig ? s - 1u : s;
    // (s + 1)^2
    uint t = s + 1u;
    uint th = t >> 12, tl = t & 0xfffu;
    uint tmid = 2u * th * tl;
    uint tlo = tl * tl + ((tmid & 0xfffu) << 12);
    uint thi = th * th + (tmid >> 12) + (tlo >> 24);
    tlo &= 0xffffffu;
    bool fits = thi < nh || (thi == nh && tlo <= nl);
    s = fits ? s + 1u : s;
  }
  // remainder N - s^2, to round to nearest: up when it exceeds s
  uint sh2 = s >> 12, sl2 = s & 0xfffu;
  uint mid2 = 2u * sh2 * sl2;
  uint lo2 = sl2 * sl2 + ((mid2 & 0xfffu) << 12);
  uint hi2 = sh2 * sh2 + (mid2 >> 12) + (lo2 >> 24);
  lo2 &= 0xffffffu;
  uint rem = ((nh - hi2) << 24) + nl - lo2;
  uint r = s + (rem > s ? 1u : 0u);
  bool carry = r == 0x1000000u;
  r = carry ? 0x800000u : r;
  int er = (e >> 1) + (carry ? 1 : 0) + 127;
  uint res = (uint(er) << 23) | (r & 0x7fffffu);
  return (a << 1) == 0u ? 0u : res;
}

${EXP2_GLSL}
#endif

void fogPixel(uint fsel, int z, int x, inout ivec4 c) {
  uint A = fogFloat(S(0xeeu)), C = fogFloat(S(0xf1u) & 0xfffffu);
  uint Bm = S(0xefu);
  int Bs = int(S(0xf0u) & 31u);
  uint ze;
  // perspective: A * 0xffffff / (B - (z >> shift)); orthographic: A * (z / 0xffffff); through one copy of the division
  bool persp = bf(S(0xf1u), 20, 1) == 0u;
  uint fn = f_from_int(persp ? int(Bm) - (z >> Bs) : z);
  uint fq = f_div(persp ? f_mul(A, 0x4b7fffffu) : fn, persp ? fn : 0x4b7fffffu);
  ze = persp ? fq : f_mul(A, fq);
#ifdef FOG_EXTRA
  if (bf(S(0xe8u), 10, 1) == 1u) {
    uint o = f_div(f_from_int(x - (bfi(S(0xe8u), 0, 10) - 342)), S(273u));
    uint fidx = f_sub(0x41100000u, f_mul(f_abs(o), 0x41100000u));
    fidx = f_lt(fidx, 0u) ? 0u : (f_gt(fidx, 0x41100000u) ? 0x41100000u : fidx);
    int lo = f_trunc(fidx), up = lo + 1;
    // the table's entries at lo and up, through one copy (a loop with a run-time bound)
    uint Kv[2];
    for (int j = 0; j < uK.w; j++) {
      int li = lo + j;
      uint wj = S(0xe9u + uint(li >> 1));
      Kv[j] = f_mul(f_div(f_from_int(int((li & 1) == 1 ? (wj & 0xfffu) : ((wj >> 12) & 0xfffu))), 0x43800000u), 0x40800000u);
    }
    uint Klo = Kv[0], Kup = Kv[1];
    uint factor = f_sub(f_from_int(up), fidx);
    uint k = f_add(f_mul(Klo, factor), f_mul(Kup, f_sub(F_ONE, factor)));
    ze = f_mul(ze, f_div(f_sqrt(f_add(f_mul(o, o), f_mul(k, k))), k));
  }
#endif
  ze = f_sub(ze, C);
  uint fog = f_lt(ze, 0u) ? 0u : (f_gt(ze, F_ONE) ? F_ONE : ze);
#ifdef FOG_EXTRA
  // 4: 1 - 2^(-8 fog), 5: 1 - 2^(-8 fog fog), 6: 2^(-8 (1 - fog)), 7: 2^(-8 (1 - fog) (1 - fog)); one copy of the power
  if (fsel >= 4u) {
    bool inv = fsel >= 6u;
    uint g = inv ? f_sub(F_ONE, fog) : fog;
    uint ar = f_mul(0xc1000000u, g);
    ar = (fsel & 1u) == 1u ? f_mul(ar, g) : ar;
    uint ex = f_exp2(ar);
    fog = inv ? ex : f_sub(F_ONE, ex);
  }
#endif
  int fi = f_trunc(f_mul(fog, 0x43800000u));
  uint fc = S(0xf2u);
  ivec3 fr = ivec3(int((fc >> 16) & 255u), int((fc >> 8) & 255u), int(fc & 255u));
  c.rgb = (c.rgb * (256 - fi) + fr * fi) >> 8;
}

// the compare codes are their bits: 1 less, 2 equal, 4 greater (0 never, 3 less or equal, 5 not equal, 6 greater or equal, 7 always)
bool cmpOp(uint code, int a, int b) {
  return ((code & 1u) != 0u && a < b) || ((code & 2u) != 0u && a == b) || ((code & 4u) != 0u && a > b);
}

ivec4 blendPixel(uint mode, uint dstAlpha, ivec4 s, ivec4 d) {
  ivec4 r;
  bool enable = (mode & 1u) == 1u, logic = ((mode >> 1) & 1u) == 1u, sub = ((mode >> 11) & 1u) == 1u;
  uint dfc = (mode >> 5) & 7u, sfc = (mode >> 8) & 7u, lop = (mode >> 12) & 15u;
  if (enable) {
    if (sub) r = max(ivec4(0), d - s);
    else {
      // the factors (0, 1, the other's color, one minus it, source alpha, one minus it, destination alpha, one minus it) on all four components
      ivec4 fsv[8] = ivec4[8](ivec4(0), ivec4(255), d, 255 - d, ivec4(s.a), ivec4(255 - s.a), ivec4(d.a), ivec4(255 - d.a));
      ivec4 fdv[8] = ivec4[8](ivec4(0), ivec4(255), s, 255 - s, ivec4(s.a), ivec4(255 - s.a), ivec4(d.a), ivec4(255 - d.a));
      ivec4 fs = fsv[sfc], fd = fdv[dfc];
      fs += fs >> 7; fd += fd >> 7;
      r = min(ivec4(255), (s * fs + d * fd) >> 8);
    }
  } else if (logic) {
    uint Sw = uint(s.a) | (uint(s.b) << 8) | (uint(s.g) << 16) | (uint(s.r) << 24);
    uint Dw = uint(d.a) | (uint(d.b) << 8) | (uint(d.g) << 16) | (uint(d.r) << 24);
    // the 16 operations are their truth tables: bit 0 of the code is the result where S and D are set, bit 1 S and not D, bit 2 D and
    // not S, bit 3 neither (0 clear, 1 and, 3 copy, 5 keep, 6 xor, 7 or, 8 nor, 10 invert, 15 set, ...)
    uint m11 = (lop & 1u) != 0u ? 0xffffffffu : 0u, m10 = (lop & 2u) != 0u ? 0xffffffffu : 0u;
    uint m01 = (lop & 4u) != 0u ? 0xffffffffu : 0u, m00 = (lop & 8u) != 0u ? 0xffffffffu : 0u;
    uint w = (Sw & Dw & m11) | (Sw & ~Dw & m10) | (~Sw & Dw & m01) | (~Sw & ~Dw & m00);
    r = ivec4(int(w >> 24), int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u));
  } else r = s;
  if (((dstAlpha >> 8) & 1u) == 1u) r.a = int(dstAlpha & 255u);
  return r;
}

ivec4 readColor(uint w, uint fmt) {
  if (fmt == 1u) {
    return ivec4(w6(bfi(w, 18, 6)), w6(bfi(w, 12, 6)), w6(bfi(w, 6, 6)), w6(bfi(w, 0, 6)));
  }
  return ivec4(int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u), 255);
}

uint writeColor(uint old, uint fmt, uint mode, ivec4 r) {
  bool colorUpd = ((mode >> 3) & 1u) == 1u, alphaUpd = ((mode >> 4) & 1u) == 1u;
  if (colorUpd) {
    if (fmt == 1u) {
      uint a6 = alphaUpd ? uint(r.a >> 2) : (old & 63u);
      return a6 | (uint(r.b >> 2) << 6) | (uint(r.g >> 2) << 12) | (uint(r.r >> 2) << 18);
    }
    return uint(r.b) | (uint(r.g) << 8) | (uint(r.r) << 16);
  }
  if (alphaUpd && fmt == 1u) return (old & ~63u) | uint(r.a >> 2);
  return old;
}

// ---------------------------------------------------------------------------------------------------------------------
// one pixel of one triangle (spec 8 to 11)

void shade(int x, int y, inout uint col, inout uint dep) {
  uint stIdx = gState;
  sbase = stIdx * STATE_WORDS;
  uint b0 = S(0x00u);
  int nStages = bfi(b0, 10, 4) + 1;
  int numCols = bfi(b0, 4, 3);
  uint zmode = S(0x40u);
  bool zEnable = (zmode & 1u) == 1u, zUpdate = ((zmode >> 4) & 1u) == 1u;
  uint zFunc = (zmode >> 1) & 7u;
  uint b43 = S(0x43u);
  uint pixFmt = b43 & 7u;
  bool zEarly = ((b43 >> 6) & 1u) == 1u && zEnable;

  uint dx = f_add(gOx, f_from_int(x - gXi)), dy = f_add(gOy, f_from_int(y - gYi));
  int stored = int(dep);
  uint newDep = dep;
  int z = 0;
  for (int i = 0; i < 8; i++) gRasCh[i] = 0;
  // plane 1 the depth (clamped to 0 .. 0xffffff, then the early depth test), planes 2.. the raster colors: one copy of planeAt and f_trunc
  for (int i = 0; i <= numCols * 4; i++) {
    uint pv = planeAt(uint(1 + i), dx, dy);
    int tv = f_trunc(i == 0 ? (f_gt(pv, 0x4b7fffffu) ? 0x4b7fffffu : (f_lt(pv, 0u) ? 0u : pv)) : pv);
    if (i == 0) {
      z = tv & 0xffffff;
      if (zEarly) {
        if (!cmpOp(zFunc, z, stored)) return;
        if (zUpdate) newDep = uint(z);
      }
    } else {
      int v16 = tv & 0xffff;
      gRasCh[i - 1] = (v16 & ~(v16 >> 8)) & 0xff;
    }
  }
  loadColorRegs();
  for (int i = 0; i < 4; i++) { gLastTex[i] = 0; gTex[i] = 0; }
  int prevS = 0, prevT = 0;
  for (int si = 0; si < nStages; si++) {
    uint ord = S(0x28u + uint(si >> 1)) >> ((si & 1) == 1 ? 12u : 0u);
    uint texmap = bf(ord, 0, 3), texcoord = bf(ord, 3, 3), rasSel = bf(ord, 7, 3);
    bool texEn = bf(ord, 6, 1) == 1u;
    uint cc = S(0xc0u + uint(2 * si)), ac = S(0xc1u + uint(2 * si));
    uint kw = S(0xf6u + uint(si >> 1));
    int kcs = ((si & 1) == 1) ? bfi(kw, 14, 5) : bfi(kw, 4, 5);
    int kas = ((si & 1) == 1) ? bfi(kw, 19, 5) : bfi(kw, 9, 5);
    uint rsw = bf(ac, 0, 2), tsw = bf(ac, 2, 2);
    int bump = 0;
#ifdef INDIRECT
    // with the indirect unit three coordinate computations and two samples go through one copy of each, by loops with run-time bounds:
    // coordinates job 0 the level of detail of the indirect stage (the low two bits of its map and coordinate numbers, a quirk of the
    // reference), job 1 its coordinates, job 2 the stage's own; sample job 0 the indirect sample, job 1 the stage's
    uint indWord = bfi(b0, 16, 3) > 0 ? S(0x10u + uint(si)) : 0u;
    bool hasInd = indWord != 0u;
    int ibt = bfi(indWord, 0, 2);
    uint iref = S(0x27u);
    int imap = bfi(iref, 6 * ibt, 3), icoord = bfi(iref, 6 * ibt + 3, 3);
    uint ssw = S(0x25u + uint(ibt >> 1));
    int iss = bfi(ssw, (ibt & 1) * 8, 4), its = bfi(ssw, (ibt & 1) * 8 + 4, 4);
    int jS[3], jT[3], jL[3];
    bool jLin[3];
    for (int j = 0; j < uK.z; j++) {
      jS[j] = 0; jT[j] = 0; jL[j] = 0; jLin[j] = false;
      if (j == 2 ? texEn : hasInd) {
        uint mapj = j == 0 ? uint(imap & 3) : (j == 1 ? uint(imap) : texmap);
        uint genj = j == 0 ? uint(icoord & 3) : (j == 1 ? uint(icoord) : texcoord);
        stageCoords(loadMap(mapj), genj, x, y, jS[j], jT[j], jL[j], jLin[j]);
      }
    }
    int mS = jS[2], mT = jT[2];
    for (int k = 0; k < uK.w; k++) {
      if (k == 0 ? hasInd : texEn) {
        MapI mps = loadMap(k == 0 ? uint(imap) : texmap);
        ivec4 r = sampleMap(mps, k == 0 ? jS[1] >> iss : mS, k == 0 ? jT[1] >> its : mT, k == 0 ? jL[0] : jL[2], k == 0 ? jLin[0] : jLin[2]);
        if (k == 0) {
          int oS, oT;
          indirectOffsets(indWord, r, jS[2], jT[2], prevS, prevT, oS, oT, bump);
          mS = oS; mT = oT;
        } else {
          prevS = mS; prevT = mT;
          int tv[4] = int[4](r.r, r.g, r.b, r.a);
          swz(tsw, tv, gTex);
          for (int i = 0; i < 4; i++) gLastTex[i] = gTex[i];
        }
      }
    }
#else
    if (texEn) {
      MapI mp = loadMap(texmap);
      int cS, cT, lod;
      bool lin;
      stageCoords(mp, texcoord, x, y, cS, cT, lod, lin);
      prevS = cS; prevT = cT;
      ivec4 tx = sampleMap(mp, cS, cT, lod, lin);
      int tv[4] = int[4](tx.r, tx.g, tx.b, tx.a);
      swz(tsw, tv, gTex);
      for (int i = 0; i < 4; i++) gLastTex[i] = gTex[i];
    }
#endif
    for (int i = 0; i < 4; i++) gRas[i] = 0;
    if (rasSel == 0u || rasSel == 1u) {
      int rv[4] = int[4](gRasCh[int(rasSel) * 4], gRasCh[int(rasSel) * 4 + 1], gRasCh[int(rasSel) * 4 + 2], gRasCh[int(rasSel) * 4 + 3]);
      swz(rsw, rv, gRas);
    } else if (rasSel == 5u || rasSel == 6u) {
      int bv = rasSel == 5u ? bump : (bump | (bump >> 5));
      gRas[0] = bv; gRas[1] = bv; gRas[2] = bv; gRas[3] = bv;
    }
    // the combiner's inputs (10.2): the selections from arrays filled once per stage (switch functions at each input took the
    // D3D compiler a long time: it inlines every call)
    ivec3 cIn[16];
    for (int r = 0; r < 4; r++) { cIn[2 * r] = ivec3(gRegs[4 * r], gRegs[4 * r + 1], gRegs[4 * r + 2]); cIn[2 * r + 1] = ivec3(gRegs[4 * r + 3]); }
    cIn[8] = ivec3(gTex[0], gTex[1], gTex[2]); cIn[9] = ivec3(gTex[3]);
    cIn[10] = ivec3(gRas[0], gRas[1], gRas[2]); cIn[11] = ivec3(gRas[3]);
    cIn[12] = ivec3(255); cIn[13] = ivec3(128); cIn[14] = konstColor(kcs); cIn[15] = ivec3(0);
    ivec3 ca = cIn[bfi(cc, 12, 4)], cb = cIn[bfi(cc, 8, 4)], ccc = cIn[bfi(cc, 4, 4)], cd = cIn[bfi(cc, 0, 4)];
    int cbias = bfi(cc, 16, 2), cop = bfi(cc, 18, 1), cclamp = bfi(cc, 19, 1), cscale = bfi(cc, 20, 2), cdest = bfi(cc, 22, 2);
    int aIn[8] = int[8](gRegs[3], gRegs[7], gRegs[11], gRegs[15], gTex[3], gRas[3], konstAlpha(kas), 0);
    int aa = aIn[bfi(ac, 13, 3)], ab = aIn[bfi(ac, 10, 3)], ac_ = aIn[bfi(ac, 7, 3)], ad = aIn[bfi(ac, 4, 3)];
    int abias = bfi(ac, 16, 2), aop = bfi(ac, 18, 1), aclamp = bfi(ac, 19, 1), ascale = bfi(ac, 20, 2), adest = bfi(ac, 22, 2);
    ivec3 rcv;
    ivec3 dv = ivec3(sx11(uint(cd.x) & 0x7ffu), sx11(uint(cd.y) & 0x7ffu), sx11(uint(cd.z) & 0x7ffu));
    if (cbias == 3) rcv = clampTev3(dv + ivec3(compare3((cscale << 1) | cop, ca & 255, cb & 255)) * (ccc & 255), cclamp);
    else rcv = tevColor3(ca & 255, cb & 255, ccc & 255, dv, cbias, cop, cscale, cclamp);
    int rc[3] = int[3](rcv.x, rcv.y, rcv.z);
    int ra;
    if (abias == 3) {
      int mode = (ascale << 1) | aop;
      bool cond;
      if (mode >= 6) cond = mode == 6 ? ((aa & 255) > (ab & 255)) : ((aa & 255) == (ab & 255));
      else cond = compareCond(mode, ca & 255, cb & 255, 0);
      ra = clampTev(sx11(uint(ad) & 0x7ffu) + (cond ? (ac_ & 255) : 0), aclamp);
    } else ra = tevRegular(true, aa & 255, ab & 255, ac_ & 255, sx11(uint(ad) & 0x7ffu), abias, aop, ascale, aclamp);
    gRegs[cdest * 4] = rc[0]; gRegs[cdest * 4 + 1] = rc[1]; gRegs[cdest * 4 + 2] = rc[2];
    gRegs[adest * 4 + 3] = ra;
  }
  int lastC = bfi(S(0xc0u + uint(2 * (nStages - 1))), 22, 2), lastA = bfi(S(0xc1u + uint(2 * (nStages - 1))), 22, 2);
  ivec4 src = ivec4(gRegs[lastC * 4] & 255, gRegs[lastC * 4 + 1] & 255, gRegs[lastC * 4 + 2] & 255, gRegs[lastA * 4 + 3] & 255);
  // alpha test
  uint at = S(0xf3u);
  bool a0 = cmpOp(bf(at, 16, 3), src.a, bfi(at, 0, 8)), a1 = cmpOp(bf(at, 19, 3), src.a, bfi(at, 8, 8));
  uint lg = bf(at, 22, 2);
  bool pass = lg == 0u ? (a0 && a1) : (lg == 1u ? (a0 || a1) : (lg == 2u ? (a0 != a1) : (a0 == a1)));
  if (!pass) { dep = newDep; return; }
  // depth texture
  uint dtOp = bf(S(0xf5u), 2, 2);
  if (dtOp != 0u) {
    uint sel = bf(S(0xf5u), 0, 2);
    int X = sel == 0u ? gLastTex[3] : (sel == 1u ? ((gLastTex[3] << 8) | gLastTex[0]) : ((gLastTex[0] << 16) | (gLastTex[1] << 8) | gLastTex[2]));
    z = (int(S(0xf4u)) + X + (dtOp == 1u ? z : 0)) & 0xffffff;
  }
  uint fsel = bf(S(0xf1u), 21, 3);
  if (fsel != 0u) fogPixel(fsel, z, x, src);
  if (!zEarly && zEnable) {
    if (!cmpOp(zFunc, z, stored)) { dep = newDep; return; }
    if (zUpdate) newDep = uint(z);
  }
  ivec4 dst = readColor(col, pixFmt);
  ivec4 res = blendPixel(S(0x41u), S(0x42u), src, dst);
  col = writeColor(col, pixFmt, S(0x41u), res);
#ifdef DEBUG_REGS
  // a test aid: the color word carries two of the TEV registers' components instead of the pixel
  col = (uint(gRegs[DEBUG_A] & 0xfff) << 12) | uint(gRegs[DEBUG_B] & 0xfff);
#endif
  dep = newDep;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec2 e = texelFetch(uEfb, p, 0).rg;
  uint col = e.x, dep = e.y;
  int tile = (p.x >> ${TILE_SHIFT}) + (p.y >> ${TILE_SHIFT}) * uTilesX;
  uvec2 ti = texelFetch(uTiles, ivec2(tile & 1023, tile >> 10), 0).rg;
  int sub = ((p.x >> 3) & 1) + (((p.y >> 3) & 1) << 1);
  for (uint i = 0u; i < ti.y; i++) {
    uint ent = wd(uList, ti.x + i);
    if (((ent >> uint(24 + sub)) & 1u) == 0u) continue;
    uint tri = ent & 0xffffffu;
    uvec4 h0 = td(tri);
    int bx = p.x & ~1, by = p.y & ~1;
    if (bx < int(h0.x) || bx >= int(h0.y) || by < int(h0.z) || by >= int(h0.w)) continue;
    uvec4 h1 = td(tri + 1u), h2 = td(tri + 2u), h3 = td(tri + 3u);
    int DX12 = int(h1.x), DY12 = int(h1.y), DX23 = int(h1.z), DY23 = int(h1.w), DX31 = int(h2.x), DY31 = int(h2.y);
    int C1 = int(h2.z), C2 = int(h2.w), C3 = int(h3.x);
    if (C1 + DX12 * (16 * p.y) - DY12 * (16 * p.x) <= 0) continue;
    if (C2 + DX23 * (16 * p.y) - DY23 * (16 * p.x) <= 0) continue;
    if (C3 + DX31 * (16 * p.y) - DY31 * (16 * p.x) <= 0) continue;
    uvec4 h4 = td(tri + 4u);
    gTri = tri;
    gXi = int(h3.y); gYi = int(h3.z);
    gOx = h3.w; gOy = h4.x;
    gState = h4.y;
    gNp = h4.z;
    shade(p.x, p.y, col, dep);
  }
  o = uvec4(col, dep, 0u, 0u);
}
`;
  // (dual: a check of the card's float arithmetic against the soft one on the real operands: a pixel where some addition or multiplication
  // gave other bits comes out with bit 31 of its depth word set; the depth read in is the stored 24 bits)
  const out = opts.floatOps !== "dual" ? src : src.replace("  uint col = e.x, dep = e.y;", "  uint col = e.x, dep = e.y & 0xffffffu;")
    .replace("  o = uvec4(col, dep, 0u, 0u);\n}", "  o = uvec4(col, gFloatMismatch ? (dep | 0x80000000u) : dep, 0u, 0u);\n}");
  if (opts.floatOps === "dual" && !out.includes("gFloatMismatch ? (dep")) throw new Error("pixelShader: no place for the dual check");
  return opts.mutate ? opts.mutate(out) : out;
}

export const PIXEL_FS = pixelShader();


/** the constants of f_exp2: 2^(-2^-k) for k = 1..6, ln 2, and the number of Taylor terms, as 64-bit fractions of four 16-bit limbs (the uniform uExpC) */
export function expConstants(): Uint32Array {
  const PREC = 200n;
  const ONE = 1n << PREC;
  let ln2 = 0n;
  for (let k = 1n; k < 220n; k++) ln2 += ONE / (k << k);
  // e^-w for a fixed-point w
  const expNeg = (w: bigint): bigint => {
    let term = ONE, sum = ONE;
    for (let j = 1n; term !== 0n; j++) { term = (term * w) / ONE / j; sum += j % 2n === 1n ? -term : term; }
    return sum;
  };
  const limbs = (v: bigint): number[] => {
    const r = (v + (1n << (PREC - 65n))) >> (PREC - 64n);   // 64 bits, rounded (all values here are below 1)
    const x = r >= (1n << 64n) ? (1n << 64n) - 1n : r;
    return [Number((x >> 48n) & 0xffffn), Number((x >> 32n) & 0xffffn), Number((x >> 16n) & 0xffffn), Number(x & 0xffffn)];
  };
  const out = new Uint32Array(32);
  for (let k = 1; k <= 6; k++) out.set(limbs(expNeg(ln2 >> BigInt(k))), (k - 1) * 4);
  out.set(limbs(ln2), 24);
  out[28] = 8;
  return out;
}
