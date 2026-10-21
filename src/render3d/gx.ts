/* 3D replay viewer: the GameCube's fixed-function graphics as
 * the game's library (sysdolphin, HSD) sets them up, written out once so the
 * renderer's shaders and the tests share one account of it.
 *
 * - Lights: GX lights a vertex, not a pixel. Each light has an angle
 *   attenuation (a0 + a1 c + a2 c^2, c the cosine to its axis) and a distance
 *   attenuation (k0 + k1 d + k2 d^2); HSD derives them from a light's spot
 *   cutoff and reference brightness and distance. A lit material's color
 *   channel is the ambient light times the material's ambient plus every
 *   diffuse light, clamped, in the channel's 8-bit integers; a specular
 *   material has a second channel whose lights aim along the half-way vector.
 * - The texture environment (TEV): HSD builds a material's stages from its
 *   render mode and its textures' flags - the textures that change the
 *   diffuse color first, then the lighting, then the specular term with its
 *   own textures, then the textures laid on after lighting. `compileMaterial`
 *   turns a material into that list; `evalMaterial` runs it in the TEV's own
 *   integers (`tevStage`), as the fragment shader does.
 * - Texture coordinates, fog, mip levels.
 *
 * Written from the GX SDK's documented formulas and from what
 * the sysdolphin library does with them; no code from the game or from any
 * emulator is in it.
 */
import type { MObj, TObj } from "./hsd";
import { MakeTextureMtx } from "./gxmath";
import { CNST_ALPHA, CNST_BLEND, CNST_DIFFUSE, CNST_SPECULAR, CNST_TEXREG, type TevProgram, compileTExp, runTev } from "./texp";

// ---------------------------------------------------------------- lights

/** a light's GX attenuation: angle (a0, a1, a2) then distance (k0, k1, k2) */
export type Attn = [number, number, number, number, number, number];

/** the angle attenuation of a spot light with this cutoff (degrees) and
 *  falloff (GX_SP_OFF, FLAT, COS, COS2, SHARP, RING1, RING2) */
export function spotAttn(cutoff: number, func: number): [number, number, number] {
  if (cutoff <= 0 || cutoff > 90) func = 0;
  const cr = Math.cos((cutoff * Math.PI) / 180);
  const d = (1 - cr) * (1 - cr);
  switch (func) {
    case 1: return [-1000 * cr, 1000, 0];
    case 2: return [-cr / (1 - cr), 1 / (1 - cr), 0];
    case 3: return [0, -cr / (1 - cr), 1 / (1 - cr)];
    case 4: return [(cr * (cr - 2)) / d, 2 / d, -1 / d];
    case 5: return [(-4 * cr) / d, (4 * (1 + cr)) / d, -4 / d];
    case 6: return [1 - (2 * cr * cr) / d, (4 * cr) / d, -2 / d];
    default: return [1, 0, 0];
  }
}

/** the distance attenuation of a light that is `refBright` as bright at
 *  `refDist` (GX_DA_OFF, GENTLE, MEDIUM, STEEP) */
export function distAttn(refDist: number, refBright: number, func: number): [number, number, number] {
  if (refDist < 0 || refBright <= 0 || refBright >= 1) func = 0;
  const r = (1 - refBright) / refBright;
  switch (func) {
    case 1: return [1, r / refDist, 0];
    case 2: return [1, (0.5 * r) / refDist, (0.5 * r) / (refDist * refDist)];
    case 3: return [1, 0, r / (refDist * refDist)];
    default: return [1, 0, 0];
  }
}

/** the attenuation of a specular light for a material this shiny */
export function specAttn(shininess: number): Attn {
  const k0 = shininess * 0.5;
  return [0, 0, 1, k0, 0, 1 - k0];
}

export const LOBJ = { INFINITE: 1, POINT: 2, SPOT: 3, DIFFUSE: 4, SPECULAR: 8, ALPHA: 0x10, HIDDEN: 0x20, RAW: 0x40 };

/** one light as the shaders take it: where it is (w 1) or which way it is
 *  from everything (w 0), its axis (toward the light), color, attenuation,
 *  and whether it lights the diffuse channel, the specular one or both */
