/* 3D replay viewer: a small WebGL2 renderer for posed HSD models.
 *
 * Skinning happens on the GPU: each piece of mesh is uploaded once, and a
 * draw hands the shader the (up to ten) matrices its vertices pick from.
 *
 * Materials are drawn as the GameCube draws them (gx.ts has the math): the
 * vertex shader lights each vertex with the stage's lights (GX's color
 * channels, with their attenuation, and the specular channel) and makes the
 * texture coordinates; the fragment shader runs the texture environment HSD
 * builds for the material - the textures laid on the diffuse color, the
 * lighting, the specular term, the textures laid on after it - then the
 * alpha test and the fog. Pixel engine settings (blend, depth test and
 * write, color writes) come from the material as HSD sets them. Textures
 * are filtered as the file says, with the file's own mip levels.
 */
import { Archive, Image, MObj, TObj, Tlut, decodeImage } from "./hsd";
import { DrawGroup, Drawable, MatState, Skeleton, TexState, billboardViewOf } from "./skeleton";
import { Mat, invert, lookAt, mul } from "./math";
import { HSD_MtxInverseTranspose, PSMTXConcat, concatGL, mkBillBoardMtx, mtxFromGL, mtxToGL, mtxToGL3 } from "./gxmath";
import { type ViewLights, jointInView, lightsInView, newViewLights, specularDirs } from "./gxlights";
import { SHADOW_SIZE, shadowGray } from "./shadow";
import type { Tint as ColTint } from "./fx/colanim";
import { FOG_GLSL, type FogRegs, NO_FOG, gxSetFog, nearFar } from "./fog";
import {
  ALPHA_MAP_IN, COLOR_MAP_IN, Fog, MatProgram, RENDER, compileMaterial, defaultAlphaTest, minFilter, mipLevels, tevScalar,
  textureMatrix,
} from "./gx";
import { CNST_ALPHA, CNST_BLEND, CNST_DIFFUSE, CNST_SPECULAR, CNST_TEXREG, IN_CNST, IN_RAS, IN_STAGE, IN_TEX, IN_VALUE, type TevProgram, compileTExp, packTev } from "./texp";
import { DEFAULT_LIGHTS, LightSet, Lighting } from "./lightset";
import { LOOK_H, LOOK_W, Look480 } from "./look480";
import { GamePicture, type PictureOptions } from "./picture";
import { CRT_LOOKS, type CrtPreset, crtPixels } from "./crt";
import { drawingSize } from "./drawsize";
import { pageWeak } from "../state/pageCache";
import { idle } from "./idle";
import { mark, timed } from "./startup";

const tmpM = new Float32Array(16);
const MIRROR_W = 80, MIRROR_H = 60;
// the fighters' shadows a material takes, at most, and their texture units (after the material's four)
const MAX_SHADOWS = 4, SHADOW_UNIT = 4;

// uMatF (vec4s): 0 diffuse.rgb alpha | 1 ambient.rgb shininess | 2 specular.rgb
//   | 3 each sampler's blend | 4 each sampler's LOD bias | 5 alpha test refs
//   (0..255), the alpha's TEV byte / 255 | 6..17 each sampler's texture
//   matrix (3 rows) | 18..29 each sampler's own TEV colors: konst, tev0, tev1
// uMatI (ivec4s): 0 stages, channel, flags (1 vertex base, 2 lit, 4
//   specular), alpha test (comp0 | comp1 << 3 | op << 6) | 1 each sampler's
//   coordinates (TexGen, -1 unused) | 2 the TEV program's stage count, its
//   output stage, the textures modulated after it (count, samplers 2 bits
//   each) | 3.. its stages, three each (texp.ts packTev): the color inputs,
//   the alpha inputs, (color mode, alpha mode, sampler, channel)
const MAX_TEV = 16;
/** the material block's size: its vec4s and its ivec4s */
export const MATF = 30, MATI = 3 + MAX_TEV * 3;
// the programs of the materials that are no material's own: the diffuse color as it is, or lit
const PLAIN_TEV = compileTExp({ renderMode: 0 } as MObj, [], () => -1);
const LIT_TEV = compileTExp({ renderMode: RENDER.DIFFUSE } as MObj, [], () => -1);
/** a TEV program into a material block's integers (uMatI 2..) */
function putTev(I: Int32Array, p: TevProgram): number {
  const n = packTev(p, I, 12, MAX_TEV);
  I[8] = n;
  I[9] = Math.max(0, Math.min(p.out, n - 1));
  return n;
}
// (a uniform block: each material keeps its own buffer of them, sent again
// only when something in it changes, and a draw only binds it)
const MAT_DECL = `layout(std140) uniform Mat {\n  vec4 uMatF[${MATF}];\n  ivec4 uMatI[${MATI}];\n};`;
const MAT_BYTES = (MATF + MATI) * 16;

// GX's TEV in its integers (gx.ts tevStage, tevCompare, colorMap, alphaMap,
// alphaTest: the same arithmetic, one stage function for every stage): 8-bit
// inputs, 10-bit signed results, the lerp over 256 with its rounding bias
const TEV_GLSL = `
// a color as the bytes it stands for (a value kept as byte / 255; a texel round(t * 255))
ivec4 bytes(vec4 v) { return ivec4(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5)); }
int bytes1(float v) { return int(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5)); }
// one stage on four channels: a, b, c bytes (their low 8 bits), d 10-bit; sub 1 where it subtracts; bias
// (GX_TB_*), scale (GX_CS_*), clamped to 0..255 or kept to -1024..1023
ivec4 tev4(ivec4 a, ivec4 b, ivec4 c, ivec4 d, ivec4 sub, int bias, int scale, bool cl) {
  a &= 255; b &= 255; c &= 255;
  int s = scale == 1 ? 1 : scale == 2 ? 2 : 0;
  bool halve = scale == 3;
  ivec4 dd = (d + (bias == 1 ? 128 : bias == 2 ? -128 : 0)) << s;
  ivec4 l = ((((a << 8) + (b - a) * (c + (c >> 7))) << s) + (halve ? ivec4(0) : 128 - sub)) >> 8;
  ivec4 v = dd + l * (1 - 2 * sub);
  if (halve) v >>= 1;
  return cl ? clamp(v, 0, 255) : clamp(v, -1024, 1023);
}
bool tevPass(bool eq, int x, int y) { return eq ? x == y : x > y; }
// a compare stage (GX_TEV_COMP_*): d + c where a compares to b as asked (rgb, or the alpha in .a)
ivec4 tevCmp(int op, ivec4 a, ivec4 b, ivec4 c, ivec4 d, bool alpha, bool cl) {
  a &= 255; b &= 255; c &= 255;
  bool eq = (op & 1) == 1;
  int mode = (op >> 1) & 3;
  int va = mode == 1 ? a.r + (a.g << 8) : mode == 2 ? a.r + (a.g << 8) + (a.b << 16) : a.r;
  int vb = mode == 1 ? b.r + (b.g << 8) : mode == 2 ? b.r + (b.g << 8) + (b.b << 16) : b.r;
  bool all = tevPass(eq, va, vb);
  ivec4 add = mode == 3 ? ivec4(tevPass(eq, a.r, b.r) ? c.r : 0, tevPass(eq, a.g, b.g) ? c.g : 0, tevPass(eq, a.b, b.b) ? c.b : 0,
                                tevPass(eq, a.a, b.a) ? c.a : 0) : all ? c : ivec4(0);
  ivec4 v = d + add;
  return cl ? clamp(v, 0, 255) : clamp(v, -1024, 1023);
}
// a texture's color map and alpha map (TObjMakeTExp's stages), their inputs by gx.ts COLOR_MAP_IN, ALPHA_MAP_IN:
// 0 zero, 1 the color so far, 2 the texel, 3 its alpha, 4 the blending
const int CMAP[45] = int[45](${COLOR_MAP_IN.flat().join(", ")});
const int AMAP[40] = int[40](${ALPHA_MAP_IN.flat().join(", ")});
ivec3 pickC(int k, ivec3 p, ivec4 t, int b) { return k == 1 ? p : k == 2 ? t.rgb : k == 3 ? ivec3(t.a) : k == 4 ? ivec3(b) : ivec3(0); }
int pickA(int k, int p, int t, int b) { return k == 1 ? p : k == 3 ? t : k == 4 ? b : 0; }
ivec3 colorMap(int op, ivec3 p, ivec4 t, int b) {
  int o = (op < 0 || op > 8 ? 0 : op) * 5;
  return tev4(ivec4(pickC(CMAP[o], p, t, b), 0), ivec4(pickC(CMAP[o + 1], p, t, b), 0), ivec4(pickC(CMAP[o + 2], p, t, b), 0),
              ivec4(pickC(CMAP[o + 3], p, t, b), 0), ivec4(CMAP[o + 4]), 0, 0, true).rgb;
}
int alphaMap(int op, int p, int t, int b) {
  int o = (op < 0 || op > 7 ? 0 : op) * 5;
  return tev4(ivec4(pickA(AMAP[o], p, t, b)), ivec4(pickA(AMAP[o + 1], p, t, b)), ivec4(pickA(AMAP[o + 2], p, t, b)),
              ivec4(pickA(AMAP[o + 3], p, t, b)), ivec4(AMAP[o + 4]), 0, 0, true).a;
}
// GX's alpha test on the alpha's byte: two comparisons (GX_NEVER .. GX_ALWAYS) and their logic (GX_AOP_*)
bool cmpI(int f, int a, int r) {
  return f == 0 ? false : f == 1 ? a < r : f == 2 ? a == r : f == 3 ? a <= r : f == 4 ? a > r : f == 5 ? a != r : f == 6 ? a >= r : true;
}
bool alphaPass(int a, int comp0, int ref0, int op, int comp1, int ref1) {
  bool p = cmpI(comp0, a, ref0), q = cmpI(comp1, a, ref1);
  return op == 0 ? (p && q) : op == 1 ? (p || q) : op == 2 ? (p != q) : (p == q);
}`;

// A material's TEV program (texp.ts compileTExp, runTev: the same table, run the same way): each stage's inputs
// fetched by their codes (kind | part << 3 | index << 6), its color and alpha through tev4 / tevCmp, the result of
// each kept for the stages after. Reads uMatI and uMatF (MAT_DECL), and tevTx (each sampler's texel) and tevRas
// (the two rasterized colors), set before it runs.
const TEV_PROG_GLSL = `
ivec4 tevTx[4];
ivec4 tevRas[2];
ivec4 tevRes[${MAX_TEV}];
// a constant (texp.ts CNST_*): the diffuse color, the alpha, the specular color, a sampler's blend, its own TEV colors
ivec4 tevCnst(int id) {
  if (id == ${CNST_DIFFUSE}) return ivec4(bytes(uMatF[0]).rgb, 255);
  if (id == ${CNST_ALPHA}) return ivec4(bytes1(uMatF[5].z));
  if (id == ${CNST_SPECULAR}) return ivec4(bytes(uMatF[2]).rgb, 255);
  if (id < ${CNST_TEXREG}) return ivec4(bytes1(uMatF[3][id - ${CNST_BLEND}]));
  return bytes(uMatF[18 + id - ${CNST_TEXREG}]);
}
ivec4 tevIn(int x, int tex, int chan) {
  int kind = x & 7, part = (x >> 3) & 7, idx = x >> 6;
  ivec4 v;
  if (kind == ${IN_VALUE}) return ivec4(idx);
  else if (kind == ${IN_TEX}) v = tex >= 0 ? tevTx[tex] : ivec4(0);
  else if (kind == ${IN_RAS}) v = chan >= 0 ? tevRas[chan] : ivec4(0);
  else if (kind == ${IN_CNST}) v = tevCnst(idx);
  else if (kind == ${IN_STAGE}) v = tevRes[idx];
  else return ivec4(0);
  if (part == 0) return v;
  return ivec4(part == 1 ? v.r : part == 2 ? v.g : part == 3 ? v.b : v.a);
}
ivec4 tevProgram() {
  ivec4 h = uMatI[2];
  for (int k = 0; k < ${MAX_TEV}; k++) {
    if (k >= h.x) break;
    ivec4 ci = uMatI[3 + k * 3], ai = uMatI[4 + k * 3], md = uMatI[5 + k * 3];
    int tex = md.z, ch = md.w, cm = md.x, am = md.y;
    ivec4 A = tevIn(ci.x, tex, ch), B = tevIn(ci.y, tex, ch), C = tevIn(ci.z, tex, ch), D = tevIn(ci.w, tex, ch);
    ivec4 o = ivec4(0);
    if ((cm & 512) != 0) {
      int op = cm & 15;
      bool cl = (cm & 256) != 0;
      o.rgb = op >= 8 ? tevCmp(op, A, B, C, D, false, cl).rgb : tev4(A, B, C, D, ivec4(op), (cm >> 4) & 3, (cm >> 6) & 3, cl).rgb;
    }
    if ((am & 512) != 0) {
      ivec4 a = tevIn(ai.x, tex, ch), b = tevIn(ai.y, tex, ch), c = tevIn(ai.z, tex, ch), d = tevIn(ai.w, tex, ch);
      int op = am & 15;
      bool cl = (am & 256) != 0;
      o.a = op >= 8 ? tevCmp(op, ivec4(A.rgb, a.a), ivec4(B.rgb, b.a), ivec4(0, 0, 0, c.a), ivec4(0, 0, 0, d.a), true, cl).a
                    : tev4(a, b, c, d, ivec4(op), (am >> 4) & 3, (am >> 6) & 3, cl).a;
    }
    tevRes[k] = o;
  }
  return h.x > 0 ? tevRes[h.y] : ivec4(0);
}`;

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUv0; in vec2 aUv1; in vec2 aUv2; in vec4 aClr; in float aMtx; in vec3 aBin; in vec3 aTan;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform mat4 uMats[10];
// what GX is loaded with: each matrix's modelview (the view times the model's
// matrix, made on the CPU as the game makes it) and the projection
uniform mat4 uMV[10];
uniform mat4 uProj;
// and each one's normal matrix (HSD_MtxInverseTranspose of the modelview: the normals GX lights in view space)
uniform mat3 uNrm[10];
uniform float uInflate; // a ghost's outline: pushed out along the normal, world units
uniform float uPointSize; // a point list's points, pixels across (GX's point size)
${MAT_DECL}
// the lights (lightset.ts): the ambient, then each light's place (w 1) or
// the way to it (w 0), axis, color, angle attenuation (w: 1 diffuse, 2
// specular, 4 alpha) and distance attenuation
uniform vec3 uAmbLight;
uniform float uAmbA; // the ambient light's alpha when it has LOBJ_ALPHA, else -1
uniform int uNumLights;
uniform vec4 uLPos[8]; uniform vec4 uLAxis[8]; uniform vec4 uLCol[8]; uniform vec4 uLA[8]; uniform vec4 uLK[8];
uniform vec3 uEye;    // the camera, world space
// the lights as GX is loaded with them for the view drawn through (gxlights.ts): each one's position in view
// space (an infinite one's 2^20 out, a point), a spot's axis toward it, each specular light's half-way
// direction for the drawn joint (HSD_LObjSetupSpecularInit), and the color animation light's position
uniform vec4 uLPosV[8]; uniform vec4 uLAxisV[8]; uniform vec4 uLSpecV[8];
uniform vec3 uOverPosV;
// a fighter's color animation (fx/colanim.ts): a light from uOverDir
// (ftCo_8009F5AC's x588). Mode 1 (x7C_light_enable): a white light added to
// the fighter's own (its alpha the strength, LOBJ_ALPHA), whose alpha channel
// adds the color (ftMaterial_800BF534's stage); mode 2: the fighter lit by the
// ambient light and it alone (HSD_LObjSetCurrentAll(lobj1): the set's first
// ambient light, then x588 added), in its color
uniform vec4 uOverLight;
uniform vec3 uOverDir;
uniform int uOverMode;
// (each texture's s, t and q: GX divides by q at each pixel, which a
// projected texture - the stage's mirror image - needs across big triangles)
out vec4 vRas0; out vec3 vRas1; out vec3 vT0; out vec3 vT1; out vec3 vT2; out vec3 vT3;
out vec3 vNrmV; out vec3 vPosV; out float vOverA; out vec3 vPosW;
out vec2 vBump; // an emboss bump map's coordinates, shifted toward the first diffuse light

