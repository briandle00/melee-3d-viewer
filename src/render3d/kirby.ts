/* 3D replay viewer: Kirby's copy abilities.
 *
 * Kirby wears a hat of the character he has copied (ftkirby.c). Most hats
 * are one small model of the copy's file, PlKbCp<xx>.dat, whose public
 * symbol ftDataKirbyCopy<Name> begins with the hat's joint and its parts'
 * visibility tables (KirbyHatStruct); the game copies Kirby's joint 6's
 * matrix onto it each frame it draws it (ftKb_UnkMtxFunc0). Five copies
 * (Donkey Kong, Jigglypuff, Mewtwo, Falco, Mr. Game & Watch) have a hat in
 * Kirby's own colors instead, a whole skeleton like his, in a file per
 * costume (PlKb<color>Cp<xx>.dat: ftKb_Init_803CB3E8), its visibility
 * tables at the head of the copy's symbol; it moves with his joints.
 *
 * Which copy he has is the viewer track's ("charge", "kb.kind": the hat's
 * fighter kind, 4 for none); without a track it is worked out from the
 * replay: the character he swallowed as he drank it in, the copy's own
 * special moves, and gone when he is KO'd or taunts.
 */
import { loadJoint, parseArchive, ptr, type Archive } from "./hsd";
import { loadArticle, type Article } from "./fighter";
import { partSkips, partToModelJoint } from "./parts";
import { Prop } from "./prop";
import { Skeleton } from "./skeleton";
import { FaceTextures, faceTextures } from "./face";

export const KIRBY = 4;

/** the copies: their file's code and the name in the copy's symbol */
export const COPIES: Record<number, { code: string; name: string; colored?: boolean }> = {
  0: { code: "Mr", name: "Mario" }, 1: { code: "Fx", name: "Fox" }, 2: { code: "Ca", name: "Captain" },
  3: { code: "Dk", name: "Donkey", colored: true }, 5: { code: "Kp", name: "Koopa" }, 6: { code: "Lk", name: "Link" },
  7: { code: "Sk", name: "Seak" }, 8: { code: "Ns", name: "Ness" }, 9: { code: "Pe", name: "Peach" },
  10: { code: "Pp", name: "Popo" }, 12: { code: "Pk", name: "Pikachu" }, 13: { code: "Ss", name: "Samus" },
  14: { code: "Ys", name: "Yoshi" }, 15: { code: "Pr", name: "Purin", colored: true },
  16: { code: "Mt", name: "Mewtwo", colored: true }, 17: { code: "Lg", name: "Luigi" }, 18: { code: "Ms", name: "Mars" },
  19: { code: "Zd", name: "Zelda" }, 20: { code: "Cl", name: "Clink" }, 21: { code: "Dr", name: "Drmario" },
  22: { code: "Fc", name: "Falco", colored: true }, 23: { code: "Pc", name: "Pichu" },
  24: { code: "Gw", name: "Gamewatch", colored: true }, 25: { code: "Gn", name: "Ganon" }, 26: { code: "Fe", name: "Emblem" },
};
const COLORS = ["Nr", "Ye", "Bu", "Re", "Gr", "Wh"];
/** the joint a small hat sits on (ftKb_UnkMtxFunc0: parts[6]) */
export const HAT_JOINT = 6;

export interface KirbyHat {
  /** a small hat on Kirby's joint 6 */
  prop: Prop | null;
  /** a hat in Kirby's colors: a skeleton like his, posed as he is */
  skin: Skeleton | null;
  /** a colored hat's meshes hidden in the passes that draw his low-detail model - the shadows' and a
   *  mirror's (ftDrawCommon_80081200, ftDrawCommon_80080C28: ftParts_800750C8 hides lookup 0 and shows
   *  lookup 1, which ftKb_UnkIntBoolFunc0 does to the hat's meshes too) */
  lowHidden?: Set<number>;
  /** Mr. Game & Watch's: the outline's shells (drawn first, in its color,
   *  as his are), and how thin it is across (ftKb_SpecialN_800F14B4) */
  outline?: { shown: Set<number>; hidden: Set<number>; color: [number, number, number, number] };
  thin?: number;
  /** a colored hat's extra joints (the copy's mask of PlCo.dat's entries:
   *  its symbol's +0x10), and its joints' map onto his (hatJointMap) */
  mask?: number;
  map?: number[];
  /** and each of its joints' part in his part list (hatJointParts) */
  parts?: number[];
  /** a colored hat's face: the textures turned with Kirby's own (its
   *  symbol's +8: ftKb_Init_UnkCallbackPairs0_1, face.ts) */
  face?: FaceTextures | null;
  /** Yoshi's copy: the hat with the animations his moves put on it (its
   *  tongue: the copy data's slots 1-3, HSD_JObjAddAnimAll on the hat), by slot */
  anims?: (Prop | null)[];
}

