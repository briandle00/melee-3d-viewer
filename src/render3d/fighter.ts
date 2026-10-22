/* 3D replay viewer: a fighter, posed from one frame of a replay.
 *
 * How a fighter is put together follows the game: the costume model is a
 * joint tree; each action state plays one animation from the subaction table
 * in PlXx.dat (which one is the action table, read from the game's
 * executable - dol.ts); the animation data lives in PlXxAJ.dat; TopN carries
 * the world position and facing (rotation Y = facing * pi/2) and TransN's
 * animated translation is root motion the game takes out before drawing.
 * Every number here is read from your game files at runtime.
 */
import { animTime } from "./animtime";
import { Archive, FigaTree, JObj, loadFigaTree, loadJoint, parseArchive, ptr, sample, str, type Track } from "./hsd";
import { Face, FaceTextures, PartAnims, PartPose, faceTextures, partAnims } from "./face";
import { Skeleton } from "./skeleton";
import { Prop } from "./prop";
import { itemHitElement, ScriptEvent, runScript } from "./fx/script";
// (how far on a move that loops by itself has its script run: fx/script.ts ScriptClock)
const CLOCK_HORIZON = 3600;
import type { CameraBox } from "./camera";
import { scriptQuakes, type ScriptQuake } from "./hitlag";
import { kirbyTrackJoints, partToModelJoint } from "./parts";
import type { WaitAnim } from "./waitanim";
import { blendTurn, readDynamics, type DynData } from "./dynamics";
import { itemVisEvents, type ItemVis } from "./itemhold";

const NO_VIS: ItemVis[] = [];
import { animPtclKeys, type PtclKey } from "./fx/bank";
import type { TrackAnim } from "./track";

const NO_EVENTS: ScriptEvent[] = [];
// the shield's states: held (Guard), and coming up (GuardOn, and a powershield's GuardReflect)
const GUARD = 179, GUARD_ON = new Set([178, 182]), GUARD_RISE = 178;
// (Yoshi's shield is his egg: his own code, ftyoshiguard.c)
const YOSHI = 14, POPO = 10, NANA = 11;

// internal character id -> the code its files are named with, its motion
// table's name, and its costume files in costume-index order (the game's own
// costume table: Popo's Nr, Gr, Or, Re go with Nana's Nr, Ye, Aq, Wh). Nana's
// files hold only her eight moves of her own (Squall Hammer and Belay as the
// partner); every other animation she plays is Popo's, so `shares` names the
// fighter whose table and animations fill the gaps in hers.
export const FIGHTERS: Record<number, { code: string; table: string; costumes: string[]; shares?: number }> = {
  0: { code: "Mr", table: "ftMr", costumes: ["Nr", "Ye", "Bk", "Bu", "Gr"] },
  1: { code: "Fx", table: "ftFx", costumes: ["Nr", "Or", "La", "Gr"] },
  2: { code: "Ca", table: "ftCa", costumes: ["Nr", "Gy", "Re", "Wh", "Gr", "Bu"] },
  3: { code: "Dk", table: "ftDk", costumes: ["Nr", "Bk", "Re", "Bu", "Gr"] },
  4: { code: "Kb", table: "ftKb", costumes: ["Nr", "Ye", "Bu", "Re", "Gr", "Wh"] },
  5: { code: "Kp", table: "ftKp", costumes: ["Nr", "Re", "Bu", "Bk"] },
  6: { code: "Lk", table: "ftLk", costumes: ["Nr", "Re", "Bu", "Bk", "Wh"] },
  7: { code: "Sk", table: "ftSk", costumes: ["Nr", "Re", "Bu", "Gr", "Wh"] },
  8: { code: "Ns", table: "ftNs", costumes: ["Nr", "Ye", "Bu", "Gr"] },
  9: { code: "Pe", table: "ftPe", costumes: ["Nr", "Ye", "Wh", "Bu", "Gr"] },
  10: { code: "Pp", table: "ftPp", costumes: ["Nr", "Gr", "Or", "Re"] },
  11: { code: "Nn", table: "ftNn", costumes: ["Nr", "Ye", "Aq", "Wh"], shares: 10 },
  12: { code: "Pk", table: "ftPk", costumes: ["Nr", "Re", "Bu", "Gr"] },
  13: { code: "Ss", table: "ftSs", costumes: ["Nr", "Pi", "Bk", "Gr", "La"] },
  14: { code: "Ys", table: "ftYs", costumes: ["Nr", "Re", "Bu", "Ye", "Pi", "Aq"] },
  15: { code: "Pr", table: "ftPr", costumes: ["Nr", "Re", "Bu", "Gr", "Ye"] },
  16: { code: "Mt", table: "ftMt", costumes: ["Nr", "Re", "Bu", "Gr"] },
  17: { code: "Lg", table: "ftLg", costumes: ["Nr", "Wh", "Aq", "Pi"] },
  18: { code: "Ms", table: "ftMs", costumes: ["Nr", "Re", "Gr", "Bk", "Wh"] },
  19: { code: "Zd", table: "ftZd", costumes: ["Nr", "Re", "Bu", "Gr", "Wh"] },
  20: { code: "Cl", table: "ftCl", costumes: ["Nr", "Re", "Bu", "Wh", "Bk"] },
  21: { code: "Dr", table: "ftDr", costumes: ["Nr", "Re", "Bu", "Gr", "Bk"] },
  22: { code: "Fc", table: "ftFc", costumes: ["Nr", "Re", "Bu", "Gr"] },
  23: { code: "Pc", table: "ftPc", costumes: ["Nr", "Re", "Bu", "Gr"] },
  24: { code: "Gw", table: "ftGw", costumes: ["Nr"] },
  25: { code: "Gn", table: "ftGn", costumes: ["Nr", "Re", "Bu", "Gr", "La"] },
  26: { code: "Fe", table: "ftFe", costumes: ["Nr", "Re", "Bu", "Gr", "Ye"] },
};

/** the three files one fighter in one costume is drawn from */
export function fighterFiles(internalId: number, costume: number): [string, string, string] | null {
  const f = FIGHTERS[internalId];
  if (!f) return null;
  const c = f.costumes[costume] ?? f.costumes[0];
  return [`Pl${f.code}.dat`, `Pl${f.code}AJ.dat`, `Pl${f.code}${c}.dat`];
}

/** the data and animation files of the fighter whose animations this one
 *  borrows (Nana: Popo's), or null */
export function sharedFiles(internalId: number): [string, string] | null {
  const s = FIGHTERS[internalId]?.shares;
  const f = s === undefined ? undefined : FIGHTERS[s];
  return f ? [`Pl${f.code}.dat`, `Pl${f.code}AJ.dat`] : null;
}

/** (flags: the entry's +0x10 - 0x40000000 its animation loops by itself) */
interface Subaction { name: string | null; off: number; size: number; script: number | null; flags: number }

/** a fighter's article, ready to pose: its model in one state, its scale
 *  (its attributes, +0x60), and a float of its own attributes by offset */
export interface Article { prop: Prop; scale: number; special: ((o: number) => number) | null; attach: number;
                          /** Mr. Game & Watch's props: the joints of the prop itself and of its
                           *  outline, and the outline's color (it_266F_ItemVars, itdraw.c) */
                          outline?: { main: number[]; shell: number[]; color: [number, number, number, number] };
                          /** its color whatever its material animation says (his props are
                           *  drawn in his color: their files animate a gray) */
                          color?: [number, number, number, number];
                          /** a model its special attributes keep at an offset (a joint
                           *  tree: Link's arrow's trail) */
                          modelAt?: (offset: number) => Prop | null;
                          /** the particles its state's animation starts (fx/bank.ts animPtclKeys) */
                          ptcl?: PtclKey[];
                          /** how a hand holds it (its attributes' first byte, the low three bits:
                           *  itGetHoldKind) and whether it is a heavy one (the top bit: itIsHeavy) -
                           *  itemhold.ts */
                          hold?: number; heavy?: boolean;
                          /** whether the game turns it to face its way (its attributes' second byte, 0x20: x1_3, which
                           *  Item_80268E5C's HSD_JObjSetFacingDirItem asks) */
                          facingTurn?: boolean }

/** An article (an item's description: attributes, special attributes, its
 *  states, its model) at `art` of an archive, in one of the item's states
 *  with that state's animations; null without a model */
export function loadArticle(a: Archive, art: number, state: number, tag: string): Article | null {
  // (the item state's animation, item-animation.ts: -1 is none, the model without an animation)
  if (!Number.isInteger(state) || state < -1 || state >= 256) return null;
  const d = a.data;
  const attr = ptr(a, art), special = ptr(a, art + 0x04), states = ptr(a, art + 0x0c), model = ptr(a, art + 0x10);
  const joint = model === null ? null : ptr(a, model);
  if (joint === null) return null;
  // the states' list: as long as the gap to the next thing in the file
  const nStates = states === null ? 0 : Math.floor(structSize(a, states) / 0x10);
  const sd = states === null || state < 0 || state >= nStates ? null : states + state * 0x10;
  // the state's animations (a state the list does not have: none)
  let prop: Prop | null = null;
  try {
    prop = new Prop(a, joint, sd === null ? null : ptr(a, sd), sd === null ? null : ptr(a, sd + 4), tag, true);
  } catch {
    try { prop = new Prop(a, joint, null, null, tag, true); } catch { prop = null; }
  }
  if (!prop) return null;
  prop.itemRoot = true;
  const sc = attr === null ? 1 : d.getFloat32(attr + 0x60);
  const ptcl = animPtclKeys(a, sd === null ? null : ptr(a, sd));
  // (the joint the game ties to its holder's hand when held: ItemModelDesc +8)
  const attach = model === null ? 0 : d.getInt32(model + 8);
  const models = new Map<number, Prop | null>();
  const modelAt = (offset: number): Prop | null => {
    if (models.has(offset)) return models.get(offset)!;
    const j = special === null ? null : ptr(a, special + offset);
    let out: Prop | null = null;
    if (j !== null) {
      try { out = new Prop(a, j, null, null, `${tag}:+${offset}`, true); } catch { out = null; }
    }
    models.set(offset, out);
    return out;
  };
  return { prop, ptcl, scale: sc > 0.01 && sc < 20 ? sc : 1, special: special === null ? null : (o: number) => d.getFloat32(special + o),
           attach: attach >= 0 && attach < prop.skeleton.n ? attach : 0, modelAt,
           hold: attr === null ? 0 : d.getUint8(attr) & 7, heavy: attr !== null && (d.getUint8(attr) & 0x80) !== 0,
           facingTurn: attr === null || (d.getUint8(attr + 1) & 0x20) !== 0 };
}

