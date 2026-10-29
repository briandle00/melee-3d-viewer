/* 3D replay viewer: the game's effects, run alongside the replay.
 *
 * Each frame the effects the game started are placed as its own dispatch
 * made them: from the viewer track's pieces while it holds (placePieces),
 * else every fighter's move script's (the dust of a dash, a jump, a
 * landing...), the hits' sparks where the hitbox met the hurtbox
 * (fx/contact.ts), and what the code starts besides as public replays'
 * tracks have it (the learned table: learnedEvents).
 * Each effect is the game's own: an effect model with its animation, from
 * the common effect file or the fighter's own, or a particle generator
 * whose particles run their own scripts (fx/particles.ts). The world steps
 * one frame at a time as the replay plays; after a jump it is rebuilt from a
 * little before, so what is on screen is the same whether the replay played
 * there or skipped there.
 */
import type { PlayerState } from "../../common/types";
import { type Fighter } from "../fighter";
import { EffectBank, type PtclKey } from "./bank";
import { Spawn, spawnFor } from "./dispatch";
import { AppSRT, Generator, hsdNext, Particle, ParticleSystem, Rng } from "./particles";
import { APP_ONCE } from "./appsrt";
import type { Once, ScriptEvent } from "./script";
import { SWORD_ATTRS, SwordAttrs, SwordTrails, swordAttrs } from "./swordtrail";
import type { Prop } from "../prop";
import { partToModelJoint } from "../parts";
import { effectsPaused } from "../hitlag";
import { colAnimGfx, ColAnimGfx, ColAnimTables, FighterColAnim, keepsSecondColor, Overlay, SECOND, startsOver, Tint } from "./colanim";
import { storedAnim, storedStarts } from "./charges";
import type { TrackEvent } from "../track";
import { cutterAnimationFrame, NativeCallbackClock, nativeEffectEvents, nativeEffectFamily, nativeEffectIds,
         outgoingNativeScriptEvents } from "./native-callbacks";
import { iceTransitionEffects, itemRuleEffects, itemTransitionEffects } from "../item-effects";

/** a fighter on one frame: its state, its model, and its joints' world
 *  matrices on that frame (16 floats each) */
export interface ActorFrame { key: string; st: PlayerState; fighter: Fighter; world: Float32Array }

/** what an effect is placed with */
export interface SpawnCtx {
  pos: [number, number, number];
  follow: (() => Float32Array | null) | null;
  facing: number;
  angle: number;
  damage: number;
  scale: number;
  /** a fighter whose change of move ends it, and the move */
  owner: string | null;
  /** the fighter it is made for: its effects all end together when the game
   *  says (efLib_DestroyAll: the track's "fxend") */
  by?: string;
  /** the tag its generators end with (an item's Ice Shot trail: "i:<spawn id>"); none, the fighter's (`by`).
   *  An impact's burst has none: it outlives its item */
  tag?: string;
  /** the frames it has already run: a callback's effect made where a seek lands part way through its move */
  age?: number;
  /** the call's offset from its joint (a script's): for the "offsetY" callback */
  offset?: [number, number, number];
  /** the world matrix of the maker's fighter part (an index into fp->parts), for a spawn made on a part */
  partFollow?: (part: number) => Float32Array | null;
  /** the frame of Final Cutter's effects its move let go on, when it has (cutterAnimationFrame) */
  cutterRelease?: number;
}

/** one piece of an effect in the learned table (effect-table.json, optional):
 *  m|g, its file's id, how it is made, the joint, its turn y (facing taken
 *  out) and z, scale, update callback, and for one made at a point where
 *  from its fighter or item (x with the facing taken out) */
export type LearnedPiece = ["m" | "g", number, string, number, number, number, number, string, number, number, number,
                            number?, number?, number?];
/** an effect the learned table has at a place: its id and pieces */
export type LearnedFx = [number, LearnedPiece[]];

/** An effect world taken to frame `f`: one step while playing, the frames
 *  between after a small skip, and after a jump made again from WARM frames
 *  back. `pose(g)` is called before each frame's `step(g)` - what the world
 *  reads from outside as it steps (the stage's joints, which its generators
 *  go along) has to be as it was on that frame, the warm-up's too - and the
 *  last one posed is `f`. True when it stepped frames before `f`. */
export function stepThrough(w: { frame: number; reset(f: number): void }, f: number, step: (g: number) => void,
                            pose: (g: number) => void,
                            far?: { frames: number | ((f: number) => number); start(g: number): void; step(g: number): void }): boolean {
  if (f === w.frame) return false;
  const gap = f - w.frame;
  let from = w.frame + 1;
  if (!(gap > 0 && gap <= 8)) {
    w.reset(f);
    from = Math.max(0, f - WARM);
    // (what lives longer than WARM - the stage's particles - is warmed from
    // further back, by a lighter step that runs it alone)
    if (far) {
      const first = Math.max(0, f - Math.max(WARM, typeof far.frames === "number" ? far.frames : far.frames(f)));
      far.start(first);
      for (let g = first; g < from; g++) { pose(g); far.step(g); }
    }
  }
  for (let g = from; g <= f; g++) { pose(g); step(g); }
  return from < f;
}

/** efLib_SpawnParticleEffect's other cases, by the effect's number. The particle list a key's generator and its
 *  particles are in (the game steps list 0's particles and generators first, then the others'): 2 for these,
 *  1 for those, 0 for the rest */
const MODEL_KEY_LIST = new Map<number, number>([[0xd4, 2], [0x243, 2], [0xfc, 1], [0xff, 1], [0xf7, 1], [0x7918, 1]]);
/** ... and the ones made on no joint at all (hsd_8039F05C, a transform set once from the model's root): they do
 *  not go along the model, and do not end with it or with its owner's effects */
const MODEL_KEY_ALONE = new Set([0x16d, 0x16e, 0x16f, 0x170, 0x7e2, 0xd4, 0x243, 0xe3]);
/** the generators a model's particle key makes under a transform of their own (efLib_SpawnParticleEffect's cases) */
/** ... of those, the ones whose transform takes the turn about y of the top joint of the model's tree, its size,
 *  and the joint's own size each frame (type 0x1000) */
const MODEL_KEY_ROT_Y = new Set([0x4a38, 0x4a39, 0x4a3a, 0xb798, 0xb799, 0xb79a]);
const MODEL_KEY_SCALE = new Set([0x127, 0x2, 0x6, 0xa3, 0xa7, 0xaa, 0xf2, 0x12a, 0x132, 0x133]);
const MODEL_KEY_JOINT_SIZE = new Set([0x2d, 0x2e, 0x31]);
const MODEL_KEY_SRT = new Set([0x2d, 0x2e, 0x31, 0x127, 0x4a38, 0x4a39, 0x4a3a, 0xb798, 0xb799, 0xb79a,
                               0x2, 0x6, 0xa3, 0xa7, 0xaa, 0xf2, 0x12a, 0x132, 0x133]);

/** An effect world as it stood after a frame (FxWorld.save), to be made again exactly (FxWorld.load): its own
 *  state copied, what it only reads (the effect files, the models' props, the hooks) kept as it is */
export interface FxSnapshot { frame: number; state: Record<string, unknown>; bytes: number }

// the classes an effect world's state is made of, copied in a snapshot; any other object it holds is kept
const COPIED = new Set<unknown>([ParticleSystem, Rng, SwordTrails, FighterColAnim, Overlay, NativeCallbackClock]);

/** A copy of a world's state: plain objects, arrays, maps, sets and the classes above, one copy of each however
 *  often it is held (a transform shared by a generator and its particles stays shared); typed arrays copied but
 *  a byte view into a file (a particle's script); functions and every other object kept. Walked with a stack
 *  (a particle list is a chain hundreds long). `size`: the bytes, roughly */
function copyState<T>(root: T, size: { bytes: number }): T {
  const memo = new Map<unknown, unknown>();
  const work: [unknown, unknown][] = [];
  const shell = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const seen = memo.get(v);
    if (seen !== undefined) return seen;
    let out: unknown;
    if (ArrayBuffer.isView(v)) {
      const t = v as Uint8Array;
      if (t instanceof Uint8Array && t.byteLength !== t.buffer.byteLength) return v;
      out = t.slice();
      size.bytes += t.byteLength;
      memo.set(v, out);
      return out;
    }
    if (Array.isArray(v)) out = new Array(v.length);
    else if (v instanceof Map) out = new Map();
    else if (v instanceof Set) out = new Set();
    else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null && !COPIED.has(proto.constructor)) return v;
      out = Object.create(proto);
    }
    memo.set(v, out);
    work.push([v, out]);
    return out;
  };
  const top = shell(root);
  while (work.length) {
    const [src, dst] = work.pop()!;
    size.bytes += 16;
    if (Array.isArray(src)) {
      const d = dst as unknown[];
      for (let i = 0; i < src.length; i++) d[i] = shell(src[i]);
      size.bytes += 8 * src.length;
    } else if (src instanceof Map) {
      for (const [k, v] of src) (dst as Map<unknown, unknown>).set(shell(k), shell(v));
      size.bytes += 16 * src.size;
    } else if (src instanceof Set) {
      for (const v of src) (dst as Set<unknown>).add(shell(v));
      size.bytes += 8 * src.size;
    } else {
      const d = dst as Record<string, unknown>;
      for (const k of Object.keys(src as object)) d[k] = shell((src as Record<string, unknown>)[k]);
      size.bytes += 8 * Object.keys(src as object).length;
    }
  }
  return top as T;
}

/** how far back the stage's generators are warmed after a jump: longer than any stage particle lives */
export const STAGE_WARM = 330;
/** ... and the furthest back (FxWorld.stageFrames) */
export const STAGE_FAR = 1200;

export interface ModelFx {
  /** the effect file it is a model of */
  bank: EffectBank;
  index: number;
  x: number; y: number; z: number;
  rotY: number; rotZ: number; scale: number;
  /** its turn about x, when the dispatch gives it one (HSD_JObjSetRotationX: an egg's shell pieces, efSync 0x4CF) */
  rotX?: number;
  age: number;
  life: number;
  follow: (() => Float32Array | null) | null;
  /** the fighter it was made for (SpawnCtx.by) */
  by?: string;
  /** whose effect the track says it is (a fighter's key, or "i:<item spawn id>"):
   *  it goes, and the generators on its joints end, when that owner's effects end */
  whose?: string | null;
  /** not drawn this frame (a model shown only in some of its fighter's states) */
  hidden?: boolean;
  /** a child of this joint (its world matrix), turned as it turns */
  under?: (() => Float32Array | null) | null;
  owner: string | null;
  /** turns it each frame, as the game's effect update does (to the way the
   *  fighter faces, or flies) */
  turn: ((m: ModelFx) => void) | null;
  /** where the generators its animation starts are kept, when they end with
   *  the move that started it (a special move's own effect) */
  kin?: Generator[];
  /** the frame it jumps to its end on (Final Cutter's trail: frame 65, 11 more frames) */
  endAt?: number;
  /** colors the game sets on its first texture's TEV (a KO blast's) */
  tint?: { konst: number[]; tev0: number[] };
  /** the game's random state as its animation's first step ran (a version 2
   *  track's piece): its own generators are then made when the game makes
   *  them (modelParticles) */
  seed?: number;
  /** its update callback's part that makes a generator, run each frame it
   *  runs after its animation's step (efLib_Cb_LifetimeEndSpawn) */
  after?: (m: ModelFx) => void;
  /** never paused in its owner's hitlag (NEVER_PAUSED) */
  steady?: boolean;
  /** what its update callback carries from frame to frame: the way it last flew (SetRotYZ_FromFighter), its
   *  falling speed (SetOffset_FromParams, a flung shell), the frames its lifetime has left (LifetimeEndSpawn) */
  way?: number;
  fall?: number;
  left?: number;
  /** its root joint's place is the one the game's dispatch set, over the file's own (a track's piece made at a
   *  place or on a joint: efLib_Create_Attach_Pos and the attach calls set the root's translation; a few
   *  models' roots have a place of their own in the file, 114 units toward the camera in one) */
  rootSet?: boolean;
  /** kept this far above the joint it follows ("offsetY" callback) */
  offsetY?: number;
  /** its joint 1 carried along z as it ages ("jabZ" callback) */
  jabZ?: boolean;
  /** Final Cutter's effect: its frames follow the move, and when the move let go (cutterAnimationFrame) */
  cutter?: { releasedAt?: number };
  /** its root's turn about y (`rotY`) or z (`rotZ`) set after its animation, in place of the animated one
   *  (HSD_JObjSetRotationY and Z in its callback) rather than added to it */
  rootRotationY?: boolean;
  rootRotationZ?: boolean;
  /** held to the joint it is under by place and turn constraints (Prop.poseConstrained), not made its child */
  constrained?: boolean;
  /** the root's first child's next joint and everything under it hidden, as its update callback last set
   *  them (efLib_Cb_ftMr_SpecialLw, efLib_Cb_ftLg_SpecialLw) */
  secondChildOff?: boolean;
}

/** The effects whose model the game's dispatch marks with state bit 0x80
 *  (efasync.c, each of these cases: the hit sparks, the dust and flash
 *  models). When a move pauses its fighter's effects in hitlag,
 *  efLib_PauseAll keeps that bit beside "entering pause", and efLib_Update
 *  compares the whole byte with "entering pause" and "paused": with the bit
 *  set neither matches, so such a model is never paused. Seen in the game's
 *  memory: state 0x81 through a hitlag, its lifetime counting down and its
 *  joint turning every frame, while the same owner's other model stood
 *  still at state 2. */
const NEVER_PAUSED = new Set([
  0x3e8, 0x3eb, 0x3ec, 0x3f5, 0x3f6, 0x3f7, 0x3f8, 0x3f9, 0x3fa, 0x3fb, 0x3fc, 0x3fd, 0x3ff, 0x404, 0x406, 0x415,
  0x41d,
]);

/** efLib_Cb_LifetimeEndSpawn: when the model's lifetime has run down to 1 it
 *  makes this common generator on the joint the dispatch set aside for it
 *  (the fighter's part, by the effect's id - the track's piece names only the
 *  joint the model is on), and the model then lives this many frames more */
const LIFETIME_END_GEN = 0x1ab, LIFETIME_END_MORE = 0x27;
const LIFETIME_END_PART: Record<number, number> = { 0x501: 85 };

// the KO blast's model in the common effect file, and its spawn (efSync 0x42B)
const KO_BLAST = 0x19, KO_BLAST_FX = 0x42b;

/** Kirby (internal id), and the states of his Final Cutter, whose effects carry on through all of them */
const KIRBY = 4, CUTTER_FIRST = 385, CUTTER_LAST = 392, CUTTER_FX = 0x494;
/** Fire Fox's and Fire Bird's launch on the ground (its speed forward is the ground's, not the air's) */
const FIRE_LAUNCH_GROUND = 355;
/** whether Final Cutter's script has let go of its effects by its frame `counter` (its command variable 2 set) */
const letsGo = (script: readonly ScriptEvent[], counter: number) =>
  script.some((e) => e.kind === "cmdVar" && e.index === 2 && e.value !== 0 && e.frame <= counter);