/** the files a copy's hat needs: the copy's data, and its colored model (or null) */
export function hatFiles(kind: number, costume: number): [string, string | null] | null {
  const c = COPIES[kind];
  if (!c) return null;
  // (Mr. Game & Watch's colored hat is in the plain color only)
  const col = kind === 24 ? "Nr" : COLORS[costume] ?? "Nr";
  return [`PlKbCp${c.code}.dat`, c.colored ? `PlKb${col}Cp${c.code}.dat` : null];
}

/** a parts visibility description (FtPartsDesc: model count, then the tables
 *  per costume): the meshes to hide - lookups 1 and 3 (the game shows every
 *  variant of a hat's lookup 0 while it draws: ftKb_UnkIntBoolFunc0,
 *  ftParts_80074CA0); with `shownLookup` 1, its low-detail look's: lookups 0
 *  and 3 hidden, every variant of lookup 1 shown */
function hiddenBy(a: Archive, desc: number, costume = 0, metal = false, shownLookup = 0): Set<number> {
  const d = a.data, out = new Set<number>(), shown = new Set<number>();
  const n = d.getUint32(desc), vis = ptr(a, desc + 4);
  if (vis === null || n > 64) return out;
  // (a small hat's metal look, lookup 2, is in its own meshes too: hidden)
  for (const k of metal ? [0, 1, 2, 3] : [0, 1, 3]) {
    const lk = ptr(a, vis + costume * 16 + k * 4) ?? ptr(a, vis + k * 4);
    for (let m = 0; lk !== null && m < n; m++) {
      const count = d.getUint32(lk + m * 8), list = ptr(a, lk + m * 8 + 4);
      for (let v = 0; v < count && v < 64 && list !== null; v++) {
        const c = d.getUint32(list + v * 8), ids = ptr(a, list + v * 8 + 4);
        for (let i = 0; i < c && i < 256 && ids !== null; i++) (k === shownLookup ? shown : out).add(d.getUint8(ids + i));
      }
    }
  }
  shown.forEach((i) => out.delete(i));
  return out;
}

/** a copy's hat from its files (see hatFiles) */
/** the meshes of a lookup's model parts, every variant (FtPartsVisLookup) */
function lookupMeshes(a: Archive, lk: number, n: number): Set<number> {
  const d = a.data, out = new Set<number>();
  for (let m = 0; m < n; m++) {
    const count = d.getUint32(lk + m * 8), list = ptr(a, lk + m * 8 + 4);
    for (let v = 0; v < count && v < 64 && list !== null; v++) {
      const c = d.getUint32(list + v * 8), ids = ptr(a, list + v * 8 + 4);
      for (let i = 0; i < c && i < 256 && ids !== null; i++) out.add(d.getUint8(ids + i));
    }
  }
  return out;
}