/** one of a fighter's hurtboxes: a capsule on a joint (ftData +0x30) */
export interface Hurtbox { joint: number; a: [number, number, number]; b: [number, number, number]; radius: number }

/** a fighter data file's animation table: each entry's name and where its
 *  animation sits in the matching AJ file */
function subactionsOf(pl: Archive, ftData: number): Subaction[] {
  const d = pl.data;
  const table = ptr(pl, ftData + 0x0c);
  if (table === null) throw new Error("a fighter's data file without animations");
  const n = Math.floor(structSize(pl, table) / 0x18);
  const out: Subaction[] = [];
  for (let i = 0; i < n; i++) {
    const e = table + i * 0x18;
    const np = ptr(pl, e);
    out.push({ name: np === null ? null : str(pl, np), off: d.getUint32(e + 4), size: d.getUint32(e + 8),
               script: ptr(pl, e + 0x0c), flags: d.getUint32(e + 0x10) });
  }
  return out;
}

const ftDataOf = (a: Archive) => [...a.publics].find(([n]) => n.startsWith("ftData"))?.[1];

export interface MotionTable { common: (number | null)[]; chars: Record<string, (number | null)[]> }

/** the number of action states every fighter shares; ids above are its own */
const COMMON_STATES = 341;
/** Mr. Game & Watch's internal id */
const GAME_WATCH = 24;

function structSize(a: Archive, off: number): number {
  let next = a.data.byteLength;
  for (const r of a.reloc) { const t = a.data.getUint32(r); if (t > off && t < next) next = t; }
  for (const p of a.publics.values()) if (p > off && p < next) next = p;
  return next - off;
}

export interface PoseInput {
  actionStateId: number;
  actionStateFrameCounter: number;
  xPosition: number;
  yPosition: number;
  facingDirection: number;
  /** a shield's tilt (guard.ts), when held */
  guard?: { frame: number; amount: number } | null;
  /** frames the shield has been coming up (GuardOn, GuardReflect), 0 on the first */
  guardAge?: number;
  /** thrown: the thrower's animation of the one it throws (its nodes the
   *  named parts, nodeJoint this fighter's joint for each) */
  borrow?: { anim: FigaTree; nodeJoint: number[] } | null;
  /** the animation it plays when not its state's own (a wait's: waitanim.ts) */
  subaction?: number;
  /** how far off the stage's plane it stands (the viewer track's: fighters
   *  that overlap are moved apart in depth), 0 on it */
  depth?: number;
  /** TopN's turn about y when it is not the facing's quarter turn (a jump that turns the fighter round) */
  turn?: number;
  /** its model's height scale (entering: it grows up from almost
   *  nothing as its stand rises, ftCo_EntryStart_Phys) */
  yScale?: number;
  /** the state whose animation it holds at its end instead of its own (the
   *  entry's end has none: it keeps the entry's) */
  holdAnimOf?: number;
  /** the animation as the game played it, from the viewer track, for the
   *  game frame posed: used in place of the state's own while it says */
  game?: GameAnim | null;
  /** the model joint of its named part 53, the second root some animations
   *  move it by (rootMotion); -1 or left out: none */
  root2?: number;
  /** the model joint of the fighter's TransN (its named part 1), when known */
  transN?: number;
  /** falling: how far it leans into the fall's forward or backward animation (FallLean) */
  fallLean?: FallLean | null;
  /** without the viewer track (a game whose track is not in yet, and every simulated run): what the fighter was
   *  posed from on the last frame before this state began. A state with no animation of its own (buried, frozen,
   *  held by a special move, a rebound's stop) keeps the joints where the move before left them, as the game does
   *  (Ft_MF_SkipAnim); null when the replay has no such frame */
  kept?: (() => PoseInput | null) | null;
  /** the replay frame posed: the clock a stand-in animation runs on (standIn) */
  clock?: number;
  /** in the air (the replay's flag) */
  airborne?: boolean;
}

/** A state the player had no animation for, and nothing to keep: it is never drawn in the model's bind pose
 *  (arms out, the T-pose). It plays its fall in the air and its wait on the ground, on the replay's clock so that
 *  it moves, and the state is noted here once (character:state, with how many poses) and logged once, so a
 *  missing one can be found: `missingAnimations()` */
const MISSING = new Map<string, number>();
export const missingAnimations = (): Record<string, number> => Object.fromEntries(MISSING);
export const clearMissingAnimations = () => MISSING.clear();
const FALL_STATE = 29, WAIT_STATE = 14;
/** Yoshi's shield held and struck (ftYs_MS_GuardHold, GuardDamage) */
const YOSHI_EGG = new Set([342, 344]);

/** A fall's lean (Fall, FallAerial, FallSpecial: ftCo_Fall_Anim_Inner,
 *  ftCo_800CC988). Each frame after the fall's own animation the game moves
 *  the joints `amount` of the way to another animation, the fall's forward
 *  or backward one by the way the fighter drifts: `sub` which (the fall's
 *  own subaction + 1 the forward one, + 2 the backward one, + 0 itself),
 *  `frame` its frame; on the frame it takes up a new one it does so twice,
 *  first at `first` */
export interface FallLean { sub: 0 | 1 | 2; amount: number; frame: number; first?: number }

/** a fighter's animations as the game played them (the viewer track's "anim") */
export interface GameAnim {
  at: (frame: number) => TrackAnim | null;
  /** the game frame posed */
  frame: number;
  /** what the fighter is posed from on an earlier game frame (the same
   *  fighter's PoseInput then), for the pose a blend starts from and the
   *  pose a state with no animation keeps; null when the replay has none */
  input?: (frame: number) => PoseInput | null;
  /** the model joint of the fighter's second root (PoseInput.root2) */
  root2?: number;
  /** the fighter's swinging joints' turns as they were at a game frame's end, written over the pose's (`rot`,
   *  three a joint), when they are known: a blend starts from the joints as they are, and a tail's or a cap's
   *  joint is where it had swung to, not where the animation before had it */
  swung?: (frame: number, rot: Float32Array) => void;
}

const MEWTWO_ID = 16;

export class Fighter {
  skeleton: Skeleton;
  /** its joint 1 (TransN) has nothing under it */
  private transNLeaf = false;
  /** the model joint that is TransN, the fighter's named part 1 (PlCo's table): joint 1 for all but Mewtwo and
   *  Mr. Game & Watch, whose joint 1 is another (Mewtwo's: the joint a held item floats on) and whose TransN is
   *  joint 2. Set from the pose's input (PoseInput.transN) once the common file is in */
  private transN = 1;
  modelScale: number;
  platformScale = 1;
  shieldSize: number;
  shieldJoint: number;
  /** how thin it is across its body, when it is (Mr. Game & Watch), else null */
  thin: number | null = null;
  /** the joint an item it holds is tied to (ftData+8, byte 0x10) */
  itemJoint: number;
  /** the parts its footsteps' effects come out at (ftData+8, bytes 0x13 and 0x14) */
  footParts: [number, number] = [-1, -1];
  cameraBox: CameraBox | null = null;
  nameTagHeight = 0;
  cameraPart = -1;
  cameraOffset: [number, number, number] = [0, 0, 0];
  private subactions: Subaction[] = [];
  // the borrowed table and its animations (Nana's: Popo's), used for every
  // entry this fighter's own table leaves empty
  private shared: { subactions: Subaction[]; aj: ArrayBuffer } | null = null;
  private anims = new Map<number, FigaTree | null>();
  private scripts = new Map<number, ScriptEvent[]>();
  private pl: Archive;
  private sharedPl: Archive | null = null;
  /** its hurtboxes, as the game builds them (ftColl_8007B320) */
  hurtboxes: Hurtbox[] = [];
  private ftData: number;
  private articles = new Map<string, Article | null>();
  private articleElements = new Map<string, number | null>();
  /** a costume's hat, a model of its own in the costume's file (Jigglypuff's
   *  bow, bonnet, headband and crown: ftpurin.c), and the joint it sits on */
  hat: { prop: Prop; joint: number } | null = null;