// color animations: the invincibility blink, and the ones a stored charge
// runs (Game & Watch's full bucket, Samus, DK, Sheik, Mewtwo)
const INVINCIBLE = 9;
const STORED = new Set([5, 53, 57, 86, 92]);
// a fighter coming back on the platform
const REBIRTH = 12, REBIRTH_WAIT = 13;
// entering the match (EntryStart), and its white flash (color animation 0x75)
const ENTRY_START = 323, ENTRY_END = 324, ENTRY_FLASH = 0x75;
// the techs that flash (color animation 120): in place (Passive,
// ftCo_800987D0), on a wall and its jump (ftCo_800C1E64: a wall jump too),
// on the ceiling (ftCo_800C23FC) - each started by the code that enters the
// state, after the change of state has run the frame's colors, so it shows
// from the next frame's step. A tech roll (PassiveStandF/B, ftCo_800989D4)
// has none; the tech's own wall jump (from PassiveWall) goes on without one
const TECH_FLASH = 120, PASSIVE = 199, PASSIVE_WALL = 202, PASSIVE_WALL_JUMP = 203, PASSIVE_CEIL = 204;
const techFlashes = (s: number, from: number) =>
  s === PASSIVE || s === PASSIVE_WALL || s === PASSIVE_CEIL || (s === PASSIVE_WALL_JUMP && from !== PASSIVE_WALL);
// the color animations the fighters' own moves start as a state begins:
// Jigglypuff's Rollout charged full (ftpurinspecialn.c: 5, ground and air)
const STATE_COLORS: Record<number, Record<number, number>> = {
  15: { 349: 5, 357: 5 },
};
// moves begun from the fighter's input check (IASA), which runs after the
// frame's color animations have: the one its script starts at once
// (Fighter_ChangeMotionState runs the script's first frame) shows from the
// next frame. Fox's and Falco's reflector turning (ftFx_SpecialLwTurn_Check,
// from the loop's IASA: its glow, 46, is off on the turn's first frame)
const INPUT_ENTERED: Record<number, number[]> = { 1: [364, 369], 22: [364, 369] };
// spawns whose models are drawn outside the effect world (fx/drawn.ts: from
// the track's pieces too, by the player's own drawing): the shield's bubble
// (0x417-0x41A: its size and color follow the shield's health) and the
// reflector's three models (0x488-0x48A)
const DRAWN_ELSEWHERE = new Set([0x417, 0x418, 0x419, 0x41a, 0x488, 0x489, 0x48a]);
// the update callbacks of a piece that turn it the way its fighter faces
// every frame (efLib_Cb_SetRotY_FromFighterDir and its kin), and those that
// need nothing here: they keep the model where the dispatch put it, or only
// change its colors
const FACING_CALLBACKS = new Set(["SetRotY_FromFighterDir", "SetRotYZ_FromFighter", "SetScaleRotY_FromFighter"]);
const KNOWN_CALLBACKS = new Set(["ApplyStoredAlpha", "SetRotYAndTransition", "LifetimeEndSpawn"]);

/** whether a move whose last frame showed `counter` ended with its animation
 *  (its animation callback changed the state: ftAnim_IsFramesRemaining): its
 *  next step, at `rate` frames a step, would have reached the end */
export function animEnded(fighter: Partial<Pick<Fighter, "animFor">>, action: number, counter: number, rate = 1): boolean {
  const an = fighter.animFor?.(action);
  return !!an && an.frames > 0 && counter + Math.max(rate, 1e-3) >= an.frames - 0.5;
}

// changes of state a move's animation callback makes before its animation
// ends (in the frame's animation step, before its color step): the jump
// leaving its squat (ftCo_KneeBend_Anim, by its own count), and Mewtwo's
// Shadow Ball charged full (ftMt_SpecialNLoop_Anim), on the ground and in the air
const KNEE_BEND = 24, JUMP_F = 25, JUMP_B = 26;
const ANIM_CB_CHANGES: Record<number, [number, number][]> = { 16: [[342, 343], [347, 348]] };
// (the full charge carries the loop's animation on from its frame: no step of the colors of its own)
const carriesOn = (char: number, from: number, to: number) => char === 16 && ((from === 342 && to === 343) || (from === 347 && to === 348));
// Yoshi's egg roll switching between rolling on the ground (357), turning
// (358) and rolling in the air (362): with Ft_MF_UpdateCmd the new state's
// script is run on to where it stands without doing its commands
// (ftAction_8007349C: its color at frame 0 not started again), and but for
// the turn with Ft_MF_SkipColAnim its color goes on (ftyoshispecials.c:
// 0x0C4C509A, 0x0C4C5892, 0x4C4892). Its loops' counters stand at 0 (their
// animations' rate is 0), so the replay cannot tell these from a fresh start
const ROLL_SWITCH: Record<string, { keepColor: boolean }> = {
  "362>357": { keepColor: true }, "357>362": { keepColor: true }, "358>362": { keepColor: true }, "357>358": { keepColor: false },
};
const rollSwitch = (char: number, from: number, to: number) => (char === 14 ? ROLL_SWITCH[`${from}>${to}`] : undefined);
// the shield up (GuardOn to Guard: its animation's end, though the replay's counter stays at -1 through both)
const GUARD_ON = 178, GUARD = 179;
const byAnimCallback = (char: number, from: number, to: number) =>
  (from === KNEE_BEND && (to === JUMP_F || to === JUMP_B)) || (from === GUARD_ON && to === GUARD) ||
  (ANIM_CB_CHANGES[char]?.some(([f, t]) => f === from && t === to) ?? false);
// states whose animation loops (its end changes nothing): standing, walking,
// running, falling, crouched, shielding. One seen starting over is another
const LOOPING = new Set([14, 15, 16, 17, 21, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 179,
  // and flying from a hit (DamageFlyHi to DamageFlyRoll: they end by the hitstun, not the animation)
  87, 88, 89, 90, 91]);
// what a fighter standing still takes up from its input check (walking,
// turning, dashing, the jump's squat, crouching, the shield, the ground
// attacks, a grab, a roll or dodge): one of these where an animation ended
// that frame was taken from the Wait the animation's end went to first
// (and the ledge: its catch ends into its wait, and an option is taken from there: CliffClimbSlow to CliffJumpQuick2)
const CLIFF_CATCH = 252, CLIFF_OPTIONS = [254, 263];
// (and the floor: a knockdown's bounce ends into lying there, and getting up
// or rolling is taken from there - DownBoundU to DownStandU, DownFowardU and
// DownBackU, the same face down. Not the attack: the bounce takes that itself)
const DOWN_OPTIONS: Record<number, number[]> = { 183: [186, 188, 189], 191: [194, 196, 197] };
// Sheik's needles let go as the start's animation ends: its loop came first (AirNStart to AirNEnd, NStart to NEnd)
const INPUT_AFTER_END: Record<number, [number, number][]> = { 7: [[345, 348], [341, 344]] };
// what only a collision starts (landing, a tech or a bounce off the floor, the
// ledge caught): always after the frame's color step, whatever the animation before did
const COLLISION_STATES = new Set([42, 43, 183, 191, 199, 200, 201, 202, 203, 204, 252]);
const FROM_WAIT = new Set([15, 16, 17, 18, 20, 24, 39, 178, ...Array.from({ length: 21 }, (_, i) => 44 + i), 212, 233, 234, 235]);
// what is taken up from falling (the jumps in the air, the aerials, an air
// dodge): from an air move whose animation ended into Fall, unseen, the same
// frame (ftCo_Pass_Anim, the jumps' and aerials' ends: Fall, its own step of
// the colors, then the input check's change)
const FROM_FALL = new Set([27, 28, 65, 66, 67, 68, 69, 236]);
const LANDING_FALL_SPECIAL = 43, JUMPS = new Set([25, 26, 27, 28]);
// moves whose loop starts over by entering itself again, not by its animation
// looping: the blaster's loop shooting again (ftFox_SpecialNLoop_Anim, the
// same for Falco: Fighter_ChangeMotionState, with its step of the colors)
const REENTERED: Record<number, number[]> = { 1: [342, 345], 22: [342, 345] };

/** a fighter's move as the world last stepped it (grounded: on the floor on that frame) */
interface Track { action: number; entry: number; entryCounter: number; counter: number; seen: number; grounded?: boolean;
                 /** begun on its entry frame (not picked up under way by a world started later) */
                 fresh?: boolean;
                 /** whether its counter moved on the frame last stepped (else its animation stood still) */
                 moved?: boolean;
                 /** the frames its counter last moved by in a step (its animation's rate) */
                 rate?: number;
                 /** its counter has started over (a looping animation) */
                 looped?: boolean;
                 /** a move whose animation loops by itself: how far its script has run
                  *  (a frame each frame out of hitlag: Fighter.clockedScript) */
                 age?: number }

/** a replay item (a projectile) on a frame, as its effects need it */
export interface FxItem { spawnId: number; typeId: number; owner: number; x: number; y: number; missile: number; launched?: boolean;
                          facing?: number; vx?: number; vy?: number; state?: number }
// how many frames back a rebuild starts from (the longest-lived dust)
export const WARM = 48;
const NO_WORLD = new Float32Array(0);
const NO_PARTICLES: Particle[] = [];

export class FxWorld {
  ps = new ParticleSystem();
  models: ModelFx[] = [];
  /** the last frame stepped */
  frame = Number.NEGATIVE_INFINITY;
  private tracks = new Map<string, Track>();
  /** each fighter's callback effects started in its current move (fx/native-callbacks.ts) */
  private nativeClocks = new Map<string, NativeCallbackClock>();
  private worlds = new Map<string, Float32Array>();
  private prevWorlds = new Map<string, Float32Array>();
  private owned = new Map<string, { action: number; gens: Generator[]; models: ModelFx[] }>();
  /** each fighter's state on the frame being stepped */
  private sts = new Map<string, PlayerState>();
  /** the frame being stepped */
  private stepping = Number.NEGATIVE_INFINITY;
  /** the fighters whose move began this frame after its color step (enterColors) */
  private lateStart = new Set<string>();
  /** when a fighter's scripts last started an effect (by "key:id") */
  private scriptStarted = new Map<string, number>();

  /** extra events for a frame: hits and the like (contact.ts) */
  extra: ((frame: number, actors: ActorFrame[], w: FxWorld) => void) | null = null;
  /** the replay's items on a frame */
  items: ((frame: number) => FxItem[]) | null = null;
  /** an item's model's particle keys in its state and how far into its
   *  animation it is (its article's: Luigi's fireball's smoke), or null */
  itemPtcl: ((it: FxItem, frame: number) => { keys: PtclKey[]; age: number } | null) | null = null;
  /** the effects the game started on a frame, from the viewer track (track.ts
   *  "fx"), or null without one: then the fighters' own code's effects are
   *  started at their exact frames from it, not guessed from their states */
  trackFx: ((frame: number) => TrackEvent[]) | null = null;
  /** the first frame (the replay's index) the track's effects do not hold
   *  for: from there the scripts and the learned table start them, as with
   *  no track (a track whose game parted from the replay's) */
  trackUntil = Number.POSITIVE_INFINITY;
  /** whether the frame being stepped has its effects from the track */
  private get tracked(): boolean {
    return !!this.trackFx && this.stepping < this.trackUntil;
  }
  /** the pieces of the effects the game made on a frame, from the viewer
   *  track ("fxp": what the game's own dispatch made for each spawn - which
   *  model or generator of which effect file, on which joint or where,
   *  turned and scaled how, run on by which callback), or null when it has
   *  none (a track from before the simulator wrote them) */
  trackPieces: ((frame: number) => TrackEvent[]) | null = null;
  /** the game's random state after a frame's gameplay, from the viewer track
   *  ("rng"): what the particles' update draws from that frame, so they are
   *  the game's own. null where the track has none (an earlier track): the
   *  particles draw from the stand-in stream, as with no track */
  trackRng: ((frame: number) => number | null) | null = null;
  /** whether the frame being stepped has its effects placed from the
   *  track's pieces alone: none of the scripts', the code's or the hits'
   *  own starts, which the pieces already are */
  get generic(): boolean {
    return this.tracked;
  }
  /** each piece placed on a fighter's joint, as it is placed: the spawn,
   *  whose, the piece, and where it went here against where the game made it
   *  (its joint's world position then) - the parity harness's */
  placed: ((frame: number, gfx: number, by: string | null, index: number, ours: number[], game: number[], before: number[]) => void) | null = null;
  /** the effects the game starts, learned from public replays' tracks
   *  (effect-table.json beside the page, optional): by a fighter's
   *  "f<character>:<state>:<frame of it>" or an item's "i<type>:<state>:<age>",
   *  each effect and its pieces. Used where no track holds (none yet, or
   *  after its game parted from the replay), with the move scripts' own */
  learned: ((key: string) => LearnedFx[] | undefined) | null = null;
  /** an effect's pieces as the game makes them most often (the learned
   *  table's): how a move script's own effect of a fighter's file is made */
  learnedGfx: ((gfx: number) => LearnedPiece[] | undefined) | null = null;
  /** the frame each item was first seen on (its age, for the learned table) */
  private itemBorn = new Map<number, number>();
  /** the update callbacks the pieces named that are not run here (a check's) */
  readonly unknownCallbacks = new Set<string>();
  /** where a fighter's current move started: its frame and counter there */
  entryCounterOf: ((key: string, frame: number) => { entry: number; counter: number } | undefined) | null = null;
  /** a fighter's state on any frame of the replay (by its key), for what is worked out from before a seek */
  stateAt: ((key: string, frame: number) => PlayerState | undefined) | null = null;

  /** the color animations' scripts (PlCo.dat), and each fighter's running ones */
  colTables: ColAnimTables | null = null;
  private cols = new Map<string, FighterColAnim>();
  /** each fighter's whole-body state its move scripts set (0: hittable) */
  private bodyStates = new Map<string, number>();
  /** each fighter's smash attack charging, and its color animation */
  private charging = new Map<string, number>();
  /** whether a fighter is in its invincibility after coming back or catching
   *  the ledge (the game blinks it: color animation 9) */
  invincible: ((key: string, frame: number) => boolean) | null = null;
  /** whether the fighter's change of state on this frame sets that timer (its blink starts there) */
  invincibleAsked: ((key: string, frame: number) => boolean) | null = null;
  /** the color animation of a charge a fighter holds stored at full (fx/charges.ts), or 0 */
  stored: ((key: string, frame: number) => number) | null = null;
  /** a launched fighter's puff of smoke on a frame: its angle, or NaN for
   *  none (fx/launchsmoke.ts; a viewer track's own puffs take its place) */
  launchSmoke: ((key: string, frame: number) => number) | null = null;

  /** the common effects (EfCoData), and the fighters' own effect files by
   *  the game's number for them (fx/dispatch.ts EFFECT_FILES) */
  constructor(public common: EffectBank, private partToJoint: (char: number, part: number) => number,
              public banks: Map<number, EffectBank> = new Map([[common.id, common]])) {}

  /** the fields that are the world's state after a frame (everything reset() empties, and what it keeps) */
  private static readonly STATE = ["ps", "models", "frame", "stepping", "stageKept", "spawned", "spawning", "tracks",
    "nativeClocks", "worlds", "prevWorlds", "owned", "sts", "lateStart", "scriptStarted", "itemBorn", "cols", "bodyStates",
    "charging", "rngAfter", "hudPlaces", "itemAt", "itemJoints", "swords"] as const;

  /** the world as it stands now, to be made again by load(): a stepped world is the same frame for frame from
   *  the same snapshot, so a jump made from the nearest one before it and stepped on is the game's, as playing
   *  through to it is */
  save(): FxSnapshot {
    const size = { bytes: 0 };
    const me = this as unknown as Record<string, unknown>;
    const state = copyState(Object.fromEntries(FxWorld.STATE.map((k) => [k, me[k]])), size);
    return { frame: this.frame, state, bytes: size.bytes };
  }