export interface GxLight {
  pos: [number, number, number, number];
  axis: [number, number, number];
  color: [number, number, number, number];
  attn: Attn;
  diffuse: boolean;
  specular: boolean;
  /** where the light is in the world as its LObj holds it (an infinite light's position too, and a spot's
   *  interest: what HSD_LObjSetup hands GX through the view) */
  place?: [number, number, number];
  interest?: [number, number, number];
}

type V3 = [number, number, number] | number[];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): number[] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** the direction to a light from a point, and how far it is (0 for a light
 *  infinitely far) */
function toLight(l: GxLight, p: V3): { ld: number[]; dist: number } {
  if (l.pos[3] === 0) return { ld: norm(l.pos), dist: 0 };
  const v = [l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]];
  const dist = Math.hypot(v[0], v[1], v[2]) || 1e-6;
  return { ld: [v[0] / dist, v[1] / dist, v[2] / dist], dist };
}

/** the diffuse color channel at a vertex (the shader's, in JS), in bytes as
 *  GX's lighting has it: position and normal in view space (the lights as
 *  gxlights.ts puts them there: every one a point), the ambient
 *  light and the material's ambient (0..1). The channel's ambient register is
 *  the two colors' product (HSD_SetupChannelMode's HSD_MulColor); each light
 *  adds its color times its attenuation and turn, rounded; the sum, clamped,
 *  times the channel's material color (white) is the vertex's color
 *  (chanColor) */
export function diffuseChannel(lights: GxLight[], ambient: V3, matAmbient: V3, p: V3, n: V3): number[] {
  const N = norm(n);
  const out = mulColor([0, 1, 2].map((i) => byteOf(matAmbient[i])), [0, 1, 2].map((i) => byteOf(ambient[i])));
  for (const l of lights) {
    if (!l.diffuse) continue;
    const { ld, dist } = toLight(l, p);
    const c = Math.max(dot(ld, l.axis), 0);
    const [a0, a1, a2, k0, k1, k2] = l.attn;
    const att = Math.max(a0 + a1 * c + a2 * c * c, 0) / (k0 + k1 * dist + k2 * dist * dist);
    const f = att * Math.max(dot(N, ld), 0);
    for (let i = 0; i < 3; i++) out[i] += Math.round(f * byteOf(l.color[i]));
  }
  return out.map((v) => chanColor(255, v));
}

/** the specular channel at a vertex, in bytes: each specular light aimed
 *  along the half-way vector between it and the eye, as seen from the
 *  model's joint, its term rounded into the channel as the diffuse one's */
export function specularChannel(lights: GxLight[], shininess: number, eye: V3, joint: V3, p: V3, n: V3): number[] {
  const N = norm(n);
  const cdir = norm([joint[0] - eye[0], joint[1] - eye[1], joint[2] - eye[2]]);
  const [, , , k0, , k2] = specAttn(shininess);
  const out = [0, 0, 0];
  for (const l of lights) {
    if (!l.specular) continue;
    // the light's own vector: from the light toward the scene
    const lv = l.pos[3] === 0 ? norm([-l.pos[0], -l.pos[1], -l.pos[2]])
      : norm([joint[0] - l.pos[0], joint[1] - l.pos[1], joint[2] - l.pos[2]]);
    const h = norm([-(lv[0] + cdir[0]), -(lv[1] + cdir[1]), -(lv[2] + cdir[2])]);
    const { ld } = toLight(l, p);
    const nl = dot(N, ld);
    const c = nl >= 0 ? Math.max(dot(N, h), 0) : 0;
    const att = (c * c) / Math.max(k0 + k2 * c * c, 1e-6);
    const f = att * Math.max(nl, 0);
    for (let i = 0; i < 3; i++) out[i] += Math.round(f * byteOf(l.color[i]));
  }
  return out.map((v) => chanColor(255, v));
}

// ---------------------------------------------------------------- materials