  constructor(
    public internalId: number,
    plDat: ArrayBuffer,
    private ajDat: ArrayBuffer,
    costumeDat: ArrayBuffer,
    private costume: number,
    private motion: MotionTable,
    tag: string,
    shared?: { pl: ArrayBuffer; aj: ArrayBuffer },
  ) {
    const pl = (this.pl = parseArchive(plDat));
    const ftData = ftDataOf(pl);
    if (ftData === undefined) throw new Error("not a fighter's data file (no ftData)");
    this.ftData = ftData;
    const d = pl.data;
    const attrs = ptr(pl, ftData);
    if (attrs === null) throw new Error("a fighter's data file without attributes");
    this.modelScale = d.getFloat32(attrs + 0x8c);
    // the shield: its size (attributes +0x90) and the joint it hangs on
    // (ftData+8, byte 0x11: a joint of the model, forward of the body)
    this.shieldSize = d.getFloat32(attrs + 0x90);
    const x8at = ptr(pl, ftData + 0x08);
    this.shieldJoint = x8at === null ? -1 : d.getUint8(x8at + 0x11);
    this.itemJoint = x8at === null ? -1 : d.getUint8(x8at + 0x10);
    this.footParts = x8at === null ? [-1, -1] : [d.getUint8(x8at + 0x13), d.getUint8(x8at + 0x14)];
    // the box the match camera frames it by (ftData+0x3C): its lift, the
    // extents ahead and behind, and up, down and deep
    const cb = ptr(pl, ftData + 0x3c);
    if (cb !== null) {
      const g = (o: number) => d.getFloat32(cb + o);
      this.cameraBox = { lift: g(0), ahead: g(4), back: g(8), v: [g(12), g(16), g(20)] };
    }
    // the angel platform's size for this fighter (its attributes, +0x160)
    const ps = d.getFloat32(attrs + 0x160);
    this.platformScale = ps > 0.05 && ps < 20 ? ps : 1;
    // the HUD's (hud.ts): how high over it its player tag goes (+0xFC), and
    // the named part the camera and the magnifier look at, with the offset
    // from it in its own space (+0x16C, +0x170)
    this.nameTagHeight = d.getFloat32(attrs + 0xfc);
    this.cameraPart = d.getInt32(attrs + 0x16c);
    this.cameraOffset = [d.getFloat32(attrs + 0x170), d.getFloat32(attrs + 0x174), d.getFloat32(attrs + 0x178)];
    this.subactions = subactionsOf(pl, ftData);
    if (shared) {
      const spl = parseArchive(shared.pl);
      const sAt = ftDataOf(spl);
      if (sAt === undefined) throw new Error("not a fighter's data file (no ftData)");
      this.shared = { subactions: subactionsOf(spl, sAt), aj: shared.aj };
      this.sharedPl = spl;
    }
    // hurtboxes: {count, inits}, each {joint, height, grabbable, a, b, radius}
    const hb = ptr(pl, ftData + 0x30);
    const inits = hb === null ? null : ptr(pl, hb + 4);
    for (let i = 0; hb !== null && inits !== null && i < Math.min(15, d.getUint32(hb)); i++) {
      const o = inits + i * 0x28;
      const v = (at: number): [number, number, number] => [d.getFloat32(o + at), d.getFloat32(o + at + 4), d.getFloat32(o + at + 8)];
      this.hurtboxes.push({ joint: d.getUint32(o), a: v(0x0c), b: v(0x18), radius: d.getFloat32(o + 0x24) });
    }

    const md = parseArchive(costumeDat);
    const share = [...md.publics].find(([k]) => k.endsWith("_Share_joint"));
    if (!share) throw new Error("not a costume model (no _Share_joint)");
    const { all, dobjs } = loadJoint(md, share[1]);
    // Mr. Game & Watch: his color is his costume's, set on every material as
    // he loads (ftGw_Init_OnLoad: his attributes +0x4, four bytes a costume,
    // through ftMaterial_800BFB4C), and he is as thin as his attributes +0x0
    // say across his body (Fighter_UpdateModelScale: the root's x)
    if (internalId === GAME_WATCH) {
      const at = ptr(pl, ftData + 4);
      if (at !== null) {
        const c = at + 4 + costume * 4;
        if (c + 4 <= d.byteLength) {
          const rgba = [0, 1, 2, 3].map((k) => d.getUint8(c + k) / 255) as [number, number, number, number];
          for (const o of dobjs) if (o.mobj) o.mobj.diffuse = [rgba[0], rgba[1], rgba[2], rgba[3]];
          this.gwColor = rgba;
        }
        const w = d.getFloat32(at);
        if (w > 0.001 && w < 10) this.thin = w;
      }
    }
    this.skeleton = new Skeleton(md, all, dobjs, tag);
    this.transNLeaf = all.length > 1 && !all.some((j) => j.parent === 1);
    // its face (face.ts): the costume's textures its code turns (ftData+8,
    // +8), and its part animations (ftData+0x1C)
    const x8face = ptr(pl, ftData + 0x08);
    this.faceTex = x8face === null ? null : faceTextures(pl, x8face + 8, costume, md, this.skeleton, all);
    this.partAnims = partAnims(pl, ftData);
    // (the game copies its joint 6's matrix onto the hat each frame it draws it)
    const hat = [...md.publics].find(([k]) => k.endsWith("Hat_TopN_joint"));
    if (hat) {
      try { this.hat = { prop: new Prop(md, hat[1], null, null, `${tag}:hat`), joint: 6 }; } catch { this.hat = null; }
    }

    // which model parts show: the game's parts visibility tables (ftData+8)
    const x8 = ptr(pl, ftData + 0x08);
    if (x8 !== null) {
      const modelNum = d.getUint32(x8);
      const visTable = ptr(pl, x8 + 4);
      if (visTable !== null && modelNum < 64) {
        const lookups = [0, 1, 2, 3].map((k) =>
          ptr(pl, visTable + costume * 16 + k * 4) ?? ptr(pl, visTable + k * 4));
        const variants = (lk: number | null) => {
          const out: number[][][] = [];
          if (lk === null) return out;
          for (let m = 0; m < modelNum; m++) {
            const count = d.getUint32(lk + m * 8);
            const list = ptr(pl, lk + m * 8 + 4);
            const vs: number[][] = [];
            for (let v = 0; v < count && v < 64 && list !== null; v++) {
              const c = d.getUint32(list + v * 8);
              const ids = ptr(pl, list + v * 8 + 4);
              const idx: number[] = [];
              for (let k = 0; k < c && k < 256 && ids !== null; k++) idx.push(d.getUint8(ids + k));
              vs.push(idx);
            }
            out.push(vs);
          }
          return out;
        };
        // lookups 0, 1 and 3 start hidden; lookup 0 then shows each part's selected variant
        for (const k of [0, 1, 3]) for (const m of variants(lookups[k])) for (const v of m) v.forEach((i) => this.skeleton.hidden.add(i));
        this.partVariants = variants(lookups[0]);
        this.lowVariants = variants(lookups[1]);
        this.metalVariants = variants(lookups[3]);
        this.partVariants.forEach((m, part) => {
          const sel = startingPart(this.internalId, costume, part);
          this.partShown[part] = sel;
          if (sel >= 0 && m[sel]) m[sel].forEach((i) => this.skeleton.hidden.delete(i));
        });
        // Mr. Game & Watch's outline: a fifth lookup, his article slot 10
        // (ftGw_Init_OnLoad: x5AC.xC[4]), of slightly larger shells drawn in
        // his outline color (his attributes +0x14) before his body, without
        // writing depth (ftDrawCommon_80080E18); hidden from his body's pass
        if (internalId === GAME_WATCH) {
          const list = ptr(pl, ftData + 0x48);
          const l4 = list === null ? null : ptr(pl, list + 10 * 4);
          const at = ptr(pl, ftData + 4);
          if (l4 !== null && at !== null) {
            this.outlineVariants = variants(l4);
            for (const m of this.outlineVariants) {
              for (const v of m) v.forEach((i) => { this.skeleton.hidden.add(i); this.skeleton.alsoPosed.add(i); });
            }
            this.outlineColor = [0, 1, 2, 3].map((k) => d.getUint8(at + 0x14 + k) / 255) as [number, number, number, number];
          }
        }
      }
    }
  }

  /** the textures its code turns (eyes, mouth), or null */
  faceTex: FaceTextures | null = null;
  /** its part animations (hands, mouth, eyelids) */
  partAnims: PartAnims = { slots: [] };

  /** the part animations in force, over the body's animation */
  private applyParts(parts: readonly PartPose[]) {
    const sk = this.skeleton;
    for (const p of parts) {
      const slot = this.partAnims.slots[p.slot];
      const pose = slot?.poses[p.pose];
      if (!slot || !pose) continue;
      // (the list names parts; a pose's animation has a track for each of
      // the model's joints from the first part's on. Past a gap in the part
      // list - Kirby's, kept for his copies' hats, Link's - a part is a
      // joint further back in the model, and its track the joint's)
      const first = partToModelJoint(this.internalId, slot.start);
      for (const part of slot.parts) {
        const j = partToModelJoint(this.internalId, part);
        const ao = j >= first ? pose[j - first] : undefined;
        if (!ao || j < 0 || j >= sk.n) continue;
        for (const tr of ao.tracks) {
          const v = sample(tr.keys, 0);
          if (v === null) continue;
          const arr = tr.type >= 1 && tr.type <= 3 ? sk.rot : tr.type >= 5 && tr.type <= 7 ? sk.trans : tr.type >= 8 && tr.type <= 10 ? sk.scale : null;
          if (!arr) continue;
          const k = j * 3 + (tr.type >= 8 ? tr.type - 8 : tr.type >= 5 ? tr.type - 5 : tr.type - 1);
          arr[k] += (v - arr[k]) * p.weight;
        }
      }
    }
  }

  private outlineVariants: number[][][] = [];
  /** Mr. Game & Watch's costume color (his props take it too) */
  private gwColor: [number, number, number, number] | null = null;
  /** the color its outline is drawn in, when it has one (Mr. Game & Watch) */
  outlineColor: [number, number, number, number] | null = null;
  private outlineHidden = new Set<number>();

  /** the meshes hidden while its outline is drawn: all but the outline's
   *  shells for the variants its parts show now (ftParts_80074B6C on lookup 4) */
  outlinePassHidden(): Set<number> {
    const show = new Set<number>();
    this.outlineVariants.forEach((m, part) => {
      const sel = this.partShown[part] ?? -1;
      if (sel >= 0 && m[sel]) m[sel].forEach((i) => show.add(i));
    });
    this.outlineHidden.clear();
    for (let i = 0; i < this.skeleton.states.length; i++) if (!show.has(i)) this.outlineHidden.add(i);
    return this.outlineHidden;
  }