  /** the world made again as a snapshot has it (the snapshot itself left as it is, for another load) */
  load(s: FxSnapshot) {
    const me = this as unknown as Record<string, unknown>;
    const state = copyState(s.state, { bytes: 0 });
    for (const k of FxWorld.STATE) me[k] = state[k];
  }

  reset(seed: number) {
    this.ps.clear();
    this.hudPlaces.clear();
    this.stageKept = null;
    this.models.length = 0;
    this.tracks.clear();
    this.nativeClocks.clear();
    this.owned.clear();
    this.sts.clear();
    this.scriptStarted.clear();
    this.worlds.clear();
    this.prevWorlds.clear();
    this.cols.clear();
    this.bodyStates.clear();
    this.charging.clear();
    this.itemBorn.clear();
    this.itemAt.clear();
    this.swords.clear();
    this.ps.rng.seed(seed * 2654435761);
    this.frame = Number.NEGATIVE_INFINITY;
  }

  /** a joint's world matrix on the frame being stepped */
  jointWorld(key: string, joint: number): Float32Array | null {
    const w = this.worlds.get(key);
    if (!w || joint < 0 || (joint + 1) * 16 > w.length) return null;
    return w.subarray(joint * 16, joint * 16 + 16);
  }

  /** a fighter's joints on the frame before the one being stepped */
  prevWorld(key: string): Float32Array | null {
    return this.prevWorlds.get(key) ?? null;
  }

  /** how far into its move a fighter is on the frame being stepped */
  scriptTime(key: string): number | null {
    const t = this.tracks.get(key);
    return t ? t.counter - t.entryCounter : null;
  }

  /** one frame: effects the fighters start, then everything moves on */
  step(frame: number, actors: ActorFrame[]) {
    // (a fighter whose move pauses its effects in hitlag: they stand still, ../hitlag.ts)
    const still = new Set(actors.filter((a) => effectsPaused(this.sts.get(a.key), a.st)).map((a) => a.key));
    const runs = (m: ModelFx) => !m.by || m.steady || !still.has(m.by);
    const swap = this.prevWorlds;
    this.prevWorlds = this.worlds;
    this.worlds = swap;
    this.worlds.clear();
    this.sts.clear();
    this.lateStart.clear();
    this.stepping = frame;
    for (const a of actors) { this.worlds.set(a.key, a.world); this.sts.set(a.key, a.st); }
    for (const a of actors) this.fighterEvents(frame, a);
    if (!this.tracked && this.launchSmoke) for (const a of actors) this.smokePuff(frame, a);
    // (the items first: the track's effects on an item go where it is now)
    if (this.items) this.itemEvents(this.items(frame));
    if (this.tracked) this.trackEvents(frame, actors);
    else if (this.learned) this.learnedEvents(frame, actors);
    this.extra?.(frame, actors, this);
    for (const a of actors) this.colors(frame, a);
    for (const m of this.models) if (m.endAt === frame) { m.age = 65; m.life = 65 + 11; m.endAt = undefined; }
    for (const m of this.models) if (runs(m)) m.turn?.(m);
    // (the game's own random state for this frame's particles, when the track
    // has it. The effect models' animations step first - what their later
    // keys' generators draw comes before the particles' own draws)
    const state = this.tracked ? this.trackRng?.(frame) ?? null : null;
    if (state !== null) this.ps.rng.set(state);
    else this.ps.rng.free();
    // (each model's own update callback's generator comes after its animation's keys: efLib_Update)
    for (const m of this.models) if (runs(m)) { this.modelParticles(m); m.after?.(m); }
    this.ps.step();
    // (what the HUD's code makes comes after the frame's particles have run: its proc is the later one)
    if (this.tracked && this.trackHud) for (const e of this.trackHud(frame)) this.hudGen(e);
    for (const m of this.models) if (runs(m)) m.age++;
    this.models = this.models.filter((m) => m.age < m.life);
    this.frame = frame;
    this.keepRng(frame);
  }

  /** the game's random state at the end of each frame's particles and HUD generators (the replay's index), the
   *  last few hundred stepped: where the HUD's own draws start (its percent's shake and scatter, hud.ts) */
  readonly rngAfter = new Map<number, number>();
  private keepRng(frame: number) {
    const s = this.ps.rng.state;
    if (s === null) return;
    this.rngAfter.set(frame, s);
    if (this.rngAfter.size > 600) this.rngAfter.delete(this.rngAfter.keys().next().value!);
  }

  /** the generators the HUD's code made on a frame, from the viewer track
   *  ("hgen"), or null when the track has none (an earlier simulator's: the
   *  HUD then runs its bursts on its own, hud.ts) */
  trackHud: ((frame: number) => TrackEvent[]) | null = null;
  /** where the game made each of the HUD's generators, in the HUD's own
   *  space, by its tag ("hud:<port>:<icon>") */
  readonly hudPlaces = new Map<string, [number, number]>();
  /** A generator the HUD made: ["hgen", file, id, x, y, z, seed, port, icon] -
   *  a lost stock's burst where its icon was (ifStock_802F8298: efSync 0x474,
   *  the common file's generator 0xF7). It is on particle list 1, which the
   *  HUD's own camera draws, and it is in the one generator list and draws
   *  from the one random stream with everything else: made after the frame's
   *  particles have run (the HUD's proc is the later one), it takes its first
   *  step in the next frame's pass, ahead of the KO blast's own. Seen in the
   *  game's memory. */
  private hudGen(e: TrackEvent) {
    const [file, id, x, y, z, seed, port, icon] = e.slice(2).map(Number);
    const bank = this.banks.get(file) ?? null;
    const g = bank ? this.ps.generator(bank, id, seed >>> 0) : null;
    if (!g) return;
    g.made = "hud";
    g.linkNo = 1;
    g.px = x; g.py = y; g.pz = z;
    g.tag = `hud:${port}:${icon}`;
    this.hudPlaces.set(g.tag, [x, y]);
  }

  /** the particles one camera draws: the HUD's (particle list 1: the game
   *  draws it from the HUD's pass, in the HUD's space) or the match's (every
   *  other list) */
  particlesOf(hud: boolean): Particle[] {
    const all = this.ps.particles;
    if (!all.some((p) => p.linkNo === 1)) return hud ? NO_PARTICLES : all;
    return all.filter((p) => (p.linkNo === 1) === hud);
  }

  /** how old Final Cutter's effects are on `frame` and when the move let go of them (its command variable
   *  2 set), counted from the frame the move began through all its states, less the frames its effects were
   *  held still in hitlag: from the replay, so a seek gives the same as playing to there */
  private cutterHistory(a: ActorFrame, frame: number): { age: number; releasedAt?: number } {
    const read = (f: number) => this.stateAt?.(a.key, f);
    const inCutter = (s: PlayerState | undefined) =>
      s !== undefined && s.internalCharacterId === KIRBY && nativeEffectFamily(KIRBY, s.actionStateId) === family;
    const family = nativeEffectFamily(KIRBY, a.st.actionStateId);
    let start = frame;
    while (start > 0 && inCutter(read(start - 1))) start--;
    let age = 0;
    let releasedAt: number | undefined;
    for (let f = start; f <= frame; f++) {
      const st = read(f) ?? a.st;
      if (f > start && !effectsPaused(read(f - 1), st)) age++;
      if (releasedAt === undefined && letsGo(a.fighter.scriptFor(st.actionStateId), st.actionStateFrameCounter)) releasedAt = age;
    }
    return { age, releasedAt };
  }

  private fighterEvents(frame: number, a: ActorFrame) {
    const st = a.st;
    // (a move whose callback effects are not the last one's: those end with it)
    let nativeClock = this.nativeClocks.get(a.key);
    if (!nativeClock) {
      nativeClock = new NativeCallbackClock();
      this.nativeClocks.set(a.key, nativeClock);
    }
    if (nativeClock.enter(st.internalCharacterId, st.actionStateId)) this.endOwned(`${a.key}:native`);
    if (st.isDead || st.actionStateId <= 11) {
      // a KO through a blast line: its blast, once, as the fighter goes
      const t = this.tracks.get(a.key);
      if (st.actionStateId <= 3 && (t ? t.action > 3 : true)) {
        const known = t ? undefined : this.entryCounterOf?.(a.key, frame);
        // (with the track's pieces the blast is theirs: efSync 0x42B, model 0x19;
        // without, the world's own, on the blast line it crossed)
        if ((t || known) && !this.generic) this.koBlast(a, t ? 0 : frame - known!.entry);
      }
      // (by the frames since it began: the replay's counter starts over)
      const same = t !== undefined && t.action === st.actionStateId;
      const entry = same ? t!.entry : t ? frame : this.entryCounterOf?.(a.key, frame)?.entry ?? frame;
      if (t && !same) { t.action = st.actionStateId; t.entry = entry; }
      else if (!t) this.tracks.set(a.key, { action: st.actionStateId, entry, entryCounter: 0, counter: 0, seen: frame });
      // gone: the effects that go with its moves, its colors with it
      this.endOwned(a.key);
      this.endOwned(`${a.key}:native`);
      this.nativeClocks.delete(a.key);
      this.cols.delete(a.key);
      this.swords.clear(a.key);
      this.bodyStates.delete(a.key);
      this.charging.delete(a.key);
      return;
    }
    const c = st.actionStateFrameCounter;
    let t = this.tracks.get(a.key);
    let prev: number;
    let picked = false;
    // (a move picked up under way: the frames it had run for when the world picked it up)
    let pickedAge = 0;
    // the counter on the frame before, in this same move (a smash attack
    // holding still is charging)
    const before = t && t.action === st.actionStateId ? t.counter : null;
    if (!t || t.action !== st.actionStateId) {
      if (t) this.endOwned(a.key);
      // begun after the frame's color step (from an input, a collision, a
      // hit), unless the move before ran to its animation's end (its
      // animation callback: in the step's own part of the frame). One whose
      // animation stood at its end (Farore's Wind's travel, its counter held
      // there) left it some other way
      const ended = t !== undefined && !byAnimCallback(st.internalCharacterId, t.action, st.actionStateId) &&
        t.moved !== false && !t.looped && !LOOPING.has(t.action) && animEnded(a.fighter, t.action, t.counter, t.rate ?? 1);
      // (the effects of the old move's last step, which the replay's next state no longer shows: made where
      // the fighter's joints were on that step, the frame before)
      if (t && !this.tracked) {
        const script = a.fighter.scriptFor(t.action);
        const last = outgoingNativeScriptEvents(st.internalCharacterId, t.action, st.actionStateId, t.counter, t.rate ?? 1,
                                                script, ended);
        for (const e of last) this.scriptEvent(e, a, this.prevWorlds.get(a.key));
      }
      // (an animation that ended into what is taken up from standing: its
      // callback's change to Wait came first, unseen, with its own step of
      // the colors, and the one the replay shows came after the frame's
      // step, from the input check - two changes in one frame)
      const twice = ended && st.actionStateFrameCounter < 1.5 && (FROM_WAIT.has(st.actionStateId) ||
        (t!.grounded === true && st.isGrounded === true && FROM_FALL.has(st.actionStateId)) ||
        (INPUT_AFTER_END[st.internalCharacterId]?.some(([f, to]) => f === t!.action && to === st.actionStateId) ?? false) ||
        (t!.action === CLIFF_CATCH && st.actionStateId >= CLIFF_OPTIONS[0] && st.actionStateId <= CLIFF_OPTIONS[1]) ||
        (DOWN_OPTIONS[t!.action]?.includes(st.actionStateId) ?? false)) ||
        // (a jump landing in an air dodge's landing - a wave dash: the air
        // dodge taken from the input check, then the landing, the air dodge
        // unseen between them, each with its step)
        (t !== undefined && st.actionStateId === LANDING_FALL_SPECIAL && JUMPS.has(t.action)) ||
        // (a blaster's loop ending the frame something else came - a landing:
        // its end entered the loop again first, unseen, with its step; its
        // end, the frame after the loop, is the animation's own change)
        (ended && (REENTERED[st.internalCharacterId]?.includes(t!.action) ?? false) && st.actionStateId !== t!.action + 1);
      if (twice) this.colStep(frame, a);
      if (t && (twice || COLLISION_STATES.has(st.actionStateId) || !byAnimCallback(st.internalCharacterId, t.action, st.actionStateId) &&
          (t.moved === false || t.looped || LOOPING.has(t.action) || !animEnded(a.fighter, t.action, t.counter, t.rate ?? 1)))) {
        this.lateStart.add(a.key);
        // the move before ran a frame more first, unseen (the frame's
        // animation step, before the change): what its script says of the
        // body then is what the change of state finds (an air dodge's
        // intangibility beginning the frame it lands)
        const was = t.counter - t.entryCounter;
        for (const e of a.fighter.scriptFor(t.action)) {
          if (e.frame > was + 1) break;
          if (e.frame > was && e.kind === "bodyState") this.scriptEvent(e, a);
        }
      }
      const sw = t ? rollSwitch(st.internalCharacterId, t.action, st.actionStateId) : undefined;
      // (a switch between the move's ground and air versions, as it lands or
      // leaves the floor: carried on where it stood, its script skipped to
      // there, its color going on and its code's start not run again -
      // ftCommon_GroundAirColl_MF: Ft_MF_UpdateCmd, Ft_MF_SkipColAnim)
      const pair = t !== undefined && t.grounded !== undefined && t.grounded !== st.isGrounded &&
        (a.fighter.groundAirPair?.(t.action, st.actionStateId) ?? false);
      this.enterColors(frame, a, t?.action ?? -1, t ? { grounded: t.grounded ?? st.isGrounded, counter: t.counter } : null,
                        (t !== undefined && carriesOn(st.internalCharacterId, t.action, st.actionStateId)) || sw !== undefined || pair,
                        sw?.keepColor ?? pair);
      // a move already under way when the world started (a rebuild): its
      // script is picked up where it is, nothing replayed from its start
      const known = this.entryCounterOf?.(a.key, frame);
      const started = t !== undefined || known === undefined || known.entry === frame;
      // The script's clock is the animation's: the game runs a move's script
      // as its animation advances (ftAction_80073240 in ftAnim_8006EBA4), so
      // by the replay's counter it has run to the counter. A move begun from
      // its start shows 0 on its first frame, or 1 when its code advanced it
      // a frame as it began (the attacks, a roll, the shine:
      // ftAnim_8006EBA4 right after Fighter_ChangeMotionState), its script's
      // first two frames run then. One carried on part way through its
      // animation (a ground and air version's switch) had its script
      // skipped to there (ftAction_80073354), nothing before it started.
      const first = known?.counter ?? c;
      t = { action: st.actionStateId, entry: frame, entryCounter: 0, counter: c, seen: frame, fresh: started };
      this.tracks.set(a.key, t);
      prev = !started ? c : first < 2 ? -1 : first;
      if (sw || pair) prev = c;
      picked = !started;
      pickedAge = frame - (known?.entry ?? frame);
      // (one whose animation loops by itself: its script's time; picked up
      // under way, the frames since it began)
      if (a.fighter.clockedScript?.(st.actionStateId)) {
        t.age = started ? c : pickedAge + (known?.counter ?? 0);
        if (!started) prev = t.age;
      }
      // the effects the move's own code starts as it begins (as old as the
      // move is, when it was picked up under way)
      // (with a viewer track, a fresh start is the track's to say: trackEvents)
    } else if (t.age !== undefined) {
      // a move whose animation loops by itself: its script runs on by its own
      // timer, a frame each frame out of hitlag, the animation starting over or not
      prev = t.age;
      if (!((st.hitlagRemaining ?? 0) > 0)) t.age++;
      t.moved = c !== t.counter || (st.hitlagRemaining ?? 0) > 0;
      if (c < t.counter) t.looped = true;
      else if (c > t.counter) t.rate = c - t.counter;
    } else if (c < t.counter) {
      // a looping move starting over: its script from the top
      t.entryCounter = 0;
      prev = -1;
      t.moved = true;
      // (or one entering itself again: a new start, with its step of the colors)
      const again = c < 1.5 && (REENTERED[st.internalCharacterId]?.includes(st.actionStateId) ?? false);
      t.looped = !again;
      if (again) this.colStep(frame, a);
    } else {
      prev = t.counter - t.entryCounter;
      // (a counter held in hitlag is not an animation stood at its end)
      t.moved = c !== t.counter || (st.hitlagRemaining ?? 0) > 0;
      if (c > t.counter) t.rate = c - t.counter;
    }
    const clocked = t.age !== undefined ? a.fighter.clockedScript?.(st.actionStateId) : null;
    const now = clocked ? t.age! : c - t.entryCounter;
    t.counter = c;
    t.seen = frame;
    t.grounded = st.isGrounded;
    // what the move's code starts so many frames after it began (with a
    // viewer track, the track's to say)
    if (t.fresh && !this.tracked && frame > t.entry) {
    }
    const events = clocked ?? a.fighter.scriptFor(st.actionStateId);
    // (a new move turns the trail off; one picked up under way has its script's say from its start)
    this.swordStep(a, frame, events, picked ? -1 : prev, now, t.entry === frame);
    let charge = -1;
    for (const e of events) {
      if (e.frame > now) break;
      if (e.kind === "smashCharge") charge = e.anim;
      if (e.frame <= prev) {
        // the flag a move's code waits for, raised before the world picked
        // the move up: its effects, as old as they would be by now
        // (and a color the move started once, before its loop: running,
        // as far on as it would be - its age in the move, not the loop's)
        if (picked && e.kind === "colanim" && (e as Once).once) this.colStartAged(a.key, e.anim, e.frames, pickedAge - e.frame);
        continue;
      }
      // (one before its loop's label: once, not each time round)
      if (t.looped && !clocked && (e as Once).once) continue;
      else this.scriptEvent(e, a);
    }
    // what the move's own code starts besides its script (fx/native-callbacks.ts; with a track, the track's)
    if (!this.tracked && !this.generic) {
      for (const e of nativeClock.take(nativeEffectEvents(st.internalCharacterId, st.actionStateId, events), now)) {
        // (a callback's part is an index into fp->parts, which is the joint's, unlike the scripts' common bone
        // numbers - which have no entry for Final Cutter's part 44 - unless the callback looks it up as one)
        const joint = e.commonPart ? this.partToJoint(st.internalCharacterId, e.part) : e.part;
        const m = this.jointWorld(a.key, joint);
        // (picked up part way through the move: as old as it would be by now; Final Cutter's, from its start)
        const cutter = e.gfx === CUTTER_FX ? this.cutterHistory(a, frame) : null;
        const age = cutter ? cutter.age : picked ? Math.max(0, now - e.frame) : 0;
        this.spawn(e.gfx, {
          pos: m ? [m[12], m[13], m[14]] : [st.xPosition, st.yPosition, 0],
          follow: () => this.jointWorld(a.key, joint),
          facing: st.facingDirection || 1,
          angle: 0,
          damage: 0,
          scale: a.fighter.modelScale,
          owner: `${a.key}:native`,
          by: a.key,
          age,
          partFollow: (part) => this.jointWorld(a.key, part),
          cutterRelease: cutter?.releasedAt,
        });
      }
    }
    // Final Cutter letting go of its effects: they play their last 11 frames
    const cutting = st.internalCharacterId === KIRBY && st.actionStateId >= CUTTER_FIRST && st.actionStateId <= CUTTER_LAST;
    if (cutting && letsGo(events, now)) {
      for (const m of this.owned.get(`${a.key}:native`)?.models ?? []) {
        if (!m.cutter || m.cutter.releasedAt !== undefined) continue;
        m.cutter.releasedAt = m.age;
        m.life = m.age + 11;
      }
    }
    // a smash attack charging: its animation stands still (not in hitlag);
    // its color animation from when it starts to when it lets go
    // (ft_0DF0.c: started as the charge starts, reset as it ends)
    const still = charge >= 0 && before !== null && c === before && !(st.hitlagRemaining > 0);
    const was = this.charging.get(a.key);
    if (still && was === undefined) {
      this.charging.set(a.key, charge);
      if (charge !== SECOND) this.colStart(a.key, charge);
    } else if (!still && was !== undefined && !(st.hitlagRemaining > 0)) {
      this.charging.delete(a.key);
      this.colReset(a.key, was);
    }
  }