export function loadHat(kind: number, data: ArrayBuffer, colored: ArrayBuffer | null, tag: string,
                        costume = 0): KirbyHat | null {
  const c = COPIES[kind];
  if (!c) return null;
  const a = parseArchive(data);
  const sym = a.publics.get(`ftDataKirbyCopy${c.name}`);
  if (sym === undefined) return null;
  if (colored) {
    const m = parseArchive(colored);
    const share = [...m.publics].find(([k]) => k.endsWith("_Share_joint"));
    if (!share) return null;
    const { all, dobjs } = loadJoint(m, share[1]);
    const skin = new Skeleton(m, all, dobjs, `${tag}:kbhat`);
    const normal = hiddenBy(a, sym, costume);
    normal.forEach((i) => skin.hidden.add(i));
    const hat: KirbyHat = { prop: null, skin, mask: a.data.getUint32(sym + 0x10),
                            face: faceTextures(a, sym + 8, costume, m, skin, all) };
    // Mr. Game & Watch's copy: its outline's lookup (+0x18), and its looks
    // (+0x1C: how thin, the color, the outline's color)
    const ol = ptr(a, sym + 0x18), looks = ptr(a, sym + 0x1c);
    if (kind === 24 && ol !== null && looks !== null) {
      const d = a.data;
      const shells = lookupMeshes(a, ol, d.getUint32(sym));
      const rgb = (at: number) => [0, 1, 2].map((k) => d.getUint8(at + k) / 255) as [number, number, number];
      // (the outline's own meshes take the looks' color: the rest keep their
      // own, his eyes white - ftKb_SpecialN_800F1420)
      const body = rgb(looks + 4);
      shells.forEach((i) => { const st = skin.states[i]; if (st) st.diffuse.set(body); });
      shells.forEach((i) => { skin.hidden.add(i); skin.alsoPosed.add(i); });
      const hidden = new Set<number>();
      for (let i = 0; i < skin.states.length; i++) if (!shells.has(i)) hidden.add(i);
      // (its alpha the share it takes of the lit color: ftkirby.c copies the
      // four bytes to x610_color_rgba[1], as his own attributes' do)
      hat.outline = { shown: shells, hidden, color: [...rgb(looks + 8), d.getUint8(looks + 11) / 255] as [number, number, number, number] };
      const w = d.getFloat32(looks);
      if (w > 0.001 && w < 10) hat.thin = w;
    }
    // (the low-detail look: lookup 1's meshes for lookup 0's, the rest hidden as they always are)
    hat.lowHidden = hiddenBy(a, sym, costume, false, 1);
    skin.hidden.forEach((i) => { if (!normal.has(i)) hat.lowHidden!.add(i); });
    return hat;
  }
  const joint = ptr(a, sym);
  if (joint === null) return null;
  const prop = new Prop(a, joint, null, null, `${tag}:kbhat`);
  const hidden = hiddenBy(a, sym + 4, 0, true);
  hidden.forEach((i) => prop.skeleton.hidden.add(i));
  const hat: KirbyHat = { prop, skin: null };
  if (kind === 14) {
    hat.anims = [0, 1, 2, 3].map((slot) => {
      const an = slot === 0 ? null : ptr(a, sym + 0xc + slot * 4);
      if (an === null) return null;
      try {
        const p = new Prop(a, joint, an, null, `${tag}:kbhat:${slot}`);
        hidden.forEach((i) => p.skeleton.hidden.add(i));
        return p;
      } catch { return null; }
    });
  }
  return hat;
}

/** A colored hat's joints are Kirby's parts in order, with the extra
 *  joints its copy adds where his part list keeps room for them (the
 *  entries of PlCo.dat's table its copy's mask names: ftKb_SpecialN_800EF040).
 *  For each of the hat's joints: his model's joint it moves as, or -1 for
 *  one of its own (the game swings them as loose bones: left at its rest
 *  pose unless the viewer track has them, poseSkin) */
export function hatJointMap(hatJoints: number, mask: number): number[] {
  const skips = partSkips(KIRBY), out: number[] = [];
  for (let p = 0; out.length < hatJoints && p < hatJoints + skips.length; p++) {
    const i = skips.indexOf(p);
    if (i < 0) out.push(partToModelJoint(KIRBY, p, skips));
    else if (mask & (1 << i)) out.push(-1);
  }
  return out;
}

/** each of a colored hat's joints' part in Kirby's part list (hatJointMap's walk): his own parts, and the
 *  room his list keeps for the copy's extra joints, which ftKb_SpecialN_800EF040 fills with them */
export function hatJointParts(hatJoints: number, mask: number): number[] {
  const skips = partSkips(KIRBY), out: number[] = [];
  for (let p = 0; out.length < hatJoints && p < hatJoints + skips.length; p++) {
    const i = skips.indexOf(p);
    if (i < 0 || mask & (1 << i)) out.push(p);
  }
  return out;
}