  /** its low-detail model's variants (lookup 1), and lookup 3's (hidden with the metal model) */
  private lowVariants: number[][][] = [];
  private metalVariants: number[][][] = [];
  private lowHidden: Set<number> | null = null;
  private lowHiddenFor = "";
  /** the meshes hidden while it is drawn into a stage's mirror (Fountain of
   *  Dreams' pond): the game draws its low-detail model there - lookups 0,
   *  2 and 4 hidden, lookup 1's variants for its parts now shown
   *  (ftDrawCommon_80080C28) - or null when it has none */
  mirrorPassHidden(): Set<number> | null {
    if (!this.lowVariants.some((m) => m.length)) return null;
    const key = this.partShown.join(",") + ":" + this.skeleton.hidden.size;
    if (this.lowHidden && key === this.lowHiddenFor) return this.lowHidden;
    const h = new Set(this.skeleton.hidden);
    for (const list of [this.partVariants, this.metalVariants, this.lowVariants, this.outlineVariants])
      for (const m of list) for (const v of m) v.forEach((i) => h.add(i));
    this.lowVariants.forEach((m, part) => {
      const sel = this.partShown[part] ?? -1;
      if (sel >= 0 && m[sel]) m[sel].forEach((i) => h.delete(i));
    });
    this.lowHidden = h;
    this.lowHiddenFor = key;
    return h;
  }

  /** each model part's variants (their meshes), and the variant shown now (-1: none) */
  private partVariants: number[][][] = [];
  private partShown: number[] = [];

  /** the variant a part shows now (-1: none) */
  partNow(part: number): number { return this.partShown[part] ?? -1; }

  private bodyHidden: Set<number> | null = null;
  /** the meshes hidden while its body's lookup-0 meshes give way to a hat
   *  that covers it (Kirby's colored copy hats: ftKb_UnkIntBoolFunc0) */
  hiddenUnderHat(): Set<number> {
    if (!this.bodyHidden) {
      this.bodyHidden = new Set(this.skeleton.hidden);
      for (const m of this.partVariants) for (const v of m) v.forEach((i) => this.bodyHidden!.add(i));
    }
    return this.bodyHidden;
  }

  /** the variant a part starts on (the game's switches put it back there) */
  defaultPart(part: number): number {
    return startingPart(this.internalId, this.costume, part);
  }

  /** show one of a model part's variants, the others hidden (the game's part
   *  switches: ftParts_80074A4C / 80074B0C); -1 hides the part */
  setPart(part: number, variant: number) {
    const m = this.partVariants[part];
    if (!m || this.partShown[part] === variant) return;
    for (const v of m) v.forEach((i) => this.skeleton.hidden.add(i));
    if (variant >= 0 && m[variant]) m[variant].forEach((i) => this.skeleton.hidden.delete(i));
    this.partShown[part] = variant;
  }

  /** how many model parts it has */
  get partCount(): number {
    return this.partVariants.length;
  }

  private articleModels = new Map<string, Prop | null>();

  /** a model one of its articles keeps among its special attributes (a joint
   *  tree at `offset`: Link's arrow's trail, itlinkarrow.c), or null */
  articleModel(index: number, offset: number): Prop | null {
    const key = `${index}:${offset}`;
    if (this.articleModels.has(key)) return this.articleModels.get(key)!;
    const a = this.pl;
    const list = ptr(a, this.ftData + 0x48);
    const art = list === null ? null : ptr(a, list + index * 4);
    const special = art === null ? null : ptr(a, art + 0x04);
    const joint = special === null ? null : ptr(a, special + offset);
    let out: Prop | null = null;
    if (joint !== null) {
      try { out = new Prop(a, joint, null, null, `article:${this.internalId}:${index}:+${offset}`, true); } catch { out = null; }
    }
    this.articleModels.set(key, out);
    return out;
  }

  /** one of an article's models - its own (`at` null) or one its special
   *  attributes keep (`at`: their offset) - from its first child down, with
   *  the animations its special attributes keep at `anim` (joint, material:
   *  pointers to them, +0 and +4), as the game adds them to the model's child
   *  (the grapple beam's glow and claw: itsamusgrapple.c); null without one */
  articleAnimated(index: number, at: number | null, anim: number): Prop | null {
    const key = `animated:${index}:${at}:${anim}`;
    if (this.articleModels.has(key)) return this.articleModels.get(key)!;
    const a = this.pl;
    const list = ptr(a, this.ftData + 0x48);
    const art = list === null ? null : ptr(a, list + index * 4);
    const special = art === null ? null : ptr(a, art + 0x04);
    const model = art === null ? null : ptr(a, art + 0x10);
    const root = at === null ? (model === null ? null : ptr(a, model)) : special === null ? null : ptr(a, special + at);
    const child = root === null ? null : ptr(a, root + 0x08);
    const twice = (o: number) => { const p = special === null ? null : ptr(a, special + o); return p === null ? null : ptr(a, p); };
    let out: Prop | null = null;
    if (child !== null) {
      try { out = new Prop(a, child, twice(anim), twice(anim + 4), `animated:${this.internalId}:${index}:${at}`, false); } catch { out = null; }
    }
    this.articleModels.set(key, out);
    return out;
  }

  /** a model its articles' list keeps as a bare joint tree rather than an
   *  article (Yoshi's egg, slot 3: the one his egg-laid victim wears,
   *  ftYs_SpecialN_8012CDD4), or null */
  accessory(index: number): Prop | null {
    const key = `accessory:${index}`;
    if (this.articleModels.has(key)) return this.articleModels.get(key)!;
    const a = this.pl;
    const list = ptr(a, this.ftData + 0x48);
    const joint = list === null ? null : ptr(a, list + index * 4);
    let out: Prop | null = null;
    if (joint !== null) {
      try { out = new Prop(a, joint, null, null, `accessory:${this.internalId}:${index}`, true); } catch { out = null; }
    }
    this.articleModels.set(key, out);
    return out;
  }

  /** how far behind it the stand it enters on stands (fp->x40: the Ice
   *  Climbers' own attributes +0, the gap between Popo and Nana; 0 for the
   *  rest - ftpopo.c), before its size */
  get entryGap(): number {
    return this.internalId === POPO ? this.ownAttr(0) : 0;
  }

  /** its trophy's scale (common attributes +0x110: the stand it enters on is
   *  sized by it, ftCo_800C6408) */
  get trophyScale(): number {
    const at = ptr(this.pl, this.ftData);
    const v = at === null ? 1 : this.pl.data.getFloat32(at + 0x110);
    return v > 0.05 && v < 20 ? v : 1;
  }

  /** its size (common attributes +0xBC: what an egg it is laid in is scaled by) */
  get size(): number {
    const at = ptr(this.pl, this.ftData);
    const v = at === null ? 1 : this.pl.data.getFloat32(at + 0xbc);
    return v > 0.1 && v < 20 ? v : 1;
  }

  /** a float of its own attributes (ftData+0x04) */
  /** a whole number of its own attributes */
  ownAttrInt(offset: number): number {
    const at = ptr(this.pl, this.ftData + 4);
    return at === null ? 0 : this.pl.data.getInt32(at + offset);
  }

  ownAttr(offset: number): number {
    const at = ptr(this.pl, this.ftData + 4);
    return at === null ? 0 : this.pl.data.getFloat32(at + offset);
  }

  /** the element of the hitbox one of its articles makes in one of its
   *  states (its state's script: fx/script.ts itemHitElement), or null */
  articleElement(index: number, state: number): number | null {
    const key = `${index}:${state}`;
    if (this.articleElements.has(key)) return this.articleElements.get(key)!;
    const a = this.pl;
    const list = ptr(a, this.ftData + 0x48);
    const art = list === null ? null : ptr(a, list + index * 4);
    const states = art === null ? null : ptr(a, art + 0x0c);
    const n = states === null ? 0 : Math.min(32, Math.floor(structSize(a, states) / 0x10));
    const of = (s: number) => {
      const script = states === null || s < 0 || s >= n ? null : ptr(a, states + s * 0x10 + 0x0c);
      return script === null ? null : itemHitElement(a, script);
    };
    // (a hitbox made in an earlier state stays: the ice's is made as it
    // appears, and it slides on in states whose scripts make none)
    let out = of(state);
    for (let s = 0; out === null && s < n; s++) out = of(s);
    this.articleElements.set(key, out);
    return out;
  }

  /** one of its articles (ftData+0x48: its projectiles and the like) in one
   *  of the item's states, with that state's animations; null without one */
  /** what an article of this fighter's has (the parity harness's): its
   *  model, how many states, whether it is there at all */
  articleInfo(index: number): { there: boolean; model: boolean; states: number } {
    const a = this.pl, list = ptr(a, this.ftData + 0x48);
    const art = list === null ? null : ptr(a, list + index * 4);
    if (art === null) return { there: false, model: false, states: 0 };
    const model = ptr(a, art + 0x10), states = ptr(a, art + 0x0c);
    return { there: true, model: model !== null && ptr(a, model) !== null,
             states: states === null ? 0 : Math.floor(structSize(a, states) / 0x10) };
  }

  article(index: number, state: number): Article | null {
    const key = `${index}:${state}`;
    if (this.articles.has(key)) return this.articles.get(key)!;
    let out: Article | null = null;
    const a = this.pl, d = a.data;
    const list = ptr(a, this.ftData + 0x48);
    const art = list === null ? null : ptr(a, list + index * 4);
    if (art !== null) {
      const special = ptr(a, art + 0x04);
      out = loadArticle(a, art, state, `article:${this.internalId}:${index}:${state}`);
      if (out) out.modelAt = (offset) => this.articleModel(index, offset);
      // Mr. Game & Watch's props: in his color (it_8027CE64), and with an
      // outline of their own - the joints to hide for it and the ones that
      // are it, a list at the head of the prop's special attributes
      if (out && this.internalId === GAME_WATCH && special !== null && this.gwColor) {
        for (const s of out.prop.skeleton.states) s.mobj.diffuse = [...this.gwColor];
        out.color = [...this.gwColor];
        const vars = ptr(a, special);
        if (vars !== null) {
          const list = (n: number, at: number | null) => at === null ? [] : Array.from({ length: Math.min(n, 64) }, (_, i) => d.getUint8(at + i));
          const main = list(d.getUint16(vars), ptr(a, vars + 4));
          const shell = list(d.getUint16(vars + 8), ptr(a, vars + 0xc));
          if (this.outlineColor) out.outline = { main, shell, color: this.outlineColor };
          for (const j of shell) out.prop.skeleton.dobjsUnder(j).forEach((i) => out!.prop.skeleton.alsoPosed.add(i));
        }
      }
    }
    this.articles.set(key, out);
    return out;
  }