  /** the colors a fighter's new move starts (the ones a replay's states
   *  say): coming back on the platform (0xA), a tech (120), and the end of
   *  a move's whole-body intangibility (color animation 1) */
  private enterColors(frame: number, a: ActorFrame, from: number, before: { grounded: boolean; counter: number } | null,
                       carried = false, keepColor = false) {
    const s = a.st.actionStateId;
    const after = { grounded: a.st.isGrounded, counter: a.st.actionStateFrameCounter };
    // (what the change starts again, before its own step, when it comes
    // after the frame's step: that one it has already had)
    const f0 = this.cols.get(a.key), mainStarts = f0?.main.starts ?? 0, secondStarts = f0?.second.starts ?? 0;
    // the second one a move started goes with the move (the reflector's
    // glow, the platform's, a tech's): reset at the change of state as the
    // game resets it (ftCo_800C0134), unless the change carries the move on
    // (colanim.ts), or is the platform's wait (entered keeping it: ft_0D4D.c)
    if (before && !keepColor && !(from === REBIRTH && s === REBIRTH_WAIT)) this.cols.get(a.key)?.changeState(before, after);
    // a stored charge's: reset with the rest of the second and started again
    // by the fighter's own callback when the charge is full as the state
    // changes (before the change let it go that frame, or after it filled
    // it: fx/charges.ts); picked up under way, as it is
    const stored = (g: number) => storedAnim(this.stored?.(a.key, g) ?? 0);
    if (before && !keepsSecondColor(before, after)) {
      const f = this.cols.get(a.key);
      if (f && STORED.has(f.second.index)) f.second.reset();
      const full = stored(frame - 1) || stored(frame);
      if (full) this.colStart(a.key, full);
    } else if (!before && stored(frame)) this.colStart(a.key, stored(frame));
    // the whole body hittable again (ftColl_8007B62C: color 1, when it
    // outranks what runs), first thing in the change of state
    const body = this.bodyStates.get(a.key) ?? 0;
    if (body !== 0) { this.bodyStates.set(a.key, 0); this.colStart(a.key, 1); }
    // and the change of state runs the colors a step of their own
    if (before && !carried && startsOver(before, after)) this.colStep(frame, a);
    const f1 = this.cols.get(a.key);
    if (f1 && this.lateStart.has(a.key)) {
      if (f1 !== f0 || f1.main.starts !== mainStarts) f1.mainHeld = true;
      if (f1 !== f0 || f1.second.starts !== secondStarts) f1.secondHeld = true;
    }
    if (this.charging.has(a.key)) { const was = this.charging.get(a.key)!; this.charging.delete(a.key); this.colReset(a.key, was); }
    if (s === REBIRTH && from !== REBIRTH) this.colStart(a.key, 0xa, 0, true);
    if (techFlashes(s, from)) this.colStart(a.key, TECH_FLASH, 0, true, true);
    // entering the match: the white flash as it rises (ftCo_800C6408). It
    // runs in the overlay each change of state clears (ftCo_800C0134); only
    // EntryEnd is entered keeping it (Ft_MF_SkipColAnim), so it goes as the
    // fighter drops from its stand
    if (s === ENTRY_START && from !== s) this.colStart(a.key, ENTRY_FLASH);
    if (s !== ENTRY_START && s !== ENTRY_END && this.cols.get(a.key)?.second.index === ENTRY_FLASH) this.cols.get(a.key)!.second.reset();
    // a fighter's own move starting its color as it reaches a state
    const own = STATE_COLORS[a.st.internalCharacterId]?.[s];
    if (own && from !== s) this.colStart(a.key, own);
  }

  /** start a color animation on a fighter (`held`: after the frame's step, shown from the next) */
  colStart(key: string, anim: number, frames = 0, byMove = false, held = false) {
    const t = this.colTables;
    if (!t || anim <= 0 || anim >= SECOND) return;
    let f = this.cols.get(key);
    if (!f) { f = new FighterColAnim(); this.cols.set(key, f); }
    if (byMove) f.startForMove(t, anim, frames, held);
    else f.start(t, anim, frames, held);
  }

  /** start a color animation as it would be `age` frames after it began (a
   *  world picking a move up under way) */
  private colStartAged(key: string, anim: number, frames: number, age: number) {
    this.colStart(key, anim, frames, true);
    const f = this.cols.get(key), t = this.colTables;
    if (!f || !t) return;
    const o = f.main.index === anim ? f.main : f.second.index === anim ? f.second : null;
    for (let k = 0; o && o.running && k < Math.min(age, 600); k++) o.step(t, null);
  }

  /** end the one running in the slot `anim` runs in (ftCo_800C0200) */
  private colReset(key: string, anim: number) {
    const f = this.cols.get(key), t = this.colTables;
    if (!f || !t || anim >= SECOND) return;
    const e = t.entry(anim);
    (e && e.slot !== 0 ? f.second : f.main).reset();
  }

  /** a hit: the color animation for the hitbox's element and how far the
   *  hit sends (ftCo_Damage.c: by the knockback's level, 0 to 3, which the
   *  hitstun gives - knockback times 0.4 - against 10, 21 and 32) */
  hit(key: string, element: number, hitstun: number, runOn = false, full = false) {
    const level = full ? 3 : hitstun < 10 ? 0 : hitstun < 21 ? 1 : hitstun < 32 ? 2 : 3;
    const anim = element === 1 ? 11 + level : element === 2 ? 15 + level : element === 5 ? 31 + level
      : element === 13 ? 35 + level : 4;
    this.colStart(key, anim);
    // (a throw's release: its fighter's own step of the frame comes after, contact.ts hitColor)
    const f = this.cols.get(key);
    if (runOn && f && f.main.index === anim && this.colTables) f.main.step(this.colTables, null);
  }

  /** a fighter's color animations, one frame on: the ones that last while
   *  something holds (invincibility, a stored charge), then the scripts */
  private colors(frame: number, a: ActorFrame) {
    const t = this.colTables;
    if (!t) return;
    const key = a.key;
    const inv = this.invincible?.(key, frame) ?? false;
    const sv = this.stored?.(key, frame) ?? 0, stored = storedAnim(sv);
    let f = this.cols.get(key);
    if (!f && !inv && !storedStarts(sv)) return;
    if (!f) { f = new FighterColAnim(); this.cols.set(key, f); }
    // the blink while invincible: started as the timer is set, over what
    // runs when it outranks it (ftColl_8007B760), and shown from the next
    // frame when the state setting it began after the frame's color step;
    // else when nothing else runs (a world picking the fighter up in it).
    // Gone with it
    const asked = inv && (this.invincibleAsked?.(key, frame) ?? false);
    if (inv && (asked || f.main.index === 0)) f.start(t, INVINCIBLE, 0, asked && this.lateStart.has(key));
    if (!inv && f.main.index === INVINCIBLE) f.main.reset();
    // a stored charge's own (DK's steam, Samus's glow) runs in the second,
    // from a change of state (enterColors) or its move's own start
    if (storedStarts(sv)) f.start(t, stored);
    this.stepCols(frame, a, f, inv, stored);
    f.mainHeld = f.secondHeld = false;
  }

  /** one step of a fighter's color animations (ftCo_800C0408): the ones
   *  started after this frame's step wait for the next. One that ends is
   *  started again at once while what started it holds - the blink while
   *  invincible, a stored charge's (the fighter's own callback) - and run on */
  private stepCols(frame: number, a: ActorFrame, f: FighterColAnim, inv: boolean, stored: number) {
    const t = this.colTables!;
    // (with a viewer track, its effects are the track's, on the frames the
    // game started them: scriptLeftover)
    const gfx = this.tracked ? () => {} : (g: ColAnimGfx) => this.scriptEvent({ kind: "gfx", frame, gfx: g.gfx, bone: g.bone,
                                                      common: g.common, destroyOnChange: false, offset: g.offset, range: g.range }, a);
    // (one started again there runs its first step in the same one: lb_80014258's loop)
    if (f.main.running && !f.mainHeld && f.main.step(t, gfx) && inv && f.start(t, INVINCIBLE)) f.main.step(t, gfx);
    // the second's effects only while the main one is not running (ftcolanim.c)
    if (f.second.running && !f.secondHeld && f.second.step(t, f.main.index === 0 ? gfx : null) && stored &&
        f.start(t, stored)) f.second.step(t, f.main.index === 0 ? gfx : null);
  }


  /** a change of state's own step of a fighter's color animations
   *  (Fighter_ChangeMotionState runs ftCo_800C0408 as it starts the state's
   *  animation from its first frame) */
  private colStep(frame: number, a: ActorFrame) {
    const f = this.cols.get(a.key);
    if (!f || !this.colTables) return;
    this.stepCols(frame, a, f, this.invincible?.(a.key, frame) ?? false, storedAnim(this.stored?.(a.key, frame) ?? 0));
  }

  /** whether a color a move's script starts at its frame `at` waits for the
   *  next frame's step: on the move's first frame when the move began after
   *  the frame's color step (lateStart), or is one entered from its input check */
  private startsHeld(a: ActorFrame, at: number): boolean {
    if (this.tracks.get(a.key)?.entry !== this.stepping) return false;
    return this.lateStart.has(a.key) || (at === 0 && (INPUT_ENTERED[a.st.internalCharacterId]?.includes(a.st.actionStateId) ?? false));
  }

  /** which color animations a fighter runs (main, second), for the checks */
  colAnimsOf(key: string): [number, number] | null {
    const f = this.cols.get(key);
    return f ? [f.main.index, f.second.index] : null;
  }

  /** what a fighter's color animations do to its picture, or null */
  tintOf(key: string, facing: number): Tint | null {
    return this.cols.get(key)?.tint(facing) ?? null;
  }

  /** the blast a KO makes (ft_0D31.c, efasync 0x42B): common model 0x19 where
   *  the fighter crossed the blast line, held inside the zone along it,
   *  turned to face back in (left -90 degrees, right 90, down 0, up 180),
   *  in the player's two colors */
  private koBlast(a: ActorFrame, age: number) {
    const ko = this.ko;
    if (!ko) return;
    const s = a.st, z = ko.blast;
    let x = s.xPosition, y = s.yPosition;
    const side = s.actionStateId;
    if (side === 1 || side === 2) y = Math.min(z.top, Math.max(z.bottom, y));
    else x = Math.min(z.right, Math.max(z.left, x));
    const rotZ = side === 1 ? -Math.PI / 2 : side === 2 ? Math.PI / 2 : side === 0 ? 0 : Math.PI;
    const desc = this.common.models[KO_BLAST];
    if (!desc || desc.joint < 0) return;
    const prop = this.common.prop(KO_BLAST, 0, true);
    const life = desc.life >= 1 ? Math.trunc(desc.life) + 1 : Math.max(8, Math.min(240, prop?.length ?? 60));
    const port = s.playerIndex;
    this.models.push({
      bank: this.common, index: KO_BLAST, x, y, z: 0, rotY: 0, rotZ, scale: ko.scale, age, life,
      follow: null, owner: null, turn: null,
      tint: { konst: ko.konst[port] ?? [1, 1, 1], tev0: ko.tev0[port] ?? [1, 1, 1] },
    });
  }