export const RENDER = {
  CONSTANT: 1, VERTEX: 2, DIFFUSE: 4, SPECULAR: 8, XLU: 1 << 30, NO_ZUPDATE: 1 << 29, ZMODE_ALWAYS: 1 << 27,
  SHADOW: 1 << 26,
};
export const TEX = {
  COORD_MASK: 0xf, LIGHTMAP_DIFFUSE: 1 << 4, LIGHTMAP_SPECULAR: 1 << 5, LIGHTMAP_AMBIENT: 1 << 6,
  LIGHTMAP_EXT: 1 << 7, LIGHTMAP_SHADOW: 1 << 8, BUMP: 1 << 24,
};

/** how a texture's coordinates are made: a UV set, the reflection of the
 *  view-space normal, the highlight of the first infinite light, or where a
 *  point falls in a stage's mirror image (Fountain of Dreams' pond: the
 *  game's code turns that texture into a shadow-style projection) */
export const enum TexGen { UV0 = 0, UV1 = 1, REFLECTION = 2, HIGHLIGHT = 3, MIRROR = 4 }

/** one TEV step of a material: a texture laid on the color (and alpha)
 *  carried so far, in the part of the material it belongs to */
export interface MatStage {
  /** which of the material's textures (its sampler) */
  tex: number;
  /** TEX_COLORMAP_* (0..8) */
  colorMap: number;
  /** TEX_ALPHAMAP_* (0..7), or -1: a texture laid on a second time leaves the alpha alone */
  alphaMap: number;
  /** 0 the diffuse color (before lighting), 1 the specular color, 2 after
   *  lighting, 3 after everything (a shadow texture's modulation) */
  phase: 0 | 1 | 2 | 3;
}

/** a material, compiled: its lighting channel, its textures and its stages */
export interface MatProgram {
  /** the color channel (HSD's channel setup by the render mode's low bits):
   *  0 plain white, 1 the vertex color, 2 lit */
  channel: 0 | 1 | 2;
  /** the color it starts from is the channel's (RENDER_VERTEX), else the material's */
  vertexBase: boolean;
  /** its color is multiplied by the channel (RENDER_DIFFUSE) */
  lit: boolean;
  /** it has a specular term (RENDER_SPECULAR) */
  specular: boolean;
  /** the textures it samples (index into the material's texture list), at most 4 */
  textures: number[];
  /** how each sampled texture's coordinates are made */
  texGen: TexGen[];
  stages: MatStage[];
  /** its TEV as HSD_TExpCompile makes it: the stages the hardware runs (texp.ts), the one table the fragment
   *  shader and `evalMaterial` both run */
  tev: TevProgram;
  /** the sampler of its emboss bump map (HSD's volatile emboss stages: the
   *  color plus the map, minus the map shifted toward the first diffuse
   *  light, both times the lit color), or -1 */
  bump: number;
}

/** HSD's TEV for a material: its textures in the order they are laid on.
 *  `tobjs` is the material's texture list; `skip` says which to leave out
 *  (images the game renders into at runtime). */
