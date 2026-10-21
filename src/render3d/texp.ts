/* 3D replay viewer: a material's TEV as HSD compiles it (texp.c, texpdag.c).
 *
 * HSD describes a material's color combiner as an expression graph (TExp):
 * MObjMakeTExp lays the diffuse color, the textures, the lighting, the
 * specular term and the textures after it as TEV nodes on one another, each
 * texture's own TEV (MakeColorGenTExp) a node of its own. HSD_TExpCompile then
 * simplifies the graph before it becomes hardware stages - a pass-through
 * node is skipped (SimplifySrc), inputs that cannot matter are cut
 * (SimplifyThis), and a node whose only work is adding another one's lerp
 * takes that lerp into itself (SimplifyByMerge). The last changes what the
 * hardware rounds and clamps: the merged stage's lerp rounds once, with the
 * two biases together and its op flipped by a subtracting child, and the
 * child's clamp is gone. This is that graph and those passes, ported, and the
 * result as a table of stages (`TevProgram`), the same table the fragment
 * shader runs (renderer.ts) and `runTev` runs here.
 *
 * Written from the Melee decompilation's sysdolphin sources; each function
 * named as the decompilation names it.
 */
import type { MObj, TObj } from "./hsd";

// HSD_TEInput
const TE_RGB = 1, TE_R = 2, TE_G = 3, TE_B = 4, TE_A = 5, TE_X = 6, TE_0 = 7, TE_1 = 8, TE_1_8 = 9, TE_2_8 = 10,
  TE_3_8 = 11, TE_4_8 = 12, TE_5_8 = 13, TE_6_8 = 14, TE_7_8 = 15, UNDEF = 0xff;
// HSD_TExpType
const T_ZERO = 0, T_TEV = 1, T_TEX = 2, T_RAS = 3, T_CNST = 4, T_IMM = 5, T_KONST = 6;
// GXChannelID
const COLOR0A0 = 4, COLOR1A1 = 5;
// GX_TEV_KCSEL_* / KASEL_* for HSD's eighths, and the values the hardware's konst selections are
const KSEL_OF: Record<number, number> = { [TE_1]: 0, [TE_7_8]: 1, [TE_6_8]: 2, [TE_5_8]: 3, [TE_4_8]: 4, [TE_3_8]: 5, [TE_2_8]: 6, [TE_1_8]: 7 };
const KSEL_VALUE = [255, 223, 191, 159, 128, 96, 64, 32];

/** a constant: where its value is (the material's diffuse color, alpha, specular color, a texture's blending,
 *  a texture's own TEV konst, tev0, tev1), and which part (HSD_TE_RGB, or HSD_TE_X a scalar) */
interface Cnst { kind: "cnst"; key: string; id: number; comp: number; ref: number }
interface Arg { type: number; sel: number; exp: Tev | Cnst | null }
interface Tev {
  kind: "tev";
  c_op: number; c_bias: number; c_scale: number; c_clamp: number;
  a_op: number; a_bias: number; a_scale: number; a_clamp: number;
  c_in: Arg[]; a_in: Arg[];
  /** the texture it samples (a sampler), or null; the rasterized color it takes (COLOR0A0, COLOR1A1), or UNDEF */
  tex: number | null; chan: number;
  tex_swap: number; ras_swap: number; kcsel: number; kasel: number;
  c_ref: number; a_ref: number;
}
// the sentinel expressions (HSD_TEXP_ZERO, HSD_TEXP_TEX, HSD_TEXP_RAS)
const EXP_ZERO = { kind: "zero" } as const, EXP_TEX = { kind: "tex" } as const, EXP_RAS = { kind: "ras" } as const;
type Exp = Tev | Cnst | typeof EXP_ZERO | typeof EXP_TEX | typeof EXP_RAS | null;

const zeroArg = (): Arg => ({ type: T_ZERO, sel: TE_0, exp: null });

/** HSD_TExpGetType */
function typeOf(e: Exp | Arg["exp"]): number {
  if (!e) return T_ZERO;
  switch (e.kind) {
    case "tev": return T_TEV;
    case "cnst": return T_CNST;
    case "tex": return T_TEX;
    case "ras": return T_RAS;
    default: return T_ZERO;
  }
}

/** HSD_TExpTev */
function texpTev(): Tev {
  return { kind: "tev", c_op: UNDEF, c_bias: UNDEF, c_scale: UNDEF, c_clamp: UNDEF, a_op: UNDEF, a_bias: UNDEF, a_scale: UNDEF,
           a_clamp: UNDEF, c_in: [0, 1, 2, 3].map(() => ({ type: UNDEF, sel: UNDEF, exp: null })),
           a_in: [0, 1, 2, 3].map(() => ({ type: UNDEF, sel: UNDEF, exp: null })), tex: null, chan: UNDEF, tex_swap: UNDEF,
           ras_swap: UNDEF, kcsel: UNDEF, kasel: UNDEF, c_ref: 0, a_ref: 0 };
}

/** HSD_TExpRef */
function ref(e: Arg["exp"], sel: number) {
  if (!e) return;
  if (e.kind === "tev") { if (sel === TE_RGB) e.c_ref++; else e.a_ref++; }
  else e.ref++;
}

/** HSD_TExpUnref */
function unref(e: Arg["exp"], sel: number) {
  if (!e) return;
  if (e.kind === "cnst") { if (e.ref) e.ref--; return; }
  if (sel === TE_RGB) { if (e.c_ref) e.c_ref--; } else if (e.a_ref) e.a_ref--;
  if (e.c_ref === 0 && e.a_ref === 0) for (let i = 0; i < 4; i++) { unref(e.c_in[i].exp, e.c_in[i].sel); unref(e.a_in[i].exp, e.a_in[i].sel); }
}