  private anim(index: number): FigaTree | null {
    if (this.anims.has(index)) return this.anims.get(index)!;
    const load = (s: Subaction | undefined, aj: ArrayBuffer): FigaTree | null => {
      if (!s || !s.name || s.size <= 0 || s.off + s.size > aj.byteLength) return null;
      try { return loadFigaTree(aj, s.off); } catch { return null; }
    };
    // its own animation, else the one it borrows (Nana's Wait is Popo's)
    const f = load(this.subactions[index], this.ajDat)
      ?? (this.shared ? load(this.shared.subactions[index], this.shared.aj) : null);
    this.anims.set(index, f);
    return f;
  }

  private subactionOf(actionStateId: number): number | null {
    const table = FIGHTERS[this.internalId].table;
    const sm = actionStateId < COMMON_STATES
      ? this.motion.common[actionStateId]
      : this.motion.chars[table]?.[actionStateId - COMMON_STATES];
    return sm === null || sm === undefined || sm < 0 ? null : sm;
  }

  /** whether two of its states are one move's ground and air versions (their
   *  animations' names the same but for "Air": NsSpecialNHold and
   *  NsSpecialAirNHold), the kind the game switches between keeping the
   *  move's place (ftCommon_GroundAirColl_MF) */
  groundAirPair(a: number, b: number): boolean {
    const name = (s: number) => {
      const sm = this.subactionOf(s);
      const n = sm === null ? null : this.subactions[sm]?.name ?? this.shared?.subactions[sm]?.name ?? null;
      const m = n ? /_ACTION_(\w+?)_figatree/.exec(n) : null;
      return m ? m[1] : null;
    };
    const x = name(a), y = name(b);
    if (!x || !y || x === y || x.includes("Air") === y.includes("Air")) return false;
    return x.replace("Air", "") === y.replace("Air", "");
  }

  /** the animation of a fighter it throws, for a state of the one thrown
   *  (its subaction table's entry for that state: the generic skeleton's,
   *  PlyTaro_Share_ACTION_T<fighter>Throw..., named parts for nodes), or null */
  thrownAnim(actionStateId: number): FigaTree | null {
    const sm = this.subactionOf(actionStateId);
    // (its own table's entry, else the one it borrows: Nana throws with Popo's animations)
    const name = sm === null ? null : this.subactions[sm]?.name ?? this.shared?.subactions[sm]?.name;
    return name && /_Share_ACTION_T[A-Z]/.test(name) ? this.anim(sm!) : null;
  }

  private ownRemaps = new Map<FigaTree, Track[][]>();
  /** an animation's tracks on this model's joints: Kirby's copy moves made
   *  for a hat with joints of its own have tracks for those too, which are
   *  left out (parts.ts kirbyTrackJoints) */
  private ownTracks(anim: FigaTree): Track[][] {
    if (anim.tracks.length <= this.skeleton.n) return anim.tracks;
    let out = this.ownRemaps.get(anim);
    if (!out) {
      const map = kirbyTrackJoints(anim.tracks.length, this.skeleton.n);
      if (!map) return anim.tracks;
      out = Array.from({ length: this.skeleton.n }, () => [] as Track[]);
      map.forEach((j, t) => { if (j >= 0 && j < out!.length) out![j] = anim.tracks[t]; });
      this.ownRemaps.set(anim, out);
    }
    return out;
  }

  private remaps = new Map<FigaTree, Track[][]>();
  /** a borrowed animation's tracks, laid on this fighter's joints */
  private remapped(b: { anim: FigaTree; nodeJoint: number[] }): Track[][] {
    let out = this.remaps.get(b.anim);
    if (!out) {
      out = Array.from({ length: this.skeleton.n }, () => [] as Track[]);
      // (the game's retargeting: the root, TransN, XRotN, YRotN and HipN take
      // the whole animation; every other joint its turns only - the tracks
      // before the first move, so its own bone lengths stay: ftAnim_8006FCE4,
      // fn_8001E60C)
      const full = new Set([0, 1, 2, 3, 4].map((k) => b.nodeJoint[k]));
      b.anim.tracks.forEach((list, k) => {
        const j = b.nodeJoint[k] ?? -1;
        if (j < 0 || j >= out!.length) return;
        if (full.has(j)) { out![j] = list; return; }
        const first = list.findIndex((tr) => tr.type >= 5 && tr.type <= 7);
        out![j] = first < 0 ? list : list.slice(0, first);
      });
      this.remaps.set(b.anim, out);
    }
    return out;
  }

  /** A subaction's flags (its table entry's +0x10; a borrowed animation's are the borrowed table's) */
  private flagsOf(sub: number): number {
    const own = this.subactions[sub];
    return (own?.name && own.size > 0 ? own : this.shared?.subactions[sub] ?? own)?.flags ?? 0;
  }

  /** whether a state's animation is one that carries the fighter round (its
   *  flags name the part it turns by, bits 6 to 8: a turn's and a back
   *  throw's YRotN, a roll's HipN - Fighter_ChangeMotionState's x596 part) */
  turnsByAnimation(actionStateId: number): boolean {
    const sub = this.subactionOf(actionStateId);
    return sub !== null && ((this.flagsOf(sub) >> 6) & 7) !== 0;
  }

  /** An animation's frame laid on the joints from their rest, and its root
   *  motion taken out as the game takes it (ftAnim_8006E9B4, ftAnim_8006E054):
   *  only an animation whose flags say so (0x80000000) gives TransN's place
   *  to the physics and leaves the joint at 0 - any other keeps TransN where
   *  it is animated; and with a second root (0x04000000: named part 53) the
   *  physics takes that one's place, the second root goes to 0 and TransN is
   *  left the difference of the two, at the model's size */
  private applyAnim(tracks: Track[][], frame: number, flags: number, root2: number, shadow = false) {
    const sk = this.skeleton, tn = this.transN;
    sk.resetPose();
    // (the joint an item is held on: its size put to 1 over the model's as the joint tree is laid, before the
    // animation - ftAnim_8006FA58 and ftAnim_8006FB88: ftCommon_8007F6A4 - so an item tied to it is its own size)
    const hj = partToModelJoint(this.internalId, this.itemJoint);
    if (hj > 0 && hj < sk.n && this.modelScale > 0) sk.scale[hj * 3] = sk.scale[hj * 3 + 1] = sk.scale[hj * 3 + 2] = 1 / this.modelScale;
    sk.applyTracks(tracks, frame);
    if (sk.n <= tn || (tn === 1 && this.transNLeaf) || !(flags & 0x80000000)) return;
    const second = (flags & 0x04000000) !== 0 && root2 > tn && root2 < sk.n;
    // (Mewtwo's joint an item floats on, a sibling of TransN animated in TopN's frame: the root motion the
    // physics took is taken off it too, ftAnim_8006E054's last step - fp->x2221_b2, set for him alone
    // (ftMt_Init_OnLoad) - by TransN's place as animated, or the second root's. Not in an animation set with
    // a blend (`shadow`): there the joint is copied from the blend's shadow joint after that step (his code
    // marks it so: ftAnim_8006FE9C, ftAnim_8006FF74), the animation's place as it is, while that animation plays)
    const ij = this.internalId === MEWTWO_ID && !shadow ? partToModelJoint(this.internalId, this.itemJoint) : -1;
    if (ij > 0 && ij < sk.n && ij !== tn && ij !== root2) {
      const from = second ? root2 : tn;
      for (let c = 0; c < 3; c++) sk.trans[ij * 3 + c] -= sk.trans[from * 3 + c];
    }
    if (second) {
      for (let c = 0; c < 3; c++) {
        sk.trans[tn * 3 + c] = (sk.trans[tn * 3 + c] - sk.trans[root2 * 3 + c]) * this.modelScale;
        sk.trans[root2 * 3 + c] = 0;
      }
    } else sk.trans[tn * 3] = sk.trans[tn * 3 + 1] = sk.trans[tn * 3 + 2] = 0;
  }

  /** the joints from TransN down moved `t` of the way from where they are
   *  to an animation's frame: places and sizes straight, turns through
   *  quaternions (ftAnim_8006FE9C, lb_8000C490; all the way: ftAnim_8006FF74).
   *  TransN and the second root are not blended: they are the animation's */
  private blendToward(tracks: Track[][], frame: number, t: number, flags: number, root2: number, snap = -1) {
    const sk = this.skeleton;
    const rot = sk.rot.slice(), trans = sk.trans.slice(), scale = sk.scale.slice();
    this.applyAnim(tracks, frame, flags, root2, true);
    if (t >= 1) return;
    const u = 1 - t, tn = this.transN;
    // (not blended, the animation's own: TransN, the second root, and with a TransN that is not joint 1 the
    // joint before it for Mewtwo, whose own code marks it so - ftMt_Init_OnLoad; Mr. Game & Watch's is blended)
    for (let j = tn === 1 ? 2 : 1; j < sk.n; j++) {
      if (j === root2 || j === tn || (j < tn && this.internalId === MEWTWO_ID)) continue;
      // (`snap`: the part the move before turned the fighter by takes the new animation's place and turn whole)
      if (j === snap) { for (let k = j * 3; k < j * 3 + 3; k++) sk.scale[k] = sk.scale[k] * t + scale[k] * u; continue; }
      for (let k = j * 3; k < j * 3 + 3; k++) {
        sk.trans[k] = sk.trans[k] * t + trans[k] * u;
        sk.scale[k] = sk.scale[k] * t + scale[k] * u;
      }
      const r = blendTurn(sk.rot.subarray(j * 3, j * 3 + 3), rot.subarray(j * 3, j * 3 + 3), t);
      sk.rot[j * 3] = r[0]; sk.rot[j * 3 + 1] = r[1]; sk.rot[j * 3 + 2] = r[2];
    }
  }