export function compileMaterial(mo: MObj, tobjs: TObj[], skip?: (t: TObj) => boolean,
                                mirror?: (t: TObj) => boolean): MatProgram {
  const mode = mo.renderMode;
  const low = mode & 7;
  const prog: MatProgram = {
    channel: low === RENDER.VERTEX ? 1 : low === RENDER.DIFFUSE ? 2 : 0,
    vertexBase: (mode & RENDER.VERTEX) !== 0,
    lit: (mode & RENDER.DIFFUSE) !== 0,
    specular: (mode & RENDER.SPECULAR) !== 0,
    textures: [], texGen: [], stages: [], tev: { stages: [], out: 0 }, bump: -1,
  };
  // the textures that get a sampler: shadow and toon textures are the
  // game's own additions, a bump map's emboss is left out
  const sampler = new Map<number, number>();
  const use = (i: number): number => {
    let s = sampler.get(i);
    if (s !== undefined) return s;
    if (prog.textures.length >= 4) return -1;
    const t = tobjs[i];
    const coord = t.flags & TEX.COORD_MASK;
    s = prog.textures.length;
    prog.textures.push(i);
    prog.texGen.push(mirror && mirror(t) ? TexGen.MIRROR : coord === 1 ? TexGen.REFLECTION : coord === 2 ? TexGen.HIGHLIGHT
      : t.src === 5 ? TexGen.UV1 : TexGen.UV0);
    sampler.set(i, s);
    return s;
  };
  const usable = (t: TObj) => {
    const coord = t.flags & TEX.COORD_MASK;
    return coord !== 3 && coord !== 4 && !(skip && skip(t));
  };
  let done = 0;
  const pass = (lightmap: number, phase: 0 | 1 | 2) => {
    tobjs.forEach((t, i) => {
      const lm = t.flags & (TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_SPECULAR | TEX.LIGHTMAP_AMBIENT | TEX.LIGHTMAP_EXT);
      if (!(lm & lightmap) || !usable(t)) return;
      const s = use(i);
      if (s < 0) return;
      // a texture laid on in an earlier part leaves the alpha as it is
      const again = (done & lm) !== 0;
      prog.stages.push({ tex: s, colorMap: (t.flags >> 16) & 0xf, alphaMap: again ? -1 : (t.flags >> 20) & 0xf, phase });
    });
  };
  pass(TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_AMBIENT, 0);
  done |= TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_AMBIENT;
  if (prog.specular) {
    pass(TEX.LIGHTMAP_SPECULAR, 1);
    done |= TEX.LIGHTMAP_SPECULAR;
  }
  pass(TEX.LIGHTMAP_EXT, 2);
  // (the same textures, in the same samplers, through MObjMakeTExp and HSD_TExpCompile)
  prog.tev = compileTExp(mo, tobjs, (i) => (usable(tobjs[i]) ? sampler.get(i) ?? -1 : -1));
  // a bump map's emboss (one at most)
  const bi = tobjs.findIndex((t) => (t.flags & TEX.BUMP) !== 0 && usable(t));
  if (bi >= 0) prog.bump = use(bi);
  // a texture the game turned into a shadow texture after the material was
  // compiled keeps its stage above and modulates the color at the very end
  // (HSD's volatile shadow stage)
  if (mirror) tobjs.forEach((t, i) => {
    if (!mirror(t)) return;
    const s = use(i);
    if (s >= 0) prog.stages.push({ tex: s, colorMap: 4, alphaMap: -1, phase: 3 });
  });
  return prog;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ---------------------------------------------------------------- the TEV, in its own integers
//
// GX's color combiner works on 8-bit colors and 10-bit signed intermediates,
// and so does this: every TEV stage below - a material's, a texture's own,
// the lighting's multiply, the specular add, the emboss, the shadows, a
// fighter's color animation - is one call of `tevStage`, and the fragment
// shader runs the same integer arithmetic (renderer.ts tevStage). Its rules,
// as the hardware has them:
//  - the a, b and c inputs are bytes (a register's low 8 bits), d is the
//    register's whole 10-bit value;
//  - c is widened to 0..256 (c + (c >> 7)), so the lerp divides by 256:
//    (a * (256 - c) + b * c) >> 8, with a rounding bias of 128 before the
//    shift (127 when the stage subtracts);
//  - d is biased (+128, -128), a scale of 2 or 4 shifts d and the lerp (the
//    lerp before its divide), a scale of 1/2 halves the sum (no rounding
//    bias then);
//  - the result is clamped to 0..255, or kept to -1024..1023;
//  - the compare modes compare a and b (as 8, 16 or 24-bit numbers, or
//    per channel) and add c to d where they pass.
// Colors come in as bytes: a texel round(t * 255), a rasterized color
// round(c * 255), a material's or konst color its byte, a scalar (a
// texture's blending, a material's alpha) cut to a byte as HSD_TExpSetReg
// does (`tevByte`).

/** a value as a byte (0..255), rounded: what a color kept as byte / 255 is */
export const byteOf = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));

/** a scalar the TEV takes as a constant (HSD_TExpSetReg's HSD_TE_F32): 255
 *  times the value, cut to a whole number, kept to 0..255 */
export function tevByte(v: number): number {
  // ((int)(0xFF * f): the product a float's)
  return Math.min(255, Math.max(0, Math.trunc(Math.fround(255 * Math.fround(v)))));
}