function colorOp(t: Tev, op: number, bias: number, scale: number, clamp: number) { t.c_op = op; t.c_bias = bias; t.c_scale = scale; t.c_clamp = clamp; }
function alphaOp(t: Tev, op: number, bias: number, scale: number, clamp: number) { t.a_op = op; t.a_bias = bias; t.a_scale = scale; t.a_clamp = clamp; }

/** HSD_TExpColorInSub */
function colorInSub(t: Tev, sel: number, exp: Exp, i: number) {
  const prev = t.c_in[i];
  const a: Arg = { type: typeOf(exp), sel, exp: exp && (exp.kind === "tev" || exp.kind === "cnst") ? exp : null };
  if (sel === TE_0) { a.type = T_ZERO; a.exp = null; }
  else if (sel === TE_1 || sel === TE_4_8) { a.type = T_IMM; a.exp = null; }
  else if (sel >= TE_1_8 && sel <= TE_7_8) { a.type = T_KONST; a.exp = null; if (t.kcsel === UNDEF) t.kcsel = KSEL_OF[sel]; }
  else {
    switch (a.type) {
      case T_ZERO: a.sel = TE_0; break;
      case T_TEV: ref(a.exp, a.sel); break;
      case T_CNST: a.sel = (a.exp as Cnst).comp; ref(a.exp, a.sel); break;
      case T_TEX: if (t.tex_swap === UNDEF) t.tex_swap = sel === TE_A ? UNDEF : sel - TE_RGB; break;
      case T_RAS: if (t.ras_swap === UNDEF) t.ras_swap = sel === TE_A ? UNDEF : sel - TE_RGB; break;
    }
  }
  t.c_in[i] = a;
  unref(prev.exp, prev.sel);
}

/** HSD_TExpAlphaInSub */
function alphaInSub(t: Tev, sel: number, exp: Exp, i: number) {
  const prev = t.a_in[i];
  const a: Arg = { type: typeOf(exp), sel, exp: exp && (exp.kind === "tev" || exp.kind === "cnst") ? exp : null };
  if (sel === TE_0) { a.type = T_ZERO; a.exp = null; }
  else if (sel >= TE_1 && sel <= TE_7_8) { a.type = T_KONST; a.exp = null; if (t.kasel === UNDEF) t.kasel = KSEL_OF[sel] ?? 0; }
  else {
    switch (a.type) {
      case T_ZERO: a.sel = TE_0; break;
      case T_TEV: ref(a.exp, a.sel); break;
      case T_CNST: a.sel = TE_X; ref(a.exp, a.sel); break;
    }
  }
  t.a_in[i] = a;
  unref(prev.exp, prev.sel);
}

function colorIn(t: Tev, ...ins: (number | Exp)[]) { for (let i = 0; i < 4; i++) colorInSub(t, ins[i * 2] as number, ins[i * 2 + 1] as Exp, i); }
function alphaIn(t: Tev, ...ins: (number | Exp)[]) { for (let i = 0; i < 4; i++) alphaInSub(t, ins[i * 2] as number, ins[i * 2 + 1] as Exp, i); }

// ---------------------------------------------------------------- texpdag.c's simplification

const isTev = (e: Arg["exp"]): e is Tev => !!e && e.kind === "tev";

/** SimplifySrc: an input that is another node passing a value through takes the value itself */
function simplifySrc(t: Tev): boolean {
  let result = false;
  for (let i = 0; i < 4; i++) {
    const arg = t.c_in[i];
    if (arg.type !== T_TEV || !isTev(arg.exp)) continue;
    const src = arg.exp, sel = arg.sel;
    if (simplify(src)) result = true;
    if (sel === TE_RGB) {
      if (src.c_op === UNDEF) { unref(src, sel); result = true; t.c_in[i] = zeroArg(); continue; }
      if (src.c_op === 0 && src.c_in[0].sel === TE_0 && src.c_in[1].sel === TE_0 && src.c_bias === 0 && src.c_scale === 0) {
        const d = src.c_in[3];
        if (d.type === T_TEV) {
          if ((isTev(d.exp) && d.exp.c_clamp !== 0) || src.c_clamp === 0) {
            t.c_in[i] = { ...d };
            ref(d.exp, d.sel);
            unref(src, sel);
            result = true;
          }
        } else if (d.type === T_TEX) {
          if ((t.tex === null || t.tex === src.tex) && (t.tex_swap === UNDEF || src.tex_swap === UNDEF || t.tex_swap === src.tex_swap)) {
            t.c_in[i] = { ...d };
            t.tex = src.tex;
            if (t.tex_swap === UNDEF) t.tex_swap = src.tex_swap;
            unref(src, sel);
            result = true;
          }
        } else if (d.type === T_RAS) {
          // (as the decompilation has it: the rasterized swap checked against the source's texture swap)
          if ((t.chan === UNDEF || t.chan === src.chan) && (t.ras_swap === UNDEF || src.ras_swap === UNDEF || t.ras_swap === src.tex_swap)) {
            t.c_in[i] = { ...d };
            t.chan = src.chan;
            if (t.tex_swap === UNDEF) t.tex_swap = src.tex_swap;
            unref(src, sel);
            result = true;
          }
        }
      }
    } else if (src.a_op === UNDEF) {
      unref(src, sel);
      result = true;
      t.c_in[i] = zeroArg();
    }
  }
  for (let i = 0; i < 4; i++) {
    const arg = t.a_in[i];
    if (arg.type !== T_TEV || !isTev(arg.exp)) continue;
    const src = arg.exp, sel = arg.sel;
    simplify(src);
    if (src.a_op === UNDEF) { unref(src, sel); result = true; t.a_in[i] = zeroArg(); continue; }
    if (src.a_op === 0 && src.a_in[0].sel === TE_0 && src.a_in[1].sel === TE_0 && src.a_bias === 0 && src.a_scale === 0) {
      const d = src.a_in[3];
      if (d.type === T_TEV) {
        t.a_in[i] = { ...d };
        ref(d.exp, d.sel);
        unref(src, sel);
        result = true;
      } else if (d.type === T_TEX) {
        if (t.tex === null || t.tex === src.tex) { t.a_in[i] = { ...d }; t.tex = src.tex; unref(src, sel); result = true; }
      } else if (d.type === T_RAS) {
        if (t.chan === UNDEF || t.chan === src.chan) { t.a_in[i] = { ...d }; t.chan = src.chan; unref(src, sel); result = true; }
      }
    }
  }
  return result;
}