  /** the skeleton posed as the game posed it on game frame `frame`, from the
   *  viewer track's record of its animation: the animation's frame, and while
   *  it blends into it (the frames after a change of move) each joint from
   *  TransN down moved t of the way from where the last frame left it,
   *  t = rate / (rate + frames of the blend left) - ftAnim_8006E9B4,
   *  ftAnim_8006FE9C, lb_8000C490: turns through quaternions.
   *
   *  The frame a move starts the game steps its animation more than once:
   *  Fighter_ChangeMotionState steps it as it sets it (twice when the move
   *  starts past its first frame), and the frame's own step follows when the
   *  move started before it. Each is a step of the blend, so the track's "how
   *  far in" on a blend's first frame says how many there were. When only
   *  Fighter_ChangeMotionState's are there, the frame's own step came first
   *  and was the old animation's: the blend starts from the old animation one
   *  step further on than the frame before showed it (`more`: this frame's
   *  pose with one more step of its animation).
   *
   *  A state with no animation (the track's -1: the shield coming up, a
   *  rebound's stop - Ft_MF_SkipAnim) keeps the joints where the move before
   *  left them, its last step included; `state` is what the fighter is posed
   *  from on this frame.
   *
   *  What it posed (`anim` null for a kept pose), or null when the track has
   *  nothing of this fighter's own then */
  private gamePose(g: GameAnim, frame: number, depth: number, state: PoseInput | null, more = false): { anim: FigaTree | null } | null {
    const a = g.at(frame);
    if (!a) return null;
    // (the pose of an earlier frame, whole: its own animation, lean and guard)
    const earlier = (f: number, stepped: boolean): boolean => {
      if (depth >= 48) return false;
      const before = g.input?.(f);
      if (before) return this.body(before, depth + 1, stepped);
      return !!this.gamePose(g, f, depth + 1, null, stepped);
    };
    if (a.anim < 0) {
      // (held in the shield, every joint is the guard pose's: nothing is kept)
      if (!state || !g.input || state.actionStateId === GUARD) return null;
      const was = g.at(frame - 1);
      if (!earlier(frame - 1, !!was && was.anim >= 0)) return null;
      // (the joints stay as the move before left them, and a swinging one was left where it had swung to: a
      // shield coming up takes Mewtwo's tail from there, not from where his last animation had it)
      if (was && was.anim >= 0) g.swung?.(frame - 1, this.skeleton.rot);
      return { anim: null };
    }
    // (its own table's: Nana plays Popo's)
    const own = a.kind === this.internalId || (this.internalId === NANA && a.kind === POPO);
    const anim = own ? this.anim(a.anim) : null;
    if (!anim) return null;
    const tracks = this.ownTracks(anim), flags = this.flagsOf(a.anim), root2 = state?.root2 ?? g.root2 ?? -1;
    if (state?.transN !== undefined && state.transN > 0) this.transN = state.transN;
    const blending = a.blendFrames > 0 && a.blendAt < a.blendFrames;
    if (more) {
      // (one step on: a looping animation starts over, any other stops at its end)
      if (!this.gamePose(g, frame, depth + 1, state)) return null;
      const on = a.frame + a.rate, len = anim.frames;
      const f = len > 0 ? ((flags & 0x40000000) ? on % len : Math.min(on, len)) : on;
      const left = a.blendFrames - (a.blendAt + a.rate);
      if (blending && left > 0) this.blendToward(tracks, f, a.rate / (a.rate + left), flags, root2);
      else this.applyAnim(tracks, f, flags, root2, a.blendFrames > 0);
      return { anim };
    }
    if (blending) {
      // (a blend going on from the event before is one step further; a new one has had blendAt / rate)
      const b = g.at(a.since - 1);
      const goesOn = !!b && b.anim === a.anim && b.kind === a.kind && b.blendFrames === a.blendFrames && b.blendAt < a.blendAt;
      const steps = a.rate > 0 ? Math.max(1, Math.min(3, Math.round((a.blendAt - (goesOn ? b!.blendAt : 0)) / a.rate))) : 1;
      // (a new one: Fighter_ChangeMotionState's own steps are 1, or 2 when the move starts past its first frame)
      const stepped = !goesOn && steps <= (a.frame - (steps - 1) * a.rate > 1e-3 ? 2 : 1);
      if (earlier(a.since - 1, stepped)) {
        // (a new blend starts from the joints as the frame before left them: Fighter_ChangeMotionState copies
        // them as they are, and a swinging joint is where it had swung to. Mewtwo's tail's first joint going
        // from a dash attack, where it swings, into his wait, which drives it over a 12-frame blend, was up to
        // 11 units off at the tail's end for the blend's length)
        if (!goesOn) g.swung?.(a.since - 1, this.skeleton.rot);
        // (the part the move before turned the fighter by - a turn's or a back throw's YRotN, a roll's HipN: the
        // old animation's flags, fp->x596 - is not blended from where that move left it turned: after
        // Fighter_ChangeMotionState's own steps of the new animation the joint takes the shadow joint's place
        // and turn, the new animation's own, when the new animation's blend byte is not 0)
        const turned = !goesOn && b && b.anim >= 0 && b.kind === a.kind ? (this.flagsOf(b.anim) >> 6) & 7 : 0;
        const snap = turned && this.blendByte(a.anim) ? partToModelJoint(this.internalId, turned) : -1;
        const own = Math.min(steps, a.frame - (steps - 1) * a.rate > 1e-3 ? 2 : 1);
        for (let i = steps - 1; i >= 0; i--) {
          const left = a.blendFrames - (a.blendAt - i * a.rate);
          this.blendToward(tracks, Math.max(0, a.frame - i * a.rate), left <= 0 ? 1 : a.rate / (a.rate + left), flags, root2,
                           steps - i === own ? snap : -1);
        }
        return { anim };
      }
    }
    this.applyAnim(tracks, a.frame, flags, root2, a.blendFrames > 0);
    return { anim };
  }

  animFor(actionStateId: number): FigaTree | null {
    const sm = this.subactionOf(actionStateId);
    return sm === null ? null : this.anim(sm);
  }

  /** what the move's script does on which of its frames (fx/script.ts);
   *  `sub` a subaction played instead of the state's own (a wait's) */
  scriptFor(actionStateId: number, sub?: number): ScriptEvent[] {
    const sm = sub ?? this.subactionOf(actionStateId);
    return sm === null ? NO_EVENTS : this.scriptOf(sm);
  }

  private itemVis = new Map<number, ItemVis[]>();
  /** the frames a state's script hides and shows a held item on (itemhold.ts); `sub` as scriptFor's */
  itemVisFor(actionStateId: number, sub?: number): ItemVis[] {
    const sm = sub ?? this.subactionOf(actionStateId);
    if (sm === null) return NO_VIS;
    let ev = this.itemVis.get(sm);
    if (!ev) {
      const own = this.subactions[sm]?.script ?? null;
      const borrowed = this.shared?.subactions[sm]?.script ?? null;
      try {
        ev = own !== null ? itemVisEvents(this.pl, own) : borrowed !== null && this.sharedPl ? itemVisEvents(this.sharedPl, borrowed) : NO_VIS;
      } catch { ev = NO_VIS; }
      this.itemVis.set(sm, ev);
    }
    return ev;
  }

  /** the subaction of an action state, or null */
  subactionFor(actionStateId: number): number | null {
    return this.subactionOf(actionStateId);
  }

  private dynData: DynData | null | undefined;
  /** its swinging chains (ftData +0x2C: dynamics.ts), or null */
  dynamics(): DynData | null {
    if (this.dynData === undefined) {
      try { this.dynData = readDynamics(this.pl, this.ftData); } catch { this.dynData = null; }
    }
    return this.dynData;
  }

  /** a subaction's animation flags (+0x10) and its dynamics slot (ftData +0x10's second byte) */
  /** a subaction's own blend frames (ftData +0x10's first byte for it: what Fighter_ChangeMotionState blends over
   *  when it is given none) */
  private blendByte(sub: number): number {
    const t = ptr(this.pl, this.ftData + 0x10);
    const at = t === null ? -1 : t + sub * 2;
    return at >= 0 && at < this.pl.data.byteLength ? this.pl.data.getUint8(at) : 0;
  }

  animFlags(sub: number): { flags: number; slot: number } {
    const e = this.subactions[sub];
    const t = ptr(this.pl, this.ftData + 0x10);
    const at = t === null ? -1 : t + sub * 2 + 1;
    return { flags: e?.flags ?? 0, slot: at >= 0 && at < this.pl.data.byteLength ? this.pl.data.getUint8(at) : 0 };
  }

  private waits: WaitAnim[] | null = null;
  /** its wait animations to pick from (ftData+0x24: subaction, weight; waitanim.ts), with their lengths */
  waitAnims(): readonly WaitAnim[] {
    if (this.waits) return this.waits;
    const out: WaitAnim[] = [];
    const at = ptr(this.pl, this.ftData + 0x24);
    if (at !== null) {
      for (let i = 0; i < 8 && at + i * 8 + 8 <= this.pl.data.byteLength; i++) {
        const sub = this.pl.data.getInt32(at + i * 8), weight = this.pl.data.getInt32(at + i * 8 + 4);
        if (sub < 0) break;
        const a = this.anim(sub);
        if (a) out.push({ sub, weight, frames: a.frames });
      }
    }
    return this.waits = out;
  }

  private quakeLists = new Map<number, readonly ScriptQuake[]>();
  /** the camera quakes a move's script asks for (hitlag.ts scriptQuakes) */
  scriptQuakes(actionStateId: number): readonly ScriptQuake[] {
    let q = this.quakeLists.get(actionStateId);
    if (!q) this.quakeLists.set(actionStateId, q = scriptQuakes(this.scriptFor(actionStateId)));
    return q;
  }

  private gfxIndex: Map<number, Extract<ScriptEvent, { kind: "gfx" }>[]> | null = null;