/** the same, as the 0..1 value the byte stands for */
export function tevScalar(v: number): number {
  return tevByte(v) / 255;
}

/** one TEV stage on one channel: inputs a, b, c (bytes: their low 8 bits are
 *  taken) and d (10-bit signed), op (GX_TEV_ADD 0, GX_TEV_SUB 1), bias
 *  (GX_TB_ZERO, ADDHALF, SUBHALF), scale (GX_CS_SCALE_1, 2, 4, DIVIDE_2),
 *  clamp to 0..255 (else -1024..1023) */
export function tevStage(a: number, b: number, c: number, d: number, op: number, bias: number, scale: number, clamp: boolean): number {
  a &= 255; b &= 255; c &= 255;
  const s = scale === 1 ? 1 : scale === 2 ? 2 : 0, half = scale === 3;
  const dd = (d + (bias === 1 ? 128 : bias === 2 ? -128 : 0)) << s;
  const lerp = ((((a << 8) + (b - a) * (c + (c >> 7))) << s) + (half ? 0 : op === 1 ? 127 : 128)) >> 8;
  let v = op === 1 ? dd - lerp : dd + lerp;
  if (half) v >>= 1;
  return clamp ? Math.min(255, Math.max(0, v)) : Math.min(1023, Math.max(-1024, v));
}

/** a compare stage (GX_TEV_COMP_R8_GT 8 .. GX_TEV_COMP_RGB8_EQ / A8_EQ 15) on
 *  a color (rgb) or an alpha (a): d + c where a compares to b as asked; a, b,
 *  c and d are rgba, the alpha's compare reading a's and b's colors for its
 *  R8, GR16 and BGR24 modes */
export function tevCompare(op: number, a: number[], b: number[], c: number[], d: number[], alpha: boolean, clamp: boolean): number[] {
  const A = a.map((v) => v & 255), B = b.map((v) => v & 255), C = c.map((v) => v & 255);
  const eq = (op & 1) === 1, mode = (op >> 1) & 3;
  const pass = (x: number, y: number) => (eq ? x === y : x > y);
  const v16 = (q: number[]) => q[0] + (q[1] << 8), v24 = (q: number[]) => q[0] + (q[1] << 8) + (q[2] << 16);
  const lim = (v: number) => (clamp ? Math.min(255, Math.max(0, v)) : Math.min(1023, Math.max(-1024, v)));
  // (one test for every channel, except the per-channel mode: RGB8, or A8 for an alpha)
  const all = mode === 0 ? pass(A[0], B[0]) : mode === 1 ? pass(v16(A), v16(B)) : mode === 2 ? pass(v24(A), v24(B)) : null;
  if (alpha) return [lim(d[3] + ((all ?? pass(A[3], B[3])) ? C[3] : 0))];
  return [0, 1, 2].map((i) => lim(d[i] + ((all ?? pass(A[i], B[i])) ? C[i] : 0)));
}

/** where a texture's color map takes its stage's inputs (TObjMakeTExp): per
 *  TEX_COLORMAP_* the a, b, c and d of the stage and whether it subtracts,
 *  each input 0 zero, 1 the color so far, 2 the texel's color, 3 its alpha,
 *  4 the blending constant. NONE and PASS keep the color as it is. */
export const COLOR_MAP_IN: number[][] = [
  [0, 0, 0, 1, 0], // NONE
  [1, 2, 3, 0, 0], // ALPHA_MASK: lerp(color, texel, texel alpha)
  [1, 2, 2, 0, 0], // RGB_MASK: lerp(color, texel, texel)
  [1, 2, 4, 0, 0], // BLEND: lerp(color, texel, blending)
  [0, 1, 2, 0, 0], // MODULATE: color times texel
  [0, 0, 0, 2, 0], // REPLACE
  [0, 0, 0, 1, 0], // PASS
  [2, 0, 0, 1, 0], // ADD: color + texel
  [2, 0, 0, 1, 1], // SUB: color - texel
];
/** the same for TEX_ALPHAMAP_* (1 the alpha so far, 3 the texel's alpha, 4 the blending) */
export const ALPHA_MAP_IN: number[][] = [
  [0, 0, 0, 1, 0], // NONE
  [1, 3, 3, 0, 0], // ALPHA_MASK
  [1, 3, 4, 0, 0], // BLEND
  [0, 1, 3, 0, 0], // MODULATE
  [0, 0, 0, 3, 0], // REPLACE
  [0, 0, 0, 1, 0], // PASS
  [3, 0, 0, 1, 0], // ADD
  [3, 0, 0, 1, 1], // SUB
];