const clear = (a: Arg[], i: number) => { a[i] = zeroArg(); };

/** SimplifyThis: inputs a lerp of 0 or 1 cannot use are cut, a stage that adds nothing is turned off */
function simplifyThis(t: Tev): boolean {
  let result = false, changed: boolean;
  do {
    let cTex = -1, aTex = -1, cRas = -1, aRas = -1;
    for (let i = 0; i < 4; i++) {
      if (t.c_in[i].type === T_TEX) cTex = i; else if (t.c_in[i].type === T_RAS) cRas = i;
      if (t.a_in[i].type === T_TEX) aTex = i; else if (t.a_in[i].type === T_RAS) aRas = i;
    }
    if (cTex === -1 && aTex === -1) { t.tex = null; t.tex_swap = UNDEF; }
    if (cRas === -1 && aRas === -1) { t.chan = UNDEF; t.ras_swap = UNDEF; }
    changed = false;
    const c = t.c_in, a = t.a_in;
    if (t.a_op === UNDEF || t.a_op === 0xe || t.a_op === 0xf || t.a_op <= 1) {
      if (t.c_op !== UNDEF && t.c_ref === 0) {
        t.c_op = UNDEF;
        for (let i = 0; i < 4; i++) { unref(c[i].exp, c[i].sel); clear(c, i); }
        changed = true;
      }
      switch (t.c_op) {
        case 0: case 1:
          if (c[2].sel === TE_0) {
            if (c[1].sel !== TE_0) { unref(c[1].exp, c[1].sel); changed = true; clear(c, 1); }
            // (as the decompilation has it, but a zero moved onto a zero no change: HSD would go round forever on a
            // stage of nothing but a bias)
            if (t.c_op === 0 && c[3].sel === TE_0 && c[0].sel !== TE_0) { changed = true; c[3] = c[0]; clear(c, 0); t.c_clamp = 1; }
          }
          if (c[2].sel === TE_1) {
            if (c[0].sel !== TE_0) { unref(c[0].exp, c[0].sel); changed = true; clear(c, 0); }
            if (t.c_op === 0 && c[3].sel === TE_0) { changed = true; c[3] = c[1]; clear(c, 1); clear(c, 2); }
          }
          if (c[0].sel === TE_0 && c[1].sel === TE_0 && c[3].sel === TE_0 && t.c_bias === 0) {
            t.c_op = UNDEF;
            unref(c[2].exp, c[2].sel);
            changed = true;
            clear(c, 2);
          }
          break;
        case 8: case 10: case 12: case 14:
          if (c[2].sel === TE_0) {
            t.c_op = 0;
            unref(c[0].exp, c[0].sel); clear(c, 0);
            unref(c[1].exp, c[1].sel); changed = true; clear(c, 1);
          } else if (c[0].sel === TE_0) {
            t.c_op = 0;
            unref(c[1].exp, c[1].sel); clear(c, 1);
            unref(c[2].exp, c[2].sel); changed = true; clear(c, 2);
          }
          break;
        case 9: case 11: case 13: case 15:
          if (c[2].sel === TE_0) {
            t.c_op = 0;
            unref(c[0].exp, c[0].sel); clear(c, 0);
            unref(c[1].exp, c[1].sel); changed = true; clear(c, 1);
          } else if (c[0].sel === TE_0 && c[1].sel === TE_0) {
            t.c_op = 0; changed = true; c[0] = c[2]; clear(c, 2);
          }
          break;
      }
    }
    if (t.a_op !== UNDEF && t.a_ref === 0) {
      t.a_op = UNDEF;
      for (let i = 0; i < 4; i++) { unref(a[i].exp, a[i].sel); clear(a, i); }
      changed = true;
    }
    switch (t.a_op) {
      case 0: case 1:
        if (a[2].sel === TE_0) {
          if (a[1].sel !== TE_0) { unref(a[1].exp, a[1].sel); changed = true; clear(a, 1); }
          if (t.a_op === 0 && a[3].sel === TE_0 && a[0].sel !== TE_0) { changed = true; a[3] = a[0]; clear(a, 0); }
        }
        if (a[2].sel === TE_1) {
          if (a[0].sel !== TE_0) { unref(a[0].exp, a[0].sel); changed = true; clear(a, 0); }
          if (t.a_op === 0 && a[3].sel === TE_0) { changed = true; a[3] = a[1]; clear(a, 1); clear(a, 2); }
        }
        if (a[0].sel === TE_0 && a[1].sel === TE_0 && a[3].sel === TE_0) { t.a_op = UNDEF; changed = true; }
        break;
      case 8: case 9: case 0xa: case 0xb: case 0xc: case 0xd:
        if (a[2].sel === TE_0) {
          t.a_op = 0;
          unref(a[0].exp, a[0].sel); clear(a, 0);
          unref(a[1].exp, a[1].sel); changed = true; clear(a, 1);
        }
        break;
      case 0xe:
        if (a[2].sel === TE_0) {
          t.a_op = 0;
          unref(a[0].exp, a[0].sel); clear(a, 0);
          unref(a[1].exp, a[1].sel); changed = true; clear(a, 1);
        } else if (a[0].sel === TE_0) {
          t.a_op = 0;
          unref(a[1].exp, a[1].sel); clear(a, 1);
          unref(a[2].exp, a[2].sel); changed = true; clear(a, 2);
        }
        break;
      case 0xf:
        if (a[2].sel === TE_0) {
          t.a_op = 0;
          unref(a[0].exp, a[0].sel); clear(a, 0);
          unref(a[1].exp, a[1].sel); changed = true; clear(a, 1);
        } else if (a[0].sel === TE_0 && a[1].sel === TE_0) {
          t.a_op = 0; changed = true; a[0] = a[2]; clear(a, 2);
        }
        break;
    }
    if (changed) result = true;
  } while (changed);
  return result;
}