vec3 texGen(int i, vec2 uv0, vec2 uv1, vec2 uv2, vec3 nv, vec4 W) {
  int kind = uMatI[1][i];
  vec4 r0 = uMatF[6 + i * 3], r1 = uMatF[7 + i * 3], r2 = uMatF[8 + i * 3];
  if (kind == 4) {
    // where the point falls in the stage's mirror image (projective)
    float q = dot(r2, W);
    return vec3(dot(r0, W), dot(r1, W), abs(q) > 1e-6 ? q : 1e-6);
  }
  if (kind == 2) {
    // the view-space normal through HSD's reflection matrix: (x, y, z, 1)
    // times rows of (m0 / 2, -m1 / 2, 0, m0 / 2 + m1 / 2 + m2 + m3)
    vec3 m0 = vec3(0.5 * r0.x, -0.5 * r0.y, 0.0), m1 = vec3(0.5 * r1.x, -0.5 * r1.y, 0.0), m2 = vec3(0.5 * r2.x, -0.5 * r2.y, 0.0);
    float s = dot(m0, nv) + 0.5 * r0.x + 0.5 * r0.y + r0.z + r0.w;
    float t = dot(m1, nv) + 0.5 * r1.x + 0.5 * r1.y + r1.z + r1.w;
    float w = dot(m2, nv) + 0.5 * r2.x + 0.5 * r2.y + r2.z + r2.w;
    return vec3(s, t, abs(w) > 1e-6 ? w : 1.0);
  }
  if (kind == 3) {
    // the first infinite light's highlight: half-way between it and the view
    vec3 L = vec3(0.0, 0.0, 1.0);
    for (int k = 0; k < 8; k++) {
      if (k >= uNumLights) break;
      if (uLPos[k].w == 0.0) { L = -uLPos[k].xyz; break; }
    }
    vec3 h = normalize(mat3(uView) * L + vec3(0.0, 0.0, -1.0));
    float e = 0.5 - 0.5 * dot(h, nv);
    return vec3(r0.x * e + r0.w, r1.x * e + r1.w, 1.0);
  }
  vec2 uv = kind == 1 ? uv1 : kind == 5 ? uv2 : uv0;
  return vec3(dot(r0, vec4(uv, 1.0, 1.0)), dot(r1, vec4(uv, 1.0, 1.0)), 1.0);
}

// a see-through material of a fighter whose color animation adds its light
// (ftMaterial_800BF534 takes it to ftCo_8009F75C(fp, false)): its channels are
// set while the lights are the ambient and x588 alone - the diffuse channel on
// GX light 0, no specular light - and the fighters' own set is loaded again
// before it is drawn (ftCo_8009F75C(fp, true)), so it is lit by the ambient
// and the set's first light only, without the added light
bool firstLightOnly() { return uOverMode == 1 && (uMatI[0].z & 512) != 0; }

// a color as the bytes it stands for (a value kept as byte / 255)
ivec3 bytes3(vec3 v) { return ivec3(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5)); }
// a light's term into a channel, rounded to the channel's integers
ivec3 term(float f, vec3 color) { return ivec3(floor(f * vec3(bytes3(color)) + 0.5)); }
// a channel's output: the material color (white) times the clamped sum (gx.ts chanColor)
vec3 chanOut(ivec3 acc) { ivec3 l = clamp(acc, 0, 255); return vec3((255 * (l + (l >> 7))) >> 8) / 255.0; }

// GX's color channel, in its integers (gx.ts diffuseChannel): the ambient
// register (the ambient light times the material's ambient, HSD_MulColor),
// then each diffuse light by its angle and distance attenuation and the
// normal's turn to it, each term rounded, the sum clamped
// (in view space, as GX lights: V the vertex, N its normal through the normal matrix; every light a point - an
// infinite one 2^20 out - its way to the vertex normalized, its spot attenuation by that way and its axis, its
// distance attenuation by the distance)
vec3 toLightV(vec3 p, vec3 V, out float dist) { vec3 v = p - V; dist = length(v); return v / max(dist, 1e-30); }
// (a diffuse light's angle and distance attenuation times the normal's turn to it)
float diffuseTurn(int k, vec3 V, vec3 N) {
  vec4 a = uLA[k];
  float dist;
  vec3 ld = toLightV(uLPosV[k].xyz, V, dist);
  float c = max(dot(ld, uLAxisV[k].xyz), 0.0);
  vec3 kk = uLK[k].xyz;
  float att = max(a.x + a.y * c + a.z * c * c, 0.0) / (kk.x + kk.y * dist + kk.z * dist * dist);
  return att * max(dot(N, ld), 0.0);
}
vec3 diffuseLights(vec3 V, vec3 N) {
  ivec3 L = (bytes3(uAmbLight) * bytes3(uMatF[1].rgb)) / 255;
  bool first = firstLightOnly();
  for (int k = 0; k < 8; k++) {
    if (k >= uNumLights || (first && k > 0)) break;
    if ((int(uLA[k].w) & 1) == 0 || uOverMode == 2) continue;
    L += term(diffuseTurn(k, V, N), uLCol[k].rgb);
  }
  float od;
  vec3 ol = toLightV(uOverPosV, V, od);
  if (uOverMode == 2) L += term(max(dot(N, ol), 0.0), uOverLight.rgb);
  else if (uOverMode == 1 && !first) L += term(max(dot(N, ol), 0.0), vec3(1.0));
  return chanOut(L);
}

// the alpha channel (gx.ts alphaChannel; HSD_SetupChannelMode's lit case, HSD_State_80405A38_90): lit when the
// ambient light has LOBJ_ALPHA (its alpha the ambient register's) or a light is in HSD_LObjGetLightMaskAlpha (w 4,
// ambient alpha 0) - each such light's alpha by its attenuation and turn, rounded, as the color's terms, the sum
// clamped, times the register's 255 - else unlit (HSD_State_80405A38_C0): 255
// (a color animation's added light has LOBJ_ALPHA, ftCo_8009F5AC, and is in the mask with the set's own; while it
// lights alone, or for a see-through material whose channels are set with the ambient and x588 alone, x588 has it
// cleared, ftCo_8009F75C(fp, false): the mask is empty)
float alphaLights(vec3 V, vec3 N) {
  bool lit = uAmbA >= 0.0;
  int A = lit ? bytes3(vec3(uAmbA)).x : 0;
  bool own = uOverMode == 0 || (uOverMode == 1 && !firstLightOnly());
  for (int k = 0; k < 8; k++) {
    if (k >= uNumLights || !own) break;
    if ((int(uLA[k].w) & 4) == 0) continue;
    lit = true;
    A += term(diffuseTurn(k, V, N), vec3(uLCol[k].a)).x;
  }
  if (own && uOverMode == 1) {
    float od;
    vec3 ol = toLightV(uOverPosV, V, od);
    lit = true;
    A += term(max(dot(N, ol), 0.0), vec3(uOverLight.a)).x;
  }
  return lit ? chanOut(ivec3(A)).x : 1.0;
}

// the specular channel: each specular light aimed along the half-way vector
// between it and the eye as seen from the joint, attenuated by the material's
// shininess as GX's specular lights are
vec3 specularLights(vec3 V, vec3 N) {
  ivec3 S = ivec3(0);
  if (uOverMode == 2 || firstLightOnly()) return vec3(0.0);
  float k0 = 0.5 * uMatF[1].w, k2 = 1.0 - k0;
  for (int k = 0; k < 8; k++) {
    if (k >= uNumLights) break;
    if ((int(uLA[k].w) & 2) == 0) continue;
    // (GX_AF_SPEC: the light's direction - the half-way one - against the normal, where the light is in front)
    vec3 h = uLSpecV[k].xyz;
    float dist;
    vec3 ld = toLightV(uLPosV[k].xyz, V, dist);
    float nl = dot(N, ld);
    float c = nl >= 0.0 ? max(dot(N, h), 0.0) : 0.0;
    float att = c * c / max(k0 + k2 * c * c, 1e-6);
    S += term(att * max(nl, 0.0), uLCol[k].rgb);
  }
  return chanOut(S);
}

void main() {
  int mi = int(aMtx + 0.5);
  mat4 M = uMats[mi];
  vec3 n = mat3(M) * aNrm;
  vec3 N = normalize(n + vec3(0.0, 0.0, 1e-9));
  vec4 w = M * vec4(aPos, 1.0);
  if (uInflate > 0.0) w.xyz += normalize(n + vec3(0.0, 0.0, 1e-4)) * uInflate;
  // (the vertex and its normal as GX has them: through the modelview and its normal matrix)
  vec3 pv = (uMV[mi] * vec4(aPos, 1.0)).xyz;
  vec3 nv = normalize(uNrm[mi] * aNrm + vec3(0.0, 0.0, 1e-30));
  vNrmV = nv;
  vPosV = pv;
  vPosW = w.xyz;
  ivec4 m0 = uMatI[0];
  vRas0 = vec4(1.0);
  if (m0.y == 1) vRas0 = aClr;
  else if (m0.y == 2) vRas0 = vec4(diffuseLights(pv, nv), alphaLights(pv, nv));
  vRas1 = (m0.z & 4) != 0 ? specularLights(pv, nv) : vec3(0.0);
  // (the added color is the light's times the rasterized alpha, GX_CC_RASA: a lit material's alpha channel -
  // the added light's alpha by the turn with the set's alpha lights', alphaLights; an unlit one's is its vertex
  // alpha or its material's; the fragment shader adds the light's color times it, ftMaterial_800BF534's stage)
  float rasA = m0.y == 2 ? vRas0.a : m0.y == 1 ? aClr.a : uMatF[0].a;
  vOverA = uOverMode == 1 ? rasA : -1.0;
  // (and that lit alpha is the rasterized alpha the material's alpha stage takes, lerp(0, alpha, ras.a), as it
  // is the color's: while the light adds, a lit material's alpha is its alpha times the light's alpha by the turn)
  if (m0.y == 2 && uOverMode == 1) vRas0.a = rasA;
  vT0 = texGen(0, aUv0, aUv1, aUv2, nv, w);
  vT1 = texGen(1, aUv0, aUv1, aUv2, nv, w);
  vT2 = texGen(2, aUv0, aUv1, aUv2, nv, w);
  vT3 = texGen(3, aUv0, aUv1, aUv2, nv, w);
  // GX's bump texture coordinates: the map's own, moved by the first
  // diffuse light's direction along the tangent and the binormal
  int bs = ((m0.z >> 4) & 7) - 1;
  vBump = vec2(0.0);
  if (bs >= 0) {
    vec3 L = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      if (k >= uNumLights) break;
      if ((int(uLA[k].w) & 1) == 0) continue;
      vec4 p = uLPos[k];
      L = p.w == 0.0 ? p.xyz : normalize(p.xyz - w.xyz);
      break;
    }
    vec3 b3 = bs == 0 ? vT0 : bs == 1 ? vT1 : bs == 2 ? vT2 : vT3;
    vec2 base = b3.xy / b3.z;
    vBump = base + vec2(dot(mat3(M) * aTan, L), dot(mat3(M) * aBin, L));
  }
  // (a ghost's outline is pushed out in the world: the one draw not through the modelview)
  gl_Position = uInflate > 0.0 ? uViewProj * w : uProj * (uMV[mi] * vec4(aPos, 1.0));
  gl_PointSize = uPointSize;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 vRas0; in vec3 vRas1; in vec3 vT0; in vec3 vT1; in vec3 vT2; in vec3 vT3;
in vec3 vNrmV; in vec3 vPosV; in float vOverA; in vec2 vBump; in vec3 vPosW;
uniform sampler2D uTex0; uniform sampler2D uTex1; uniform sampler2D uTex2; uniform sampler2D uTex3;
// the fighters' shadows (shadow.ts): each a picture and its world-to-(s, t)
// matrix, laid on a material that takes them (RENDER_SHADOW); and a shadow
// being made: every pixel one flat gray, nothing else read (uCast.a > 0)
uniform sampler2D uShadow0; uniform sampler2D uShadow1; uniform sampler2D uShadow2; uniform sampler2D uShadow3;
uniform mat4 uShadowM[4];
uniform int uShadowN;
uniform int uShadowMask; // which of them this joint takes (the stage's shadow check), bit k for shadow k
uniform vec4 uCast;
${MAT_DECL}
uniform vec4 uTint; // a ghost: rgb, strength in a (0: not a ghost)
uniform vec4 uFlat; // one flat color (a ghost's outline), when a > 0
uniform vec4 uOutline; // the lit color toward rgb by a, when a > 0 (Mr. Game & Watch's outline: ftmaterial.c)
uniform float uFlash; // toward white (an L-cancel's flash), 0..1
uniform vec4 uOverColor; // a color animation's color, blended over by its alpha
uniform vec4 uOverLight; // the color animation's added light (its color laid on where its alpha falls)
${FOG_GLSL}
out vec4 outColor;