/** a texture's color map laid on the color so far (bytes; TObjMakeTExp's stage) */
export function colorMap(op: number, c: number[], t: number[], blend: number): number[] {
  const m = COLOR_MAP_IN[op] ?? COLOR_MAP_IN[0];
  return [0, 1, 2].map((i) => {
    const pick = (k: number) => (k === 1 ? c[i] : k === 2 ? t[i] : k === 3 ? t[3] : k === 4 ? blend : 0);
    return tevStage(pick(m[0]), pick(m[1]), pick(m[2]), pick(m[3]), m[4], 0, 0, true);
  });
}

/** a texture's alpha map laid on the alpha so far (bytes) */
export function alphaMap(op: number, a: number, t: number, blend: number): number {
  const m = ALPHA_MAP_IN[op] ?? ALPHA_MAP_IN[0];
  const pick = (k: number) => (k === 1 ? a : k === 3 ? t : k === 4 ? blend : 0);
  return tevStage(pick(m[0]), pick(m[1]), pick(m[2]), pick(m[3]), m[4], 0, 0, true);
}

/** what a material's TEV makes of its inputs (the fragment shader, in its
 *  integers): its colors, each sampler's texel and blend and own TEV colors
 *  (konst, tev0, tev1), the two lighting channels; every input a byte
 *  (0..255), the result four bytes. The stages are HSD_TExpCompile's
 *  (`p.tev`: MObjMakeTExp's graph, simplified); then
 *  HSD_TObjSetupVolatileTev's emboss and shadows, each reading the last
 *  stage's 10-bit result, and the pixel its low 8 bits. */
export function evalMaterial(p: MatProgram, inp: {
  diffuse: number[]; alpha: number; specular: number[]; ras0: number[]; ras1: number[];
  texels: number[][]; blend: number[];
  /** each sampler's own TEV colors, konst, tev0, tev1 (bytes, rgba) */
  tevColors?: number[][][];
  /** the bump map's texel at its shifted coordinates */
  bumpShifted?: number[];
  /** the shadows' texels, each laid on after everything (TObjSetupTevModulateShadow) */
  shadows?: number[][];
}): number[] {
  const zero = [0, 0, 0, 0];
  const out = runTev(p.tev, {
    texel: (s) => inp.texels[s] ?? zero,
    ras: (ch) => (ch === 1 ? inp.ras1 : inp.ras0),
    cnst: (id) => {
      if (id === CNST_DIFFUSE) return [...inp.diffuse.slice(0, 3), 255];
      if (id === CNST_ALPHA) return [inp.alpha, inp.alpha, inp.alpha, inp.alpha];
      if (id === CNST_SPECULAR) return [...inp.specular.slice(0, 3), 255];
      if (id < CNST_TEXREG) { const b = inp.blend[id - CNST_BLEND] ?? 255; return [b, b, b, b]; }
      const k = id - CNST_TEXREG;
      return inp.tevColors?.[Math.floor(k / 3)]?.[k % 3] ?? zero;
    },
  }, { stage: tevStage, compare: tevCompare });
  let c = out.slice(0, 3);
  if (p.bump >= 0 && inp.bumpShifted) {
    // (SetupEmbossBumpTev: plus the map times the lit color, unclamped, then minus the shifted map's, clamped)
    const t = inp.texels[p.bump], u = inp.bumpShifted;
    c = c.map((v, i) => tevStage(0, t[i], inp.ras0[i], v, 0, 0, 0, false));
    c = c.map((v, i) => tevStage(0, u[i], inp.ras0[i], v, 1, 0, 0, true));
  }
  for (const s of p.stages) if (s.phase === 3) c = c.map((v, i) => tevStage(0, v, inp.texels[s.tex][i], 0, 0, 0, 0, true));
  for (const sh of inp.shadows ?? []) c = c.map((v, i) => tevStage(0, v, sh[i], 0, 0, 0, 0, true));
  // (what leaves the last stage for the pixel engine: the register's low 8 bits)
  return [c[0] & 255, c[1] & 255, c[2] & 255, out[3] & 255];
}