  /** what a KO's blast needs: the blast zone, its size, and the players'
   *  colors for it (PlCo's tables 18 and 19) */
  ko: { blast: { left: number; right: number; top: number; bottom: number }; scale: number;
        konst: [number, number, number][]; tev0: [number, number, number][] } | null = null;

  /** a launched fighter's puff of smoke, where its TopN is, along its way (ftCo_Damage.c: efAsync 1032) */
  private smokePuff(frame: number, a: ActorFrame) {
    const angle = this.launchSmoke!(a.key, frame);
    if (Number.isNaN(angle)) return;
    const w = this.jointWorld(a.key, this.partToJoint(a.st.internalCharacterId, 0));
    const pos: [number, number, number] = w ? [w[12], w[13], w[14]] : [a.st.xPosition, a.st.yPosition, 0];
    this.spawn(0x408, { pos, follow: null, facing: a.st.facingDirection, angle, damage: 0, scale: 1, owner: null, by: a.key });
  }

  /** the effects the game made on this frame, from the viewer track: its
   *  fighters' effects all ending (efLib_DestroyAll: "fxend") and each
   *  spawn's pieces, placed as the game placed them */
  private trackEvents(frame: number, actors: ActorFrame[]) {
    // (in the track's own order when it gives one: an effect made before its
    // owner's effects end goes with them, one made after stays)
    if (this.trackOrdered) {
      this.placePieces(frame, actors, this.trackOrdered(frame));
      return;
    }
    for (const e of this.trackFx?.(frame) ?? []) {
      if (e[1] === "fxend") this.trackEnd(e, false);
    }
    this.placePieces(frame, actors, this.trackPieces?.(frame) ?? []);
  }
  /** a frame's pieces and effect ends ("fxp", "fxend") in the order the game made them */
  trackOrdered: ((frame: number) => TrackEvent[]) | null = null;

  /** the effects the learned table has for each fighter and item on this
   *  frame, placed the way a track's pieces are (placePiece) */
  private learnedEvents(frame: number, actors: ActorFrame[]) {
    const place = (owner: string, ownerId: number, gfx: number, pieces: LearnedPiece[], at: [number, number], facing: number,
                   a: ActorFrame | undefined, spawnId: number | null) => {
      let told = false;
      pieces.forEach(([kind, id, how, joint, ry, rz, s, cb, dx, dy, dz, p0, p1, p2], i) => {
        const e = [frame - 123, "fxp", gfx, owner, ownerId, i, kind, id, how, joint,
                   at[0] + dx * facing, at[1] + dy, dz, 0, ry * facing, rz, s, s, s, cb, 0, p0 ?? 0, p1 ?? 0, p2 ?? 0, 0] as TrackEvent;
        const key = owner === "f" ? a?.key ?? null : owner === "i" ? `i:${ownerId}` : null;
        if (this.placePiece(e, a, spawnId, key) === true && !told) {
          told = true;
          this.started?.(this.stepping, gfx, key, "learned");
        }
      });
    };
    for (const a of actors) {
      const st = a.st;
      if (st.isDead) continue;
      const k = `f${st.internalCharacterId}:${st.actionStateId}:${Math.floor(st.actionStateFrameCounter ?? 0)}`;
      const [pl, nn] = a.key.split(":").map(Number);
      for (const [gfx, pieces] of this.learned!(k) ?? []) {
        // (the KO's blast is koBlast's: on the blast line, not at a learned offset)
        if (gfx === KO_BLAST_FX) continue;
        // (one the fighter's scripts started on this frame already: theirs)
        if (this.scriptStarted.get(`${a.key}:${gfx}`) === this.stepping) continue;
        // (one its move's code starts in this state: the callbacks' (fx/native-callbacks.ts), not twice)
        if (nativeEffectIds(st.internalCharacterId, st.actionStateId).includes(gfx)) continue;
        place("f", pl * 2 + nn, gfx, pieces, [st.xPosition, st.yPosition], st.facingDirection < 0 ? -1 : 1, a, null);
      }
    }
    for (const it of this.items?.(frame) ?? []) {
      if (!this.itemBorn.has(it.spawnId)) this.itemBorn.set(it.spawnId, frame);
      const age = frame - this.itemBorn.get(it.spawnId)!;
      for (const [gfx, pieces] of this.learned!(`i${it.typeId}:${it.state ?? 0}:${age}`) ?? []) {
        // (one the item's own code starts as it changes state: the rules' in itemEvents (../item-effects.ts),
        // not twice)
        if (itemRuleEffects(it.typeId).includes(gfx)) continue;
        place("i", it.spawnId, gfx, pieces, [it.x, it.y], 1, undefined, it.spawnId);
      }
    }
  }

  /** a fighter's (or an item's) effects all ended: ["fxend", "f"|"i", owner] */
  private trackEnd(e: TrackEvent, ordered: boolean) {
    if (e[2] === "f") this.endFighterFx(`${Number(e[3]) >> 1}:${Number(e[3]) & 1}`, ordered);
    else if (e[2] === "i") {
      // (an item's effect models go with it as a fighter's do, and the generators on their joints end)
      const tag = `i:${Number(e[3])}`;
      for (const m of this.models) {
        if (m.whose !== tag || m.age >= m.life) continue;
        this.ps.endModel(m);
        m.age = m.life;
      }
      this.ps.endTag(tag);
    }
    // (the game walks its generators whatever its owner: where the next new one goes)
    else this.ps.passed();
  }

  /** every piece the game made on this frame, placed as the game placed it:
   *  [frame, "fxp", gfx, owner kind, owner, index, "m"|"g", id, how, part,
   *  tx, ty, tz, rx, ry, rz, sx, sy, sz, callback, lifetime, p0, p1, p2,
   *  mirrored, ax, ay, az, seed (a generator's: the game's random state as
   *  it made it; a version 2 track's)]. The models drawn elsewhere (the shield's bubble, the
   *  reflector) are left to those */
  private placePieces(frame: number, actors: ActorFrame[], events: TrackEvent[]) {
    // (told to the harness once a spawn - its pieces from index 0 on - as its
    // first piece draws; one none of whose pieces drew, with why)
    let told = false, why: string[] = [], last: { gfx: number; key: string | null } | null = null;
    const close = () => {
      if (last && !told) this.unplaced?.(this.stepping, last.gfx, last.key, why.join(", "));
      told = false;
      why = [];
      // (the spawn's pieces all made: its models' animations take their
      // first step, the last made first - the game's queue of them)
      for (let i = this.spawned.length - 1; i >= 0; i--) this.modelParticles(this.spawned[i], true);
      this.spawned.length = 0;
      last = null;
    };
    for (const e of events) {
      // (a spawn is done when the next event of any kind comes: its models' first steps are before an
      // owner's effects end or a stage's generator made after it, as in the game)
      if (e[1] === "fxend") { close(); this.trackEnd(e, true); continue; }
      if (e[1] === "gen" || e[1] === "sgen") { close(); this.stageGen(e); continue; }
      if (e[1] === "send") { close(); this.stageEnd(e); continue; }
      const gfx = Number(e[2]);
      if (Number(e[5]) === 0) close();
      const kind = String(e[3]), owner = Number(e[4]);
      const key = kind === "f" ? `${owner >> 1}:${owner & 1}` : kind === "i" ? `i:${owner}` : null;
      const a = kind === "f" ? actors.find((x) => x.key === key) : undefined;
      if (DRAWN_ELSEWHERE.has(gfx)) {
        // (drawn by the player's own drawing: here only so that its
        // generators, and the ones its model's animation starts, are among
        // the game's - only with a seeded track, where that is the point)
        if (e.length >= 29) {
          const before = this.models.length;
          // (not told to the harness's placement measure: what is drawn of it is the player's own drawing's)
          const tell = this.placed;
          this.placed = null;
          this.placePiece(e, a, kind === "i" ? owner : null, key);
          this.placed = tell;
          for (let i = before; i < this.models.length; i++) this.models[i].hidden = true;
        }
        last = null;
        continue;
      }
      last = { gfx, key };
      const drew = this.placePiece(e, a, kind === "i" ? owner : null, key);
      if (drew !== true) why.push(drew);
      else if (!told) {
        told = true;
        this.started?.(this.stepping, gfx, key, "generic");
      }
    }
    close();
  }
  /** a stage joint's world matrix as the stage is posed now (the stage object's
   *  number, the joint's preorder index in it), or null: set by the player */
  stageJoint: ((map: number, joint: number) => Float32Array | null) | null = null;
  /** the stage's scale (a generator its code places is under a transform of that size) */
  stageScale = 1;
  /** a generator the stage made, from the track, in the game's order with
   *  the pieces: ["gen", file, id, x, y, z, seed, stage object, joint] - an
   *  animation's key, on its joint (hsd_8039EFAC) - or ["sgen", running
   *  object, file, id, x, y, z, seed, stage object, joint] - the stage's
   *  code's own: placed under a transform (grLib_801C96F8) when it names no
   *  joint, else placed once from the joint (grLib_801C97DC). A last value on
   *  an "sgen": "on" - made on the joint and going with it (grLib_801C9808);
   *  "kept" - the placed one the stage's code keeps, to end later ("send") */
  private stageGen(e: TrackEvent): Generator | null {
    const own = e[1] === "sgen";
    const v = e.map((x) => (typeof x === "number" ? x : 0));
    const o = own ? 3 : 2;
    const [file, id, x, y, z, seed, map, joint] = v.slice(o, o + 8);
    const bank = file === 30 ? this.stageBank?.() ?? null : this.banks.get(file) ?? null;
    this.ps.rng.phase = 4;
    const g = bank ? this.ps.generator(bank, id, seed >>> 0) : null;
    this.ps.rng.phase = 0;
    if (g) g.made = "stage";
    if (!g) return null;
    g.maxAge = Infinity;
    g.tag = "stage";
    // (a key on a fighter's or an item's joint: the event names whose - it ends with that owner's effects)
    const whose = e[o + 8], who = Number(e[o + 9]);
    if (!own && (whose === "f" || whose === "i") && who >= 0) g.tag = whose === "f" ? `f:${who >> 1}:${who & 1}` : `i:${who}`;
    let w = joint >= 0 && map >= 0 ? () => this.stageJoint?.(map, joint) ?? null : null;
    // (a key of an item's own model: the generator is on the item's joint and goes with it. The track does not
    // say which joint: the item's place stands for it)
    // (a newer track names the joint, and has its turn and place each frame: "ij")
    const at = e[o + 10];
    if (!own && !w && whose === "i" && who >= 0) {
      w = typeof at === "number" && at >= 0 ? () => this.itemJointWorld(who, at) : () => this.itemAt.get(who) ?? null;
    }
    const mark = own ? e[o + 8] : undefined;
    if (mark === "kept") this.stageKept = g;
    if (own && !w) {
      // (grLib_801C96F8: a transform made ONCE, or the generator's own (kind 0x20000) no longer only following -
      // its xA2 cleared, so its particles are placed through its matrix; at the place, times the stage's scale,
      // Ground_801C0498, whatever bank the generator is of: Zebes' and Mute City's of bank 0 too)
      const s = this.stageScale;
      const srt: AppSRT = { tx: x, ty: y, tz: z, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false, status: APP_ONCE };
      if (g.srt) Object.assign(g.srt, { tx: x, ty: y, tz: z, sx: g.srt.sx * s, sy: g.srt.sy * s, sz: g.srt.sz * s, view: false });
      else g.srt = srt;
      g.px = g.py = g.pz = 0;
      return g;
    }
    g.type |= g.kind & 0x20000 ? 0x500 : 0x700;
    g.px = x; g.py = y; g.pz = z;
    if (own && mark !== "on") {
      const now = w?.();
      if (now) this.ps.placeOnce(g, now);
      else { g.follow = null; g.onJoint = false; }
      return g;
    }
    if (w) this.attach(g, w, [x, y, z]);
    else g.onJoint = true;
    // (on a joint of the stage's: the stage's code ends generators by joint)
    if (map >= 0 && joint >= 0) g.stageAt = map * 65536 + joint;
    return g;
  }
  /** the placed generator the stage's code keeps (the last "sgen" marked "kept") */
  private stageKept: Generator | null = null;
  /** the stage's own code ends generators: ["send", how, stage object, joint,
   *  joints] - "kept" the one it kept (hsd_8039D4DC), "kept-now" and its
   *  particles at once; "joints" every one on `joints` joints of the stage
   *  object from `joint` on, "joint-now" and "joints-now" their particles at
   *  once too */
  private stageEnd(e: TrackEvent) {
    const how = String(e[2]), map = Number(e[3]), joint = Number(e[4]), count = Number(e[5]);
    if (how === "kept" || how === "kept-now") {
      const g = this.stageKept;
      this.stageKept = null;
      if (g && !g.dead) this.ps.end(g, how === "kept-now");
      return;
    }
    if (map < 0 || joint < 0 || !(count > 0)) return;
    this.ps.endStage(map * 65536 + joint, count, how !== "joints");
  }
  /** every stage generator event of the track up to a frame (the replay's index), in order: set by the player */
  trackStageBefore: ((frame: number) => TrackEvent[]) | null = null;
  /** the warm-up after a jump starts at `frame`: the stage generators made
   *  before it and still running then are made now - the ones that never end
   *  of themselves, and the ones whose life is not over (Battlefield's stars:
   *  399 frames, made every 400) as they stand after the frames they ran:
   *  their life and their count of particles to come (hsd_8039D214's step,
   *  for a generator whose count grows by a set amount each frame) */
  stageStart(frame: number) {
    this.stepping = frame;
    for (const e of this.trackStageBefore?.(frame) ?? []) {
      if (e[1] === "send") { this.stageEnd(e); continue; }
      const c = this.stageCmd(e), made = Number(e[0]) + 123;
      if (!c) continue;
      const used = frame - made;
      if (c.genLife !== 0 && (used <= 0 || used >= c.genLife)) continue;
      const g = this.stageGen(e);
      if (!g || used <= 0) continue;
      if (g.genLife !== 0) g.genLife -= used;
      g.age += used;
      if (g.random < 0) {
        let n = g.count;
        for (let k = 0; k < used; k++) {
          n = Math.fround(n - g.random);
          while (n >= 1) n = Math.fround(n - 1);
        }
        g.count = n;
      }
    }
  }
  /** how many frames before `f` a jump warms the stage's generators from:
   *  STAGE_WARM, or back to where one still running then was made, when what
   *  it made before could still be up at `f` (its particles live longer than
   *  the warm-up) or where it is depends on that frame (placed once from a
   *  joint), up to STAGE_FAR */
  stageFrames(f: number): number {
    const start = f - STAGE_WARM;
    let from = start;
    for (const e of this.trackStageBefore?.(start) ?? []) {
      if (e[1] === "send") continue;
      const c = this.stageCmd(e), made = Number(e[0]) + 123;
      if (!c || made >= from || (c.genLife > 0 && made + c.genLife <= start)) continue;
      const own = e[1] === "sgen", joint = Number(e[own ? 10 : 9]), map = Number(e[own ? 9 : 8]);
      const placedOnce = own && map >= 0 && joint >= 0 && e[own ? 11 : 10] !== "on";
      if (placedOnce || c.life > STAGE_WARM) from = made;
    }
    return f - Math.max(from, f - STAGE_FAR);
  }
  /** a stage generator event's command list (its bank's) */
  private stageCmd(e: TrackEvent) {
    const own = e[1] === "sgen";
    const id = Number(e[own ? 4 : 3]), file = Number(e[own ? 3 : 2]);
    const bank = file === 30 ? this.stageBank?.() ?? null : this.banks.get(file) ?? null;
    return bank?.cmds[id] ?? null;
  }
  /** one warm-up frame of the stage's generators alone: the ones the track
   *  has on it made, the particles stepped from the frame's random state */
  stepStage(frame: number) {
    this.stepping = frame;
    for (const e of this.trackOrdered?.(frame) ?? []) {
      if (e[1] === "gen" || e[1] === "sgen") this.stageGen(e);
      else if (e[1] === "send") this.stageEnd(e);
    }
    const state = this.trackRng?.(frame) ?? null;
    if (state !== null) this.ps.rng.set(state);
    else this.ps.rng.free();
    this.ps.step();
    this.frame = frame;
  }
  /** the seeded models of the spawn being placed */
  private spawned: ModelFx[] = [];
  /** a spawn none of whose pieces drew, and why (the parity harness's) */
  unplaced: ((frame: number, gfx: number, by: string | null, why: string) => void) | null = null;