const biasInt = (b: number) => (b === 1 ? 1 : b === 2 ? -1 : 0);
const conflict = (t: Tev, child: Tev) =>
  (t.tex !== null && child.tex !== null && t.tex !== child.tex) || (t.chan !== UNDEF && child.chan !== UNDEF && t.chan !== child.chan);

/** SimplifyByMerge: a stage that only adds another's lerp to a value takes the lerp in itself (one stage, one
 *  rounding; the biases together, its op flipped by a subtracting child, the child's clamp gone) */
function simplifyByMerge(t: Tev): boolean {
  let result = false, merged: boolean;
  do {
    merged = false;
    if (t.a_op === UNDEF || t.a_op === 0xe || t.a_op === 0xf || t.a_op <= 1) {
      const c = t.c_in;
      if ((t.c_op === 0 || t.c_op === 1) && c[1].sel === TE_0 && c[2].sel === TE_0 && typeOf(c[0].exp) !== T_CNST &&
          typeOf(c[3].exp) !== T_CNST) {
        if (t.c_op === 0 && c[3].type === T_TEV && isTev(c[3].exp) &&
            ((c[3].sel === TE_RGB && c[3].exp.c_clamp !== 0) || (c[3].sel === TE_A && c[3].exp.a_clamp !== 0))) {
          if (c[0].type === T_TEX || c[0].type === T_RAS) { const tmp = c[0]; c[0] = c[3]; c[3] = tmp; }
        }
        if (c[0].type === T_TEV && c[0].sel === TE_RGB && isTev(c[0].exp)) {
          const child = c[0].exp, childSel = c[0].sel;
          if ((child.c_op === 0 || child.c_op === 1) && child.c_in[3].sel === TE_0 && child.c_scale === 0 && !conflict(t, child)) {
            let bias = biasInt(child.c_bias);
            if (child.c_op === 1) bias = -bias;
            bias += biasInt(t.c_bias);
            if (bias >= -1 && bias <= 1) {
              t.c_bias = bias === 1 ? 1 : bias === -1 ? 2 : 0;
              merged = true;
              if (child.c_op === 1) t.c_op = t.c_op === 0 ? 1 : 0;
              for (let i = 0; i < 3; i++) { c[i] = { ...child.c_in[i] }; ref(c[i].exp, c[i].sel); }
              if (t.tex === null) t.tex = child.tex;
              if (t.chan === UNDEF) t.chan = child.chan;
              if (t.tex_swap === UNDEF) t.tex_swap = child.tex_swap;
              if (t.ras_swap === UNDEF) t.ras_swap = child.ras_swap;
              unref(child, childSel);
            }
          }
        } else if (c[0].type === T_ZERO && c[3].type === T_TEV && c[3].sel === TE_RGB && isTev(c[3].exp)) {
          const child = c[3].exp, childSel = c[3].sel;
          if (child.c_scale === 0 && (t.c_bias === 0 || t.c_bias !== child.c_bias) && !conflict(t, child)) {
            merged = true;
            for (let i = 0; i < 4; i++) { c[i] = { ...child.c_in[i] }; ref(c[i].exp, c[i].sel); }
            t.c_op = child.c_op;
            let bias = biasInt(child.c_bias);
            if (child.c_op === 1) bias = -bias;
            bias += biasInt(t.c_bias);
            t.c_bias = bias === 1 ? 1 : bias === -1 ? 2 : 0;
            if (t.c_clamp === UNDEF || t.c_clamp === 0) t.c_clamp = child.c_clamp;
            if (t.tex === null) t.tex = child.tex;
            if (t.chan === UNDEF) t.chan = child.chan;
            if (t.tex_swap === UNDEF) t.tex_swap = child.tex_swap;
            if (t.ras_swap === UNDEF) t.ras_swap = child.ras_swap;
            unref(child, childSel);
          }
        }
      }
      const a = t.a_in;
      if ((t.a_op === 0 || t.a_op === 1) && a[1].sel === TE_0 && a[2].sel === TE_0 && typeOf(a[0].exp) !== T_CNST &&
          typeOf(a[3].exp) !== T_CNST) {
        if (t.a_op === 0 && a[3].type === T_TEV && isTev(a[3].exp) && a[3].exp.a_clamp !== 0) {
          if (a[0].type === T_TEX || a[0].type === T_RAS) { const tmp = a[0]; a[0] = a[3]; a[3] = tmp; }
        }
        if (a[0].type === T_TEV && isTev(a[0].exp)) {
          const child = a[0].exp, childSel = a[0].sel;
          if ((child.a_op === 0 || child.a_op === 1) && child.a_in[3].sel === TE_0 && child.a_scale === 0 && !conflict(t, child)) {
            let bias = biasInt(child.a_bias);
            if (child.a_op === 1) bias = -bias;
            bias += biasInt(t.a_bias);
            if (bias >= -1 && bias <= 1) {
              t.a_bias = bias === 1 ? 1 : bias === -1 ? 2 : 0;
              merged = true;
              if (child.a_op === 1) t.a_op = t.a_op === 0 ? 1 : 0;
              for (let i = 0; i < 3; i++) { a[i] = { ...child.a_in[i] }; ref(a[i].exp, a[i].sel); }
              if (t.tex === null) t.tex = child.tex;
              if (t.chan === UNDEF) t.chan = child.chan;
              unref(child, childSel);
            }
          }
        } else if (a[0].type === T_ZERO && a[3].type === T_TEV && isTev(a[3].exp)) {
          const child = a[3].exp, childSel = a[3].sel;
          if (child.a_scale === 0 && (t.a_bias === 0 || t.a_bias !== child.a_bias) && !conflict(t, child)) {
            merged = true;
            for (let i = 0; i < 4; i++) { a[i] = { ...child.a_in[i] }; ref(a[i].exp, a[i].sel); }
            t.a_op = child.a_op;
            let bias = biasInt(child.a_bias);
            if (child.a_op === 1) bias = -bias;
            bias += biasInt(t.a_bias);
            t.a_bias = bias === 1 ? 1 : bias === -1 ? 2 : 0;
            if (t.a_clamp === UNDEF || t.a_clamp === 0) t.a_clamp = child.a_clamp;
            if (t.tex === null) t.tex = child.tex;
            if (t.chan === UNDEF) t.chan = child.chan;
            unref(child, childSel);
          }
        }
      }
    }
    if (merged) result = true;
  } while (merged);
  return result;
}