/** a texture's own TEV step (HSD_TObjTevDesc, MakeColorGenTExp) on its texel,
 *  in bytes: inputs a..d per channel (GX_CC_*, GX_CA_*, or the TOBJ_TEV_*
 *  picks of its konst, tev0 and tev1 colors), the stage's op (a compare
 *  too), bias, scale and clamp; konst, tev0 and tev1 as bytes */
export function tevDescStep(desc: {
  colorOp: number; alphaOp: number; colorBias: number; alphaBias: number; colorScale: number; alphaScale: number;
  colorClamp: number; alphaClamp: number; colorIn: number[]; alphaIn: number[]; active: number;
}, konst: number[], tev0: number[], tev1: number[], t: number[]): number[] {
  const cIn = (code: number): number[] => {
    switch (code) {
      case 8: return t.slice(0, 3);
      case 9: return [t[3], t[3], t[3]];
      case 12: return [255, 255, 255];
      case 13: return [128, 128, 128];
      case 0x80: return konst.slice(0, 3);
      case 0x81: return [konst[0], konst[0], konst[0]];
      case 0x82: return [konst[1], konst[1], konst[1]];
      case 0x83: return [konst[2], konst[2], konst[2]];
      case 0x84: return [konst[3], konst[3], konst[3]];
      case 0x85: return tev0.slice(0, 3);
      case 0x86: return [tev0[3], tev0[3], tev0[3]];
      case 0x87: return tev1.slice(0, 3);
      case 0x88: return [tev1[3], tev1[3], tev1[3]];
      default: return [0, 0, 0];
    }
  };
  const aIn = (code: number): number => {
    switch (code) {
      case 4: return t[3];
      case 0x40: return konst[0];
      case 0x41: return konst[1];
      case 0x42: return konst[2];
      case 0x43: return konst[3];
      case 0x44: return tev0[3];
      case 0x45: return tev1[3];
      default: return 0;
    }
  };
  const out = t.slice();
  const cs = desc.colorIn.map(cIn);
  if (desc.active & 0x40000000) {
    const [a, b, c, d] = cs;
    if (desc.colorOp >= 8) {
      const r = tevCompare(desc.colorOp, [...a, 0], [...b, 0], [...c, 0], [...d, 0], false, !!desc.colorClamp);
      out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
    } else {
      for (let i = 0; i < 3; i++) out[i] = tevStage(a[i], b[i], c[i], d[i], desc.colorOp, desc.colorBias, desc.colorScale, !!desc.colorClamp);
    }
  }
  if (desc.active & 0x80000000) {
    const [a, b, c, d] = desc.alphaIn.map(aIn);
    if (desc.alphaOp >= 8) {
      const [ca, cb] = cs;
      out[3] = tevCompare(desc.alphaOp, [...ca, a], [...cb, b], [0, 0, 0, c], [0, 0, 0, d], true, !!desc.alphaClamp)[0];
    } else out[3] = tevStage(a, b, c, d, desc.alphaOp, desc.alphaBias, desc.alphaScale, !!desc.alphaClamp);
  }
  return out;
}

/** a color laid over toward `to` by `alpha` (bytes): a fighter's color animation and outline (ftMaterial's
 *  stages), lerp(color, to, alpha) */
export function overColor(c: number[], to: number[], alpha: number): number[] {
  return c.map((v, i) => tevStage(v, to[i], alpha, 0, 0, 0, 0, true));
}

/** HSD_MulColor: two colors' product, byte by byte, divided by 255 (an integer division) */
export function mulColor(a: number[], b: number[]): number[] {
  return a.map((v, i) => Math.trunc((v * b[i]) / 255));
}

/** a color channel's output (GX's lighting, in bytes): the material color times the clamped sum of the ambient
 *  and the lights, mat * (acc + (acc >> 7)) >> 8 */