${TEV_GLSL}
${TEV_PROG_GLSL}
// a texel as the TEV takes it: round(t * 255)
ivec4 sampleTex(int i) {
  float bias = uMatF[4][i];
  vec4 t;
  if (i == 0) t = texture(uTex0, vT0.xy / vT0.z, bias);
  else if (i == 1) t = texture(uTex1, vT1.xy / vT1.z, bias);
  else if (i == 2) t = texture(uTex2, vT2.xy / vT2.z, bias);
  else t = texture(uTex3, vT3.xy / vT3.z, bias);
  return bytes(t);
}
void main() {
  if (uCast.a > 0.0) { outColor = vec4(uCast.rgb, 1.0); return; }
  ivec4 m0 = uMatI[0];
  int flags = m0.z;
  for (int i = 0; i < 4; i++) tevTx[i] = uMatI[1][i] >= 0 ? sampleTex(i) : ivec4(0);
  // (the TEV, HSD_TExpCompile's stages in bytes: gx.ts evalMaterial)
  ivec4 r0 = bytes(vRas0);
  tevRas[0] = r0; tevRas[1] = ivec4(bytes(vec4(vRas1, 1.0)).rgb, 255);
  ivec4 res = tevProgram();
  ivec3 ci = res.rgb;
  int ai = res.a;
  // after everything HSD compiled, the emboss (SetupEmbossBumpTev): plus the
  // map times the lit color unclamped, minus the map shifted toward the light
  int bs = ((flags >> 4) & 7) - 1;
  if (bs >= 0) {
    vec4 u = bs == 0 ? texture(uTex0, vBump) : bs == 1 ? texture(uTex1, vBump) : bs == 2 ? texture(uTex2, vBump) : texture(uTex3, vBump);
    ci = tev4(ivec4(0), ivec4(tevTx[bs].rgb, 0), r0, ivec4(ci, 0), ivec4(0), 0, 0, false).rgb;
    ci = tev4(ivec4(0), ivec4(bytes(u).rgb, 0), r0, ivec4(ci, 0), ivec4(1), 0, 0, true).rgb;
  }
  // a texture the game made a shadow-style projection of: the color times its texel (the stages' phase 3)
  ivec4 h = uMatI[2];
  for (int s = 0; s < 4; s++) {
    if (s >= h.z) break;
    ci = tev4(ivec4(0), ivec4(ci, 0), tevTx[(h.w >> (s * 2)) & 3], ivec4(0), ivec4(0), 0, 0, true).rgb;
  }
  // the shadows, after all of the material's own stages: its color times
  // each one's texel (HSD_TObjSetupVolatileTev's TObjSetupTevModulateShadow)
  if ((flags & 256) != 0) {
    for (int k = 0; k < 4; k++) {
      if (k >= uShadowN) break;
      if (((uShadowMask >> k) & 1) == 0) continue;
      vec2 st = (uShadowM[k] * vec4(vPosW, 1.0)).xy;
      vec4 s = k == 0 ? textureLod(uShadow0, st, 0.0) : k == 1 ? textureLod(uShadow1, st, 0.0)
             : k == 2 ? textureLod(uShadow2, st, 0.0) : textureLod(uShadow3, st, 0.0);
      ci = tev4(ivec4(0), ivec4(ci, 0), bytes(s), ivec4(0), ivec4(0), 0, 0, true).rgb;
    }
  }
  // (the overlay light's added color, prev + konst x ras.a: ftMaterial_800BF534 lays it on opaque materials only)
  if ((flags & 512) == 0 && vOverA >= 0.0)
    ci = tev4(ivec4(0), ivec4(bytes(uOverLight).rgb, 0), ivec4(bytes1(vOverA)), ivec4(ci, 0), ivec4(0), 0, 0, true).rgb;
  // a color animation's color, toward it by its alpha; an outline's the same (ftMaterial_800BF6BC)
  if (uOverColor.a > 0.0)
    ci = tev4(ivec4(ci, 0), ivec4(bytes(uOverColor).rgb, 0), ivec4(bytes1(uOverColor.a)), ivec4(0), ivec4(0), 0, 0, true).rgb;
  if (uOutline.a > 0.0)
    ci = tev4(ivec4(ci, 0), ivec4(bytes(uOutline).rgb, 0), ivec4(bytes1(uOutline.a)), ivec4(0), ivec4(0), 0, 0, true).rgb;
  // what leaves the last stage for the pixel engine: the register's low 8 bits
  ci &= 255; ai &= 255;
  // the alpha test, on the alpha's byte
  int at = m0.w;
  if (!alphaPass(ai, at & 7, int(uMatF[5].x + 0.5), (at >> 6) & 3, (at >> 3) & 7, int(uMatF[5].y + 0.5))) discard;
  // the fog, on the 8-bit color at the pixel's 24-bit depth (fog.ts)
  ci = gxFogI(ci);
  vec3 c = vec3(ci) / 255.0;
  float a = float(ai) / 255.0;
  if (uFlat.a > 0.0) { outColor = uFlat; return; }
  // (an outline's color was laid on in the TEV; nothing after it but the fog)
  if (uOutline.a > 0.0) { outColor = vec4(c, a); return; }
  if (uTint.a > 0.0) {
    // a ghost: the model's shading in the ghost's color at full strength (a
    // dark green read as a hole in the stage), and a white rim at the edges,
    // so it stands apart from the real fighters and from the stage behind it
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    float rim = pow(1.0 - abs(normalize(vNrmV).z), 1.2);
    vec3 g = uTint.rgb / max(max(uTint.r, uTint.g), max(uTint.b, 0.001));
    outColor = vec4(mix(g * (0.7 + 0.5 * l), vec3(1.0), 0.85 * rim), min(1.0, uTint.a * (0.9 + 0.3 * rim)));
    return;
  }
  outColor = vec4(mix(c, vec3(1.0), uFlash), a);
}`;

// The game's particles (fx/draw.ts builds the quads): the texture blends the
// environment color into the primary one, then the particle's own alpha
// compare (GX's two comparisons and their logic) decides the pixel
const PARTICLE_VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in vec4 aPrim; in vec4 aEnv; in vec3 aCmp; in float aTex;
uniform mat4 uViewProj;
out vec2 vUv; out vec4 vPrim; out vec4 vEnv; flat out vec3 vCmp; flat out float vTex;
void main() {
  vUv = aUv; vPrim = aPrim; vEnv = aEnv; vCmp = aCmp; vTex = aTex;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv; in vec4 vPrim; in vec4 vEnv; flat in vec3 vCmp; flat in float vTex;
uniform sampler2D uTex;
out vec4 outColor;
${TEV_GLSL}
void main() {
  // (psdisptev.c's stage: lerp(env, prim, texel); without a texture, the primitive color)
  ivec4 c = bytes(vPrim);
  if (vTex > 0.5) {
    // mirrored repeat, as the game's MirrorS/T texture coordinates want
    vec2 uv = 1.0 - abs(mod(vUv, 2.0) - 1.0);
    c = tev4(bytes(vEnv), c, bytes(texture(uTex, uv)), ivec4(0), ivec4(0), 0, 0, true);
  }
  int mode = int(vCmp.x + 0.5);
  if (!alphaPass(c.a, (mode >> 3) & 7, int(vCmp.y + 0.5), (mode >> 6) & 3, mode & 7, int(vCmp.z + 0.5))) discard;
  outColor = vec4(c) / 255.0;
}`;

/** the programs' sources (the tests compile them in a browser) */
export const SHADERS = { VS, FS, PARTICLE_VS, PARTICLE_FS, TEV_GLSL, TEV_PROG_GLSL, MAT_DECL, MATF, MATI };

// the model programs' attribute slots (the meshes' vertex arrays serve both),
// the uniforms looked up once they are linked, and the particles' slots
const ATTRS = ["aPos", "aNrm", "aUv0", "aUv1", "aUv2", "aClr", "aMtx", "aBin", "aTan"];
const UNIFORMS = ["uViewProj", "uView", "uMats", "uMV", "uProj", "uAmbLight", "uAmbA", "uNumLights", "uLPos", "uLAxis",
                  "uLCol", "uLA", "uLK", "uEye", "uNrm", "uLPosV", "uLAxisV", "uLSpecV", "uOverPosV", "uTint", "uTex0", "uTex1", "uTex2", "uTex3", "uInflate",
                  "uFlat", "uOutline", "uFlash", "uOverColor", "uOverLight", "uOverDir", "uOverMode",
                  "uFogI", "uFogF", "uFogColor", "uPointSize", "uShadow0", "uShadow1", "uShadow2", "uShadow3", "uShadowM",
                  "uShadowN", "uShadowMask", "uCast"];
const PARTICLE_ATTRS = ["aPos", "aUv", "aPrim", "aEnv", "aCmp", "aTex"];
/** a particle quad buffer's layout (17 floats a vertex), into the vertex array bound */
function particleAttribs(gl: WebGL2RenderingContext) {
  const put = (i: number, size: number, at: number) => {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, size, gl.FLOAT, false, 17 * 4, at * 4);
  };
  put(0, 3, 0); put(1, 2, 3); put(2, 4, 5); put(3, 4, 9); put(4, 3, 13); put(5, 1, 16);
}

/** an image's pixels at one of its levels, decoded once for the page: every
 *  player on it reads the game files' same bytes (files.ts), so the pixels
 *  of an image in them are kept by those bytes (pageWeak) */
function decoded(a: Archive, image: Image, tlut: Tlut | null, lv: { w: number; h: number; at: number }): Uint8Array {
  const byFile = pageWeak<ArrayBufferLike, Map<string, Uint8Array>>("pixels");
  const buf = a.data.buffer;
  let m = byFile.get(buf);
  if (!m) byFile.set(buf, (m = new Map()));
  const key = `${a.data.byteOffset + image.dataOff + lv.at}:${lv.w}x${lv.h}:${image.format}:${tlut ? a.data.byteOffset + tlut.offset : -1}`;
  let px = m.get(key);
  if (!px) {
    px = lv.at === 0 ? decodeImage(a, image, tlut)
      : decodeImage(a, { ...image, dataOff: image.dataOff + lv.at, width: lv.w, height: lv.h }, tlut);
    m.set(key, px);
  }
  return px;
}

interface TexCache {
  image: Image | null; tlut: Tlut | null; tex: WebGLTexture;
  tu: number; tv: number; su: number; sv: number; r: number; rx: number; ry: number; m: Float32Array; epoch: number;
  /** counts the changes to m (a material's block knows whether it has the latest) */
  ver: number;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  type: number;
  /** what its indices draw: triangles, or points */
  mode: number;
  /** where its indices start in its vertex array's list, bytes */
  offset: number;
}

/** a ghost's look: its color and how solid it is */
export interface Tint { color: [number, number, number]; alpha: number }

/** a texture drawn into (Renderer.target) */
export interface RenderTarget {
  fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; w: number; h: number;
  /** a picture the game erases with a quad of its own as it starts it (the draw log says so, drawlog.ts) */
  erase?: boolean;
}

export type { Fog };

export type { Lighting };

/** the lighting a model gets when there is no stage: the game's own fallback */
export const DEFAULT_LIGHTING: Lighting = new LightSet(DEFAULT_LIGHTS).at(0);

// GX compare functions as GL's (NEVER .. ALWAYS)
const ZF = [0x200, 0x201, 0x202, 0x203, 0x204, 0x205, 0x206, 0x207];
const GL_MIN = [0x2600, 0x2601, 0x2700, 0x2701, 0x2702, 0x2703]; // NEAREST .. LINEAR_MIPMAP_LINEAR

/** what a material sets that never changes, packed (Renderer.staticsOf) */
interface MatStatics {
  p: MatProgram;
  /** its uniform block's contents as last sent (std140: its floats, then its integers), and views of them */
  bytes: Uint8Array; F: Float32Array; I: Int32Array;
  ubo: WebGLBuffer | null;
  sent: boolean;
  /** each sampler's texture state and its matrix's version, as last put in */
  tcs: (TexCache | null)[]; tcVers: number[];
  /** its pixel engine */
  colorOn: boolean; blend: number; srcF: number; dstF: number; zWrite: boolean; zFunc: number;
}

let precompiling: Promise<void> | null = null;
let precompileAsked = false;

/** Compile and link the model and particle programs on a scratch canvas at page
 *  start, before any player exists. The driver and the browser keep a compiled
 *  program by its source, so a player's own context finds them done when it
 *  asks (its first compile is the longest wait of a first open: a second or
 *  more on a slow graphics card). A player made while this is under way waits
 *  for it before it makes its own programs: they would only be compiled twice
 *  at once. Nothing is drawn; the scratch context is let go when the programs
 *  are done. Does nothing where there is no OffscreenCanvas or WebGL 2, or on
 *  a second call. */
export function precompilePrograms() {
  if (precompileAsked || typeof OffscreenCanvas === "undefined") return;
  precompileAsked = true;
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2", {
      antialias: false, alpha: false, depth: true, stencil: true, preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) return;
    const made: WebGLProgram[] = [];
    const build = (vs: string, fs: string, attrs: string[]) => {
      const p = gl.createProgram()!;
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        gl.attachShader(p, s);
      }
      attrs.forEach((n, i) => gl.bindAttribLocation(p, i, n));
      gl.linkProgram(p);
      made.push(p);
    };
    build(VS, FS, ATTRS);
    build(PARTICLE_VS, PARTICLE_FS, PARTICLE_ATTRS);
    mark("precompileStart");
    const ext = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    const lose = gl.getExtension("WEBGL_lose_context");
    precompiling = new Promise<void>((done) => {
      const began = Date.now();
      const poll = () => {
        try {
          // (without the extension, the link status itself waits for the link)
          const finished = ext ? made.every((p) => gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR))
            : made.every((p) => gl.getProgramParameter(p, gl.LINK_STATUS) !== undefined);
          // (a context the browser took away, or a driver that never answers: let go)
          if (!finished && !gl.isContextLost() && Date.now() - began < 10000) { setTimeout(poll, 20); return; }
        } catch { /* let go */ }
        mark("precompileDone");
        try { lose?.loseContext(); } catch { /* already gone */ }
        precompiling = null;
        done();
      };
      poll();
    });
  } catch { /* the player compiles them itself, as before */ }
}