  /** one piece (placePieces): true when it drew, else why not */
  private placePiece(e: TrackEvent, a: ActorFrame | undefined, spawnId: number | null, key: string | null): true | string {
    const v = e.map((x) => (typeof x === "number" ? x : 0));
    const isModel = e[6] === "m", id = v[7], how = String(e[8]), part = v[9];
    const t: [number, number, number] = [v[10], v[11], v[12]];
    const [ry, rz, sx] = [v[14], v[15], v[16]];
    const callback = String(e[19] ?? ""), lifetime = v[20], mirrored = v[24] === 1;
    const fileNo = Math.floor(id / 1000);
    const bank = fileNo === 30 ? this.stageBank?.() ?? null : this.banks.get(fileNo) ?? null;
    if (how === "carrier") return "a carrier";
    if (!bank) return `effect file ${fileNo} not loaded`;
    // what it goes with: the fighter's joint (the track names it by its place
    // in the fighter's joint list, fp->parts, as jointWorld takes it - not a
    // named part), or the item
    let follow: (() => Float32Array | null) | null = null;
    if (a && part >= 0) {
      follow = () => this.jointWorld(a.key, part);
    } else if (!isModel && e.length >= 31 && v[29] >= 0 && v[30] >= 0 && how !== "place" && how !== "srt") {
      // (a generator on an item's joint, which a newer track names: the joint's own turn and place, "ij")
      const item = v[29], joint = v[30];
      if (this.itemAt.has(item)) follow = () => this.itemJointWorld(item, joint);
    } else if (spawnId !== null && how !== "place" && how !== "srt") {
      const at = this.itemAt.get(spawnId);
      if (at) follow = () => this.itemAt.get(spawnId) ?? at;
    }
    const now = follow?.();
    const here: [number, number, number] = now ? [now[12], now[13], now[14]] : t;
    // (the game's place for it: its joint's then, when the track says - a newer simulator's)
    if (now && a && e.length >= 28) {
      // (and where its joint was the frame before: the game makes it before the frame's joints are moved)
      const pj = a && part >= 0 ? part : -1;
      const pw = pj >= 0 ? this.prevWorld(a.key) : null;
      const before = pw && (pj + 1) * 16 <= pw.length ? [pw[pj * 16 + 12], pw[pj * 16 + 13], pw[pj * 16 + 14]] : here;
      this.placed?.(this.stepping, Number(e[2]), key, v[5], here, [v[25], v[26], v[27]], before);
    }
    if (!isModel) {
      // (a piece with the game's random state: made as the game made it, and
      // kept until the game ends it)
      const seeded = e.length >= 29;
      const g = this.ps.generator(bank, id, seeded ? v[28] >>> 0 : null);
      if (g) g.made = "piece";
      if (!g) return `no generator ${id} in file ${fileNo}`;
      if (key) g.tag = key.startsWith("i:") ? key : `f:${key}`;
      if (mirrored) g.kind |= 0x40000;
      if (seeded) g.maxAge = Infinity;
      // (the transform the dispatch gave it: its own already, when its command made one)
      const under = (follows: boolean, tx: number, ty: number, tz: number) => {
        const srt = { tx, ty, tz, rx: v[13], ry, rz, sx, sy: v[17], sz: v[18], follow: follows };
        if (g.srt) Object.assign(g.srt, srt);
        else g.srt = follows ? { ...srt, owner: g } : srt;
      };
      if (how === "place") {
        g.px = t[0]; g.py = t[1]; g.pz = t[2];
        // (the few the game keeps on lists of their own: efLib_CreateGenerator)
        g.linkNo = id === 0x121 ? 2 : id === 0xff || id === 0xfc || id === 0xf7 || id === 0x7918 ? 1 : 0;
      } else if (how === "srt") {
        under(false, t[0], t[1], t[2]);
      } else {
        // on a joint: with a transform of its own when the dispatch gave it one
        if (how === "joint-srt") under(true, 0, 0, 0);
        if (follow) this.attach(g, follow, here);
        else {
          // (nothing here to follow - an item the replay does not list yet: it is on a joint in the game all
          // the same, and ends with its owner's effects as any generator on one)
          g.px = t[0]; g.py = t[1]; g.pz = t[2];
          g.onJoint = true;
          g.type |= g.kind & 0x20000 ? 0x500 : 0x700;
        }
        // (its emission takes the joint's turn only when the dispatch made it
        // on the joint itself, "joint-rot": efLib's own calls leave it out)
        if (how === "joint") g.type &= ~0x400;
        else if (how === "joint-srt") g.type = (g.type & ~0x600) | 0x800;
      }
      return true;
    }
    const index = id % 1000;
    const desc = bank.models[index];
    if (!desc || desc.joint < 0) return `no model ${index} in file ${fileNo}`;
    const prop = bank.prop(index, 0, true);
    // (how long it lives: what the dispatch set, else its file's own; with none of its own the game keeps it
    // until its owner's effects end (efLib_Update frees only a model whose lifetime runs out) - which a seeded
    // track says; without one, about as long as its animation)
    const life = lifetime > 0 ? lifetime : desc.life >= 1 ? Math.trunc(desc.life) + 1
      : e.length >= 29 && key ? Infinity : Math.max(8, Math.min(240, prop?.length ?? 60));
    const facing = () => (a ? ((this.sts.get(a.key)?.facingDirection ?? 1) < 0 ? -1 : 1) : 1);
    // (its update callback, run once a frame from the frame it is made, as
    // efLib's are: eflib.c)
    const [p0, p1, p2] = [v[21], v[22], v[23]];
    let turn: ModelFx["turn"] = null, onJoint = follow;
    if (callback === "SetRotYZ_FromParamZ_FighterDir") {
      // (efLib_Cb_SetRotYZ_FromParamZ_FighterDir: a quarter turn to the side faced, and about z by its third
      // parameter, the other way when facing right)
      turn = (m) => { const f = facing(); m.rotY = f * Math.PI / 2; m.rotZ = f < 0 ? p2 : -p2; };
    } else if (callback === "SetRotYZ_FromFighter") {
      // (efLib_Cb_SetRotYZ_FromFighter: a quarter turn to the side faced, and about z by a quarter turn less
      // the move's angle - Fire Fox's and Fire Bird's way of flying, which the replay's speeds give as they
      // give the fighter's own lean; kept while the speeds are 0)
      // (the way it last had kept on the model: what a step changes is the world's own, copied with it)
      turn = (m) => {
        const f = facing(), st = a ? this.sts.get(a.key) : undefined;
        const vx = st?.selfInducedAirXSpeed ?? 0, vy = st?.selfInducedAirYSpeed ?? 0;
        if (vx !== 0 || vy !== 0) m.way = Math.atan2(vy, vx * f);
        const way = m.way ?? Math.PI / 2;
        m.rotY = f * Math.PI / 2;
        m.rotZ = f < 0 ? Math.PI / 2 - way : -(Math.PI / 2 - way);
      };
    } else if (FACING_CALLBACKS.has(callback) || (callback === "SetRotYAndTransition" && how !== "child")) {
      // (efLib_Cb_SetRotYAndTransition too, on the two of Final Cutter's three that efalt.c 0x494 gives the fighter
      // as their user data - the ones it attaches, not its child: the root's turn about y set to the side faced
      // after each step of the animation)
      turn = (m) => { m.rotY = facing() * Math.PI / 2; };
    }
    else if (callback === "SetOffset_FromParams") {
      // flung by its parameters, falling 0.1 a frame faster each frame (an egg's shell)
      turn = (m) => { m.fall = (m.fall ?? p1) - 0.1; m.x += p0; m.y += m.fall; m.z += p2; };
    } else if (callback === "SetOffsetY_FromParamY" && follow) {
      // where its joint is, raised by its parameter
      const on = follow;
      onJoint = null;
      turn = (m) => { const w = on(); if (w) { m.x = w[12]; m.y = w[13] + p1; m.z = w[14]; } };
    } else if (callback === "SetScale_FromParamX") turn = (m) => { m.scale *= p0 || 1; };
    else if (callback === "ftMr_SpecialLw" || callback === "ftLg_SpecialLw") {
      // (efLib_Cb_ftMr_SpecialLw, efLib_Cb_ftLg_SpecialLw: the root's first child's next and all under it
      // shown while the fighter is in motion 349 (Mario's) or 357 (Luigi's), HSD_JObjSetFlagsAll HIDDEN
      // on it otherwise)
      const motion = callback === "ftMr_SpecialLw" ? 349 : 357;
      turn = (m) => {
        const st = a ? this.sts.get(a.key) : undefined;
        if (st) m.secondChildOff = st.actionStateId !== motion;
      };
    }
    else if (callback && !KNOWN_CALLBACKS.has(callback)) this.unknownCallbacks.add(callback);
    // (a model made at a place stays there; one on a joint goes with it, a
    // child of it turned as it turns)
    const placed = how === "place" || how === "create" || !onJoint;
    const m: ModelFx = {
      bank, index, x: placed ? t[0] : here[0], y: placed ? t[1] : here[1], z: placed ? t[2] : here[2],
      rotY: ry, rotZ: rz, rotX: v[13] || undefined, scale: sx || 1, age: 0, life, follow: placed ? null : onJoint, owner: null, turn,
      by: a?.key, whose: key, under: how === "child" ? onJoint : null, steady: NEVER_PAUSED.has(Number(e[2])),
      rootSet: how !== "child" && !(how === "create" && t[0] === 0 && t[1] === 0 && t[2] === 0),
    };
    if (callback === "SetRotYAndTransition" && turn) m.rootRotationY = true;
    if (FACING_CALLBACKS.has(callback) || callback === "SetRotYZ_FromParamZ_FighterDir" || m.rootRotationY) turn?.(m);
    // (efLib_Cb_SetScaleRotY_FromFighter: after each animation step the root's scale times the fighter's root
    // joint's, its model scale (Fighter_UpdateModelScale) - the root's own being its animation's that step, the
    // product is the same each frame)
    if (callback === "SetScaleRotY_FromFighter" && a) m.scale *= a.fighter.modelScale;
    const endPart = LIFETIME_END_PART[Number(e[2])];
    if (callback === "LifetimeEndSpawn" && lifetime > 0 && a && key && endPart !== undefined && e.length >= 29) {
      // (the game counts the lifetime down once each frame the model runs, from the frame it is made)
      m.left = lifetime;
      const who = a.key;
      m.after = (mm) => {
        if (--mm.left! !== 1) return;
        mm.after = undefined;
        mm.life = mm.age + LIFETIME_END_MORE;
        this.ps.rng.phase = 1;
        const g = this.ps.generator(this.common, LIFETIME_END_GEN);
        this.ps.rng.phase = 0;
        if (!g) return;
        g.made = "key";
        g.tag = `f:${who}`;
        g.maxAge = Infinity;
        const on = () => this.jointWorld(who, endPart);
        const w = on();
        this.attach(g, on, w ? [w[12], w[13], w[14]] : [mm.x, mm.y, mm.z]);
      };
    }
    // (the KO blast in its player's colors, PlCo's tables 18 and 19, as koBlast draws it)
    if (Number(e[2]) === KO_BLAST_FX && this.ko && String(e[3]) === "f") {
      const port = v[4] >> 1;
      m.tint = { konst: this.ko.konst[port] ?? [1, 1, 1], tev0: this.ko.tev0[port] ?? [1, 1, 1] };
    }
    if (e.length >= 29) {
      m.seed = v[28] >>> 0;
      this.spawned.push(m);
    }
    this.models.push(m);
    return true;
  }

  /** every effect made for a fighter goes (the game's effects of the
   *  fighter's, all at once) */
  private endFighterFx(key: string, ordered = false) {
    // (not the ones made this frame: a move script's are queued (efAsync_Spawn)
    // and made as the frame's queue is flushed, after its code ended the rest.
    // In the track's own order the generators made before this are already
    // there and the later ones are not: nothing to keep by age)
    for (const m of this.models) {
      if ((m.by !== key && m.whose !== key) || !(ordered || m.age > 0)) continue;
      this.ps.endModel(m);
      m.age = m.life;
    }
    this.ps.endTag(`f:${key}`, !ordered);
  }