/** HSD_TExpSimplify */
function simplify(t: Exp): boolean {
  if (!t || t.kind !== "tev") return false;
  let res = false;
  if (simplifySrc(t)) res = true;
  if (simplifyThis(t)) res = true;
  if (simplifyByMerge(t)) res = true;
  return res;
}

// ---------------------------------------------------------------- MObjMakeTExp, TObjMakeTExp, MakeColorGenTExp

/** a constant's id in the stage table: 0 the diffuse color, 1 the material's alpha, 2 the specular color,
 *  3 + s sampler s's blending, 8 + 3 s + k sampler s's own TEV konst (k 0), tev0 (1), tev1 (2) */
export const CNST_DIFFUSE = 0, CNST_ALPHA = 1, CNST_SPECULAR = 2, CNST_BLEND = 3, CNST_TEXREG = 8;

const LM = { DIFFUSE: 1 << 4, SPECULAR: 1 << 5, AMBIENT: 1 << 6, EXT: 1 << 7, SHADOW: 1 << 8 };
const LM_ALL = LM.DIFFUSE | LM.SPECULAR | LM.AMBIENT | LM.EXT | LM.SHADOW;

class Builder {
  private cnsts = new Map<string, Cnst>();
  /** HSD_TExpCnst: one node a value and part */
  cnst(key: string, id: number, comp: number, chan = 0): Cnst {
    const k = `${key}:${comp}:${chan}`;
    let c = this.cnsts.get(k);
    if (!c) this.cnsts.set(k, (c = { kind: "cnst", key: k, id, comp, ref: 0 }));
    (c as Cnst & { chan: number }).chan = chan;
    return c;
  }
}

/** MakeColorGenTExp: a texture's own TEV stage (HSD_TObjTevDesc) as a node; c and a its color and alpha */
function makeColorGenTExp(b: Builder, t: TObj, sampler: number): { c: Exp; a: Exp } {
  const tev = t.tev!;
  const reg = CNST_TEXREG + sampler * 3;
  const konst = (comp: number, chan: number) => b.cnst(`konst${sampler}`, reg, comp, chan);
  const pass = (src: Cnst, alpha: boolean): Tev => {
    const p = texpTev();
    if (alpha) { alphaOp(p, 0, 0, 0, 1); alphaIn(p, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_X, src); }
    else { colorOp(p, 0, 0, 0, 1); colorIn(p, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, src.comp, src); }
    return p;
  };
  const e0 = texpTev();
  e0.tex = sampler;
  let c: Exp = EXP_TEX, a: Exp = EXP_TEX;
  if (tev.active & 0x40000000) {
    const sel: number[] = [], exp: Exp[] = [];
    for (const code of tev.colorIn) {
      let s = TE_0, e: Exp = EXP_ZERO;
      switch (code) {
        case 15: break; // GX_CC_ZERO
        case 12: s = TE_1; break; // GX_CC_ONE
        case 13: s = TE_4_8; break; // GX_CC_HALF
        case 8: s = TE_RGB; e = EXP_TEX; break; // GX_CC_TEXC
        case 9: s = TE_A; e = EXP_TEX; break; // GX_CC_TEXA
        case 0x80: s = TE_RGB; e = konst(TE_RGB, 0); break;
        case 0x81: s = TE_X; e = konst(TE_X, 0); break;
        case 0x82: s = TE_X; e = konst(TE_X, 1); break;
        case 0x83: s = TE_X; e = konst(TE_X, 2); break;
        case 0x84: s = TE_X; e = konst(TE_X, 3); break;
        case 0x85: s = TE_RGB; e = pass(b.cnst(`tev0${sampler}`, reg + 1, TE_RGB), false); break;
        case 0x86: s = TE_RGB; e = pass(b.cnst(`tev0${sampler}`, reg + 1, TE_X, 3), false); break;
        case 0x87: s = TE_RGB; e = pass(b.cnst(`tev1${sampler}`, reg + 2, TE_RGB), false); break;
        case 0x88: s = TE_RGB; e = pass(b.cnst(`tev1${sampler}`, reg + 2, TE_X, 3), false); break;
      }
      sel.push(s); exp.push(e);
    }
    colorOp(e0, tev.colorOp, tev.colorBias, tev.colorScale, tev.colorClamp);
    colorIn(e0, sel[0], exp[0], sel[1], exp[1], sel[2], exp[2], sel[3], exp[3]);
    c = e0;
  }
  if (tev.active & 0x80000000) {
    const sel: number[] = [], exp: Exp[] = [];
    for (const code of tev.alphaIn) {
      let s = TE_0, e: Exp = EXP_ZERO;
      switch (code) {
        case 7: break; // GX_CA_ZERO
        case 4: s = TE_A; e = EXP_TEX; break; // GX_CA_TEXA
        case 0x40: s = TE_X; e = konst(TE_X, 0); break;
        case 0x41: s = TE_X; e = konst(TE_X, 1); break;
        case 0x42: s = TE_X; e = konst(TE_X, 2); break;
        case 0x43: s = TE_X; e = konst(TE_X, 3); break;
        case 0x44: s = TE_A; e = pass(b.cnst(`tev0${sampler}`, reg + 1, TE_X, 3), true); break;
        case 0x45: s = TE_A; e = pass(b.cnst(`tev1${sampler}`, reg + 2, TE_X, 3), true); break;
      }
      sel.push(s); exp.push(e);
    }
    alphaOp(e0, tev.alphaOp, tev.alphaBias, tev.alphaScale, tev.alphaClamp);
    alphaIn(e0, sel[0], exp[0], sel[1], exp[1], sel[2], exp[2], sel[3], exp[3]);
    a = e0;
  }
  return { c, a };
}