export class Renderer {
  gl: WebGL2RenderingContext;
  prog!: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private attr: Record<string, number> = {};
  private lighting: Lighting | null = null;
  /** the lighting each program has, by version */
  private litVersion = new Map<WebGLProgram, number>();
  private view: Mat = new Float32Array(16);
  private proj: Mat = new Float32Array(16);
  private eye = [0, 0, 0];
  private meshes = new Map<string, GpuMesh>();
  private textures = new Map<string, WebGLTexture>();
  private archiveIds = new WeakMap<Archive, number>();
  private nextArchive = 1;
  private sphere: GpuMesh | null = null;
  private spriteTex = new Map<string, WebGLTexture>();
  private particleProg!: WebGLProgram;
  private ploc: Record<string, WebGLUniformLocation | null> = {};
  private pvao: WebGLVertexArrayObject;
  private pvbo: WebGLBuffer;
  private pibo: WebGLBuffer;
  private pQuads = 0;
  private white: WebGLTexture;
  private bound: (WebGLTexture | null)[] = [null, null, null, null];
  // (a material block's layout: its floats, then its integers - std140's vec4s and ivec4s)
  private matBytes = new Uint8Array(MAT_BYTES);
  private matF = new Float32Array(this.matBytes.buffer, 0, MATF * 4);
  private matI = new Int32Array(this.matBytes.buffer, MATF * 16, MATI * 4);
  private viewProj: Mat = new Float32Array(16);
  /** each material's TEV, compiled once */
  private programs = new WeakMap<MatState, MatProgram>();
  /** draw calls in the last frame, for the stats */
  draws = 0;
  lost = false;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // (the canvas only takes the finished picture: picture.ts or the 480p look draws the scene)
      antialias: false, alpha: false, depth: true, stencil: true, preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("this browser has no WebGL2");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    // The programs are compiled and linked by the graphics driver while the
    // page goes on (KHR_parallel_shader_compile, where the browser has it:
    // the model program's is seconds of work, per player), and looked at
    // only once they are done (ready). Nothing is drawn until then.
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    // the model program, and its variant for the shield's card (the only one
    // that writes its own depth, so every other draw keeps its early depth
    // test); both with the same attribute slots, so the meshes serve both
    const program = (vsh: WebGLShader, fs: string, attrs: string[]) => {
      const p = gl.createProgram()!;
      const f = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, vsh);
      gl.attachShader(p, f);
      attrs.forEach((n, i) => gl.bindAttribLocation(p, i, n));
      gl.linkProgram(p);
      this.linking.push({ p, shaders: [vsh, f] });
      return p;
    };
    // (made at once, or when the page's scratch compile of the same programs is
    // done, which is what makes them quick here: precompilePrograms)
    const build = () => {
      const p = program(sh(gl.VERTEX_SHADER, VS), FS, ATTRS);
      this.prog = p;
      this.current = p;
      this.particleProg = program(sh(gl.VERTEX_SHADER, PARTICLE_VS), PARTICLE_FS, PARTICLE_ATTRS);
    };
    ATTRS.forEach((n, i) => { this.attr[n] = i; });
    // the game's particles: one dynamic buffer of quads, drawn in batches
    this.pvao = gl.createVertexArray()!;
    gl.bindVertexArray(this.pvao);
    this.pvbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
    particleAttribs(gl);
    this.pibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
    gl.bindVertexArray(null);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    // the material block for draws that are no material's own (a ghost, a depth pass, a plain sphere)
    this.scratchUbo = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.scratchUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, MAT_BYTES, gl.DYNAMIC_DRAW);
    this.ready = precompiling
      ? precompiling.then(() => { build(); return this.whenLinked(); })
      : (build(), this.whenLinked());
  }

  /** the programs being linked, and their shaders */
  private linking: { p: WebGLProgram; shaders: WebGLShader[] }[] = [];
  /** once the programs are linked and set up: nothing is drawn before (a
   *  failure - a shader the driver refuses - is its error) */
  readonly ready: Promise<void>;
  isReady = false;
  private async whenLinked() {
    const gl = this.gl;
    const ext = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    if (ext) {
      // (asked a frame at a time: the answer is the driver's, not a wait)
      while (!this.linking.every((l) => gl.getProgramParameter(l.p, ext.COMPLETION_STATUS_KHR))) {
        if (gl.isContextLost()) throw new Error("the graphics card dropped the 3D view");
        await new Promise((r) => setTimeout(r, 16));
      }
    }
    for (const { p, shaders } of this.linking) {
      if (gl.getProgramParameter(p, gl.LINK_STATUS)) continue;
      const why = shaders.map((s) => gl.getShaderInfoLog(s)).filter((x) => x).join(" ") || gl.getProgramInfoLog(p);
      throw new Error(why || "a shader did not link");
    }
    const setUp = (p: WebGLProgram, loc: Record<string, WebGLUniformLocation | null>) => {
      for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(p, n);
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, "Mat"), 0);
      gl.useProgram(p);
      gl.uniform1i(loc.uTex0, 0); gl.uniform1i(loc.uTex1, 1);
      gl.uniform1i(loc.uTex2, 2); gl.uniform1i(loc.uTex3, 3);
      for (let k = 0; k < MAX_SHADOWS; k++) gl.uniform1i(loc[`uShadow${k}`], SHADOW_UNIT + k);
    };
    setUp(this.prog, this.loc);
    for (const n of ["uViewProj", "uTex"]) this.ploc[n] = gl.getUniformLocation(this.particleProg, n);
    gl.useProgram(this.prog);
    this.current = this.prog;
    this.isReady = true;
  }
  private upload(d: Drawable): GpuMesh {
    // (kept on the drawable: a lookup by its key per draw adds up)
    const c = d.gpu;
    if (c && c.owner === this && c.epoch === this.meshEpoch) return c.mesh as GpuMesh;
    const m = (d.group ? this.modelMesh(d) : null) ?? this.uploadByKey(d);
    d.gpu = { owner: this, epoch: this.meshEpoch, mesh: m };
    return m;
  }

  /** each model's buffers: every mesh of a skeleton (its tag) in one vertex
   *  array, each mesh a stretch of the one index list, so a model's draws
   *  one after another bind nothing between them */
  private models = new Map<string, { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; meshes: Map<string, GpuMesh> }>();
  private modelMesh(d: Drawable): GpuMesh | null {
    const g = d.group!;
    let model = this.models.get(g.tag);
    if (!model) this.models.set(g.tag, (model = this.buildModel(g)));
    return model.meshes.get(d.key) ?? null;
  }
  private buildModel(g: DrawGroup) {
    const gl = this.gl;
    // (a mesh whose arrays are not one entry a vertex is left to a vertex array of its own)
    const fits = (m: Drawable["mesh"]) => {
      const n = m.mtx.length;
      return m.pos.length === n * 3 && m.nrm.length === n * 3 && m.uv.length === n * 2 && m.uv1.length === n * 2 && m.clr.length === n * 4 &&
        (!m.uv2 || m.uv2.length === n * 2) && (!m.bin || !m.tan || (m.bin.length === n * 3 && m.tan.length === n * 3));
    };
    const ds: Drawable[] = [];
    const seen = new Set<string>();
    let nv = 0, ni = 0, nbt = false, nt2 = false;
    for (const d of g.drawables) {
      if (seen.has(d.key) || !fits(d.mesh)) continue;
      seen.add(d.key);
      ds.push(d);
      nv += d.mesh.mtx.length;
      ni += d.mesh.indices.length;
      if (d.mesh.bin && d.mesh.tan) nbt = true;
      if (d.mesh.uv2) nt2 = true;
    }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv0 = new Float32Array(nv * 2), uv1 = new Float32Array(nv * 2);
    const clr = new Float32Array(nv * 4), mtx = new Float32Array(nv);
    // (the meshes without binormals and tangents read zeros, as an attribute left off does)
    const bin = nbt ? new Float32Array(nv * 3) : null, tan = nbt ? new Float32Array(nv * 3) : null;
    // (and those without a third texture coordinate set zeros)
    const uv2 = nt2 ? new Float32Array(nv * 2) : null;
    const wide = nv > 65536;
    const idx = wide ? new Uint32Array(ni) : new Uint16Array(ni);
    const type = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, bytes = wide ? 4 : 2;
    const vao = gl.createVertexArray()!;
    const meshes = new Map<string, GpuMesh>();
    let v = 0, i = 0;
    for (const d of ds) {
      const m = d.mesh, n = m.mtx.length, ix = m.indices;
      pos.set(m.pos, v * 3); nrm.set(m.nrm, v * 3); uv0.set(m.uv, v * 2); uv1.set(m.uv1, v * 2); clr.set(m.clr, v * 4); mtx.set(m.mtx, v);
      if (bin && tan && m.bin && m.tan) { bin.set(m.bin, v * 3); tan.set(m.tan, v * 3); }
      if (uv2 && m.uv2) uv2.set(m.uv2, v * 2);
      for (let k = 0; k < ix.length; k++) idx[i + k] = ix[k] + v;
      meshes.set(d.key, { vao, buffers: [], count: ix.length, type, mode: m.points ? gl.POINTS : gl.TRIANGLES, offset: i * bytes });
      v += n;
      i += ix.length;
    }
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const buf = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = this.attr[name];
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
      buffers.push(b);
    };
    buf(pos, "aPos", 3); buf(nrm, "aNrm", 3); buf(uv0, "aUv0", 2); buf(uv1, "aUv1", 2); buf(clr, "aClr", 4); buf(mtx, "aMtx", 1);
    if (bin && tan) { buf(bin, "aBin", 3); buf(tan, "aTan", 3); }
    if (uv2) buf(uv2, "aUv2", 2);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    return { vao, buffers, meshes };
  }
  /** the vertex array bound now (undefined: not known) */
  private vaoBound: WebGLVertexArrayObject | null | undefined = undefined;
  private bindVao(v: WebGLVertexArrayObject) {
    if (this.vaoBound === v) return;
    this.gl.bindVertexArray(v);
    this.vaoBound = v;
  }
  /** meshes' buffers forgotten so far (a drawable's own note of its buffers is good while this stands) */
  private meshEpoch = 0;
  private uploadByKey(d: Drawable): GpuMesh {
    let m = this.meshes.get(d.key);
    if (m) return m;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const buf = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = this.attr[name];
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
      buffers.push(b);
    };
    buf(d.mesh.pos, "aPos", 3);
    buf(d.mesh.nrm, "aNrm", 3);
    buf(d.mesh.uv, "aUv0", 2);
    buf(d.mesh.uv1, "aUv1", 2);
    buf(d.mesh.clr, "aClr", 4);
    buf(d.mesh.mtx, "aMtx", 1);
    // (a mesh without binormals and tangents reads zeros: the attributes stay off)
    if (d.mesh.bin && d.mesh.tan) { buf(d.mesh.bin, "aBin", 3); buf(d.mesh.tan, "aTan", 3); }
    if (d.mesh.uv2) buf(d.mesh.uv2, "aUv2", 2);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.indices, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    m = { vao, buffers, count: d.mesh.indices.length, mode: d.mesh.points ? gl.POINTS : gl.TRIANGLES, offset: 0,
          type: d.mesh.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT };
    this.meshes.set(d.key, m);
    return m;
  }

  /** forget the buffers of meshes whose key starts with this (a stage left behind) */
  release(prefix: string) {
    const gl = this.gl;
    for (const [k, m] of this.meshes) {
      if (!k.startsWith(prefix)) continue;
      gl.deleteVertexArray(m.vao);
      m.buffers.forEach((b) => gl.deleteBuffer(b));
      this.meshes.delete(k);
    }
    for (const [k, m] of this.models) {
      if (!k.startsWith(prefix)) continue;
      gl.deleteVertexArray(m.vao);
      m.buffers.forEach((b) => gl.deleteBuffer(b));
      this.models.delete(k);
    }
    this.meshEpoch++;
  }

  private archiveId(a: Archive): number {
    let id = this.archiveIds.get(a);
    if (!id) { id = this.nextArchive++; this.archiveIds.set(a, id); }
    return id;
  }

  // by the image object itself (a draw asks for its textures every frame:
  // no key to build), then by archive and offsets (the same image twice)
  private texByImage = new WeakMap<Image, Map<number, WebGLTexture>>();

  /** images the game renders into at run time (Pokemon Stadium's big
   *  screen): drawn from a picture the caller makes, uploaded when its
   *  version changes */
  private live = new WeakMap<Image, {
    tex: WebGLTexture | null; version: number; source: TexImageSource | null;
    /** the targets drawn into, by texture */
    targets?: Map<WebGLTexture, RenderTarget>;
    /** the copy made at the end of a frame (captureLive), and the frame it was made at: it is shown from the next */
    pend?: WebGLTexture; pendFrame?: number;
    /** the frame the shown picture was settled for (liveAdvance) */
    shownFor?: number;
    /** the frame the screen was blacked for (liveAdvance), whether its first drawing is under way, and whether its second */
    jumpedAt?: number; first?: boolean; second?: boolean;
  }>();

  /** show this picture where the file has the image (a render target), from now on */
  liveImage(image: Image, source: TexImageSource, version: number) {
    let l = this.live.get(image);
    if (!l) this.live.set(image, (l = { tex: null, version: -1, source: null }));
    l.source = source;
    if (l.version === version && l.tex) return;
    const gl = this.gl;
    // (a new texture for the image: the texture caches look again; a new
    // picture in the same one needs no looking up)
    if (!l.tex) this.imageEpoch++;
    if (!l.tex) {
      l.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else gl.bindTexture(gl.TEXTURE_2D, l.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    l.version = version;
    this.bound.fill(null);
  }

  /** A live image's texture as a target to draw into (w x h, as its picture is): Pokemon Stadium's screen,
   *  which the game letters with quads drawn into the picture it shows. The texture must have been made
   *  (liveImage); its first row is the top, so draw through a camera that turns the picture over. */
  liveTarget(image: Image, w: number, h: number): RenderTarget | null {
    const l = this.live.get(image);
    if (!l?.tex) return null;
    return this.targetOf(l, l.tex, w, h);
  }
  private targetOf(l: { targets?: Map<WebGLTexture, RenderTarget> }, tex: WebGLTexture, w: number, h: number): RenderTarget {
    const had = l.targets?.get(tex);
    if (had && had.w === w && had.h === h) return had;
    const gl = this.gl;
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bound.fill(null);
    const t = { fbo, tex, depth, w, h, erase: true };
    (l.targets ??= new Map()).set(tex, t);
    return t;
  }

  /** While the screen shows the match, it shows on a frame the copy made at the end of the frame before it - the
   *  game copies the picture after the screen is drawn - and never the copy of this frame, however many times this
   *  frame is drawn. Call this before drawing frame `frame` with `shows` for whether the screen shows the match.
   *  The copy of the frame before is promoted; a redraw leaves what is shown as it is. A frame that does not follow
   *  one (the first, a jump) has no copy of the frame before: the screen is black for a first drawing, and true is
   *  returned - the frame is to be drawn again, with the copy that drawing made (at its end) on the screen - and
   *  every drawing of that frame is those two, so the picture is the same whatever the number of draws. */
  liveAdvance(image: Image, frame: number, shows: boolean, w: number, h: number): boolean {
    const l = this.live.get(image);
    if (!l?.tex || !shows) return false;
    if (l.second) { l.second = false; return false; }
    if (l.jumpedAt !== frame) {
      if (l.shownFor === frame) return false;
      if (l.pend && l.pendFrame === frame - 1) {
        [l.tex, l.pend] = [l.pend, l.tex];
        l.shownFor = frame;
        this.bound.fill(null);
        this.imageEpoch++;
        this.dirty();
        return false;
      }
    }
    // a frame with no copy of the one before: black, drawn twice
    const gl = this.gl, t = this.targetOf(l, l.tex, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bindPicture();
    l.jumpedAt = frame;
    l.shownFor = frame;
    l.first = true;
    this.bound.fill(null);
    this.imageEpoch++;
    this.dirty();
    return true;
  }

  /** A part of the picture drawn so far into a live image's texture (w x
   *  h), scaled as the canvas scales a picture (bilinear, each of its pixels
   *  from the point under its center) and times a color (0-255): Pokemon
   *  Stadium's screen showing the match. All on the graphics card: the part
   *  copied out, then drawn into the texture. `rect`: fractions of the
   *  picture from its top left (x, y, w, h). The texture's first row is the
   *  top, as a canvas's upload has it. */
  captureLive(image: Image, w: number, h: number, rect: [number, number, number, number], tint: [number, number, number], frame?: number) {
    const gl = this.gl;
    const l = this.live.get(image);
    if (!l?.tex) return;
    // (with a frame, the copy waits to be shown from the next: in a texture of its own)
    let dst = l.tex;
    if (frame !== undefined) {
      if (!l.pend) {
        l.pend = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, l.pend);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      dst = l.pend;
      l.pendFrame = frame;
    }
    const [PW, PH] = this.look ? [LOOK_W, LOOK_H] : this.pic ? [this.pic.w, this.pic.h] : this.size;
    const sx = rect[0] * PW, sy = rect[1] * PH, sw = rect[2] * PW, sh = rect[3] * PH;
    // the picture's pixels under the part, bottom-up as GL counts its rows
    const x0 = Math.max(0, Math.floor(sx - 1)), x1 = Math.min(PW, Math.ceil(sx + sw + 1));
    const top = PH - (sy + sh), y0 = Math.max(0, Math.floor(top - 1)), y1 = Math.min(PH, Math.ceil(PH - sy + 1));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw <= 0 || ch <= 0) return;
    const c = (this.cap ??= this.makeCapture());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    if (c.w < cw || c.h < ch) {
      c.w = Math.max(c.w, cw); c.h = Math.max(c.h, ch);
      // (color alone: the canvas's picture has no alpha to copy)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, c.w, c.h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    }
    // (from the picture as drawn so far: the game's frame buffer resolved, when it is multisampled)
    if (!this.look) this.pic?.readable();
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x0, y0, cw, ch);
    // into the screen's texture: each of its pixels (x, y from the top) takes
    // the picture at (sx + (x + 0.5) sw / w, sy + (y + 0.5) sh / h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(c.prog);
    gl.uniform4f(c.uMap, sw / w / c.w, sx / c.w - x0 / c.w, -sh / h / c.h, (PH - sy - y0) / c.h);
    gl.uniform3f(c.uTint, tint[0] / 255, tint[1] / 255, tint[2] / 255);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // back to the frame's picture
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    this.bindPicture();
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    this.bound.fill(null);
    // (the first drawing of a frame the screen was blacked for: its copy is what the second shows)
    if (frame !== undefined && l.first && l.jumpedAt === frame && l.pend) {
      [l.tex, l.pend] = [l.pend, l.tex];
      l.first = false;
      l.second = true;
      this.imageEpoch++;
    }
    this.dirty();
  }
  private cap: { prog: WebGLProgram; fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number;
                 uMap: WebGLUniformLocation | null; uTint: WebGLUniformLocation | null } | null = null;
  private makeCapture() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uMap; // s = fx * x + y, t = fy * z + w (fx, fy: the pixel's center)
uniform vec3 uTint;
out vec4 outColor;
void main() {
  vec2 st = vec2(gl_FragCoord.x * uMap.x + uMap.y, gl_FragCoord.y * uMap.z + uMap.w);
  outColor = vec4(texture(uSrc, st).rgb * uTint, 1.0);
}`));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, "uSrc"), 0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { prog, fbo: gl.createFramebuffer()!, tex, w: 0, h: 0,
             uMap: gl.getUniformLocation(prog, "uMap"), uTint: gl.getUniformLocation(prog, "uTint") };
  }

  /** an image as a texture, wrapped and filtered as the TObj says: the
   *  file's own mip levels when it has them, HSD's minification filter */
  private texture(a: Archive, image: Image, tlut: Tlut | null, t: TObj): WebGLTexture {
    const live = this.live.get(image);
    if (live?.tex) return live.tex;
    const own = this.imageTex.get(image);
    if (own) return own;
    let byImage = this.texByImage.get(image);
    if (!byImage) this.texByImage.set(image, (byImage = new Map()));
    const minF = minFilter(t.lod ? t.lod.minFilt : null, !!image.mipmap, image.format);
    const k = (((tlut ? tlut.offset + 1 : 0) * 16 + (t.wrapS & 3) * 4 + (t.wrapT & 3)) * 8 + minF) * 2 + t.magFilt;
    const known = byImage.get(k);
    if (known) return known;
    const key = `${this.archiveId(a)}:${image.offset}:${tlut?.offset ?? 0}:${t.wrapS}${t.wrapT}:${minF}${t.magFilt}`;
    let tex = this.textures.get(key);
    if (tex) { byImage.set(k, tex); return tex; }
    const gl = this.gl;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const levels = minF >= 2 ? mipLevels(image.width, image.height, image.format, image.maxLOD ?? 0) : [{ w: image.width, h: image.height, at: 0 }];
    let n = 0;
    for (const lv of levels) {
      let rgba: Uint8Array;
      try {
        rgba = decoded(a, image, tlut, lv);
      } catch { break; }
      gl.texImage2D(gl.TEXTURE_2D, n, gl.RGBA, lv.w, lv.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      n++;
    }
    const mip = minF >= 2 && n > 1;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mip ? n - 1 : 0);
    if (mip) {
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, image.minLOD ?? 0);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, Math.min(image.maxLOD ?? 0, n - 1));
    }
    const wrap = (w: number) => (w === 0 ? gl.CLAMP_TO_EDGE : w === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(t.wrapS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(t.wrapT));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, GL_MIN[mip ? minF : minF & 1]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, t.magFilt ? gl.LINEAR : gl.NEAREST);
    this.textures.set(key, tex);
    byImage.set(k, tex);
    this.bound.fill(null);
    return tex;
  }

  // images drawn with a texture made here instead of their own pixels
  private imageTex = new WeakMap<Image, WebGLTexture>();

  /** draw an image of a model with a texture made here (the HUD's magnifier:
   *  its picture of the fighter is drawn into a target each frame, as the
   *  game draws into the image its bubble shows) */
  bindImage(image: Image, tex: WebGLTexture) {
    this.imageTex.set(image, tex);
    this.bound.fill(null);
    this.imageEpoch++;
  }
  /** changes whenever an image is given another texture (the cache looks again) */
  private imageEpoch = 0;

  /** a texture to draw into, w x h, with a depth buffer of its own */
  target(w: number, h: number): RenderTarget {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bound.fill(null);
    const t = { fbo, tex, depth, w, h };
    this.targets.push(t);
    return t;
  }
  private targets: RenderTarget[] = [];

  /** Draws from here on go through another camera: over the picture with
   *  the depth cleared (the HUD: the game draws it with cameras of its own,
   *  over the match), or into a target, cleared to a color first (the
   *  magnifier's picture). endOverlay() puts the match camera back. */
  overlay(proj: Mat, view: Mat, target: RenderTarget | null = null, clear: [number, number, number, number] | null = null,
          mirrored = false, gx: Float32Array | null = null) {
    const gl = this.gl;
    this.endPass();
    // (a camera that turns the picture over turns the faces' winding too)
    this.mirrored = mirrored;
    this.ovProj.set(proj);
    this.ovView.set(view);
    const viewProj = mul(this.ovVP, this.ovProj, this.ovView);
    this.overlayVP = viewProj;
    this.setCull(viewProj);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    }
    gl.depthMask(true);
    if (clear) gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.DEPTH_BUFFER_BIT | (clear ? gl.COLOR_BUFFER_BIT : 0));
    gl.uniformMatrix4fv(this.loc.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.ovView);
    gl.uniformMatrix4fv(this.loc.uProj, false, this.ovProj);
    this.camera(viewProj, this.ovView, this.ovProj);
    // (the GX projection it was made from, when the caller has one: for the draw log)
    if (gx) this.camGx = (this.ovGx.set(gx), this.ovGx);
    this.dirty();
  }
  private ovGx = new Float32Array(16);

  private mirrored = false;
  private overlayVP: Mat | null = null;
  /** an overlay's camera, as it was handed over */
  private ovProj: Mat = new Float32Array(16);
  private ovView: Mat = new Float32Array(16);
  private ovVP: Mat = new Float32Array(16);

  // ---- a shift of what is drawn next, in world units: a fighter's hitlag
  // shake. The game adds it to the camera's view for the fighter's draw
  // (ftDrawCommon_8008051C), so its joints stay where they are - its
  // effects, its trail - and only its model moves.
  /** the camera draws go through now (the frame's, an overlay's, the mirror's) */
  private camVP: Mat = new Float32Array(16);
  private camView: Mat = new Float32Array(16);
  /** the projection uploaded for it (uProj), and the GX projection it was made from when there is one */
  private camProj: Mat = new Float32Array(16);
  private camGx: Float32Array | null = null;
  /** the frame camera's GX projection (row major, as C_MTXPerspective makes it), or null */
  private gxFrame: Float32Array | null = null;
  private gxFrameBuf = new Float32Array(16);
  private shiftVP: Mat = new Float32Array(16);
  private shiftView: Mat = new Float32Array(16);
  private shifted = false;
  /** a count of the views draws have gone through: a drawable's modelview is made again under another */
  private viewVer = 0;
  private camera(vp: Mat, view: Mat, proj: Mat) {
    this.camVP = vp;
    this.camView = view;
    this.camProj = proj;
    this.camGx = proj === this.proj ? this.gxFrame : null;
    this.shifted = false;
    this.viewVer++;
  }
  /** move what is drawn from now on by (dx, dy) in the world; (0, 0) ends it */
  shiftDraws(dx: number, dy: number) {
    const gl = this.gl;
    if (!dx && !dy) {
      if (!this.shifted) return;
      this.shifted = false;
      this.viewVer++;
      gl.uniformMatrix4fv(this.loc.uViewProj, false, this.camVP);
      gl.uniformMatrix4fv(this.loc.uView, false, this.camView);
      this.setCull(this.camVP);
      return;
    }
    this.shifted = true;
    this.viewVer++;
    // M x translate(dx, dy, 0): M's last column gains dx its first and dy its second
    const at = (out: Mat, m: Mat) => {
      out.set(m);
      for (let r = 0; r < 4; r++) out[12 + r] = m[12 + r] + dx * m[r] + dy * m[4 + r];
    };
    at(this.shiftVP, this.camVP);
    at(this.shiftView, this.camView);
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.shiftVP);
    gl.uniformMatrix4fv(this.loc.uView, false, this.shiftView);
    this.setCull(this.shiftVP);
  }

  endOverlay() {
    const gl = this.gl;
    this.endPass();
    this.mirrored = false;
    this.overlayVP = null;
    this.setCull(this.viewProj);
    // back to the frame's picture: the canvas, or the 480p look's frame buffer
    this.bindPicture();
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.view);
    gl.uniformMatrix4fv(this.loc.uProj, false, this.proj);
    this.camera(this.viewProj, this.view, this.proj);
    this.dirty();
  }

  /** textures decoded and buffers made ahead of the first frame that needs
   *  them: queued, and done a few milliseconds at a time between the page's
   *  other work (a model's textures at once are a tenth of a second the
   *  page cannot move in); warmed() says when the queue is empty */
  warm(sk: Skeleton) {
    for (const d of sk.drawables) {
      this.warmQueue.push(() => timed("upload", "", () => this.upload(d)));
      for (const t of d.state.tex) {
        this.warmQueue.push(() => timed("texture", "", () => { try { this.texture(d.archive, t.image, t.tlut, t.tobj); } catch { /* drawn without it */ } }));
      }
    }
    this.pumpWarm();
  }
  private warmQueue: (() => void)[] = [];
  private warmAt = 0;
  private warmWaiting: (() => void)[] = [];
  private warmTimer: { cancel(): void } | null = null;
  /** how many things it has warmed so far (the warm-up's watch reads it: still moving) */
  warmDone = 0;
  private pumpWarm() {
    if (this.warmTimer !== null) return;
    // (in the page's idle time: between its frames, never in their way)
    this.warmTimer = idle((left) => {
      this.warmTimer = null;
      // (the queue's next few: what fits in the idle time, at least one)
      while (this.warmAt < this.warmQueue.length) {
        this.warmQueue[this.warmAt++]();
        this.warmDone++;
        if (left() < 2) break;
      }
      if (this.warmAt < this.warmQueue.length) { this.pumpWarm(); return; }
      this.warmQueue = [];
      this.warmAt = 0;
      const w = this.warmWaiting;
      this.warmWaiting = [];
      for (const f of w) f();
    });
  }
  /** once everything asked to be warmed so far is */
  warmed(): Promise<void> {
    if (this.warmAt >= this.warmQueue.length && this.warmTimer === null) return Promise.resolve();
    return new Promise((r) => this.warmWaiting.push(r));
  }

  /** a frame: the canvas at (cssW, cssH) CSS pixels (the caller knows its
   *  size; reading it here would lay the page out). device: the screen
   *  pixels it covers, when the browser says - with a CRT on (crt.ts), the
   *  canvas takes exactly those, so the grille's stripes land on the screen's
   *  own pixels (the scene is drawn at 640 x 480 then, whatever the canvas) */
  begin(proj: Mat, view: Mat, clear: [number, number, number], cssW: number, cssH: number,
        device?: [number, number], gxProj: Float32Array | null = null, nearFar: [number, number] | null = null) {
    const gl = this.gl;
    // (its size follows the element, the screen's pixel ratio counted, within a cap: drawsize.ts)
    if (this.maxDim === 0) {
      const v = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
      this.maxDim = v ? Math.min(v[0], v[1]) : 4096;
    }
    const exact = !!(this.look && this.crt !== "off" && device && device[0] > 0 && device[1] > 0);
    const [w, h] = drawingSize(cssW, cssH, window.devicePixelRatio || 1, { device, exact, maxDim: this.maxDim });
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.size = [w, h];
    // the scene into the 480p look's 640 x 480 frame buffer (look480.ts), else into one of the game's shape at
    // the canvas's scale, stretched over the canvas at the end as Dolphin shows it (picture.ts)
    if (!this.look) (this.pic ??= new GamePicture(gl, this.picOpts)).resize(w, h);
    this.viewH = this.look ? LOOK_H : this.pic!.h;
    this.bindPicture();
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.ghostRef = 0;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    this.proj.set(proj);
    this.view.set(view);
    this.gxFrame = gxProj ? (this.gxFrameBuf.set(gxProj), this.gxFrameBuf) : null;
    this.frameNearFar = nearFar;
    mul(this.viewProj, this.proj, this.view);
    this.camera(this.viewProj, this.view, this.proj);
    this.setCull(this.viewProj);
    this.culled = 0;
    this.bbFrame = billboardViewOf(this.view);
    invert(tmpM, view);
    this.eye = [tmpM[12], tmpM[13], tmpM[14]];
    gl.useProgram(this.prog);
    this.frameUniforms(this.loc);
    this.draws = 0;
    this.dirty();
    this.uboBound = null;
    this.setTint(null);
    this.setFog(null);
  }

  /** what every draw of a frame shares, into a program */
  private frameUniforms(l: Record<string, WebGLUniformLocation | null>) {
    const gl = this.gl;
    gl.uniformMatrix4fv(l.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(l.uView, false, this.view);
    gl.uniformMatrix4fv(l.uProj, false, this.proj);
    gl.uniform3f(l.uEye, this.eye[0], this.eye[1], this.eye[2]);
    gl.uniform4f(l.uTint, 0, 0, 0, 0);
    gl.uniform4f(l.uFlat, 0, 0, 0, 0);
    gl.uniform4f(l.uOutline, 0, 0, 0, 0);
    gl.uniform1f(l.uFlash, 0);
    gl.uniform1f(l.uInflate, 0);
    gl.uniform4f(l.uCast, 0, 0, 0, 0);
    gl.uniform1i(l.uShadowN, 0);
    gl.uniform1i(l.uShadowMask, 15);
    this.shadowMask = 15;
  }

  /** where the frame's scene is drawn: the 480p look's frame buffer, or the game's picture's */
  private bindPicture() {
    const gl = this.gl;
    if (this.look) this.look.bind();
    else if (this.pic) this.pic.bind();
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.size[0], this.size[1]); }
  }
  /** the picture as the game's frame buffer has it, stretched over the canvas as Dolphin shows it
   *  (picture.ts); made on the first frame */
  private pic: GamePicture | null = null;
  // (no anti-aliasing, as the game's frame buffer: its edges are the game's)
  private picOpts: PictureOptions = { samples: 0 };
  /** the game's picture made again with other options, from the next frame (trials: __viewer3d.setPicture) */
  setPicture(opts: Partial<PictureOptions>) {
    this.picOpts = { ...this.picOpts, ...opts };
    this.pic?.dispose();
    this.pic = null;
  }

  /** the 480p look (look480.ts), from the next frame on */
  private look: Look480 | null = null;
  setLook480(on: boolean) {
    if (on === !!this.look) return;
    if (on) { this.look = new Look480(this.gl); this.look.setCrt(this.tv()); }
    else { this.look!.dispose(); this.look = null; }
  }
  /** the TV the 480p look is shown on (crt.ts) and its curve (the player's
   *  slider: 0 flat), from the next frame on */
  private crt: CrtPreset = "off";
  private curve = 0;
  setCrt(p: CrtPreset, curve = 0) {
    if (p === this.crt && curve === this.curve) return;
    this.crt = p;
    this.curve = curve;
    this.look?.setCrt(this.tv());
  }
  private tv() { return this.crt === "off" ? null : { ...CRT_LOOKS[this.crt], curve: this.curve }; }
  /** the CRT pass alone at w x h pixels, ms a frame (null: no TV on) */
  benchCrt(w: number, h: number, n?: number): number | null {
    const ms = this.look?.benchCrt(w, h, n) ?? null;
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
    return ms;
  }
  /** the checks: the CRT pass on a made-up picture of its own at w x h,
   *  with a TV and a curve (crt.ts crtPixels) */
  crtPixels(p: Exclude<CrtPreset, "off">, curve: number, w: number, h: number): Uint8Array {
    const px = crtPixels(this.gl, { ...CRT_LOOKS[p], curve }, w, h);
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
    return px;
  }
  /** the 480p look's copy and stretch on the graphics card, ms (null: off or not known) */
  get lookGpuMs(): number | null { return this.look?.gpuMs ?? null; }
  /** how many pixels tall the scene is drawn: the 480p look's 480, else the game's picture's */
  get pictureHeight(): number { return this.look ? 480 : this.pic?.h ?? this.canvas.height; }

  /** the end of a frame: the picture onto the canvas (the 480p look's copy, or the game's picture's stretch) */
  finish() {
    if (this.look) this.look.present(this.canvas.width, this.canvas.height);
    else if (this.pic) this.pic.present(this.canvas.width, this.canvas.height);
    else return;
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
  }

  /** a fighter's color animation for the draws that follow, or null for none */
  setTint(t: ColTint | null) {
    const gl = this.gl, l = this.loc;
    if (!t) {
      if (!this.tinted) return;
      this.tinted = false;
      gl.uniform4f(l.uOverColor, 0, 0, 0, 0);
      gl.uniform1i(l.uOverMode, 0);
      return;
    }
    this.tinted = true;
    const c = t.color;
    gl.uniform4f(l.uOverColor, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c?.[3] ?? 0);
    const li = t.light;
    gl.uniform1i(l.uOverMode, li ? (li.adds ? 1 : 2) : 0);
    if (li) {
      gl.uniform4f(l.uOverLight, li.rgb[0], li.rgb[1], li.rgb[2], li.a);
      gl.uniform3f(l.uOverDir, li.dir[0], li.dir[1], li.dir[2]);
      const od = this.overDir;
      if (!od || od[0] !== li.dir[0] || od[1] !== li.dir[1] || od[2] !== li.dir[2]) {
        this.overDir = [li.dir[0], li.dir[1], li.dir[2]];
        this.overVer++;
      }
    }
  }
  private tinted = true;

  /** the lights the draws that follow are lit by */
  setLighting(l: Lighting) {
    this.lighting = l;
    this.uploadLighting(this.current, this.loc);
  }
  /** the model program in use (the main one, or the shield's for a moment) */
  private current!: WebGLProgram;

  private uploadLighting(p: WebGLProgram, loc: Record<string, WebGLUniformLocation | null>) {
    const l = this.lighting;
    if (!l || this.litVersion.get(p) === l.version) return;
    const gl = this.gl;
    this.litVersion.set(p, l.version);
    gl.uniform3fv(loc.uAmbLight, l.ambient);
    gl.uniform1f(loc.uAmbA, l.ambientAlpha ?? -1);
    gl.uniform1i(loc.uNumLights, l.n);
    gl.uniform4fv(loc.uLPos, l.pos);
    gl.uniform4fv(loc.uLAxis, l.axis);
    gl.uniform4fv(loc.uLCol, l.color);
    gl.uniform4fv(loc.uLA, l.attnA);
    gl.uniform4fv(loc.uLK, l.attnK);
  }

  /** the fog the draws that follow are in (null: none, as the game's effects are): packed as GXSetFog packs it
   *  (fog.ts), with the near and far of the camera drawn through now (HSD_FogSet: HSD_CObjGetNear, GetFar) unless
   *  they are given */
  setFog(f: Fog | null, near?: number, far?: number) {
    const gl = this.gl, l = this.loc;
    let r = NO_FOG;
    if (f) {
      // (the camera's own near and far, as its CObj has them, when the frame's camera is the game's; else
      // taken back from the projection)
      const [n, fa] = near !== undefined && far !== undefined ? [near, far]
        : this.frameNearFar && this.camProj === this.proj ? this.frameNearFar : nearFar(this.camProj);
      r = gxSetFog(f.type, f.start, f.end, n, fa, [0, 1, 2].map((i) => Math.round(Math.min(Math.max(f.color[i], 0), 1) * 255)) as
        [number, number, number]);
    }
    this.fogRegs = r;
    gl.uniform4i(l.uFogI, r.fsel, r.bMag, r.bShift, r.proj);
    gl.uniform2f(l.uFogF, r.a, r.c);
    gl.uniform3i(l.uFogColor, r.color[0], r.color[1], r.color[2]);
  }
  /** the frame camera's near and far planes, when it is the game's */
  private frameNearFar: [number, number] | null = null;
  /** the fog's registers as last packed and uploaded */
  private fogRegs: FogRegs = NO_FOG;

  /** a debug aid (?debug=flat): what is drawn next in one flat color, over
   *  every pixel the material lets through, or back to its own (null) */
  // ---- the fighters' shadows (shadow.ts)
  /** a fighter's shadow picture: one target per fighter, made once */
  shadowTarget(i: number): RenderTarget {
    let t = this.shadowTargets[i];
    if (!t) {
      const gl = this.gl;
      t = this.shadowTargets[i] = this.target(SHADOW_SIZE, SHADOW_SIZE);
      // (the game's shadow texture: clamped, magnified nearest, minified linear)
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.bound.fill(null);
    }
    return t;
  }
  private shadowTargets: RenderTarget[] = [];
  /** draws from here on make a shadow: into `t`, cleared white, through the
   *  shadow camera, every pixel the stage's shadow intensity (0..255) as the
   *  copy keeps it (shadowGray), two pixels in from each edge
   *  (HSD_ShadowStartRender); endShadow() puts the frame back */
  beginShadow(t: RenderTarget, proj: Mat, view: Mat, intensity: number) {
    const gl = this.gl;
    this.overlay(proj, view, t, [1, 1, 1, 1]);
    this.casting = true;
    const gray = shadowGray(intensity);
    gl.uniform4f(this.loc.uCast, gray, gray, gray, 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(2, 2, t.w - 4, t.h - 4);
  }
  endShadow() {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.uniform4f(this.loc.uCast, 0, 0, 0, 0);
    this.casting = false;
    this.endOverlay();
  }
  /** a shadow being made (material() sets its pixel engine) */
  private casting = false;
  /** the shadows the materials that take them get from now on: each a
   *  picture and its world-to-(s, t) matrix, the last made first, as
   *  HSD_MObjAddShadowTexture puts each new one at the head of its list */
  setShadows(list: { tex: WebGLTexture; mtx: Mat; y?: number; laid?: boolean }[]) {
    const gl = this.gl;
    const n = Math.min(MAX_SHADOWS, list.length);
    for (let k = 0; k < n; k++) {
      gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT + k);
      gl.bindTexture(gl.TEXTURE_2D, list[k].tex);
      this.shadowM.set(list[k].mtx, k * 16);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.unit = 0;
    if (n) gl.uniformMatrix4fv(this.loc.uShadowM, false, this.shadowM.subarray(0, n * 16));
    gl.uniform1i(this.loc.uShadowN, n);
    this.shadowMaps = list.slice(0, n).map((x) => ({ mtx: x.mtx }));
    this.shadowLaid = 0;
    for (let k = 0; k < n; k++) {
      this.shadowY[k] = list[k].y ?? Infinity;
      if (list[k].laid !== false) this.shadowLaid |= 1 << k;
    }
  }
  /** the shadows laid on anything (bit k for shadow k): one made but not laid is a fighter's that
   *  lbShadow_8000EEE0 leaves inactive (ftLib_800872BC: the Ice Climbers' Nana), its texture out of the list */
  private shadowLaid = 15;
  /** each shadow's fighter's height (its position's y), for the stage's shadow check */
  private shadowY = new Float64Array(MAX_SHADOWS);
  /** the shadows the draw being made takes: bit k for shadow k (the draw log reads it) */
  shadowMask = 15;
  /** a joint of a part whose stage checks each shadow (grDisplay_801C5B90: a
   *  part flagged x10_flags.b5 asks the stage's on_check_shadow_render per
   *  joint and fighter) takes the shadows of the fighters whose height plus
   *  the stage's margin is above the joint's place (lb_8000B1CC's
   *  translation); any other joint takes them all */
  private setShadowMask(d: Drawable, sk: Skeleton | null) {
    let mask = this.shadowLaid;
    const bias = sk?.shadowBias;
    if (bias !== null && bias !== undefined && d.state.mobj.renderMode & RENDER.SHADOW) {
      const jy = sk!.world[d.jobj.index * 16 + 13];
      mask = 0;
      for (let k = 0; k < this.shadowMaps.length; k++) if (this.shadowY[k] + bias > jy) mask |= 1 << k;
      mask &= this.shadowLaid;
    }
    if (mask !== this.shadowMask) {
      this.gl.uniform1i(this.loc.uShadowMask, mask);
      this.shadowMask = mask;
    }
  }
  private shadowM = new Float32Array(16 * MAX_SHADOWS);
  /** the shadows set now (the draw log reads them) */
  shadowMaps: { mtx: Mat }[] = [];

  setFlat(c: [number, number, number] | null) {
    this.gl.uniform4f(this.loc.uFlat, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c ? 1 : 0);
  }

  /** what is drawn next as an outline (Mr. Game & Watch's, his props'): its
   *  own lit color taken toward the outline's by the outline's alpha, as the
   *  game's TEV stage does (ftmaterial.c, itmaterial.c: the color register
   *  and its alpha as the ratio), or back to its own (null) */
  setOutline(c: [number, number, number, number] | null) {
    this.gl.uniform4f(this.loc.uOutline, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c ? Math.max(c[3], 1e-3) : 0);
  }

  /** what is drawn next writes no depth (an outline drawn behind its body) */
  setNoDepthWrite(on: boolean) { this.noDepthWrite = on; }
  private noDepthWrite = false;
  /** what is drawn next writes depth only: no color, no blend, compared less-or-equal (an outline's second draw) */
  setDepthOnly(on: boolean) { this.depthOnly = on; }
  private depthOnly = false;

  /** A skeleton's meshes of the game's passes in `trsp` (HSD_TRSP_OPA 1, XLU 2, TEXEDGE 4), each mesh's pass as
   *  DObjLoad gives it from its material: neither of render mode bits 29 and 30 the opaque one, bit 30 alone
   *  the cut-out one (TEXEDGE), both the see-through one. For what the game draws by its joints' passes
   *  where the player's two do not split them as it does */
  drawSkeletonTrsp(sk: Skeleton, trsp: number) {
    for (const d of sk.drawables) {
      const rm = d.state.mobj.renderMode & 0x60000000;
      const of = rm === 0 ? 1 : rm === 0x40000000 ? 4 : 2;
      if (!(of & trsp) || !sk.isVisible(d) || this.outOfView(d)) continue;
      this.drawOne(d, null, sk);
    }
  }

  /** one pass over a skeleton: its opaque parts, or its see-through ones;
   *  flash (0..1) turns it toward white (an L-cancel) */
  drawSkeleton(sk: Skeleton, pass: "opa" | "xlu", flash = 0) {
    if (flash > 0) this.gl.uniform1f(this.loc.uFlash, flash);
    for (const d of sk.drawables) {
      if (d.translucent !== (pass === "xlu") || !sk.isVisible(d) || this.outOfView(d)) continue;
      this.drawOne(d, null, sk);
    }
    if (flash > 0) this.gl.uniform1f(this.loc.uFlash, 0);
  }

  // ---- what the camera cannot see is not sent at all (no GL calls for it).
  // A mesh's bounding sphere under each of the matrices its vertices pick
  // from (a vertex takes exactly one: the shader's uMats[aMtx]): wholly
  // outside one plane of the camera's frustum under all of them, none of
  // its triangles can reach the picture.
  /** the camera draws are culled against (null: none) and its six planes */
  private cullVP: Mat | null = null;
  private planes = new Float32Array(24);
  /** off with ?nocull (to compare) */
  private cullOn = typeof location === "undefined" || !new URLSearchParams(location.search).has("nocull");
  /** drawables skipped this frame as out of view (the checks read it) */
  culled = 0;

  /** cull against this camera from now on (null: draw everything) */
  private setCull(vp: Mat | null) {
    this.cullVP = this.cullOn ? vp : null;
    if (!this.cullVP) return;
    const m = vp!, P = this.planes;
    for (let i = 0; i < 3; i++) {
      for (const s of [1, -1]) {
        const o = (i * 2 + (s > 0 ? 0 : 1)) * 4;
        const a = m[3] + s * m[i], b = m[7] + s * m[4 + i], c = m[11] + s * m[8 + i], w = m[15] + s * m[12 + i];
        const l = Math.hypot(a, b, c) || 1;
        P[o] = a / l; P[o + 1] = b / l; P[o + 2] = c / l; P[o + 3] = w / l;
      }
    }
  }

  private sphereOf(d: Drawable): Float32Array {
    // (kept on the drawable: a lookup per draw would cost as much as the test)
    let s = d.sphere;
    if (s) return s;
    const p = d.mesh.pos;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r = 0;
    for (let i = 0; i + 2 < p.length; i += 3) r = Math.max(r, Math.hypot(p[i] - cx, p[i + 1] - cy, p[i + 2] - cz));
    s = Float32Array.of(cx, cy, cz, p.length ? r * 1.01 + 1 : -1);
    d.sphere = s;
    return s;
  }

  /** whether nothing of a drawable can reach the picture */
  private outOfView(d: Drawable): boolean {
    // (a skinned mesh too - a fighter: its vertices each take one of its
    // matrices, so it is out when its sphere is under every one of them; the
    // test costs less than the draw, and the mirror's camera sees few of them)
    if (!this.cullVP) return false;
    const s = this.sphereOf(d);
    if (s[3] < 0) return false;
    const P = this.planes, M = d.mats, n = Math.max(1, Math.min(d.filled, d.nMats)), W = this.worldSph;
    for (let k = 0; k < n; k++) {
      const o = k * 16, w = k * 4;
      W[w] = M[o] * s[0] + M[o + 4] * s[1] + M[o + 8] * s[2] + M[o + 12];
      W[w + 1] = M[o + 1] * s[0] + M[o + 5] * s[1] + M[o + 9] * s[2] + M[o + 13];
      W[w + 2] = M[o + 2] * s[0] + M[o + 6] * s[1] + M[o + 10] * s[2] + M[o + 14];
      W[w + 3] = s[3] * Math.sqrt(Math.max(M[o] * M[o] + M[o + 1] * M[o + 1] + M[o + 2] * M[o + 2],
                                           M[o + 4] * M[o + 4] + M[o + 5] * M[o + 5] + M[o + 6] * M[o + 6],
                                           M[o + 8] * M[o + 8] + M[o + 9] * M[o + 9] + M[o + 10] * M[o + 10]));
    }
    // (a matrix that is not all numbers is drawn as GX would draw it: never culled - the plane tests are false for NaN)
    for (let k = 0; k < n * 4; k++) if (!Number.isFinite(W[k])) return false;
    for (let q = 0; q < 24; q += 4) {
      let out = true;
      for (let k = 0; k < n && out; k++) {
        const w = k * 4;
        if (P[q] * W[w] + P[q + 1] * W[w + 1] + P[q + 2] * W[w + 2] + P[q + 3] > -W[w + 3]) out = false;
      }
      if (out) { this.culled++; return true; }
    }
    return false;
  }
  private worldSph = new Float32Array(40);
  /** whether a drawable can reach the picture through the camera culled
   *  against now (not counted as culled) */
  inView(d: Drawable): boolean {
    const c = this.culled, out = this.outOfView(d);
    this.culled = c;
    return !out;
  }


  private ghostRef = 0;

  /** A ghost: the model once into the depth and stencil buffers, then its
   * nearest surface once in the ghost's color, so it reads as one
   * see-through shape rather than a stack of overlapping parts. The stencil
   * keeps it to the pixels where it is in front: where it stands exactly
   * where the real fighter does (every run shares the game up to the moment),
   * the real game reads on top, as in the line-art player. */
  drawGhost(sk: Skeleton, tint: Tint, outline = 0) {
    const gl = this.gl;
    const ref = (this.ghostRef = (this.ghostRef % 255) + 1);
    this.dirty();
    if (ref === 1 && this.draws > 0) { gl.stencilMask(0xff); gl.clear(gl.STENCIL_BUFFER_BIT); }
    this.plainMaterial();
    gl.disable(gl.BLEND);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, ref, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    for (const d of sk.drawables) if (sk.isVisible(d) && !d.translucent) this.drawGeometry(d);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, ref, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);
    gl.uniform4f(this.loc.uTint, tint.color[0], tint.color[1], tint.color[2], tint.alpha);
    for (const d of sk.drawables) if (sk.isVisible(d) && !d.translucent) this.drawOne(d, tint, sk);
    gl.uniform4f(this.loc.uTint, 0, 0, 0, 0);
    if (outline > 0) {
      // A dark edge just outside the silhouette, so a ghost stands off a light
      // stage as well as a dark one whatever its color (its white rim does
      // the rest): the model pushed out along its normals, drawn only where
      // the ghost itself is not, behind whatever the stage has in front.
      this.plainMaterial();
      gl.stencilFunc(gl.NOTEQUAL, ref, 0xff);
      gl.depthFunc(gl.LEQUAL);
      gl.uniform1f(this.loc.uInflate, outline);
      gl.uniform4f(this.loc.uFlat, 0.06, 0.07, 0.1, 0.85);
      gl.disable(gl.CULL_FACE);
      for (const d of sk.drawables) {
        if (!sk.isVisible(d) || d.translucent) continue;
        const m = this.upload(d);
        this.mats(d);
        this.bindVao(m.vao);
        gl.drawElements(m.mode, m.count, m.type, m.offset);
        this.draws++;
      }
      gl.uniform1f(this.loc.uInflate, 0);
      gl.uniform4f(this.loc.uFlat, 0, 0, 0, 0);
    }
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    this.dirty();
  }

  /** an opaque, untextured, never-discarded material: for depth-only passes */
  private plainMaterial() {
    const F = this.matF, I = this.matI;
    F.fill(0); I.fill(0);
    F[0] = F[1] = F[2] = F[3] = F[22] = 1;
    I[4] = I[5] = I[6] = I[7] = -1;
    I[3] = 7 | (7 << 3);
    I[0] = putTev(I, PLAIN_TEV);
    this.uploadMaterial();
  }

  /** a drawable's matrices, when they are not the ones already there */
  private mats(d: Drawable) {
    if (d === this.lastMatsD && d.stamp === this.lastMatsStamp && this.viewVer === this.lastMatsView) return;
    // (the same matrices as the draw before - two meshes on one joint - are
    // not sent again)
    const n = d.nMats * 16, L = this.lastMats, M = d.mats;
    let same = this.lastMatsD !== null && n === this.lastMatsN && n <= L.length && this.viewVer === this.lastMatsView;
    for (let k = 0; same && k < n; k++) if (M[k] !== L[k]) same = false;
    this.lastMatsD = d;
    this.lastMatsStamp = d.stamp;
    if (same) return;
    // only the ones it has: a vertex picks among its own (a rigid part's all
    // pick the first)
    this.uploadMats(M, d.nMats, d);
    if (n <= L.length) L.set(M.subarray(0, n));
  }
  /** model matrices (world) and their modelviews under the camera drawn through now, into the shader: each
   *  PSMTXConcat(vmtx, model) in float32, as HSD_JObjDisp and SetupEnvelopeModelMtx make what GX is loaded with */
  private uploadMats(M: Float32Array, count: number, d: Drawable | null = null) {
    const n = count * 16, V = this.shifted ? this.shiftView : this.camView, MV = this.mvBuf;
    // (a billboard drawn through the view it was made under: its modelview as the game made it - every slot but a
    // shared-vertex skin's second joint's; the frame's camera or another's, the mirror's)
    let bb = d && d.bbMV && !this.shifted && d.bbMVView === (this.camView === this.view ? this.bbFrame : billboardViewOf(this.camView))
      ? d.bbMV : null;
    // (one drawn through another camera it was not posed under - a mirror's, a shadow's - made again under that
    // camera's view, as HSD_JObjMakePositionMtx makes it with the vmtx of the camera drawing)
    if (!bb && d && d.bbMV && d.bbW && d.bbKind && !this.shifted) {
      const V12 = mtxFromGL(V, this.bbV12, 0), W12 = mtxFromGL(d.bbW, this.bbW12, 0);
      PSMTXConcat(V12, W12, W12);
      mkBillBoardMtx(d.bbKind, d.bbPersp ?? false, d.bbRotZ ?? 0, W12, this.bbP12);
      bb = mtxToGL(this.bbP12, this.bbMVAgain);
    }
    const N = this.nrmBuf, T = this.nrmTmp;
    for (let k = 0; k < count; k++) {
      if (bb && !(k === 1 && d!.second >= 0)) MV.set(bb, k * 16);
      else concatGL(MV, k * 16, V, 0, M, k * 16);
      // (and its normal matrix: HSD_MtxInverseTranspose of the modelview, as SetupRigidModelMtx loads it)
      mtxToGL3(HSD_MtxInverseTranspose(mtxFromGL(MV, T, k * 16), T), N, k * 9);
    }
    this.gl.uniformMatrix4fv(this.loc.uMats, false, M, 0, n);
    this.gl.uniformMatrix4fv(this.loc.uMV, false, MV, 0, n);
    this.gl.uniformMatrix3fv(this.loc.uNrm, false, N, 0, count * 9);
    this.lastMatsN = n;
    this.lastMatsView = this.viewVer;
  }
  private bbV12 = new Float32Array(12);
  private bbW12 = new Float32Array(12);
  private bbP12 = new Float32Array(12);
  private bbMVAgain = new Float32Array(16);
  private lastMats = new Float32Array(32);
  private lastMatsN = 0;
  private lastMatsView = -1;
  /** the billboard view (skeleton.ts) when it is the frame's view, else -1 */
  private bbFrame = -1;
  /** the modelviews last uploaded (uMV), the drawable's own: view times each of its matrices */
  private mvBuf = new Float32Array(160);
  /** and their normal matrices (uNrm: 3 x 3s, column major) */
  private nrmBuf = new Float32Array(90);
  private nrmTmp = new Float32Array(12);

  // ---- the lights as GX is loaded with them for the view drawn through now (gxlights.ts), made again when the
  // lighting, the view or the color animation's light changes; and each specular joint's half-way directions
  /** what the uploaded view lights were made from: lighting version, view version, color animation light version */
  private lightVKey = [-1, -1, -1];
  private overVer = 0;
  private overDir: number[] | null = null;
  /** the view-space lights as uploaded (the draw log reads them) */
  private lightV: ViewLights = newViewLights();
  private lightMtx = new Float32Array(12);
  private specDirs = new Float32Array(32);
  private specKey = [NaN, NaN, NaN, -1];
  private specPos = [0, 0, 0];
  private viewLights() {
    const l = this.lighting, K = this.lightVKey;
    if (!l || (K[0] === l.version && K[1] === this.viewVer && K[2] === this.overVer)) return;
    K[0] = l.version; K[1] = this.viewVer; K[2] = this.overVer;
    // (by the camera as it is, a shake or not: the game sets the lights up from the current camera
    // (ftCo_8009F5AC's HSD_LObjSetupInit) and only the meshes' modelview takes the shake (ftDrawCommon_8008051C))
    const V = mtxFromGL(this.camView, this.lightMtx, 0);
    const v = lightsInView(l, V, this.overDir, this.lightV);
    const gl = this.gl, loc = this.loc;
    gl.uniform4fv(loc.uLPosV, v.pos);
    gl.uniform4fv(loc.uLAxisV, v.axis);
    gl.uniform3f(loc.uOverPosV, v.over[0], v.over[1], v.over[2]);
    this.specKey[3] = -1;
  }
  /** the specular lights' half-way directions for a joint at (x, y, z) in the world */
  private specularAt(x: number, y: number, z: number) {
    const l = this.lighting, S = this.specKey;
    if (!l || (S[0] === x && S[1] === y && S[2] === z && S[3] === 1)) return;
    S[0] = x; S[1] = y; S[2] = z; S[3] = 1;
    jointInView(this.lightMtx, x, y, z, this.specPos);
    this.gl.uniform4fv(this.loc.uLSpecV, specularDirs(l, this.lightV, this.specPos, this.specDirs));
  }

  private drawGeometry(d: Drawable) {
    const gl = this.gl;
    const m = this.upload(d);
    this.mats(d);
    this.cull(d);
    this.bindVao(m.vao);
    gl.drawElements(m.mode, m.count, m.type, m.offset);
    this.draws++;
  }

  private cull(d: Drawable) {
    const gl = this.gl;
    const cull = d.pobj.flags & 0xc000;
    if (this.cs.cull === cull) return;
    // GX winds front faces clockwise
    if (this.cs.cull === -1) gl.frontFace(this.mirrored ? gl.CCW : gl.CW);
    if (cull === 0) gl.disable(gl.CULL_FACE);
    else {
      if (this.cs.cull <= 0) gl.enable(gl.CULL_FACE);
      gl.cullFace(cull === 0x8000 ? gl.BACK : cull === 0x4000 ? gl.FRONT : gl.FRONT_AND_BACK);
    }
    this.cs.cull = cull;
  }

  // The GL state the model draws last set, so a draw sets only what differs
  // (-1: not known - something else set it directly). A frame makes several
  // hundred draws; most share their state with the one before.
  private cs = { cull: -1, blend: -1, src: -1, dst: -1, eq: -1, dmask: -1, dfunc: -1, cmask: -1 };
  // the texture unit last made active (not known: -1)
  private unit = -1;
  private dirty() {
    const c = this.cs;
    c.cull = c.blend = c.src = c.dst = c.eq = c.dmask = c.dfunc = c.cmask = -1;
    this.unit = -1;
    this.specKey[3] = -1;
    this.lastMatsD = null;
    this.vaoBound = undefined;
  }
  private setBlend(on: boolean, src = 0, dst = 0, eq = 0) {
    const gl = this.gl, c = this.cs;
    if (!on) { if (c.blend !== 0) { gl.disable(gl.BLEND); c.blend = 0; } return; }
    if (c.blend !== 1) { gl.enable(gl.BLEND); c.blend = 1; }
    if (c.eq !== eq) { gl.blendEquation(eq); c.eq = eq; }
    if (c.src !== src || c.dst !== dst) { gl.blendFunc(src, dst); c.src = src; c.dst = dst; }
  }
  private setDepth(mask: boolean, func: number) {
    const gl = this.gl, c = this.cs;
    const m = mask ? 1 : 0;
    if (c.dmask !== m) { gl.depthMask(mask); c.dmask = m; }
    if (c.dfunc !== func) { gl.depthFunc(func); c.dfunc = func; }
  }
  private setColorWrite(on: boolean) {
    const c = this.cs, v = on ? 1 : 0;
    if (c.cmask === v) return;
    this.gl.colorMask(on, on, on, on);
    c.cmask = v;
  }
  /** a material that is no material's own (matF, matI: a ghost, a depth
   *  pass, a plain sphere), into the scratch block and bound */
  private uploadMaterial() {
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.scratchUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.matBytes);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.scratchUbo);
    this.uboBound = this.scratchUbo;
  }
  private scratchUbo: WebGLBuffer;
  /** every material's block, to let go of with the renderer */
  private ubos: WebGLBuffer[] = [];
  /** the material block bound now (null: not known) */
  private uboBound: WebGLBuffer | null = null;
  private bindUbo(b: WebGLBuffer) {
    if (this.uboBound === b) return;
    this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, 0, b);
    this.uboBound = b;
  }
  // the matrices last uploaded: which drawable, as of which pose
  private lastMatsD: Drawable | null = null;
  private lastMatsStamp = -1;

  private drawOne(d: Drawable, tint: Tint | null, sk: Skeleton | null) {
    const gl = this.gl;
    if ((d.pobj.flags & 0xc000) === 0xc000) return;
    const m = this.upload(d);
    this.mats(d);
    if (!this.material(d, d.state, tint !== null, sk)) return;
    if (this.shadowMaps.length) this.setShadowMask(d, sk);
    this.cull(d);
    // (points as wide as the model says, in the game's 480 lines: GX_SetPointSize)
    if (m.mode === gl.POINTS) gl.uniform1f(this.loc.uPointSize, (sk?.pointSize ?? 1) * this.viewH / 480);
    this.bindVao(m.vao);
    gl.drawElements(m.mode, m.count, m.type, m.offset);
    this.draws++;
  }

  // each texture's GL texture and matrix, looked up again only when its
  // animation changes its image or moves it
  private texCache = new WeakMap<TexState, TexCache>();
  private texState(a: Archive, t: TexState): TexCache {
    // (kept on the texture's state: a map lookup per texture per draw adds up)
    let c = t.gl?.owner === this ? t.gl.cache as TexCache : undefined;
    if (!c) t.gl = { owner: this, cache: (c = { image: null, tlut: null, tex: this.white, tu: NaN, tv: 0, su: 0, sv: 0, r: 0, rx: 0, ry: 0,
                                        m: new Float32Array(12), epoch: -1, ver: 0 }) };
    if (c.image !== t.image || c.tlut !== t.tlut || c.epoch !== this.imageEpoch) {
      try { c.tex = this.texture(a, t.image, t.tlut, t.tobj); } catch { c.tex = this.white; }
      c.image = t.image; c.tlut = t.tlut; c.epoch = this.imageEpoch;
    }
    if (c.tu !== t.translate[0] || c.tv !== t.translate[1] || c.su !== t.scale[0] || c.sv !== t.scale[1] || c.r !== t.rotate ||
        c.rx !== t.rotX || c.ry !== t.rotY) {
      const o = t.tobj;
      c.m.set(textureMatrix([t.translate[0], t.translate[1], o.translate[2]], [t.scale[0], t.scale[1], o.scale[2]],
                            [t.rotX, t.rotY, t.rotate], o.repeatS, o.repeatT, o.wrapT));
      c.tu = t.translate[0]; c.tv = t.translate[1]; c.su = t.scale[0]; c.sv = t.scale[1]; c.r = t.rotate;
      c.rx = t.rotX; c.ry = t.rotY;
      c.ver++;
    }
    return c;
  }

  // A stage's mirror image (Fountain of Dreams' pond, grizumi.c): an 80 x 60
  // picture, cleared white, of what is drawn between beginMirror and
  // endMirror, seen by the camera put upside down below the floor (its eye
  // and its aim with their heights negated); the pond's texture takes it
  // where each point falls in that picture.
  private mirror: { fb: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer } | null = null;
  private mirrorCache: TexCache = { image: null, tlut: null, tex: null as unknown as WebGLTexture, tu: 0, tv: 0, su: 0, sv: 0, r: 0,
                                    rx: 0, ry: 0, m: new Float32Array(12), epoch: 0, ver: 0 };
  private mirrorDrawn = false;
  private size = [1, 1];
  // the most either side of the canvas can be (the card's MAX_VIEWPORT_DIMS; 0 until it is asked)
  private maxDim = 0;
  /** the picture's height in pixels, drawn to now (points are sized by it) */
  private viewH = 1;
  private mirrorState(): TexCache {
    this.mirrorCache.tex = this.mirror && this.mirrorDrawn ? this.mirror.tex : this.white;
    return this.mirrorCache;
  }
  /** returns the mirror camera's right and up (world directions: what faces it), its view and its projection */
  beginMirror(): { right: number[]; up: number[]; view: Mat; viewProj: Mat } {
    const gl = this.gl;
    if (!this.mirror) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MIRROR_W, MIRROR_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, MIRROR_W, MIRROR_H);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
      this.mirror = { fb, tex, depth };
      this.bound.fill(null);
    }
    // the mirror camera: the eye and the point it looks at, heights negated
    const v = this.view;
    invert(tmpM, v);
    const eye = [tmpM[12], -tmpM[13], tmpM[14]];
    const at = [tmpM[12] - v[2] * 100, -(tmpM[13] - v[6] * 100), tmpM[14] - v[10] * 100];
    lookAt(this.mirrorView, eye, at);
    mul(this.mirrorViewProj, this.proj, this.mirrorView);
    // world -> the picture: s = 0.5 + 0.49 x, t = 0.5 + 0.49 y (the game's
    // light-perspective matrix; GL's pictures run bottom up), over w
    const m = this.mirrorViewProj, M = this.mirrorCache.m;
    this.mirrorCache.ver++;
    for (let c = 0; c < 4; c++) {
      M[c] = 0.49 * m[c * 4] + 0.5 * m[c * 4 + 3];
      M[4 + c] = 0.49 * m[c * 4 + 1] + 0.5 * m[c * 4 + 3];
      M[8 + c] = m[c * 4 + 3];
    }
    // (the picture may not be on a texture unit while it is drawn into)
    for (let n = 0; n < 4; n++) {
      if (this.bound[n] !== this.mirror.tex) continue;
      gl.activeTexture(gl.TEXTURE0 + n);
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      this.bound[n] = this.white;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mirror.fb);
    gl.viewport(0, 0, MIRROR_W, MIRROR_H);
    gl.clearColor(1, 1, 1, 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.mirrorViewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.mirrorView);
    this.camera(this.mirrorViewProj, this.mirrorView, this.proj);
    this.setCull(this.mirrorViewProj);
    // (particles and strips through it too)
    this.overlayVP = this.mirrorViewProj;
    this.dirty();
    const mv = this.mirrorView;
    // (and the mirror camera's view and projection: the particles it draws are sized and turned by its view, the
    // vmtx psDispSubAppSRT is handed when grIzumi_801CCEA0's camera draws them)
    return { right: [mv[0], mv[4], mv[8]], up: [mv[1], mv[5], mv[9]], view: this.mirrorView, viewProj: this.mirrorViewProj };
  }
  endMirror() {
    const gl = this.gl;
    this.overlayVP = null;
    this.bindPicture();
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.view);
    this.camera(this.viewProj, this.view, this.proj);
    this.setCull(this.viewProj);
    this.dirty();
    this.endPass();
    this.mirrorDrawn = true;
  }
  /** the mirror image as last drawn (RGBA rows from the bottom), its
   *  texture matrix, and the cameras (debugging) */
  mirrorDebug() {
    const gl = this.gl;
    if (!this.mirror) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mirror.fb);
    const px = new Uint8Array(MIRROR_W * MIRROR_H * 4);
    gl.readPixels(0, 0, MIRROR_W, MIRROR_H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.bindPicture();
    return { w: MIRROR_W, h: MIRROR_H, px: Array.from(px), tex: Array.from(this.mirrorCache.m), mirrorView: Array.from(this.mirrorView),
             mirrorViewProj: Array.from(this.mirrorViewProj), view: Array.from(this.view), proj: Array.from(this.proj) };
  }
  private mirrorView: Mat = new Float32Array(16);
  private mirrorViewProj: Mat = new Float32Array(16);

  /** the material's program, compiled on its first draw */
  /** a material whose render mode changed: its program and packed block made
   *  again on its next draw (HSD_MObjCompileTev) */
  forgetMaterial(s: MatState) {
    this.programs.delete(s);
    this.statics.delete(s);
    s.gl = undefined;
  }

  program(s: MatState): MatProgram {
    let p = this.programs.get(s);
    if (!p) {
      const skip = s.skip;
      const mirror = s.mirror;
      p = compileMaterial(s.mobj, s.tex.map((t) => t.tobj), skip ? (t) => skip.has(t) : undefined,
                          mirror ? (t) => mirror.has(t) : undefined);
      this.programs.set(s, p);
    }
    return p;
  }

  /** what a material sets that never changes: its program, packed (the
   *  uniform integers, the alpha test's references), its pixel engine; and
   *  its own uniform block, with a copy of what was last sent to it */
  private statics = new WeakMap<MatState, MatStatics>();
  private staticsOf(s: MatState): MatStatics {
    // (kept on the material's state: a map lookup per draw adds up)
    if (s.gl?.owner === this) return s.gl.cache as MatStatics;
    let c = this.statics.get(s);
    if (c) { s.gl = { owner: this, cache: c }; return c; }
    const gl = this.gl;
    const p = this.program(s);
    const bytes = new Uint8Array(MAT_BYTES);
    const F = new Float32Array(bytes.buffer, 0, MATF * 4), I = new Int32Array(bytes.buffer, MATF * 16, MATI * 4);
    I[4] = I[5] = I[6] = I[7] = -1;
    p.textures.forEach((ti, n) => {
      const t = s.tex[ti].tobj;
      I[4 + n] = p.texGen[n];
      F[16 + n] = t.lod ? t.lod.bias : 0;
    });
    // the TEV program, as texp.ts packs it, and the textures modulated after it (the stages' phase 3)
    const nTev = putTev(I, p.tev);
    if (nTev < p.tev.stages.length) console.warn(`a material's TEV has ${p.tev.stages.length} stages: ${MAX_TEV} run`);
    const late = p.stages.filter((q) => q.phase === 3).slice(0, 4);
    I[10] = late.length;
    I[11] = late.reduce((m, q, k) => m | ((q.tex & 3) << (k * 2)), 0);
    I[0] = nTev;
    I[1] = p.channel;
    I[2] = (p.vertexBase ? 1 : 0) | (p.lit ? 2 : 0) | (p.specular ? 4 : 0) | ((p.bump + 1) << 4) |
           (s.mobj.renderMode & RENDER.SHADOW ? 256 : 0) | (s.mobj.renderMode & RENDER.XLU ? 512 : 0);
    // the alpha test: the material's pixel engine's, else HSD's for its mode
    const mo = s.mobj, pe = mo.pe, mode = mo.renderMode;
    const at = pe ? [pe.alphaComp0, pe.ref0, pe.alphaOp, pe.alphaComp1, pe.ref1] : defaultAlphaTest(mode);
    I[3] = (at[0] & 7) | ((at[3] & 7) << 3) | ((at[2] & 3) << 6);
    F[7] = mo.shininess;
    F[20] = at[1]; F[21] = at[4];
    // the pixel engine, as HSD_SetupPEMode sets it
    let zOn = true, zFunc: number = mode & RENDER.ZMODE_ALWAYS ? gl.ALWAYS : gl.LEQUAL, zWrite = !(mode & RENDER.NO_ZUPDATE);
    let blend = mode & RENDER.XLU ? 1 : 0, src = 4, dst = 5, colorOn = true;
    if (pe) {
      zOn = (pe.flags & 0x10) !== 0;
      zFunc = ZF[pe.zComp] ?? gl.LEQUAL;
      zWrite = (pe.flags & 0x20) !== 0;
      blend = pe.type; src = pe.src; dst = pe.dst;
      colorOn = (pe.flags & 1) !== 0;
    }
    // (with the depth test off, GX writes no depth either)
    if (!zOn) { zFunc = gl.ALWAYS; zWrite = false; }
    c = { p, bytes, F, I, ubo: null, sent: false, tcs: [null, null, null, null], tcVers: [0, 0, 0, 0],
          colorOn, blend, srcF: blend === 1 ? srcFactor(gl, src) : 0, dstF: blend === 1 ? dstFactor(gl, dst) : 0, zWrite, zFunc };
    this.statics.set(s, c);
    s.gl = { owner: this, cache: c };
    return c;
  }

  /** a drawable's material into its uniform block and the pixel engine; false
   *  when it draws nothing */
  private material(d: Drawable, s: MatState, ghost: boolean, sk: Skeleton | null): boolean {
    const gl = this.gl;
    const c = this.staticsOf(s), p = c.p;
    const F = c.F;
    // what can change since the block was last sent, put in where it differs
    let ch = !c.sent;
    const dif = s.override ?? s.diffuse, amb = s.ambient, spc = s.specular;
    if (F[0] !== dif[0]) { F[0] = dif[0]; ch = true; }
    if (F[1] !== dif[1]) { F[1] = dif[1]; ch = true; }
    if (F[2] !== dif[2]) { F[2] = dif[2]; ch = true; }
    const al = Math.fround(s.alpha);
    if (F[3] !== al) { F[3] = al; ch = true; }
    // (the alpha as the TEV takes it: HSD_TExpSetReg's byte)
    const ab = Math.fround(tevScalar(s.alpha));
    if (F[22] !== ab) { F[22] = ab; ch = true; }
    if (F[4] !== amb[0]) { F[4] = amb[0]; ch = true; }
    if (F[5] !== amb[1]) { F[5] = amb[1]; ch = true; }
    if (F[6] !== amb[2]) { F[6] = amb[2]; ch = true; }
    if (F[8] !== spc[0]) { F[8] = spc[0]; ch = true; }
    if (F[9] !== spc[1]) { F[9] = spc[1]; ch = true; }
    if (F[10] !== spc[2]) { F[10] = spc[2]; ch = true; }
    const nt = p.textures.length;
    for (let n = 0; n < nt && n < 4; n++) {
      const t = s.tex[p.textures[n]];
      const tc = p.texGen[n] === 4 ? this.mirrorState() : this.texState(d.archive, t), tx = tc.tex;
      if (this.bound[n] !== tx) {
        if (this.unit !== n) { gl.activeTexture(gl.TEXTURE0 + n); this.unit = n; }
        gl.bindTexture(gl.TEXTURE_2D, tx);
        this.bound[n] = tx;
      }
      const bl = Math.fround(tevScalar(t.blending));
      if (F[12 + n] !== bl) { F[12 + n] = bl; ch = true; }
      if (c.tcs[n] !== tc || c.tcVers[n] !== tc.ver) {
        F.set(tc.m, 24 + n * 12);
        c.tcs[n] = tc; c.tcVers[n] = tc.ver;
        ch = true;
      }
      const tcol = t.tevColors;
      if (tcol) for (let k = 0, q = 72 + n * 12; k < 12; k++) if (F[q + k] !== tcol[k]) { F[q + k] = tcol[k]; ch = true; }
    }
    if (!c.ubo) {
      c.ubo = gl.createBuffer()!;
      this.ubos.push(c.ubo);
      gl.bindBuffer(gl.UNIFORM_BUFFER, c.ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, c.bytes, gl.DYNAMIC_DRAW);
      c.sent = true;
      ch = false;
    }
    if (ch) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, c.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, c.bytes);
      c.sent = true;
    }
    this.viewLights();
    if (p.specular && sk) {
      const j = d.jobj.index * 16, W = sk.world;
      this.specularAt(W[j + 12], W[j + 13], W[j + 14]);
    }
    if (ghost) {
      // a ghost keeps what is at least half there: the material's block, its alpha test changed, through the scratch one
      this.matBytes.set(c.bytes);
      this.matI[3] = 4 | (7 << 3);
      this.matF[20] = 127;
      this.uploadMaterial();
      return true;
    }
    this.bindUbo(c.ubo);
    // (a shadow being made: no blend, no depth, color only - HSD_ShadowStartRender's pixel engine)
    if (this.casting) { this.setColorWrite(true); this.setBlend(false); this.setDepth(false, gl.ALWAYS); return true; }
    this.setColorWrite(c.colorOn);
    if (c.blend === 1) this.setBlend(true, c.srcF, c.dstF, gl.FUNC_ADD);
    else if (c.blend === 3) this.setBlend(true, gl.ONE, gl.ONE, gl.FUNC_REVERSE_SUBTRACT);
    else this.setBlend(false);
    this.setDepth(c.zWrite && !this.noDepthWrite, c.zFunc);
    if (this.depthOnly) { this.setColorWrite(false); this.setBlend(false); this.setDepth(true, gl.LEQUAL); }
    return true;
  }

  /** after a pass that blended, put the defaults back */
  endPass() {
    const gl = this.gl;
    this.setBlend(false);
    if (this.cs.eq !== gl.FUNC_ADD) { gl.blendEquation(gl.FUNC_ADD); this.cs.eq = gl.FUNC_ADD; }
    this.setDepth(true, gl.LEQUAL);
    this.setColorWrite(true);
  }

  /** a see-through sphere (a shield bubble), in world units */
  drawSphere(center: number[], radius: number, color: [number, number, number], alpha: number) {
    const gl = this.gl;
    if (!this.sphere) this.sphere = this.makeSphere();
    const mats = new Float32Array(16);
    mats[0] = mats[5] = mats[10] = radius; mats[15] = 1;
    mats[12] = center[0]; mats[13] = center[1]; mats[14] = center[2];
    this.uploadMats(mats, 1);
    this.viewLights();
    const F = this.matF, I = this.matI;
    F.fill(0); I.fill(0);
    F[0] = color[0]; F[1] = color[1]; F[2] = color[2]; F[3] = alpha; F[22] = tevScalar(alpha);
    F[4] = F[5] = F[6] = 1;
    I[4] = I[5] = I[6] = I[7] = -1;
    I[1] = 2; I[2] = 2; I[3] = 7 | (7 << 3);
    I[0] = putTev(I, LIT_TEV);
    this.uploadMaterial();
    this.specKey[3] = -1;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.sphere.vao);
    gl.drawElements(gl.TRIANGLES, this.sphere.count, this.sphere.type, 0);
    this.draws++;
    this.dirty();
    this.lastMatsD = null;
    this.endPass();
  }

  /** a particle's texture: no mip levels, bilinear or nearest as the
   *  particle says (psdisp.c) */
  private spriteTexture(sprite: { key: string; w: number; h: number; rgba: Uint8Array }, near = false): WebGLTexture {
    const gl = this.gl;
    const key = near ? sprite.key + "|near" : sprite.key;
    let tex = this.spriteTex.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sprite.w, sprite.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, sprite.rgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
      this.spriteTex.set(key, tex);
      this.bound[0] = null;
    }
    return tex;
  }

  /** The game's particles: quads fx/draw.ts built (17 floats a vertex, four
   *  a quad), drawn batch by batch - each batch one texture and one blend. */
  drawParticles(data: Float32Array, batches: { sprite: { key: string; w: number; h: number; rgba: Uint8Array } | null;
                additive: boolean; near?: boolean; zwrite: boolean; nozcomp: boolean; first: number; count: number }[]) {
    if (!batches.length) return;
    const gl = this.gl;
    const quads = data.length / (17 * 4);
    gl.useProgram(this.particleProg);
    // (an overlay's particles - the HUD's - through its camera)
    gl.uniformMatrix4fv(this.ploc.uViewProj, false, this.overlayVP ?? this.viewProj);
    gl.uniform1i(this.ploc.uTex, 0);
    gl.bindVertexArray(this.pvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    if (quads > this.pQuads) {
      this.pQuads = Math.max(quads, this.pQuads * 2, 64);
      const idx = new Uint16Array(this.pQuads * 6);
      for (let q = 0; q < this.pQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
    for (const b of batches) {
      gl.bindTexture(gl.TEXTURE_2D, b.sprite ? this.spriteTexture(b.sprite, b.near) : this.white);
      if (b.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(b.zwrite);
      gl.depthFunc(b.nozcomp ? gl.ALWAYS : gl.LEQUAL);
      gl.drawElements(gl.TRIANGLES, b.count * 6, gl.UNSIGNED_SHORT, b.first * 12);
      this.draws++;
    }
    this.bound[0] = null;
    gl.bindVertexArray(null);
    gl.useProgram(this.prog);
    this.dirty();
    this.endPass();
  }

  private stripBuf: Float32Array = new Float32Array(17 * 64);
  private svao: WebGLVertexArrayObject | null = null;
  private svbo: WebGLBuffer | null = null;

  /** A sword's swing strip (fx/swordtrail.ts: x, y, z, r, g, b, a per vertex,
   *  a triangle strip), drawn as the game draws it: its vertex colors
   *  alone, blended by their alpha, what is fully clear dropped, tested
   *  against depth without writing it, both sides. */
  drawTrail(v: Float32Array) {
    const gl = this.gl;
    const n = v.length / 7;
    if (n < 3) return;
    if (this.stripBuf.length < n * 17) this.stripBuf = new Float32Array(n * 17 * 2);
    const b = this.stripBuf;
    for (let i = 0; i < n; i++) {
      const o = i * 17, s = i * 7;
      b[o] = v[s]; b[o + 1] = v[s + 1]; b[o + 2] = v[s + 2]; b[o + 3] = 0; b[o + 4] = 0;
      b[o + 5] = v[s + 3]; b[o + 6] = v[s + 4]; b[o + 7] = v[s + 5]; b[o + 8] = v[s + 6];
      b[o + 9] = b[o + 10] = b[o + 11] = b[o + 12] = 0;
      // the alpha test: greater than 0, and greater than 0
      b[o + 13] = (4 << 3) | 4; b[o + 14] = 0; b[o + 15] = 0; b[o + 16] = 0;
    }
    gl.useProgram(this.particleProg);
    gl.uniformMatrix4fv(this.ploc.uViewProj, false, this.overlayVP ?? this.viewProj);
    if (!this.svao) {
      this.svao = gl.createVertexArray()!;
      gl.bindVertexArray(this.svao);
      this.svbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.svbo);
      particleAttribs(gl);
    }
    gl.bindVertexArray(this.svao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.svbo);
    gl.bufferData(gl.ARRAY_BUFFER, b.subarray(0, n * 17), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n);
    this.draws++;
    gl.bindVertexArray(null);
    gl.useProgram(this.prog);
    this.dirty();
    this.endPass();
  }

  private makeSphere(): GpuMesh {
    const gl = this.gl;
    const pos: number[] = [], idx: number[] = [];
    const R = 16, S = 24;
    for (let i = 0; i <= R; i++)
      for (let j = 0; j <= S; j++) {
        const t = (i / R) * Math.PI, p = (j / S) * Math.PI * 2;
        pos.push(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p));
      }
    for (let i = 0; i < R; i++)
      for (let j = 0; j < S; j++) {
        const a = i * (S + 1) + j, b = a + S + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const put = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.attr[name]);
      gl.vertexAttribPointer(this.attr[name], size, gl.FLOAT, false, 0, 0);
      buffers.push(b);
    };
    const n = pos.length / 3;
    put(new Float32Array(pos), "aPos", 3);
    put(new Float32Array(pos), "aNrm", 3);
    put(new Float32Array(n * 2), "aUv0", 2);
    put(new Float32Array(n * 2), "aUv1", 2);
    put(new Float32Array(n * 4).fill(1), "aClr", 4);
    put(new Float32Array(n), "aMtx", 1);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    return { vao, buffers, count: idx.length, type: gl.UNSIGNED_SHORT, mode: gl.TRIANGLES, offset: 0 };
  }

  /** read one pixel of what was just drawn (for the checks) */
  pixel(x: number, y: number): number[] {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.readPixels(Math.round(x), Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out];
  }

  dispose() {
    const gl = this.gl;
    // (nothing more warmed: its textures would go to a renderer that is gone)
    this.warmQueue = [];
    this.warmAt = 0;
    this.warmTimer?.cancel();
    this.warmTimer = null;
    for (const f of this.warmWaiting.splice(0)) f();
    for (const m of [...this.meshes.values(), ...this.models.values()]) { gl.deleteVertexArray(m.vao); m.buffers.forEach((b) => gl.deleteBuffer(b)); }
    this.models.clear();
    for (const b of [...this.ubos, this.scratchUbo]) gl.deleteBuffer(b);
    this.ubos = [];
    for (const t of this.textures.values()) gl.deleteTexture(t);
    for (const t of this.spriteTex.values()) gl.deleteTexture(t);
    for (const t of this.targets) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.depth); }
    this.targets = [];
    this.spriteTex.clear();
    this.look?.dispose();
    this.look = null;
    this.pic?.dispose();
    this.pic = null;
    if (this.mirror) {
      gl.deleteFramebuffer(this.mirror.fb); gl.deleteTexture(this.mirror.tex); gl.deleteRenderbuffer(this.mirror.depth);
      this.mirror = null;
    }
    this.meshes.clear();
    this.meshEpoch++;
    this.textures.clear();
    this.texByImage = new WeakMap();
    this.texCache = new WeakMap();
  }
}

// GX blend factors. The source and destination tables differ in 2 and 3:
// for a source they mean the destination's color, and the other way round.
function srcFactor(gl: WebGL2RenderingContext, f: number): number {
  return [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
          gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f] ?? gl.ONE;
}
function dstFactor(gl: WebGL2RenderingContext, f: number): number {
  return [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
          gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f] ?? gl.ZERO;
}

export type { MObj };