  private scriptEvent(e: ScriptEvent, a: ActorFrame, previous?: Float32Array) {
    // (with the track's pieces, every effect start is theirs: the scripts' colors and states go on)
    // (the move scripts' own effects stay without a track: they are the game's
    // data; the learned table adds what the code starts besides)
    if (this.generic && (e.kind === "gfx" || e.kind === "landFx" || e.kind === "stepFx")) return;
    if (e.kind === "gfx") {
      const started = `${a.key}:${e.gfx}`;
      this.scriptStarted.set(started, this.stepping);
      const joint = e.common ? this.partToJoint(a.st.internalCharacterId, e.bone) : e.bone;
      // (on the joints of the frame before, when given: an old move's last step, outgoingNativeScriptEvents)
      const before = previous && joint >= 0 && (joint + 1) * 16 <= previous.length ? previous.subarray(joint * 16, joint * 16 + 16) : null;
      const m = before ?? this.jointWorld(a.key, joint) ?? this.jointWorld(a.key, 0);
      const R = this.ps.rng;
      const ox = e.offset[0] + 2 * e.range[0] * (R.next() - 0.5);
      const oy = e.offset[1] + 2 * e.range[1] * (R.next() - 0.5);
      const oz = e.offset[2] + 2 * e.range[2] * (R.next() - 0.5);
      const pos: [number, number, number] = m
        ? [m[0] * ox + m[4] * oy + m[8] * oz + m[12], m[1] * ox + m[5] * oy + m[9] * oz + m[13], m[2] * ox + m[6] * oy + m[10] * oz + m[14]]
        : [a.st.xPosition, a.st.yPosition, 0];
      const key = a.key;
      // (one of a fighter's own effect files: its pieces as the game makes
      // them most often - the learned table's - on the script's joint)
      if (!spawnFor(e.gfx)) {
        const pieces = this.learnedGfx?.(e.gfx);
        const f = a.st.facingDirection < 0 ? -1 : 1;
        const [pl, nn] = a.key.split(":").map(Number);
        let drew = false;
        pieces?.forEach(([kind, id, how, , ry, rz, s, cb, , , , p0, p1, p2], i) => {
          drew = this.placePiece([this.stepping - 123, "fxp", e.gfx, "f", pl * 2 + nn, i, kind, id, how, joint, pos[0], pos[1], pos[2],
                                  0, ry * f, rz, s, s, s, cb, 0, p0 ?? 0, p1 ?? 0, p2 ?? 0, 0] as TrackEvent, a, null, a.key) === true || drew;
        });
        if (drew) this.started?.(this.stepping, e.gfx, a.key, "fighter");
        return;
      }
      // (the dizzy stars: at the fighter's ftData attribute +0x168's size: ftCo_8009F834)
      const scale = e.gfx >= 0x428 && e.gfx <= 0x42a ? a.fighter.commonAttr(0x168) || 1
        : e.gfx === 0x438 ? a.fighter.modelScale * (a.fighter.commonAttr(0x144) || 1) : a.fighter.modelScale;
      this.spawn(e.gfx, {
        pos, follow: () => this.jointWorld(key, joint), facing: a.st.facingDirection || 1, angle: 0, damage: 0,
        scale, owner: e.destroyOnChange ? a.key : null, by: a.key, offset: [ox, oy, oz],
      });
    } else if (e.kind === "colanim") {
      // (one of the second kind goes with the move: enterColors; one on the
      // first frame of a move begun after the frame's color step - from an
      // input check, a collision - shows from the next: the change of state
      // runs the script after its own step of the colors)
      this.colStart(a.key, e.anim, e.frames, true, this.startsHeld(a, e.frame));
    } else if (e.kind === "bodyState") {
      // ftColl_8007B62C: hittable again (1), invincible (3), intangible (2);
      // its color held as a script's own is (a ledge catch's, from a collision)
      this.bodyStates.set(a.key, e.state);
      this.colStart(a.key, e.state === 0 ? 1 : e.state === 1 ? 3 : 2, 0, false, this.startsHeld(a, e.frame));
    } else if (e.kind === "landFx") {
      // (the floor's material may name another: Fountain's and Stadium's
      // ripples - ftAction_80072E4C, mpLib_80056AC4)
      const alt = this.floorFx?.(a, 1) ?? null;
      this.scriptStarted.set(`${a.key}:${alt ?? e.gfx}`, this.stepping);
      const pos: [number, number, number] = [a.st.xPosition, a.st.yPosition, 0];
      if (alt !== null && alt >= 30000) this.stageSpawn(alt, pos, `${a.key}@${a.st.actionStateId}`);
      else {
        this.spawn(alt ?? e.gfx, {
          pos, follow: null, facing: a.st.facingDirection || 1, angle: 0, damage: 0,
          scale: a.fighter.modelScale, owner: null,
        });
      }
    } else if (e.kind === "stepFx") {
      // a footstep: only the floor's material's effect, at the foot (ftAction's footstep command)
      const alt = this.floorFx?.(a, 0) ?? null;
      const part = a.fighter.footParts[e.alt ? 1 : 0];
      if (alt === null || part < 0) return;
      this.scriptStarted.set(`${a.key}:${alt}`, this.stepping);
      const w = this.jointWorld(a.key, this.partToJoint(a.st.internalCharacterId, part));
      const pos: [number, number, number] = w ? [w[12], w[13], w[14]] : [a.st.xPosition, a.st.yPosition, 0];
      if (alt >= 30000) this.stageSpawn(alt, pos);
      else this.spawn(alt, { pos, follow: null, facing: a.st.facingDirection || 1, angle: 0, damage: 0, scale: a.fighter.modelScale, owner: null });
    }
  }

  /** start one of the game's effects by its id */
  /** the effect a floor's material puts in place of a move's own, for a
   *  fighter standing on it (ft_80084A80: 0 a footstep's, 1 a landing's, 2 a
   *  bounce's): an effect id, or null for the move's own */
  floorFx?: (a: ActorFrame, which: 0 | 1 | 2) => number | null;
  /** the stage's own effects (its file's particle bank, ids from 30000) */
  stageBank: (() => EffectBank | null) | null = null;
  /** one of the stage's effects started where it is put (efAsync with an id of the stage's file) */
  private stageSpawn(id: number, pos: [number, number, number], by: string | null = null) {
    this.spawnLog.push({ frame: this.frame, id, by, pos: pos.map((v) => Math.round(v * 10) / 10) });
    if (this.spawnLog.length > 64) this.spawnLog.shift();
    const bank = this.stageBank?.() ?? null;
    const g = bank ? this.ps.generator(bank, id) : null;
    if (!g) return;
    this.started?.(this.stepping, id, by, "stage");
    g.px = pos[0]; g.py = pos[1]; g.pz = pos[2];
  }
  /** the effects started lately: frame, effect id, whose (the checks read them) */
  spawnLog: { frame: number; id: number; by: string | null; pos: number[] }[] = [];
  /** every effect it starts that draws something, as it starts it: the frame
   *  being stepped, the effect's id, whose, and from where ("common", "stage",
   *  "fighter": its file) - the parity harness's (effect checks) */
  started: ((frame: number, id: number, by: string | null, via: string) => void) | null = null;
  spawn(id: number, ctx: SpawnCtx) {
    this.spawnLog.push({ frame: this.frame, id, by: ctx.by ?? ctx.owner ?? null, pos: ctx.pos.map((v) => Math.round(v * 10) / 10) });
    if (this.spawnLog.length > 64) this.spawnLog.shift();
    const s = spawnFor(id);
    if (s) {
      this.started?.(this.stepping, id, ctx.by ?? ctx.owner ?? null, "common");
      this.spawning = id;
      this.place(s, ctx);
    }
  }
  /** the effect whose pieces `place` is making */
  private spawning = 0;