/** TObjMakeTExp: a texture's color map and alpha map laid on the color and alpha so far */
function tobjMakeTExp(b: Builder, t: TObj, sampler: number, done: number, st: { c: Exp; a: Exp }) {
  const repeat = (done & t.flags & LM_ALL) !== 0;
  let cSrc: Exp = EXP_TEX, aSrc: Exp = EXP_TEX;
  const cSel = TE_RGB, aSel = TE_A;
  const e0 = texpTev();
  if (t.tev && t.tev.active & 0xc0000000) {
    const g = makeColorGenTExp(b, t, sampler);
    cSrc = g.c; aSrc = g.a;
  }
  e0.tex = sampler;
  const blend = () => b.cnst(`blend${sampler}`, CNST_BLEND + sampler, TE_X);
  switch ((t.flags >> 16) & 0xf) {
    case 1: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_RGB, st.c, cSel, cSrc, aSel, aSrc, TE_0, EXP_ZERO); break;
    case 2: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_RGB, st.c, cSel, cSrc, cSel, cSrc, TE_0, EXP_ZERO); break;
    case 3: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_RGB, st.c, cSel, cSrc, TE_X, blend(), TE_0, EXP_ZERO); break;
    case 4: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_0, EXP_ZERO, TE_RGB, st.c, cSel, cSrc, TE_0, EXP_ZERO); break;
    case 5: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, cSel, cSrc); break;
    case 7: colorOp(e0, 0, 0, 0, 1); colorIn(e0, cSel, cSrc, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, st.c); break;
    case 8: colorOp(e0, 1, 0, 0, 1); colorIn(e0, cSel, cSrc, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, st.c); break;
    default: colorOp(e0, 0, 0, 0, 1); colorIn(e0, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, st.c); break; // NONE, PASS
  }
  st.c = e0;
  if (!repeat) {
    switch ((t.flags >> 20) & 0xf) {
      case 1: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, TE_A, st.a, aSel, aSrc, aSel, aSrc, TE_0, EXP_ZERO); break;
      case 2: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, TE_A, st.a, aSel, aSrc, TE_X, blend(), TE_0, EXP_ZERO); break;
      case 3: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, TE_0, EXP_ZERO, TE_A, st.a, aSel, aSrc, TE_0, EXP_ZERO); break;
      case 4: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, aSel, aSrc); break;
      case 6: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, aSel, aSrc, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_A, st.a); break;
      case 7: alphaOp(e0, 1, 0, 0, 1); alphaIn(e0, aSel, aSrc, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_A, st.a); break;
      default: alphaOp(e0, 0, 0, 0, 1); alphaIn(e0, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_A, st.a); break;
    }
    st.a = e0;
  }
}

/** MObjMakeTExp: the material's graph. `samplerOf` is the sampler a texture of the material's list has (or -1:
 *  left out, as a texture without a texture map is) */