// Kirby's Yoshi copy's neutral-B states: the tongue going out (413 on the
// ground, 418 in the air, and catching: 414, 415, 419, 420) and the one
// caught being pulled in (416, 417) - ftkirbyspecialyoshi.c
const YS_FIRST = 413, YS_LAST = 422, YS_PULL = new Set([416, 417]), YS_AIR_START = 418;

/** the animation Yoshi's copy's hat runs on a frame and how far into it:
 *  the tongue going out (the copy data's slot 1 on the ground, 3 in the air)
 *  from the move's start, the pull from when it begins (slot 2), each a
 *  frame on each frame (HSD_JObjAnimAll in the moves' callbacks); null out
 *  of these moves. `state(k)` his state k frames back */
export function yoshiHatAnim(state: (k: number) => number | undefined): { slot: number; frame: number } | null {
  const s = state(0);
  if (s === undefined || s < YS_FIRST || s > YS_LAST) return null;
  let k = 0;
  while (k < 600) {
    const p = state(k + 1);
    if (p === undefined || p < YS_FIRST || p > YS_LAST) break;
    if (YS_PULL.has(state(k)!) && !YS_PULL.has(p)) return { slot: 2, frame: k };
    k++;
  }
  if (YS_PULL.has(s)) return { slot: 2, frame: k };
  const first = state(k)!;
  if (first > 420) return null;
  return { slot: first === YS_AIR_START || first === 419 || first === 420 ? 3 : 1, frame: k };
}

/** a skinned hat posed as Kirby is: his joints' pose copied, then its matrices. `swung`: his joints as the
 *  viewer track has them, by part (its "fj" and "fp" lines: rot, scale, translate, NaN for a value not sent),
 *  laid on the hat's own joints - the copy's extra joints are his parts while he wears it, and the copy's
 *  swinging chain (Mewtwo's tail: ftCo_8009DB50) moves them */
export function poseSkin(hat: KirbyHat, kirby: Skeleton, ...swung: (Map<number, Float32Array> | null | undefined)[]) {
  const sk = hat.skin!;
  // (once PlCo.dat's table is in; until then joint for joint)
  if (!hat.map && partSkips(KIRBY).length) {
    hat.map = hatJointMap(sk.n, hat.mask ?? 0);
    hat.parts = hatJointParts(sk.n, hat.mask ?? 0);
  }
  const map = hat.map ?? Array.from({ length: sk.n }, (_, i) => i);
  sk.resetPose();
  map.forEach((j, h) => {
    if (j < 0) {
      const p = hat.parts?.[h];
      for (const by of swung) {
        const v = p === undefined ? undefined : by?.get(p);
        if (!v) continue;
        for (let k = 0; k < 3; k++) {
          if (!Number.isNaN(v[k])) sk.rot[h * 3 + k] = v[k];
          if (!Number.isNaN(v[3 + k])) sk.scale[h * 3 + k] = v[3 + k];
          if (!Number.isNaN(v[6 + k])) sk.trans[h * 3 + k] = v[6 + k];
        }
      }
      return;
    }
    if (j >= kirby.n) return;
    for (let k = 0; k < 3; k++) {
      sk.rot[h * 3 + k] = kirby.rot[j * 3 + k];
      sk.scale[h * 3 + k] = kirby.scale[j * 3 + k];
      sk.trans[h * 3 + k] = kirby.trans[j * 3 + k];
    }
    sk.shown[h] = kirby.shown[j];
  });
  if (hat.thin !== undefined) sk.scale[0] = hat.thin;
  sk.update();
}

// ---- his copies' projectiles

/** Kirby's copies' items (the replay's item kinds, It_Kind_Kirby_*): the
 *  copy whose file has the article, which of the copy's articles it is (the
 *  list after the hat's parts: ftKb_SpecialN_800F16D0), the original's item
 *  kind it is drawn as, and the joint it is held on when that differs (his
 *  code names his joints by number) */