export function chanColor(mat: number, acc: number): number {
  const l = Math.min(255, Math.max(0, acc));
  return (mat * (l + (l >> 7))) >> 8;
}

// ---------------------------------------------------------------- the pixel engine

/** GX's alpha test: two comparisons (GX_NEVER .. GX_ALWAYS) against their
 *  references (0..255) joined by GX_AOP_AND, OR, XOR or XNOR */
export function alphaTest(a255: number, comp0: number, ref0: number, op: number, comp1: number, ref1: number): boolean {
  const cmp = (f: number, r: number) => [false, a255 < r, a255 === r, a255 <= r, a255 > r, a255 !== r, a255 >= r, true][f] ?? true;
  const p = cmp(comp0, ref0), q = cmp(comp1, ref1);
  return op === 0 ? p && q : op === 1 ? p || q : op === 2 ? p !== q : p === q;
}

/** the alpha test HSD sets for a material without a pixel-engine
 *  description: see-through ones that write depth drop what is fully clear,
 *  the rest keep everything. [comp0, ref0, op, comp1, ref1] */
export function defaultAlphaTest(renderMode: number): [number, number, number, number, number] {
  if (!(renderMode & RENDER.NO_ZUPDATE) && renderMode & RENDER.XLU) return [4, 0, 0, 4, 0];
  return [7, 0, 0, 7, 0];
}

// ---------------------------------------------------------------- fog

// (the fog as the hardware evaluates it, on GXSetFog's registers: fog.ts)

// ---------------------------------------------------------------- textures

/** a GX texture format's block size (width, height, bytes) */
export function blockOf(format: number): [number, number, number] {
  switch (format) {
    case 0: case 8: return [8, 8, 32]; // I4, C4
    case 1: case 2: case 9: return [8, 4, 32]; // I8, IA4, C8
    case 3: case 4: case 5: case 10: return [4, 4, 32]; // IA8, RGB565, RGB5A3, C14X2
    case 6: return [4, 4, 64]; // RGBA8
    case 14: return [8, 8, 32]; // CMPR
    default: return [4, 4, 32];
  }
}

/** a mip-mapped image's levels: size and where each starts after the first
 *  (each level is whole blocks, one after the other) */
export function mipLevels(width: number, height: number, format: number, maxLod: number): { w: number; h: number; at: number }[] {
  const [bw, bh, bytes] = blockOf(format);
  const out: { w: number; h: number; at: number }[] = [];
  let w = width, h = height, at = 0;
  for (let lv = 0; lv <= Math.max(0, Math.floor(maxLod)); lv++) {
    out.push({ w, h, at });
    at += Math.ceil(w / bw) * Math.ceil(h / bh) * bytes;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

/** the minification filter HSD sets: the texture's LOD one (GX_NEAR ..
 *  GX_LIN_MIP_LIN; LIN_MIP_LIN without an LOD description), trilinear turned
 *  bilinear for color-indexed images, the mip part dropped without levels */
export function minFilter(lodFilter: number | null, mipmap: boolean, format: number): number {
  let f = lodFilter ?? 5;
  if ((format === 8 || format === 9 || format === 10) && f === 5) f = 3;
  if (!mipmap) f &= 1;
  return f;
}

/** HSD's texture matrix (MakeTextureMtx: scale by repeat over scale, turn by the rotation - its z negated -
 *  move by minus the translation; HSD_MkRotationMtx and PSMTXConcat, in float32 as the game makes it) as three
 *  rows of four. (A repeat of 0, which the game asserts against, is taken as 1.) */
export function textureMatrix(tr: number[], sc: number[], rot: number[], repS: number, repT: number, wrapT: number): Float32Array {
  return MakeTextureMtx(new Float32Array(12), [tr[0], tr[1], tr[2] ?? 0], [sc[0], sc[1], sc[2] ?? 1],
                        [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0], repS || 1, repT || 1, wrapT);
}

/** GX fog as a stage sets it: its kind (GX_FOG_*), where it starts and ends
 *  (eye depth) and its color */
export interface Fog { type: number; start: number; end: number; color: [number, number, number] }