function mobjMakeTExp(mo: MObj, tobjs: TObj[], samplerOf: (i: number) => number): Tev {
  const b = new Builder();
  const mode = mo.renderMode;
  const st: { c: Exp; a: Exp } = { c: null, a: null };
  {
    const exp = texpTev();
    if (mode & 2) {
      exp.chan = COLOR0A0;
      colorOp(exp, 0, 0, 0, 1);
      colorIn(exp, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, EXP_RAS);
      alphaOp(exp, 0, 0, 0, 1);
      alphaIn(exp, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_A, EXP_RAS);
    } else {
      colorOp(exp, 0, 0, 0, 1);
      colorIn(exp, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, b.cnst("diffuse", CNST_DIFFUSE, TE_RGB));
      alphaOp(exp, 0, 0, 0, 1);
      alphaIn(exp, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_X, b.cnst("alpha", CNST_ALPHA, TE_X));
    }
    st.c = st.a = exp;
  }
  let done = 0;
  const pass = (lm: number, which: { c: Exp; a: Exp }) => {
    tobjs.forEach((t, i) => {
      const s = samplerOf(i);
      if (!(t.flags & lm) || s < 0) return;
      tobjMakeTExp(b, t, s, done, which);
    });
  };
  pass(LM.DIFFUSE | LM.AMBIENT, st);
  done |= LM.DIFFUSE | LM.AMBIENT;
  if (mode & 4) {
    const e = texpTev();
    e.chan = COLOR0A0;
    colorOp(e, 0, 0, 0, 1);
    colorIn(e, TE_0, EXP_ZERO, TE_RGB, st.c, TE_RGB, EXP_RAS, TE_0, EXP_ZERO);
    st.c = e;
    alphaOp(e, 0, 0, 0, 1);
    alphaIn(e, TE_0, EXP_ZERO, TE_A, st.a, TE_A, EXP_RAS, TE_0, EXP_ZERO);
    st.a = e;
  }
  if (mode & 8) {
    let e = texpTev();
    colorOp(e, 0, 0, 0, 1);
    colorIn(e, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, b.cnst("specular", CNST_SPECULAR, TE_RGB));
    const spec = { c: e as Exp, a: st.a };
    pass(LM.SPECULAR, spec);
    st.a = spec.a;
    done |= LM.SPECULAR;
    e = texpTev();
    e.chan = COLOR1A1;
    colorOp(e, 0, 0, 0, 1);
    colorIn(e, TE_0, EXP_ZERO, TE_RGB, spec.c, TE_RGB, EXP_RAS, TE_0, EXP_ZERO);
    const lit = e;
    e = texpTev();
    colorOp(e, 0, 0, 0, 1);
    colorIn(e, TE_RGB, lit, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, st.c);
    st.c = e;
  }
  const ext = { c: st.c, a: st.a };
  pass(LM.EXT, ext);
  if (ext.c !== ext.a || typeOf(ext.c) !== T_TEV || typeOf(ext.a) !== T_TEV) {
    const e = texpTev();
    colorOp(e, 0, 0, 0, 1);
    colorIn(e, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_RGB, ext.c);
    alphaOp(e, 0, 0, 0, 1);
    alphaIn(e, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_0, EXP_ZERO, TE_A, ext.a);
    return e;
  }
  return ext.c as Tev;
}

// ---------------------------------------------------------------- the stages, as a table

/** an input of a stage, encoded: kind (0 zero, 1 a value, 2 the stage's texel, 3 its rasterized color, 4 a
 *  constant, 5 an earlier stage's result) | part (0 rgb, 1 r, 2 g, 3 b, 4 a) << 3 | index (the value, the constant's
 *  id, the stage) << 6 */
export const IN_ZERO = 0, IN_VALUE = 1, IN_TEX = 2, IN_RAS = 3, IN_CNST = 4, IN_STAGE = 5;
const code = (kind: number, part: number, index = 0) => kind | (part << 3) | (index << 6);

/** one hardware stage: its color and alpha inputs (encoded), their ops (op | bias << 4 | scale << 6 | clamp << 8 |
 *  on << 9), the sampler it reads (-1 none), the rasterized color it takes (0 COLOR0A0, 1 COLOR1A1, -1 none) */
export interface TevStage { c: number[]; a: number[]; cMode: number; aMode: number; tex: number; chan: number }
/** a material's compiled TEV: its stages in an order each reads only earlier ones, and the one whose result the
 *  pixel takes */
export interface TevProgram { stages: TevStage[]; out: number }

const mode = (op: number, bias: number, scale: number, clamp: number, on: boolean) =>
  (op === UNDEF ? 0 : op & 15) | ((bias === UNDEF ? 0 : bias & 3) << 4) | ((scale === UNDEF ? 0 : scale & 3) << 6) |
  (clamp !== 0 ? 1 << 8 : 0) | (on ? 1 << 9 : 0);