export const KIRBY_ITEMS: Record<number, { kind: number; slot: number; like?: number; held?: Record<number, { joint: number } | number> }> = {
  0x82: { kind: 0, slot: 0, like: 0x30 },   // Mario's fireball
  0x83: { kind: 21, slot: 0, like: 0x31 },  // Dr. Mario's pill
  0x84: { kind: 17, slot: 0, like: 0x69 },  // Luigi's fireball
  0x85: { kind: 10, slot: 0, like: 0x6a },  // the Ice Climbers' ice
  0x88: { kind: 1, slot: 0, like: 0x36 },   // Fox's laser
  0x89: { kind: 22, slot: 3, like: 0x37 },  // Falco's
  // their blasters, in his hand (44: the R3rdNa its item is made on and the
  // shot comes from, ftkirbyspecialfox.c; the replay leaves it where it was made)
  0x8a: { kind: 1, slot: 1, like: 0x4a, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 44 }])) },
  0x8b: { kind: 22, slot: 4, like: 0x4b, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 44 }])) },
  // Link's and Young Link's arrow, drawn in his right hand (39), and the bow in 44
  0x8c: { kind: 6, slot: 0, like: 0x40, held: { 0: { joint: 39 } } },
  0x8d: { kind: 20, slot: 0, like: 0x41, held: { 0: { joint: 39 } } },
  0x8e: { kind: 6, slot: 1, like: 0x4c, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 44 }])) },
  0x8f: { kind: 20, slot: 1, like: 0x4d, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 44 }])) },
  // Mewtwo's Shadow Ball, held in his right hand (39) while it grows
  0x90: { kind: 16, slot: 3, like: 0x70, held: { 0: { joint: 39 } } },
  0x91: { kind: 8, slot: 0, like: 0x44 },   // PK Flash, and its explosion
  0x92: { kind: 8, slot: 1, like: 0x4e },
  0x93: { kind: 12, slot: 0, like: 0x59 },  // Thunder Jolt (Pikachu's, Pichu's)
  0x94: { kind: 12, slot: 1, like: 0x5a },
  0x95: { kind: 23, slot: 0, like: 0x5b },
  0x96: { kind: 23, slot: 1, like: 0x5c },
  0x97: { kind: 13, slot: 0, like: 0x5e },  // Samus's charge shot
  0x98: { kind: 7, slot: 0, like: 0x4f },   // Sheik's needles, thrown, and held in his hand (39)
  0x99: { kind: 7, slot: 1, like: 0x50, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 39 }])) },
  // Peach's Toad, in his hand (44: ftkirbyspecialpeach.c), and its spores
  0x86: { kind: 9, slot: 0, like: 0x68, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, { joint: 44 }])) },
  0x87: { kind: 9, slot: 1, like: 0x6f },
  // Mr. Game & Watch's Chef: the sausages, and the pan in his left thumb
  // (its named part, 31: ftkirbyspecialgamewatch.c)
  0x9b: { kind: 24, slot: 5, like: 0x7a },
  0x9c: { kind: 24, slot: 6, held: Object.fromEntries([0, 1, 2, 3, 4, 5].map((s) => [s, 31])) },
  // Yoshi's Egg Lay: the egg around the one he swallowed
  0x9d: { kind: 14, slot: 5, like: 0x57 },
};

/** a copy's data file (PlKbCp<xx>.dat), for its articles */
export class KirbyCopy {
  private articles = new Map<string, Article | null>();
  constructor(private a: Archive, private sym: number, private kind: number) {}

  static load(kind: number, data: ArrayBuffer): KirbyCopy | null {
    const c = COPIES[kind];
    if (!c) return null;
    const a = parseArchive(data);
    const sym = a.publics.get(`ftDataKirbyCopy${c.name}`);
    return sym === undefined ? null : new KirbyCopy(a, sym, kind);
  }

  private joints = new Map<number, Prop | null>();
  /** a slot of that list read as a bare joint tree (Yoshi's copy's slot 0:
   *  the egg one laid by Kirby wears, ftKb_SpecialNYs_801093A0), or null */
  joint(slot: number): Prop | null {
    if (this.joints.has(slot)) return this.joints.get(slot)!;
    const j = ptr(this.a, this.sym + 0xc + slot * 4);
    let out: Prop | null = null;
    if (j !== null) {
      try { out = new Prop(this.a, j, null, null, `kbcopy:${this.kind}:joint${slot}`, true); } catch { out = null; }
    }
    this.joints.set(slot, out);
    return out;
  }

