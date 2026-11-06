import { PIXEL_FS } from "../../../src/render3d/gxr/glsl-pixel.ts";
export { PIXEL_FS };
const rep = (fs: string, a: string, b: string): string => { if (!fs.includes(a)) throw new Error("missing: " + a); return fs.replace(a, b); };
const cut = (fs: string, from: string, to: string, body: string): string => { const a = fs.indexOf(from), b = fs.indexOf(to); if (a < 0 || b < 0) throw new Error("cut " + from); return fs.slice(0, a) + body + fs.slice(b); };
const NA = "uint f_add(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) + uintBitsToFloat(b)); }\n";
const NM = "uint f_mul(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) * uintBitsToFloat(b)); }\n";
const ND = "uint f_div(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) / uintBitsToFloat(b)); }\n";
const cutAdd = (s: string) => cut(s, "uint f_add(uint a, uint b) {", "uint f_sub(uint a, uint b)", NA);
const cutMul = (s: string) => cut(s, "uint f_mul(uint a, uint b) {", "uint f_div(uint a, uint b)", NM);
const cutDiv = (s: string) => cut(s, "uint f_div(uint a, uint b) {", "// float(n) for", ND);
export const variants: Record<string, (fs: string) => string> = {
  nativef: (s) => cutDiv(cutMul(cutAdd(s))),
  nativeadd: cutAdd,
  nativemul: cutMul,
  nativediv: cutDiv,
  full: (s) => s,
  nofog: (s) => rep(s, "  if (fsel != 0u) fogPixel(fsel, z, x, src);", ""),
  noblend: (s) => rep(rep(s, "  ivec4 res = blendPixel(S(0x41u), S(0x42u), src, dst);", "  ivec4 res = src;"), "  ivec4 dst = readColor(col, pixFmt);", "  ivec4 dst = ivec4(0);"),
  notex: (s) => rep(s, "bool texEn = bf(ord, 6, 1) == 1u;", "bool texEn = false;"),
  nocomb: (s) => rep(s, "    ivec3 ca = csel(", "    gRegs[0] = int(cc); continue;\n    ivec3 ca = csel("),
  nosample: (s) => rep(s, "      ivec4 tx = sampleMap(mp, cS, cT, lod, lin);", "      ivec4 tx = ivec4(cS, cT, lod, lin ? 1 : 0);"),
  nocoords: (s) => rep(s, "if (!constLod || j == me) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);", "sv[j] = uint(bx + j); tv[j] = uint(by + j);"),
  nofetch: (s) => rep(s, "      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;", "      sum += ivec4(wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt), int(off), 0) * wgt;"),
};
variants.nocsel = (s) => rep(s, "    ivec3 ca = csel(bfi(cc, 12, 4)), cb = csel(bfi(cc, 8, 4)), ccc = csel(bfi(cc, 4, 4)), cd = csel(bfi(cc, 0, 4));", "    ivec3 ca = ivec3(bfi(cc, 12, 4)), cb = ivec3(bfi(cc, 8, 4)), ccc = ivec3(bfi(cc, 4, 4)), cd = ivec3(bfi(cc, 0, 4));");
variants.noasel = (s) => rep(s, "    int aa = asel(bfi(ac, 13, 3), kas), ab = asel(bfi(ac, 10, 3), kas), ac_ = asel(bfi(ac, 7, 3), kas), ad = asel(bfi(ac, 4, 3), kas);", "    int aa = bfi(ac, 13, 3), ab = bfi(ac, 10, 3), ac_ = bfi(ac, 7, 3), ad = bfi(ac, 4, 3);");
variants.nokonst = (s) => rep(rep(rep(rep(s, "    if (bfi(cc, 12, 4) == 14) ca = konstColor(kcs);\n", ""), "    if (bfi(cc, 8, 4) == 14) cb = konstColor(kcs);\n", ""), "    if (bfi(cc, 4, 4) == 14) ccc = konstColor(kcs);\n", ""), "    if (bfi(cc, 0, 4) == 14) cd = konstColor(kcs);\n", "");
variants.noswz = (s) => rep(rep(s, "      swz(tsw, tv, gTex);", "      gTex[0] = tv[0]; gTex[1] = tv[1]; gTex[2] = tv[2]; gTex[3] = tv[3];"), "      swz(rsw, rv, gRas);", "      gRas[0] = rv[0]; gRas[1] = rv[1]; gRas[2] = rv[2]; gRas[3] = rv[3];");
variants.noalpha = (s) => rep(s, "    } else ra = tevRegular(true, aa & 255, ab & 255, ac_ & 255, sx11(uint(ad) & 0x7ffu), abias, aop, ascale, aclamp);", "    } else ra = aa + ab + ac_ + ad;");
variants.nocolorarith = (s) => rep(s, "    else rcv = tevColor3(ca & 255, cb & 255, ccc & 255, dv, cbias, cop, cscale, cclamp);", "    else rcv = ca + cb + ccc + dv;");