/** HSD_TExpCompile for a material: its graph made, simplified as HSD simplifies it, and laid out as stages */
export function compileTExp(mo: MObj, tobjs: TObj[], samplerOf: (i: number) => number): TevProgram {
  const root = mobjMakeTExp(mo, tobjs, samplerOf);
  ref(root, TE_RGB);
  ref(root, TE_A);
  simplify(root);
  const index = new Map<Tev, number>();
  const stages: TevStage[] = [];
  const partOf = (sel: number) => (sel === TE_RGB ? 0 : sel === TE_R ? 1 : sel === TE_G ? 2 : sel === TE_B ? 3 : 4);
  const encode = (t: Tev, arg: Arg, alpha: boolean): number => {
    switch (arg.type) {
      case T_ZERO: return code(IN_ZERO, 0);
      case T_IMM: return code(IN_VALUE, 0, arg.sel === TE_1 ? 255 : 128);
      case T_KONST: return code(IN_VALUE, 0, KSEL_VALUE[(alpha ? t.kasel : t.kcsel) & 7] ?? 255);
      case T_TEX: return code(IN_TEX, alpha ? 4 : partOf(arg.sel));
      case T_RAS: return code(IN_RAS, alpha ? 4 : partOf(arg.sel));
      case T_CNST: {
        const c = arg.exp as Cnst & { chan: number };
        // (a scalar: the one byte - its channel of the register - in every part)
        return code(IN_CNST, c.comp === TE_X ? 1 + c.chan : 0, c.id);
      }
      case T_TEV: {
        const src = arg.exp as Tev, a = alpha || arg.sel === TE_A;
        // (a stage that only passes a constant on - 0 + d, clamped, a byte - read as the constant itself: the same
        // value, one stage fewer)
        const pass = a ? src.a_op === 0 && src.a_bias === 0 && src.a_scale === 0 && src.a_in[3].type === T_CNST &&
                         src.a_in[0].sel === TE_0 && src.a_in[1].sel === TE_0 && src.a_in[2].sel === TE_0
          : src.c_op === 0 && src.c_bias === 0 && src.c_scale === 0 && src.c_in[3].type === T_CNST &&
            src.c_in[0].sel === TE_0 && src.c_in[1].sel === TE_0 && src.c_in[2].sel === TE_0;
        if (pass) return encode(src, a ? src.a_in[3] : src.c_in[3], a);
        return code(IN_STAGE, a ? 4 : 0, visit(src));
      }
      default: return code(IN_ZERO, 0);
    }
  };
  const visit = (t: Tev): number => {
    const known = index.get(t);
    if (known !== undefined) return known;
    const cOn = t.c_op !== UNDEF, aOn = t.a_op !== UNDEF;
    const c = t.c_in.map((x) => (cOn ? encode(t, x, false) : 0));
    const a = t.a_in.map((x) => (aOn ? encode(t, x, true) : 0));
    const k = stages.length;
    stages.push({ c, a, cMode: mode(t.c_op, t.c_bias, t.c_scale, t.c_clamp, cOn), aMode: mode(t.a_op, t.a_bias, t.a_scale, t.a_clamp, aOn),
                  tex: t.tex ?? -1, chan: t.chan === COLOR0A0 ? 0 : t.chan === COLOR1A1 ? 1 : -1 });
    index.set(t, k);
    return k;
  };
  const out = visit(root);
  return { stages, out };
}

// ---------------------------------------------------------------- running it

/** the integer TEV stage (gx.ts tevStage, tevCompare): its arithmetic */
export interface TevMath {
  stage(a: number, b: number, c: number, d: number, op: number, bias: number, scale: number, clamp: boolean): number;
  compare(op: number, a: number[], b: number[], c: number[], d: number[], alpha: boolean, clamp: boolean): number[];
}

/** what a program's stages read: each sampler's texel, the two rasterized colors, the constants (bytes, rgba) */
export interface TevInputs { texel(s: number): number[]; ras(chan: number): number[]; cnst(id: number): number[] }

/** run a program: every stage in turn, its result 10-bit (or clamped); the output stage's color and alpha */
export function runTev(p: TevProgram, inp: TevInputs, m: TevMath): number[] {
  const res: number[][] = [];
  for (let k = 0; k < p.stages.length; k++) {
    const s = p.stages[k];
    const fetch = (x: number): number[] => {
      const kind = x & 7, part = (x >> 3) & 7, idx = x >> 6;
      let v: number[];
      switch (kind) {
        case IN_VALUE: return [idx, idx, idx, idx];
        case IN_TEX: v = s.tex >= 0 ? inp.texel(s.tex) : [0, 0, 0, 0]; break;
        case IN_RAS: v = s.chan >= 0 ? inp.ras(s.chan) : [0, 0, 0, 0]; break;
        case IN_CNST: v = inp.cnst(idx); break;
        case IN_STAGE: v = res[idx] ?? [0, 0, 0, 0]; break;
        default: return [0, 0, 0, 0];
      }
      if (part === 0) return v;
      const q = v[part - 1 < 3 ? part - 1 : 3];
      return [q, q, q, q];
    };
    const out = [0, 0, 0, 0];
    const cA = fetch(s.c[0]), cB = fetch(s.c[1]), cC = fetch(s.c[2]), cD = fetch(s.c[3]);
    if (s.cMode & 512) {
      const op = s.cMode & 15, bias = (s.cMode >> 4) & 3, scale = (s.cMode >> 6) & 3, cl = (s.cMode & 256) !== 0;
      if (op >= 8) { const r = m.compare(op, cA, cB, cC, cD, false, cl); out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; }
      else for (let i = 0; i < 3; i++) out[i] = m.stage(cA[i], cB[i], cC[i], cD[i], op, bias, scale, cl);
    }
    if (s.aMode & 512) {
      const aA = fetch(s.a[0]), aB = fetch(s.a[1]), aC = fetch(s.a[2]), aD = fetch(s.a[3]);
      const op = s.aMode & 15, bias = (s.aMode >> 4) & 3, scale = (s.aMode >> 6) & 3, cl = (s.aMode & 256) !== 0;
      out[3] = op >= 8 ? m.compare(op, [cA[0], cA[1], cA[2], aA[3]], [cB[0], cB[1], cB[2], aB[3]], [0, 0, 0, aC[3]], [0, 0, 0, aD[3]], true, cl)[0]
        : m.stage(aA[3], aB[3], aC[3], aD[3], op, bias, scale, cl);
    }
    res.push(out);
  }
  return res[p.out] ?? [0, 0, 0, 0];
}

/** a program as the material block holds it (renderer.ts: three ivec4 a stage) */
export function packTev(p: TevProgram, out: Int32Array, at: number, max: number): number {
  const n = Math.min(p.stages.length, max);
  for (let k = 0; k < n; k++) {
    const s = p.stages[k], o = at + k * 12;
    out[o] = s.c[0]; out[o + 1] = s.c[1]; out[o + 2] = s.c[2]; out[o + 3] = s.c[3];
    out[o + 4] = s.a[0]; out[o + 5] = s.a[1]; out[o + 6] = s.a[2]; out[o + 7] = s.a[3];
    out[o + 8] = s.cMode; out[o + 9] = s.aMode; out[o + 10] = s.tex; out[o + 11] = s.chan;
  }
  return n;
}