  /** the events of its moves' scripts that start an effect, by the effect's id */
  scriptGfx(id: number): readonly Extract<ScriptEvent, { kind: "gfx" }>[] {
    if (!this.gfxIndex) {
      this.gfxIndex = new Map();
      const n = Math.max(this.subactions.length, this.shared?.subactions.length ?? 0);
      for (let sm = 0; sm < n; sm++) {
        for (const e of this.scriptOf(sm)) {
          if (e.kind !== "gfx") continue;
          const list = this.gfxIndex.get(e.gfx) ?? [];
          list.push(e);
          this.gfxIndex.set(e.gfx, list);
        }
      }
    }
    return this.gfxIndex.get(id) ?? [];
  }

  private clocked = new Map<number, ScriptEvent[] | null>();
  /** a move whose animation loops by itself (its subaction's flag): its
   *  script by the game's timer, from the move's start (fx/script.ts
   *  ScriptClock), its animation started over not starting it over; null
   *  for any other move */
  clockedScript(actionStateId: number): ScriptEvent[] | null {
    const sm = this.subactionOf(actionStateId);
    if (sm === null) return null;
    if (this.clocked.has(sm)) return this.clocked.get(sm)!;
    let ev: ScriptEvent[] | null = null;
    const own = this.subactions[sm], borrowed = this.shared?.subactions[sm];
    const entry = own?.script != null ? { e: own, pl: this.pl } : borrowed?.script != null && this.sharedPl ? { e: borrowed, pl: this.sharedPl } : null;
    const length = this.animFor(actionStateId)?.frames ?? 0;
    if (entry && (entry.e.flags & 0x40000000) && length >= 1) {
      try { ev = runScript(entry.pl, entry.e.script!, { length, horizon: CLOCK_HORIZON }); } catch { ev = null; }
    }
    this.clocked.set(sm, ev);
    return ev;
  }

  private scriptOf(sm: number): ScriptEvent[] {
    let ev = this.scripts.get(sm);
    if (!ev) {
      const own = this.subactions[sm]?.script ?? null;
      const borrowed = this.shared?.subactions[sm]?.script ?? null;
      try {
        ev = own !== null ? runScript(this.pl, own) : borrowed !== null && this.sharedPl ? runScript(this.sharedPl, borrowed) : NO_EVENTS;
      } catch {
        ev = NO_EVENTS;
      }
      this.scripts.set(sm, ev);
    }
    return ev;
  }

  /** one of its special attributes (ftData+4), a float by offset; 0 without */
  specialAttr(o: number): number {
    const at = ptr(this.pl, this.ftData + 4);
    return at === null || at + o + 4 > this.pl.data.byteLength ? 0 : this.pl.data.getFloat32(at + o);
  }

  /** one of its common attributes (ftData+0: co_attrs), a float by offset; 0 without */
  commonAttr(o: number): number {
    const at = ptr(this.pl, this.ftData);
    return at === null || at + o + 4 > this.pl.data.byteLength ? 0 : this.pl.data.getFloat32(at + o);
  }

  /** the same, a whole number */
  specialInt(o: number): number {
    const at = ptr(this.pl, this.ftData + 4);
    return at === null || at + o + 4 > this.pl.data.byteLength ? 0 : this.pl.data.getInt32(at + o);
  }

  private guard: JObj[] | null | undefined;
  /** the guard pose, from the joint under TopN on (null: none) */
  private guardPose(): JObj[] | null {
    if (this.guard !== undefined) return this.guard;
    const p20 = ptr(this.pl, this.ftData + 0x20), list = p20 === null ? null : ptr(this.pl, p20);
    const root = list === null ? null : ptr(this.pl, list + 2 * 4);
    try { this.guard = root === null ? null : loadJoint(this.pl, root).all; } catch { this.guard = null; }
    return this.guard;
  }

  /** the joints under TopN moved `t` of the way to the guard pose, leaned
   *  `tilt.amount` of the way toward the Guard animation at `tilt.frame` */
  private easeToGuard(t: number, tilt?: { frame: number; amount: number } | null) {
    const g = this.guardPose(), sk = this.skeleton;
    if (!g) return;
    const n = Math.min(g.length, sk.n - 1);
    // the guard pose, and the tilted one
    const target = new Float32Array(n * 9);
    for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) {
      target[k * 9 + c] = g[k].rot[c]; target[k * 9 + 3 + c] = g[k].scale[c]; target[k * 9 + 6 + c] = g[k].trans[c];
    }
    const lean = this.animFor(GUARD);
    if (tilt && tilt.amount > 0 && lean) {
      const rot = sk.rot.slice(), scale = sk.scale.slice(), trans = sk.trans.slice();
      sk.resetPose();
      sk.applyTracks(lean.tracks, tilt.frame);
      for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) {
        const j = (k + 1) * 3 + c, a = tilt.amount;
        target[k * 9 + c] += (sk.rot[j] - target[k * 9 + c]) * a;
        target[k * 9 + 3 + c] += (sk.scale[j] - target[k * 9 + 3 + c]) * a;
        target[k * 9 + 6 + c] += (sk.trans[j] - target[k * 9 + 6 + c]) * a;
      }
      sk.rot.set(rot); sk.scale.set(scale); sk.trans.set(trans);
    }
    // (lb_8000C868: places and sizes straight, turns through quaternions)
    for (let k = 0; k < n; k++) {
      const j = (k + 1) * 3;
      for (let c = 0; c < 3; c++) {
        sk.scale[j + c] += (target[k * 9 + 3 + c] - sk.scale[j + c]) * t;
        sk.trans[j + c] += (target[k * 9 + 6 + c] - sk.trans[j + c]) * t;
      }
      if (t >= 1) { sk.rot.set(target.subarray(k * 9, k * 9 + 3), j); continue; }
      sk.rot.set(blendTurn(target.subarray(k * 9, k * 9 + 3), sk.rot.subarray(j, j + 3), t), j);
    }
  }

  /** the joints under TopN for one frame: its animation (the game's own
   *  frame and blend when the viewer track has them), a fall's lean and the
   *  guard pose. True when something posed it */
  private body(state: PoseInput, depth: number, more = false): boolean {
    const sk = this.skeleton;
    // (held or thrown: the thrower's animation of it, on this fighter's joints)
    const b = state.borrow;
    const held = b || state.holdAnimOf === undefined ? null : this.animFor(state.holdAnimOf);
    // (the game's own animation, frame and blend when the viewer track has them)
    const game = !b && !held && state.game ? this.gamePose(state.game, state.game.frame, depth, state, more) : null;
    const anim = game ? game.anim : (b ? b.anim : held ?? (state.subaction !== undefined ? this.anim(state.subaction) : this.animFor(state.actionStateId)));
    const root2 = state.root2 ?? -1;
    if (state.transN !== undefined && state.transN > 0) this.transN = state.transN;
    if (!game) {
      // (a thrower's animation of it: its root motion is the thrower's to place)
      if (b) {
        sk.resetPose();
        sk.applyTracks(this.remapped(b), animTime(state.actionStateFrameCounter, b.anim.frames));
        if (sk.n > this.transN && !(this.transN === 1 && this.transNLeaf)) sk.trans[this.transN * 3] = sk.trans[this.transN * 3 + 1] = sk.trans[this.transN * 3 + 2] = 0;
      } else if (anim) {
        const sub = held ? this.subactionOf(state.holdAnimOf!) : state.subaction ?? this.subactionOf(state.actionStateId);
        this.applyAnim(this.ownTracks(anim), held ? held.frames : animTime(state.actionStateFrameCounter, anim.frames),
                       // (without the track whether it was set with a blend is not known: taken as its own blend
                       // byte says - Fighter_ChangeMotionState's blend when it is given none)
                       sub === null ? 0x80000000 : this.flagsOf(sub), root2, sub !== null && this.blendByte(sub) > 0);
      } else if (GUARD_ON.has(state.actionStateId) || state.actionStateId === GUARD) sk.resetPose(); // (the guard pose, below)
      // (Yoshi in his egg - GuardHold, GuardDamage: the game has his joints as his model's own there, and he is
      // drawn as the egg; measured, the pose check's 105 fighter-frames)
      else if (this.internalId === YOSHI && YOSHI_EGG.has(state.actionStateId)) { sk.resetPose(); if (depth === 0) this.posedBy = "rest"; }
      else if (!this.keptPose(state, depth)) this.standIn(state);
    }
    // falling: the lean into the fall's forward or backward animation
    const fall = state.fallLean && !b && !held ? this.subactionOf(state.actionStateId) : null;
    const fl = state.fallLean, leanSub = fl && fall !== null ? fall + fl.sub : null;
    const leanTo = leanSub === null ? null : this.anim(leanSub);
    if (fl && leanTo) {
      const tracks = this.ownTracks(leanTo), wrap = (f: number) => leanTo.frames > 0 ? f % leanTo.frames : f;
      const flags = this.flagsOf(leanSub!);
      if (fl.first !== undefined) this.blendToward(tracks, wrap(fl.first), fl.amount, flags, root2);
      this.blendToward(tracks, wrap(fl.frame), fl.amount, flags, root2);
    }
    // shielding: the game does not play the Guard animation (its frames are
    // the shield tilted each way); the fighter holds its guard pose, a joint
    // tree of its data (ftData+0x20's third), and eases into it as the shield
    // comes up (ftCo_80091E78), leaned toward the stick by the tilt the hold
    // has eased to (guard.ts)
    const s = state.actionStateId;
    if ((s === GUARD || GUARD_ON.has(s)) && this.internalId !== YOSHI) {
      // (coming up: the state has no animation, so the joints start where the
      // move before left them, and each frame they are blended k / frames of
      // the way on toward the guard pose from where the last frame's blend
      // left them, frames the GuardOn animation's length - ftCo_800924C0,
      // ftCo_GuardOn_Anim, ftCo_80091E78, lb_8000C868)
      const frames = Math.max(1, (this.animFor(GUARD_RISE) ?? anim)?.frames ?? 1);
      const age = Math.min(frames, Math.max(0, state.guardAge ?? state.actionStateFrameCounter + 1));
      if (s === GUARD) this.easeToGuard(1, state.guard);
      // (the track's kept pose has the frames before in it already: this
      // frame's step only. As the shield starts the game puts the joint it
      // hangs on at 0 - ftCo_800921DC - and the blend goes on from there)
      else if (game && !game.anim) {
        const sj = partToModelJoint(this.internalId, this.shieldJoint);
        if (age > 0) this.easeToGuard(Math.min(1, age / frames), state.guard);
        else if (sj > 1 && sj < sk.n) sk.trans[sj * 3] = sk.trans[sj * 3 + 1] = sk.trans[sj * 3 + 2] = 0;
      }
      // (without the track: from the GuardOn animation's first frames)
      else if (!anim) this.easeToGuard(1, state.guard);
      else for (let k = 1; k <= age; k++) this.easeToGuard(Math.min(1, k / frames), state.guard);
    }
    return !!(game || anim);
  }

  /** how the last pose() got its joints: "animation" (the state's own, the track's or a thrower's), "kept" (a state
   *  with none: the move before's last pose) or "stand-in" (nothing to keep either: its fall or wait); "bind" only
   *  for a fighter whose file has neither a fall nor a wait; "rest" where the model's own joints are what the
   *  game has (Yoshi in his egg) */
  posedBy: "animation" | "kept" | "stand-in" | "bind" | "rest" = "animation";

  /** a state with no animation of its own: the joints as the move before left them (PoseInput.kept) */
  private keptPose(state: PoseInput, depth: number): boolean {
    if (depth >= 4 || !state.kept) return false;
    const before = state.kept();
    if (!before || before.actionStateId === state.actionStateId) return false;
    // (the earlier frame's own pose, whole; one with no animation either is not kept: its stand-in is no pose
    // of the game's)
    const sub = before.subaction ?? this.subactionOf(before.actionStateId);
    if (!before.borrow && (sub === null || !this.anim(sub))) return false;
    if (!this.body({ ...before, kept: null, game: null }, depth + 1)) return false;
    if (depth === 0) this.posedBy = "kept";
    return true;
  }

  /** nothing to pose it from: its fall in the air, its wait on the ground, looping on the replay's clock - never
   *  the bind pose - and the state noted once */
  private standIn(state: PoseInput) {
    const sk = this.skeleton, key = `${this.internalId}:${state.actionStateId}`;
    if (!MISSING.has(key)) console.warn(`3D replay viewer: no animation for character ${this.internalId} in action state ${state.actionStateId}: its ${state.airborne ? "fall" : "wait"} stands in`);
    MISSING.set(key, (MISSING.get(key) ?? 0) + 1);
    const order = state.airborne ? [FALL_STATE, WAIT_STATE] : [WAIT_STATE, FALL_STATE];
    for (const st of order) {
      const sub = this.subactionOf(st), anim = sub === null ? null : this.anim(sub);
      if (!anim || sub === null) continue;
      const t = Math.max(0, state.clock ?? state.actionStateFrameCounter);
      this.applyAnim(this.ownTracks(anim), anim.frames > 1 ? t % anim.frames : 0, this.flagsOf(sub), state.root2 ?? -1);
      this.posedBy = "stand-in";
      return;
    }
    sk.resetPose();
    this.posedBy = "bind";
  }

  /** the pose for one replay frame; `xRot` turns one joint about its own x
   *  axis after the animation, as a move's code does (Fire Fox leans its
   *  XRotN along the way it flies); `at` puts it somewhere the replay does
   *  not say (a KO into the background or onto the screen, koPlace) */
  pose(state: PoseInput, xRot?: { joint: number; angle: number }, at?: Place | null, face?: Face | null) {
    const sk = this.skeleton;
    sk.shift = null;
    this.posedBy = "animation";
    this.body(state, 0);
    if (face?.parts.length) this.applyParts(face.parts);
    if (xRot && xRot.joint > 1 && xRot.joint < sk.n) sk.rot[xRot.joint * 3] = xRot.angle;
    // (TransN: an animation's root motion goes to the physics, not the model
    // - applyAnim. Where nothing hangs from it (Mr. Game & Watch's joint 1, a
    // leaf beside his body) the animation's translation stays: it is only
    // where things are tied to him, and the game ties them there (his neutral
    // air's 6.8 up puts the parachute over his head: the item is made at that
    // point))
    // TopN: where the fighter is and which way it faces
    sk.trans[0] = at?.x ?? state.xPosition; sk.trans[1] = at?.y ?? state.yPosition; sk.trans[2] = at?.z ?? state.depth ?? 0;
    sk.rot[0] = 0; sk.rot[1] = at?.turn ?? state.turn ?? (Math.PI / 2) * state.facingDirection; sk.rot[2] = 0;
    sk.scale[0] = sk.scale[1] = sk.scale[2] = this.modelScale;
    if (this.thin !== null) sk.scale[0] = this.thin;
    if (state.yScale !== undefined) sk.scale[1] = state.yScale;
    sk.update();
  }
}

