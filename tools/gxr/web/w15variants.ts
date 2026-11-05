// W15: ablations and rewrites of the pixel shader for compile-time measurements (translate.ts). Ablations change the pictures (measurement only).
const rep = (fs: string, a: string, b: string): string => { if (!fs.includes(a)) throw new Error("missing: " + a); return fs.replace(a, b); };
const cut = (fs: string, from: string, to: string, body: string): string => { const a = fs.indexOf(from), b = fs.indexOf(to, fs.indexOf(from)); if (a < 0 || b < 0) throw new Error("cut " + from); return fs.slice(0, a) + body + fs.slice(b); };
export const w15: Record<string, (fs: string) => string> = {
  // tAddr without TMEM
  notmem: (s) => rep(s, "  if (mp.tmem) {", "  if (false) {"),
  // no CMPR
  nocmpr: (s) => rep(s, "  else if (fmt == 14u) {\n    uint c1 = v16", "  else if (false) {\n    uint c1 = v16"),
  // no palettes
  nopal: (s) => rep(s, "  if (indexed) {", "  if (false) {"),
  // fetchTexel reads only two bytes
  twobytes: (s) => rep(rep(s, "  if (fmt == 6u || fmt == 14u) { b2 = tb(mp, a0 + d2); b3 = tb(mp, a0 + d2 + 1u); }", ""), "  if (fmt == 14u) b4 = tb(mp, a4);", ""),
  // fetchTexel's decode reduced to one format
  onefmt: (s) => cut(s, "  if (fmt == 0u) { int v = w4(", "  if (indexed) {", "  r = ivec4(int(b0), int(b1), int(b2), int(b3 + b4));\n"),
  // the address part reduced
  oneaddr: (s) => cut(s, "  if (fmt == 0u || fmt == 8u) a0 = base", "  uint b0 = tb(", "  a0 = base + uint(ty * 8 + tx); a4 = a0 + 4u;\n"),
  // planeAt without the constant-plane shortcut
  noplaneshort: (s) => rep(s, "  if ((p.y & 0x7f800000u) == 0u && (p.z & 0x7f800000u) == 0u && ex != 0u && ex != 255u) return p.x;", ""),
  // no level of detail from the block (as if every map had a constant lod)
  constlod: (s) => rep(s, "  bool constLod = maxl == minl && magLin == ((mf & 4u) != 0u);", "  bool constLod = true;"),
  // no mip level offset loop
  nolevel: (s) => rep(s, "    uint off = L > 0 ? levelOffset(mp.fmt, mp.W, mp.H, L) : 0u;", "    uint off = uint(L);"),
  // wrapC trivial
  nowrap: (s) => cut(s, "int wrapC(int c, int Sz, int mode) {", "uint levelOffset(", "int wrapC(int c, int Sz, int mode) { return c & Sz; }\n\n"),
  // rewrite: the combiner's inputs from arrays filled once per stage instead of switch functions called at each input (exact)
  selarr: (s) => {
    s = rep(s, `    ivec3 ca = csel(bfi(cc, 12, 4)), cb = csel(bfi(cc, 8, 4)), ccc = csel(bfi(cc, 4, 4)), cd = csel(bfi(cc, 0, 4));
    if (bfi(cc, 12, 4) == 14) ca = konstColor(kcs);
    if (bfi(cc, 8, 4) == 14) cb = konstColor(kcs);
    if (bfi(cc, 4, 4) == 14) ccc = konstColor(kcs);
    if (bfi(cc, 0, 4) == 14) cd = konstColor(kcs);`, `    ivec3 cIn[16];
    for (int r = 0; r < 4; r++) { cIn[2 * r] = ivec3(gRegs[4 * r], gRegs[4 * r + 1], gRegs[4 * r + 2]); cIn[2 * r + 1] = ivec3(gRegs[4 * r + 3]); }
    cIn[8] = ivec3(gTex[0], gTex[1], gTex[2]); cIn[9] = ivec3(gTex[3]);
    cIn[10] = ivec3(gRas[0], gRas[1], gRas[2]); cIn[11] = ivec3(gRas[3]);
    cIn[12] = ivec3(255); cIn[13] = ivec3(128); cIn[14] = konstColor(kcs); cIn[15] = ivec3(0);
    ivec3 ca = cIn[bfi(cc, 12, 4)], cb = cIn[bfi(cc, 8, 4)], ccc = cIn[bfi(cc, 4, 4)], cd = cIn[bfi(cc, 0, 4)];`);
    s = rep(s, "    int aa = asel(bfi(ac, 13, 3), kas), ab = asel(bfi(ac, 10, 3), kas), ac_ = asel(bfi(ac, 7, 3), kas), ad = asel(bfi(ac, 4, 3), kas);",
      `    int aIn[8] = int[8](gRegs[3], gRegs[7], gRegs[11], gRegs[15], gTex[3], gRas[3], konstAlpha(kas), 0);
    int aa = aIn[bfi(ac, 13, 3)], ab = aIn[bfi(ac, 10, 3)], ac_ = aIn[bfi(ac, 7, 3)], ad = aIn[bfi(ac, 4, 3)];`);
    return s;
  },
  // rewrite: the compare codes as their bits (1 less, 2 equal, 4 greater) instead of a switch (exact)
  cmpbits: (s) => cut(s, "bool cmpOp(uint code, int a, int b) {", "int blendFactor(", `bool cmpOp(uint code, int a, int b) {
  return ((code & 1u) != 0u && a < b) || ((code & 2u) != 0u && a == b) || ((code & 4u) != 0u && a > b);
}

`),
  // rewrite: blending on the four components at once, the factors from an array (exact)
  blendvec: (s) => rep(s, `      for (int k = 0; k < 4; k++) {
        int fs = blendFactor(sfc, d[k], s, d, false);
        int fd = blendFactor(dfc, s[k], s, d, true);
        fs += fs >> 7; fd += fd >> 7;
        r[k] = min(255, (s[k] * fs + d[k] * fd) >> 8);
      }`, `      ivec4 fsv[8] = ivec4[8](ivec4(0), ivec4(255), d, 255 - d, ivec4(s.a), ivec4(255 - s.a), ivec4(d.a), ivec4(255 - d.a));
      ivec4 fdv[8] = ivec4[8](ivec4(0), ivec4(255), s, 255 - s, ivec4(s.a), ivec4(255 - s.a), ivec4(d.a), ivec4(255 - d.a));
      ivec4 fs = fsv[sfc], fd = fdv[dfc];
      fs += fs >> 7; fd += fd >> 7;
      r = min(ivec4(255), (s * fs + d * fd) >> 8);`),
  // rewrite: CMPR's thirds on the vector (exact)
  cmprvec: (s) => rep(s, `      ivec3 th = ivec3(0);
      for (int c = 0; c < 3; c++) { uint du = uint(d[c]); th[c] = int((du >> 1) - (du >> 3)); }`, `      uvec3 du = uvec3(d);
      ivec3 th = ivec3((du >> 1) - (du >> 3));`),
  // rewrite: the konst selections 0..7 from an array (exact)
  kselarr: (s) => rep(s, "int ksel8(int i) { return i == 0 ? 255 : (i == 1 ? 223 : (i == 2 ? 191 : (i == 3 ? 159 : (i == 4 ? 128 : (i == 5 ? 96 : (i == 6 ? 64 : 32)))))); }",
    "const int KSEL8[8] = int[8](255, 223, 191, 159, 128, 96, 64, 32);\nint ksel8(int i) { return KSEL8[i]; }"),
  // rewrite: the logic operations as their truth tables (bit 0: S and D, 1: S and not D, 2: not S and D, 3: neither) (exact)
  logicbits: (s) => cut(s, "    uint w;\n    switch (lop) {", "    r = ivec4(int(w >> 24)", `    uint m11 = (lop & 1u) != 0u ? 0xffffffffu : 0u, m10 = (lop & 2u) != 0u ? 0xffffffffu : 0u, m01 = (lop & 4u) != 0u ? 0xffffffffu : 0u, m00 = (lop & 8u) != 0u ? 0xffffffffu : 0u;
    uint w = (Sw & Dw & m11) | (Sw & ~Dw & m10) | (~Sw & Dw & m01) | (~Sw & ~Dw & m00);
`),
  // rewrite: the fog's two forms through one division (exact)
  fogdiv: (s) => rep(s, `  if (bf(S(0xf1u), 20, 1) == 0u) ze = f_div(f_mul(A, 0x4b7fffffu), f_from_int(int(Bm) - (z >> Bs)));
  else ze = f_mul(A, f_div(f_from_int(z), 0x4b7fffffu));`, `  bool persp = bf(S(0xf1u), 20, 1) == 0u;
  uint fn = f_from_int(persp ? int(Bm) - (z >> Bs) : z);
  uint fq = f_div(persp ? f_mul(A, 0x4b7fffffu) : fn, persp ? fn : 0x4b7fffffu);
  ze = persp ? fq : f_mul(A, fq);`),
  // rewrite: genST's two divisions through one copy (a loop with a run-time bound) (exact)
  gendiv: (s) => rep(s, `  uint iw = f_div(F_ONE, pv[0]);
  uint proj = iw;
  if (projective) {
    uint q = f_mul(pv[3], iw);
    proj = f_iszero(q) ? iw : f_div(iw, q);
  }`, `  uint iw = 0u, proj = 0u, dn = F_ONE, dd = pv[0];
  for (int i = 0; i < uK.w; i++) {
    uint r = f_div(dn, dd);
    if (i == 0) {
      iw = r; proj = r;
      if (!projective) break;
      uint q = f_mul(pv[3], iw);
      if (f_iszero(q)) break;
      dn = iw; dd = q;
    } else proj = r;
  }`),
  // ablation: float(n) by the card
  nativeconv: (s) => cut(s, "uint f_from_int(int n) {", "// the spec's trunc", "uint f_from_int(int n) { return floatBitsToUint(float(n)); }\n\n"),
  // rewrite: fetchTexel decodes a palette entry as the direct format it has (IA8, RGB565, RGB5A3): one copy of each decode (exact)
  palunify: (s) => cut(s, "  uint v16 = (b0 << 8) | b1;\n  uint pidx = 0u;", "  return r;\n}\n\nint wrapC(", `  uint v16 = (b0 << 8) | b1;
  // the indexed formats (C4, C8, C14X2): the palette entry, decoded below as IA8 (palette format 0), RGB565 (1) or RGB5A3 (2, 3)
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
      ivec3 d = b - a;
      uvec3 du = uvec3(d);
      ivec3 th = ivec3((du >> 1) - (du >> 3));
      r = sel == 2 ? ivec4((a + th) & 255, 255) : ivec4((b - th) & 255, 255);
    } else r = ivec4((a + b + 1) >> 1, sel == 2 ? 255 : 0);
  }
`),
  // rewrite: depth and raster color planes through one copy of planeAt and f_trunc (exact)
  planemerge: (s) => rep(s, `  uint zf = planeAt(1u, dx, dy);
  int z = f_trunc(f_gt(zf, 0x4b7fffffu) ? 0x4b7fffffu : (f_lt(zf, 0u) ? 0u : zf)) & 0xffffff;
  int stored = int(dep);
  uint newDep = dep;
  if (zEarly) {
    if (!cmpOp(zFunc, z, stored)) return;
    if (zUpdate) newDep = uint(z);
  }
  // raster colors
  for (int i = 0; i < 8; i++) gRasCh[i] = 0;
  for (int i = 0; i < numCols * 4; i++) {
    int tv = f_trunc(planeAt(uint(2 + i), dx, dy));
    int v16 = tv & 0xffff;
    gRasCh[i] = (v16 & ~(v16 >> 8)) & 0xff;
  }`, `  int stored = int(dep);
  uint newDep = dep;
  int z = 0;
  for (int i = 0; i < 8; i++) gRasCh[i] = 0;
  // plane 1 the depth (clamped to 0 .. 0xffffff, then the early depth test), planes 2.. the raster colors
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
  }`),
  // rewrite: the texel's bytes through one copy of tb (a loop over as many as the format reads) (exact)
  tbloop: (s) => rep(s, `  uint b0 = tb(mp, a0), b1 = tb(mp, a0 + 1u), b2 = 0u, b3 = 0u, b4 = 0u;
  if (fmt == 6u || fmt == 14u) { b2 = tb(mp, a0 + d2); b3 = tb(mp, a0 + d2 + 1u); }
  if (fmt == 14u) b4 = tb(mp, a4);`, `  uint bb[5] = uint[5](0u, 0u, 0u, 0u, 0u);
  int nb = fmt == 14u ? 5 : (fmt == 6u ? 4 : 2);
  for (int i = 0; i < nb; i++) bb[i] = tb(mp, i < 2 ? a0 + uint(i) : (i < 4 ? a0 + d2 + uint(i - 2) : a4));
  uint b0 = bb[0], b1 = bb[1], b2 = bb[2], b3 = bb[3], b4 = bb[4];`),
  // rewrite: the block sizes and nibbles per texel from a table by format (exact: every format 0..15 gives what the if chains gave)
  finfoarr: (s) => cut(s, "void finfo(uint fmt, out int kw, out int kh, out uint bytes) {", "// one texel of a level", `// by format 0..15: block width and height shifts (bits 0-1, 2-3), 64-byte blocks (bit 4), half bytes per texel (bits 5-8)
const uint FINFO[16] = uint[16](0x2fu, 0x4bu, 0x4bu, 0x8au, 0x8au, 0x8au, 0x11au, 0x8au, 0x2fu, 0x4bu, 0x8au, 0x8au, 0x8au, 0x8au, 0x2fu, 0x8au);
void finfo(uint fmt, out int kw, out int kh, out uint bytes) {
  uint f = FINFO[fmt & 15u];
  kw = int(f & 3u); kh = int((f >> 2) & 3u); bytes = (f & 16u) != 0u ? 64u : 32u;
}

// half bytes per texel, for the mip offsets (spec 9.3)
int nibblesOf(uint fmt) { return int(FINFO[fmt & 15u] >> 5); }

`),
  // ablations of the fetch on the batch-1 shader
  nocmpr2: (s) => rep(s, "  else if (kind == 14u) {", "  else if (false) {"),
  nopal2: (s) => rep(s, "  if (indexed) {\n    uint pidx", "  if (false) {\n    uint pidx"),
  onekind: (s) => cut(s, "  if (kind == 0u) { int v = w4(", "  return r;\n}\n\nint wrapC(", "  r = ivec4(int(b0), int(b1), int(b2), int(b3 + b4 + v16 + kind));\n"),
  // rewrite: the direct decodes as selects (the intensity forms 0-3 and the 16-bit colors 4-5 each one expression) (exact)
  decsel: (s) => rep(s, `  if (kind == 0u) { int v = w4((tx & 1) == 1 ? int(b0 & 15u) : int(b0 >> 4)); r = ivec4(v); }
  else if (kind == 1u) r = ivec4(int(b0));
  else if (kind == 2u) { int i = w4(int(b0 & 15u)); r = ivec4(i, i, i, w4(int(b0 >> 4))); }
  else if (kind == 3u) { int i = int(v16 & 255u); r = ivec4(i, i, i, int(v16 >> 8)); }
  else if (kind == 4u) r = ivec4(w5(bfi(v16, 11, 5)), w6(bfi(v16, 5, 6)), w5(bfi(v16, 0, 5)), 255);
  else if (kind == 5u) r = rgb5a3(v16);
  else if (kind == 6u)`, `  if (kind <= 3u) {
    // I4, I8, IA4, IA8: intensity and alpha
    int n4 = (tx & 1) == 1 ? int(b0 & 15u) : int(b0 >> 4);
    int I = kind == 0u ? n4 * 17 : (kind == 1u ? int(b0) : (kind == 2u ? int(b0 & 15u) * 17 : int(v16 & 255u)));
    int A = kind == 0u ? I : (kind == 1u ? int(b0) : (kind == 2u ? int(b0 >> 4) * 17 : int(v16 >> 8)));
    r = ivec4(I, I, I, A);
  } else if (kind <= 5u) {
    // RGB565, RGB5A3 (opaque 555 or 4443 with alpha)
    bool c565 = kind == 4u, opq = (v16 & 0x8000u) != 0u;
    ivec3 c5 = ivec3(int(v16 >> 11) & 31, int(v16 >> 5) & 63, int(v16) & 31);
    ivec3 c555 = ivec3(int(v16 >> 10) & 31, int(v16 >> 5) & 31, int(v16) & 31);
    ivec3 c4 = ivec3(int(v16 >> 8) & 15, int(v16 >> 4) & 15, int(v16) & 15) * 17;
    ivec3 e5 = c565 ? c5 : c555;
    ivec3 x5 = ivec3((e5.x << 3) | (e5.x >> 2), c565 ? ((e5.y << 2) | (e5.y >> 4)) : ((e5.y << 3) | (e5.y >> 2)), (e5.z << 3) | (e5.z >> 2));
    int a3 = int(v16 >> 12) & 7;
    r = (c565 || opq) ? ivec4(x5, 255) : ivec4(c4, (a3 << 5) | (a3 << 2) | (a3 >> 1));
  }
  else if (kind == 6u)`),
  // rewrite: the TEV registers as four vectors (exact)
  regvec: (s) => {
    s = rep(s, "int gRegs[16];", "ivec4 gR[4];");
    s = rep(s, `    gRegs[int(r) * 4] = sx11(ra & 0x7ffu); gRegs[int(r) * 4 + 3] = sx11((ra >> 12) & 0x7ffu);
    gRegs[int(r) * 4 + 2] = sx11(bg & 0x7ffu); gRegs[int(r) * 4 + 1] = sx11((bg >> 12) & 0x7ffu);`, "    gR[r] = ivec4(sx11(ra & 0x7ffu), sx11((bg >> 12) & 0x7ffu), sx11(bg & 0x7ffu), sx11((ra >> 12) & 0x7ffu));");
    s = rep(s, "    for (int r = 0; r < 4; r++) { cIn[2 * r] = ivec3(gRegs[4 * r], gRegs[4 * r + 1], gRegs[4 * r + 2]); cIn[2 * r + 1] = ivec3(gRegs[4 * r + 3]); }",
      "    for (int r = 0; r < 4; r++) { cIn[2 * r] = gR[r].rgb; cIn[2 * r + 1] = gR[r].aaa; }");
    s = rep(s, "int[8](gRegs[3], gRegs[7], gRegs[11], gRegs[15],", "int[8](gR[0].a, gR[1].a, gR[2].a, gR[3].a,");
    s = rep(s, "    gRegs[cdest * 4] = rc[0]; gRegs[cdest * 4 + 1] = rc[1]; gRegs[cdest * 4 + 2] = rc[2];\n    gRegs[adest * 4 + 3] = ra;", "    gR[cdest].rgb = rcv;\n    gR[adest].a = ra;");
    s = rep(s, "  ivec4 src = ivec4(gRegs[lastC * 4] & 255, gRegs[lastC * 4 + 1] & 255, gRegs[lastC * 4 + 2] & 255, gRegs[lastA * 4 + 3] & 255);", "  ivec4 src = ivec4(gR[lastC].rgb & 255, gR[lastA].a & 255);");
    s = rep(s, "  col = (uint(gRegs[DEBUG_A] & 0xfff) << 12) | uint(gRegs[DEBUG_B] & 0xfff);", "  col = (uint(gR[DEBUG_A >> 2][DEBUG_A & 3] & 0xfff) << 12) | uint(gR[DEBUG_B >> 2][DEBUG_B & 3] & 0xfff);");
    return s;
  },
  // ablation: the fast add/multiply without their exactness wrappers (fence, flush, tiny results, NaN)
  plainfast: (s) => cut(cut(s, "uint f_add(uint a, uint b) {\n  uint A = f_ftz(a)", "uint f_mul(uint a, uint b) {\n  uint A", "uint f_add(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) + uintBitsToFloat(b)); }\n"),
    "uint f_mul(uint a, uint b) {\n  uint A", "uint f_sub(uint a, uint b)","uint f_mul(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) * uintBitsToFloat(b)); }\n"),
  nofence: (s) => rep(s, "uint f_fence(float x) { return floatBitsToUint(x) ^ uFence; }", "uint f_fence(float x) { return floatBitsToUint(x); }"),
  noftz: (s) => rep(s, "uint f_ftz(uint a) { return (a & 0x7f800000u) == 0u ? (a & 0x80000000u) : a; }", "uint f_ftz(uint a) { return a; }"),
  addlite: (s) => rep(s, `  uint mA = A & 0x7fffffffu, mB = B & 0x7fffffffu;
  uint z = (mA | mB) == 0u ? (A & B & 0x80000000u) : (A == (B ^ 0x80000000u) ? 0u : ((mA >= mB ? A : B) & 0x80000000u));
  r = (r & 0x7f800000u) == 0u ? z : r;
`, ""),
  mullite: (s) => rep(s, `  uint p2 = f_fence(uintBitsToFloat(f_fence(fa * 16777216.0)) * fb) & 0x7fffffffu;
  bool zero = (A & 0x7fffffffu) == 0u || (B & 0x7fffffffu) == 0u;
  uint tiny = ((A ^ B) & 0x80000000u) | (!zero && p2 >= 0x0c800000u ? 0x00800000u : 0u);
  r = (r & 0x7fffffffu) <= 0x00800000u ? tiny : r;
`, ""),
  nonan: (s) => rep(rep(s, "  r = (r & 0x7f800000u) == 0u ? z : r;\n  return (r & 0x7fffffffu) > F_INF ? F_NAN : r;", "  r = (r & 0x7f800000u) == 0u ? z : r;\n  return r;"), "  r = (r & 0x7fffffffu) <= 0x00800000u ? tiny : r;\n  return (r & 0x7fffffffu) > F_INF ? F_NAN : r;", "  r = (r & 0x7fffffffu) <= 0x00800000u ? tiny : r;\n  return r;"),
  // rewrites: fewer inlined copies of the card's add/multiply (and their exactness wrappers), by loops with run-time bounds (exact)
  planeloop: (s) => rep(s, "  return f_add(f_add(p.x, f_mul(p.y, dx)), f_mul(p.z, dy));", "  uint acc = p.x;\n  for (int i = 0; i < uK.w; i++) acc = f_add(acc, f_mul(i == 0 ? p.y : p.z, i == 0 ? dx : dy));\n  return acc;"),
  offloop: (s) => {
    s = rep(s, "  uint dx = f_add(gOx, f_from_int(px - gXi)), dy = f_add(gOy, f_from_int(py - gYi));", "  uint dx, dy;\n  pixOffsets(px, py, dx, dy);");
    s = rep(s, "  uint dx = f_add(gOx, f_from_int(x - gXi)), dy = f_add(gOy, f_from_int(y - gYi));", "  uint dx, dy;\n  pixOffsets(x, y, dx, dy);");
    return rep(s, "uint planeAt(uint k, uint dx, uint dy) {", `// the pixel's offsets from the triangle's reference point, as floats (x, then y)
void pixOffsets(int px, int py, out uint dx, out uint dy) {
  uint d[2];
  for (int i = 0; i < uK.w; i++) d[i] = f_add(i == 0 ? gOx : gOy, f_from_int(i == 0 ? px - gXi : py - gYi));
  dx = d[0]; dy = d[1];
}

uint planeAt(uint k, uint dx, uint dy) {`);
  },
  stloop: (s) => rep(s, "  s = f_mul(pv[1], proj);\n  t = f_mul(pv[2], proj);", "  uint st2[2];\n  for (int i = 0; i < uK.w; i++) st2[i] = f_mul(pv[1 + i], proj);\n  s = st2[0]; t = st2[1];"),
  // candidate: a tiny or zero sum's sign taken from the card's own result (IEEE round-to-nearest gives the spec's sign there; would need the check)
  addsign: (s) => rep(s, `  uint mA = A & 0x7fffffffu, mB = B & 0x7fffffffu;
  uint z = (mA | mB) == 0u ? (A & B & 0x80000000u) : (A == (B ^ 0x80000000u) ? 0u : ((mA >= mB ? A : B) & 0x80000000u));
  r = (r & 0x7f800000u) == 0u ? z : r;
`, `  r = (r & 0x7f800000u) == 0u ? (r & 0x80000000u) : r;
`),
  // ablation: the level loop's offsets and the taps' weights
  onetap: (s) => rep(s, "  int ntaps = linear ? 4 : 1;", "  int ntaps = 1;"),
  onelev: (s) => rep(s, "  int nlev = mixl ? 2 : 1;", "  int nlev = 1;"),
  // ablations of the fog extras
  noexp: (s) => rep(s, "    uint ex = f_exp2(ar);", "    uint ex = ar ^ 0x3f800000u;"),
  nosqrt: (s) => rep(s, "f_div(f_sqrt(f_add(f_mul(o, o), f_mul(k, k))), k)", "f_div(f_add(f_mul(o, o), f_mul(k, k)), k)"),
  norange: (s) => rep(s, "  if (bf(S(0xe8u), 10, 1) == 1u) {", "  if (false) {"),
};
// combinations: a~b in translate.ts