  private place(s: Spawn, ctx: SpawnCtx) {
    if ("all" in s) { for (const x of s.all) this.place(x, ctx); return; }
    // (one made on a part of its own, not the call's joint: there, and following it)
    if ("part" in s && s.part !== undefined && ctx.partFollow) {
      const part = s.part;
      const partFollow = ctx.partFollow;
      const matrix = partFollow(part);
      ctx = { ...ctx, follow: () => partFollow(part), pos: matrix ? [matrix[12], matrix[13], matrix[14]] : ctx.pos };
    }
    const R = this.ps.rng;
    if ("pieces" in s) {
      for (let k = 0; k < s.count; k++) {
        const index = R.next() < 0.5 ? s.pieces[0] : s.pieces[1];
        if (!this.common.models[index]) continue;
        const ry = Math.PI * 2 * R.next(), rx = Math.PI * 2 * R.next();
        const vx = 2 * Math.cos(rx) * Math.sin(ry);
        const vy = 2 * Math.sin(rx);
        const vz = 2 * Math.cos(rx) * Math.cos(ry);
        const m: ModelFx = {
          bank: this.common, index, x: ctx.pos[0], y: ctx.pos[1], z: ctx.pos[2], rotY: ry, rotZ: 0, rotX: rx,
          scale: ctx.scale, age: 0, life: s.life, follow: null, owner: null, by: ctx.by,
          turn: (p) => { p.fall = (p.fall ?? vy) - 0.1; p.x += vx; p.y += p.fall; p.z += vz; }, steady: NEVER_PAUSED.has(this.spawning),
        };
        this.models.push(m);
      }
      return;
    }
    const bank = s.bank === undefined ? this.common : this.banks.get(s.bank);
    if (!bank) return;
    if ("m" in s) {
      const index = Array.isArray(s.m) ? (R.next() < 1 / 8 ? s.m[0] : s.m[1]) : s.m;
      const desc = bank.models[index];
      if (!desc || desc.joint < 0) return;
      let scale = 1;
      if (s.scale === "damage") scale = Math.max(0.3, Math.min(1.5, 0.04 * ctx.damage + 0.3));
      else if (s.scale === "arg") scale = ctx.scale;
      const prop = bank.prop(index, 0, true);
      // (its lifetime: its description's, else its animation's length; one that lasts until its move ends,
      // with none in its description, for as long as that)
      let life = desc.life >= 1 ? Math.trunc(desc.life) + 1 : Math.max(8, Math.min(240, prop?.length ?? 60));
      if (s.persistent && desc.life === 0) life = Infinity;
      const m: ModelFx = {
        bank, index, x: ctx.pos[0], y: ctx.pos[1], z: ctx.pos[2],
        rootSet: s.rootSet,
        rotY: s.face ? (ctx.facing < 0 ? -Math.PI / 2 : Math.PI / 2) : 0,
        rotZ: s.rotZ === "rand" ? Math.PI * 2 * R.next() : s.rotZ === "arg" ? ctx.angle : 0,
        scale, age: (ctx.age ?? 0) + (s.startFrame ?? 0), life,
        follow: s.attach ? ctx.follow : null, under: s.child ? ctx.follow : null, constrained: !!s.child,
        owner: ctx.owner, turn: null, by: ctx.by, steady: NEVER_PAUSED.has(this.spawning),
      };
      // (its update callback: turned to the side its fighter faces now)
      const faceFighter = (p: ModelFx) => {
        const facing = ctx.by ? this.sts.get(ctx.by)?.facingDirection ?? ctx.facing : ctx.facing;
        p.rotY = facing < 0 ? -Math.PI / 2 : Math.PI / 2;
      };
      if (s.callback === "cutter") {
        // (Final Cutter's: until its move lets go, then 11 frames more; its frames follow the move)
        m.cutter = { releasedAt: ctx.cutterRelease };
        m.rootRotationY = !!s.face;
        m.rootSet = !s.child;
        m.life = ctx.cutterRelease === undefined ? Infinity : ctx.cutterRelease + 11;
        if (s.face) m.turn = faceFighter;
      }
      if (s.callback === "face") {
        m.rootRotationY = true;
        m.turn = faceFighter;
      }
      if (s.callback === "fireLaunch") {
        // (Fire Fox's and Fire Bird's: turned the way the fighter flies, atan2 of its own speed up and its speed
        // forward; with no speed, in hitlag or between states, it keeps the way it last had)
        m.rootRotationY = true;
        m.rootRotationZ = true;
        m.turn = (p) => {
          const st = ctx.by ? this.sts.get(ctx.by) : undefined;
          const facing = (st?.facingDirection ?? ctx.facing) < 0 ? -1 : 1;
          const vx = st?.actionStateId === FIRE_LAUNCH_GROUND ? st.selfInducedGroundXSpeed : st?.selfInducedAirXSpeed;
          const vy = st?.selfInducedAirYSpeed;
          p.rotY = facing * Math.PI / 2;
          if (vx || vy) p.rotZ = facing * (Math.atan2(vy ?? 0, (vx ?? 0) * facing) - Math.PI / 2);
        };
        m.turn(m);
      }
      if (s.callback === "offsetY") {
        m.offsetY = (ctx.offset?.[1] ?? 0) * ctx.scale;
        m.rootSet = true;
      }
      if (s.callback === "jabZ") {
        m.jabZ = true;
        if (ctx.facing < 0) m.rotZ = -m.rotZ;
      }
      // (efSync steps a few models' animations once as it makes them: the particle keys of the frames that
      // step passes are made too, not only the pose it ends on)
      if (!ctx.age && s.startFrame) {
        for (m.age = 0; m.age < s.startFrame; m.age++) this.modelParticles(m);
      }
      this.models.push(m);
      if (ctx.owner) this.own(ctx.owner).models.push(m);
      return;
    }
    const g = this.ps.generator(bank, s.g);
    if (!g) return;
    // (made part way through its life: the frames it has had are gone, and one past its life is not made)
    if (ctx.age && g.genLife > 0) {
      if (ctx.age >= g.genLife) {
        this.ps.endOwned(g);
        return;
      }
      g.genLife -= ctx.age;
    }
    if (ctx.tag) g.tag = ctx.tag;
    else if (ctx.by) g.tag = `f:${ctx.by}`;
    if (s.life !== undefined && (g.genLife === 0 || g.genLife > s.life)) g.genLife = s.life;
    if (s.attach && ctx.follow) {
      // (sized: a transform of its own that follows, at the call's scale)
      if (s.scale === "arg" || s.scale === "fighter") {
        g.srt = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: ctx.scale, sy: ctx.scale, sz: ctx.scale, follow: true };
      }
      this.attach(g, ctx.follow, ctx.pos);
      // (at the call's place under the joint: the offset goes with it)
      const mm = s.pos ? ctx.follow() : null;
      if (mm) {
        g.srt ??= { tx: mm[12], ty: mm[13], tz: mm[14], rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, follow: true };
        g.px = ctx.pos[0] - mm[12]; g.py = ctx.pos[1] - mm[13]; g.pz = ctx.pos[2] - mm[14];
      }
    } else if (s.face !== undefined || s.rotZ || s.scale || s.srtRotY !== undefined) {
      const f = ctx.facing * (s.face ?? 1);
      const srt: AppSRT = { tx: ctx.pos[0], ty: ctx.pos[1], tz: ctx.pos[2], rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, follow: false };
      if (s.face !== undefined) {
        if (f < 0) { g.kind |= 0x40000; srt.ry = -Math.PI / 2; } else srt.ry = Math.PI / 2;
      }
      if (s.srtRotY !== undefined) srt.ry = ctx.facing < 0 ? s.srtRotY : -Math.PI;
      if (s.rotZ) srt.rz = ctx.angle;
      if (s.scale === "arg" || s.scale === "fighter") srt.sx = srt.sy = srt.sz = ctx.scale;
      g.srt = srt;
    } else {
      g.px = ctx.pos[0]; g.py = ctx.pos[1]; g.pz = ctx.pos[2];
    }
    if (ctx.owner) this.own(ctx.owner).gens.push(g);
  }

  /** the generators an effect model drawn outside the world (the reflector's)
   *  starts from its root joint on frame `age` of it, at `at`: its animation's
   *  particle track (the reflector's start and reflect: the sparkles, EfFxData
   *  generators 3000 and 3001). The model runs a frame as it is made
   *  (efLib_Update), so its first frame takes the keys of its first two */
  rootParticles(file: number, index: number, age: number, at: [number, number, number], scale: number, by: string) {
    // (with the track's own generator events the keys are the game's: every joint animation's particle key the
    // game ran is in the track - this reading of the model would make them a second time)
    if (this.tracked && this.trackOrdered) return;
    const b = this.banks.get(file);
    if (!b) return;
    for (const k of b.ptclKeys(index)) {
      const t = Math.floor(k.time);
      if (k.joint !== 0 || !(age === 0 ? t <= 1 : t === age + 1)) continue;
      const bank = this.banks.get(k.bank);
      const g = bank ? this.ps.generator(bank, k.gen) : null;
      if (!g) continue;
      g.srt = { tx: at[0], ty: at[1], tz: at[2], rx: 0, ry: 0, rz: 0, sx: scale, sy: scale, sz: scale, follow: false };
      g.tag = `f:${by}`;
    }
  }

  /** the generators a model's animation starts now (a hit spark's sparks),
   *  where its joint is, at the model's size and turn. One made from a seeded
   *  piece runs as the game runs it: `first`, its animation's first step, as
   *  its spawn is made - each generator's first count from the piece's
   *  random state in turn; after that one step a frame from the frame it is
   *  made (so a key at time 1 is on that same frame), drawing from the
   *  frame's state. Any other model: the key whose time is its age. */
  private modelParticles(m: ModelFx, first = false) {
    // (one already ended - its owner's move over - makes no more)
    if (m.age >= m.life) return;
    const keys = m.bank.ptclKeys(m.index);
    if (!keys.length) return;
    const seeded = m.seed !== undefined;
    if (first !== (seeded && first)) return;
    let step = !seeded ? m.age : first ? 0 : m.age + 1;
    // (Final Cutter's effects: the frame its move has them at)
    if (m.cutter) step = cutterAnimationFrame(m.age, m.cutter.releasedAt);
    let state = first ? m.seed! : null;
    let posed = false;
    const prop = m.bank.prop(m.index, 0, true);
    for (const k of keys) {
      const bank = this.banks.get(k.bank);
      const at = k.every > 0 ? step % k.every : step;
      if (Math.floor(k.time) !== at || !bank) continue;
      if (!prop) return;
      if (!posed) {
        this.poseModel(m, prop, m.age);
        posed = true;
      }
      const w = prop.skeleton.world;
      if ((k.joint + 1) * 16 > w.length) continue;
      this.ps.rng.phase = first ? 5 : 1;
      const g = this.ps.generator(bank, k.gen, state);
      this.ps.rng.phase = 0;
      if (g) g.made = "key";
      if (!g) continue;
      // (the next one's state: one draw on, when this one's count was drawn)
      if (state !== null && !(g.kind & 0x100) && g.random >= 0) state = hsdNext(state);
      const gfx = k.bank * 1000 + (k.gen % 1000), alone = seeded && MODEL_KEY_ALONE.has(gfx);
      if (seeded) g.linkNo = MODEL_KEY_LIST.get(gfx) ?? 0;
      if (seeded && !alone) {
        // (the game's: the generator is on the model's joint itself (hsd_8039EFAC), gone to it each frame, its
        // emission turned as the joint is turned, and it ends with the model's owner's effects; no transform
        // but the one its command asks for, or efLib_SpawnParticleEffect's cases give it)
        g.maxAge = Infinity;
        g.model = m;
        const on = this.keyJoint(k.joint);
        const own = MODEL_KEY_SRT.has(gfx);
        if (own) {
          // (those cases: a transform of the generator's own, which goes to the joint each frame (type 0x800)
          // and takes, by the case, the turn about y and the size of the top joint of the model's tree, or
          // the joint's own size each frame (0x1000); the generator waits, let go, while anything uses it)
          const turnY = gfx === 0x127 || MODEL_KEY_ROT_Y.has(gfx), sized = MODEL_KEY_SCALE.has(gfx);
          const sc = sized ? m.scale : 1;
          g.srt = { tx: 0, ty: 0, tz: 0, rx: 0, ry: turnY ? m.rotY : 0, rz: 0, sx: sc, sy: sc, sz: sc, follow: true, owner: g };
        }
        this.attach(g, on, [w[k.joint * 16 + 12], w[k.joint * 16 + 13], w[k.joint * 16 + 14]]);
        if (own) {
          g.type = (g.type & ~0x600) | 0x800;
          if (MODEL_KEY_JOINT_SIZE.has(gfx)) g.type |= 0x1000;
        }
        g.model = m;
        if (m.owner) this.own(m.owner).gens.push(g);
        m.kin?.push(g);
        continue;
      }
      if (seeded && alone) {
        // (made on no joint, hsd_8039F05C, under a transform set once from the top joint of the model's tree:
        // its place (0xE3: the key's joint's), and by the case its turn about y or z and its size)
        g.maxAge = Infinity;
        const atJoint = gfx === 0xe3 ? k.joint : 0;
        const turnY = gfx !== 0xd4 && gfx !== 0x243 && gfx !== 0xe3, turnZ = gfx === 0xd4 || gfx === 0x243;
        const sc = gfx === 0xd4 || gfx === 0xe3 ? m.scale : 1;
        // (efLib_AddGeneratorAppSRT and psAddGeneratorAppSRT_begin make it with status 1: ONCE)
        g.srt = { tx: w[atJoint * 16 + 12], ty: w[atJoint * 16 + 13], tz: w[atJoint * 16 + 14],
                  rx: 0, ry: turnY ? m.rotY : 0, rz: turnZ ? m.rotZ : 0, sx: sc, sy: sc, sz: sc, follow: false, status: APP_ONCE };
        m.kin?.push(g);
        continue;
      }
      g.srt = { tx: w[k.joint * 16 + 12], ty: w[k.joint * 16 + 13], tz: w[k.joint * 16 + 14],
                rx: 0, ry: m.rotY, rz: m.rotZ, sx: m.scale, sy: m.scale, sz: m.scale, follow: false };
      if ((m.follow || m.under) && !alone) {
        // (a model that moves with a fighter: its generators go with its
        // joint and leave their particles behind - Fire Fox's trail)
        const joint = k.joint;
        g.srt.follow = true;
        g.bake = true;
        g.model = m;
        g.follow = (self) => {
          const m = self.model as ModelFx;
          if (m.age >= m.life) return null;
          const pr = m.bank.prop(m.index, 0, true);
          if (!pr) return null;
          const [x, y, z] = this.modelPlace(m);
          pr.pose(m.age, x, y, z, m.scale, m.rotY, false, m.rotZ, m.rotX ?? 0);
          const ww = pr.skeleton.world;
          return (joint + 1) * 16 <= ww.length ? ww.subarray(joint * 16, joint * 16 + 16) : null;
        };
      }
      // (a seeded model's own are on its joints: they, and the ones their particles make, end with the model
      // when its owner's effects end, and go on when the model has already run out - not with everything of
      // the fighter's)
      if (m.by && !alone) g.tag = `f:${m.by}`;
      if (m.owner && !alone) this.own(m.owner).gens.push(g);
      m.kin?.push(g);
    }
  }

  /** a seeded model's joint as the game's particle update finds it on the frame being stepped: the model's
   *  animation has taken that frame's step by then (one more than its age here, which counts up after the
   *  particles). Once the model has run out the joint stays as it last was (the generator keeps it) */
  private keyJoint(joint: number): (g: Generator) => Float32Array | null {
    // (the model and the joint last found are the generator's own: g.model, g.keptJoint)
    return (g) => {
      const m = g.model as ModelFx;
      if (m && m.age < m.life) {
        const pr = m.bank.prop(m.index, 0, true);
        if (pr) {
          this.poseModel(m, pr, m.age + 1);
          const ww = pr.skeleton.world;
          if ((joint + 1) * 16 <= ww.length) g.keptJoint = ww.slice(joint * 16, joint * 16 + 16);
        }
      }
      return g.keptJoint ?? null;
    };
  }

  /** an effect model posed at a frame of its animation where it is now: a child of a fighter's joint turned
   *  as the joint is, else at its place with the turn and size the dispatch gave its root */
  poseModel(m: ModelFx, pr: Prop, age: number) {
    if (m.cutter) age = cutterAnimationFrame(age, m.cutter.releasedAt);
    // (under a joint: held by constraints, or its child)
    const parent = m.under?.() ?? null;
    if (parent) {
      if (m.constrained) pr.poseConstrained(age, parent, m.scale, false);
      else pr.poseChild(age, parent, m.scale, false);
      if (m.secondChildOff) pr.hideSecondChild();
      return;
    }
    const [x, y, z] = this.modelPlace(m);
    pr.pose(age, x, y, z, m.scale, m.rootRotationY ? 0 : m.rotY, false, m.rootRotationZ ? 0 : m.rotZ, m.rotX ?? 0, m.rootSet);
    // (what its update callback sets after the animation: the root's turn, a joint's place)
    if (m.rootRotationY) pr.setRootRotationY(m.rotY);
    if (m.rootRotationZ) pr.setRootRotationZ(m.rotZ);
    if (m.jabZ) pr.setJointTranslationZ(1, m.z - 6 + 2 * age);
    if (m.secondChildOff) pr.hideSecondChild();
  }

  private own(key: string) {
    let o = this.owned.get(key);
    if (!o) this.owned.set(key, (o = { action: -1, gens: [], models: [] }));
    return o;
  }

  /** the effects a move spawned "until the move ends" go when it does */
  private endOwned(key: string) {
    const o = this.owned.get(key);
    if (!o) return;
    for (const g of o.gens) this.ps.kill(g);
    for (const m of o.models) {
      // (and the generators on its joints end with it)
      this.ps.endModel(m);
      m.age = m.life;
    }
    this.owned.delete(key);
  }

  /** where a model effect is now (one that follows a joint moves with it) */
  /** a generator going with a joint, as the game's are when made on one (hsd_8039EFAC) */
  private attach(g: Generator, follow: (g: Generator) => Float32Array | null, at: [number, number, number]) {
    g.follow = follow;
    g.type |= g.kind & 0x20000 ? 0x500 : 0x700;
    const mm = follow(g);
    const p: [number, number, number] = mm ? [mm[12], mm[13], mm[14]] : at;
    // (a generator whose particles go with what it is on, kind 0x20000 - it
    // does not move itself: the Thunder Jolt's spark on the jolt - a
    // transform of its own that follows)
    if (!g.srt && g.kind & 0x20000) g.srt = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, follow: true, view: true };
    if (g.srt) {
      // (one with a transform of its own: its particles are made about the
      // transform's origin, which follows - the generator itself stays at 0,
      // or they would be placed twice over)
      g.srt.follow = true;
      g.srt.tx = p[0]; g.srt.ty = p[1]; g.srt.tz = p[2];
      g.px = g.py = g.pz = 0;
    } else { g.px = p[0]; g.py = p[1]; g.pz = p[2]; }
  }

  // where each item is on the frame being stepped (its effects go with it)
  private itemAt = new Map<number, Float32Array>();
  /** an item's joint as the track has it on a frame (the replay's index): ["ij", item, joint, ox, oy, oz,
   *  m00, m01, m02, m10, ..., m22] - its place from the item's own and its matrix's turn and size, the last
   *  change at or before the frame - or null (an older track): set by the player */
  trackItemJoint: ((item: number, joint: number, frame: number) => (number | string)[] | null) | null = null;
  private itemJoints = new Map<string, Float32Array>();
  /** the world matrix of an item's joint on the frame being stepped: the track's turn at the item's place,
   *  else the item's place with no turn (as before the track said) */
  private itemJointWorld(item: number, joint: number): Float32Array | null {
    const at = this.itemAt.get(item) ?? null;
    const v = at ? this.trackItemJoint?.(item, joint, this.stepping) ?? null : null;
    if (!at || !v || v.length < 12) return at;
    const key = `${item}:${joint}`;
    let m = this.itemJoints.get(key);
    if (!m) { this.itemJoints.set(key, (m = new Float32Array(16))); m[15] = 1; }
    const n = v as number[];
    m[0] = n[3]; m[4] = n[4]; m[8] = n[5];
    m[1] = n[6]; m[5] = n[7]; m[9] = n[8];
    m[2] = n[9]; m[6] = n[10]; m[10] = n[11];
    m[12] = at[12] + n[0]; m[13] = at[13] + n[1]; m[14] = at[14] + n[2];
    return m;
  }

  /** the swords' swing strips (fx/swordtrail.ts) */
  readonly swords = new SwordTrails();

  /** a fighter's sword numbers, or null without a sword */
  swordOf(f: Fighter): SwordAttrs | null {
    return this.swords.attrsOf(f, () => {
      const at = SWORD_ATTRS[f.internalId];
      return at === undefined ? null : swordAttrs(at, (o) => f.specialAttr(o), (o) => f.specialInt(o));
    });
  }

  private swordStep(a: ActorFrame, frame: number, events: readonly ScriptEvent[], prev: number, now: number, entered: boolean) {
    const at = this.swordOf(a.fighter);
    if (!at) return;
    // (the sword's number is one of the game's parts: fp->parts, the model's joints in order)
    const j = partToModelJoint(a.st.internalCharacterId, at.part);
    const blade = j >= 0 && (j + 1) * 16 <= a.world.length ? a.world.subarray(j * 16, j * 16 + 16) : null;
    // (held still by hitlag as the game reads it: Fighter_procCollResolve notes the blade unless x2219_b6, which
    // Fighter_procHitlag copies from x2219_b5 after counting the frame before's hitlag down - before this frame's
    // hits - so the frame a hit lands still notes it, and the frame its hitlag runs out too)
    const held = this.stateAt ? (this.stateAt(a.key, frame - 1)?.hitlagRemaining ?? 0) - 1 > 0 : (a.st.hitlagRemaining ?? 0) > 0;
    this.swords.step(a.key, events, prev, now, entered, held, blade);
  }

  private itemEvents(list: FxItem[]) {
    const now = new Set<number>();
    // (the items on the frame before: what each item's change of state is)
    const previous = this.items?.(this.stepping - 1) ?? [];
    for (const it of list) {
      now.add(it.spawnId);
      let m = this.itemAt.get(it.spawnId);
      if (!m) {
        // (no turn of its own: what is on it is turned as nothing - a matrix of zeros here stopped every
        // particle a generator on an item's joint sent out)
        this.itemAt.set(it.spawnId, (m = new Float32Array(16)));
        m[0] = m[5] = m[10] = m[15] = 1;
      }
      m[12] = it.x; m[13] = it.y; m[14] = 0;
      // what the item's own code starts as it changes state (../item-effects.ts; with a track, the track's):
      // once, as it enters the state, not on each frame it stays there. The effects on it end first; a burst
      // is made where it is and outlives it
      if (!(this.tracked && this.trackOrdered)) {
        const tag = `i:${it.spawnId}`;
        const before = previous.find((q) => q.spawnId === it.spawnId);
        const ice = iceTransitionEffects(before, it);
        if (ice?.stop) this.ps.endTag(tag);
        for (const id of ice?.effects ?? []) {
          const follow = () => this.itemAt.get(it.spawnId) ?? null;
          this.spawn(id, { pos: [it.x, it.y, 0], follow, facing: it.facing ?? 1, angle: 0, damage: 0, scale: 1, owner: null, by: tag, tag });
        }
        const bursts = itemTransitionEffects(before, it);
        if (bursts.length) this.ps.endTag(tag);
        for (const id of bursts) {
          this.spawn(id, { pos: [it.x, it.y, 0], follow: null, facing: it.facing ?? 1, angle: 0, damage: 0, scale: 1, owner: null, by: tag });
        }
      }
      // the particles its model's animation starts on this frame of it,
      // going with it (efLib's particle callback on the item's joints)
      // (not with the track's own generator events: the item's keys the game ran are in the track)
      const pk = this.tracked && this.trackOrdered ? null : this.itemPtcl?.(it, this.stepping);
      if (pk) {
        for (const k of pk.keys) {
          const at = k.every > 0 ? pk.age % k.every : pk.age;
          // (a key before the animation's start: on its first frame)
          if (Math.max(0, Math.floor(k.time)) !== at) continue;
          this.itemGenerator(it, m, k.bank, k.gen);
        }
      }
    }
    // (an item gone: the effects on it go with it, as the game destroys them
    // with the item)
    // (with the track's own order the item's end is the track's "fxend": the game ends them after the pieces it
    // made earlier in the frame, and ending them here, first, put those pieces at another place in the list)
    const theirs = this.tracked && !!this.trackOrdered;
    for (const id of this.itemAt.keys()) if (!now.has(id)) { this.itemAt.delete(id); if (!theirs) this.ps.endTag(`i:${id}`); }
    if (this.itemJoints.size > 256) this.itemJoints.clear();
  }

  /** a generator of a fighter's file going with an item, ended with it */
  private itemGenerator(it: FxItem, at: Float32Array, file: number, g: number) {
    const bank = this.banks.get(file);
    const gen = bank ? this.ps.generator(bank, g) : null;
    if (!gen) return;
    gen.tag = `i:${it.spawnId}`;
    this.attach(gen, () => this.itemAt.get(it.spawnId) ?? at, [it.x, it.y, 0]);
  }

  modelPlace(m: ModelFx): [number, number, number] {
    if (m.follow) {
      const w = m.follow();
      // (kept its own height above the joint, when its callback says: offsetY)
      if (w) return [w[12], w[13] + (m.offsetY ?? 0), w[14]];
    }
    return [m.x, m.y, m.z];
  }
}

export { NO_WORLD };