  /** one of its articles (+0xC on: KirbyHatStruct's list) in an item state */
  article(slot: number, state: number): Article | null {
    const key = `${slot}:${state}`;
    if (this.articles.has(key)) return this.articles.get(key)!;
    const art = ptr(this.a, this.sym + 0xc + slot * 4);
    const out = art === null ? null : loadArticle(this.a, art, state, `kbcopy:${this.kind}:${slot}:${state}`);
    // Mr. Game & Watch's copy's props (the pan, the sausages): in the copy's
    // body color, with an outline of their own as his are (it_8027CE64,
    // itmaterial.c) - the color and the outline's color its looks (+0x1C)
    // give, the joints of the outline a list at the head of the prop's
    // special attributes
    const looks = ptr(this.a, this.sym + 0x1c), special = art === null ? null : ptr(this.a, art + 0x04);
    if (out && this.kind === 24 && looks !== null) {
      const d = this.a.data;
      const rgb = (at: number) => [0, 1, 2].map((k) => d.getUint8(at + k) / 255);
      const body = [...rgb(looks + 4), 1] as [number, number, number, number];
      for (const s of out.prop.skeleton.states) s.mobj.diffuse = [...body];
      out.color = [...body];
      const vars = special === null ? null : ptr(this.a, special);
      if (vars !== null) {
        const list = (n: number, at: number | null) => at === null ? [] : Array.from({ length: Math.min(n, 64) }, (_, i) => d.getUint8(at + i));
        const main = list(d.getUint16(vars), ptr(this.a, vars + 4));
        const shell = list(d.getUint16(vars + 8), ptr(this.a, vars + 0xc));
        out.outline = { main, shell, color: [...rgb(looks + 8), d.getUint8(looks + 11) / 255] as [number, number, number, number] };
        for (const j of shell) out.prop.skeleton.dobjsUnder(j).forEach((i) => out.prop.skeleton.alsoPosed.add(i));
      }
    }
    this.articles.set(key, out);
    return out;
  }
}

// ---- which copy, from the replay (no viewer track)

// Kirby's own states (ftKb_MS_*: 341 on): drinking in what he swallowed, and
// each copy's special moves
const DRINK = new Set([367, 368, 378, 379]);
const COPY_STATES: [number, number, number][] = [
  // [first, last, kind]
  [399, 400, 0], [401, 406, 6], [407, 412, 13], [413, 422, 14], [423, 428, 1], [429, 430, 12], [431, 432, 17],
  [433, 434, 2], [435, 442, 8], [443, 448, 5], [449, 452, 9], [453, 454, 10], [455, 464, 3], [465, 466, 19],
  [467, 474, 7], [475, 491, 15], [492, 499, 18], [500, 509, 16], [510, 511, 24], [512, 513, 21], [514, 519, 20],
  [520, 525, 22], [526, 527, 23], [528, 529, 25], [530, 537, 26],
];
const TAUNT = new Set([264, 265]);

/** the copy a state is one of, or -1 */
export function copyOfState(state: number): number {
  for (const [a, b, k] of COPY_STATES) if (state >= a && state <= b) return k;
  return -1;
}

export interface KirbyFrame { state: number; dead: boolean }

/** the copy Kirby has on each frame, worked out from the replay: `states`
 *  his, `victim(i)` the character of whoever he is drinking in on frame i */
export function copiesFromReplay(frames: KirbyFrame[], victim: (i: number) => number): Int8Array {
  const out = new Int8Array(frames.length).fill(-1);
  let cur = -1, prev = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.dead || TAUNT.has(f.state)) cur = -1;
    else if (DRINK.has(f.state) && !DRINK.has(prev)) {
      const v = victim(i);
      cur = COPIES[v] ? v : v === KIRBY ? -1 : cur;
    } else {
      const k = copyOfState(f.state);
      if (k >= 0) cur = k;
    }
    prev = f.state;
    out[i] = cur;
  }
  return out;
}