// A star KO (DeadUpStar, and its frozen form): after a frame the game sends
// the fighter into the background, 350 units over 130 frames (ftCommonData
// 0x504, 0x508, 0x510), while the replay's x and y carry it up; then it is
// gone in a twinkle. The replay has no depth, so this is that depth, by how
// many frames the fighter has been in the state (the replay's own counter is
// the animation's, which starts over).
export const STAR_WAIT = 1, STAR_FRAMES = 130, STAR_DEPTH = -350;
export const isStarKO = (state: number) => state === 4 || state === 5;
// (the wait runs out in the state's animation step, which sets the speed, and
// the same frame's physics moves it: STAR_WAIT frames in, it is one step out
// - ftCo_DeadUpStar_Anim)
export function starDepth(age: number): number {
  return (STAR_DEPTH * Math.min(STAR_FRAMES, Math.max(0, age - STAR_WAIT + 1))) / STAR_FRAMES;
}

/** where a fighter is drawn, when not where the replay says */
export interface Place { x: number; y: number; z: number; turn?: number }

// A screen KO (DeadUpFall, states 6-10): the fighter is drawn at a point
// fixed to the camera, not in the world (ftDrawCommon puts it there from the
// camera's inverse view). It flies from above the picture, 100 in front of
// the eye, to just below the middle, 50 in front, over 50 frames; hits the
// screen (7, or 8 for a flat fighter, 10 frozen); holds 3 frames; then pops
// up and slides down and away for 40 frames (up 1, back 1 a frame, falling
// 0.2 a frame to at most 1.7) and is gone. It faces the camera (turned half
// round). The numbers are ftCommonData's, 0x524-0x55C.
const SCREEN_FROM = [0, 66.66, -100], SCREEN_TO = [0, -15, -50];
const SCREEN_FLY = 50, SCREEN_HOLD = 3, SCREEN_SLIDE = 40;
export const isScreenKO = (state: number) => state >= 6 && state <= 10;
const screenFlying = (state: number) => state === 6 || state === 9;

/** where a screen KO is, in the camera's space (the eye looking down -z),
 *  `age` frames into its state; null once it is gone */
export function screenPoint(state: number, age: number): [number, number, number] | null {
  if (screenFlying(state)) {
    const t = age <= 0 ? 0 : Math.min(1, (age + 1) / SCREEN_FLY);
    return [0, 1, 2].map((i) => SCREEN_FROM[i] + (SCREEN_TO[i] - SCREEN_FROM[i]) * t) as [number, number, number];
  }
  const n = age - SCREEN_HOLD + 1; // frames of the slide so far
  if (n > SCREEN_SLIDE) return null;
  let y = SCREEN_TO[1], vy = 1;
  for (let k = 1; k <= n; k++) { vy = Math.max(vy - 0.2, -1.7); y += vy; }
  return [SCREEN_TO[0], y, SCREEN_TO[2] - Math.max(0, n)];
}

/** where a KO'd fighter still in the picture is drawn: a star KO flying into
 *  the background, a screen KO on the screen (through `camInv`, the camera's
 *  inverse view); null for one not drawn. `age`: frames into its state. */
export function koPlace(state: number, age: number, x: number, y: number, flat: boolean,
                        camInv: Float32Array | null): Place | null {
  if (isStarKO(state)) return age <= STAR_WAIT + STAR_FRAMES ? { x, y, z: starDepth(age) } : null;
  if (!isScreenKO(state) || !camInv) return null;
  const p = screenPoint(state, age);
  if (!p) return null;
  const m = camInv;
  return {
    x: m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y: m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    z: m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    turn: flat ? undefined : Math.PI,
  };
}

// each character's starting part selections, as its code sets them when it
// comes in (each ftXx_Init_OnDeath's ftParts_80074A4C calls); parts not
// listed start at variant 0
const DEFAULT_PART: Record<number, number[]> = {
  24: [0, -1, 0, 0, -1, -1, -1, -1, -1, -1, -1], // Game & Watch: one of his flat poses
  7: [0, -1], // Sheik
  25: [0, -1], // Ganondorf: his sword only in his taunt
  26: [0, 0, -1], // Roy
};
/** Pichu's by costume: the goggles, the backpack or the bandanna, one each (ftPc_Init_OnDeath) */
const PICHU = 23;
const PICHU_PARTS: number[][] = [[0, -1, -1, -1], [0, 0, -1, -1], [0, -1, 0, -1], [0, -1, -1, 0]];
/** Peach's: no turnip or parasol until she uses one, and parts 1, 5 and 6 by
 *  costume - her second (1) shows part 5 instead of 1 and 6 (ftPe_Init_OnDeath) */
const PEACH = 9;
const PEACH_PARTS: number[][] = [[0, 0, 0, -1, 0, -1, 0], [0, -1, 0, -1, 0, 0, -1]];
function startingPart(internalId: number, costume: number, part: number): number {
  const list = internalId === PICHU ? PICHU_PARTS[costume] ?? PICHU_PARTS[0]
    : internalId === PEACH ? PEACH_PARTS[costume === 1 ? 1 : 0] : DEFAULT_PART[internalId];
  return list?.[part] ?? 0;
}
