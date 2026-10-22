/* 3D replay viewer: what a hit does to the picture while the
 * fighters are in hitlag, read from the Melee decompilation (ft/fighter.c,
 * ftcommon.c, ftCo_DamageFall.c, ftdrawcommon.c, ft_0DF0.c, ftCo_Damage.c,
 * cm/camera.c, ef/eflib.c); this is our own writing of it.
 *
 *  - A fighter hit with knockback shakes in place (ftCo_80090594). Its model
 *    is drawn moved by an offset from a table in PlCo.dat (ftLoadCommonData
 *    entry 9): one for a hit in the air (up and down), one on the ground
 *    (along the floor), one for an electric hit, whatever the fighter stands
 *    on. The offset steps through its table a frame at a time, from the hit's
 *    frame, for 1.3 x the hit's hitlag frames (ftCommonData +0x168, +0x16C:
 *    a hitlag of 10 shakes 13 frames, 3 past the freeze); a new hit starts it
 *    over. Only the model moves: the game adds the offset to the camera's
 *    view for the fighter's draw (ftDrawCommon_8008051C) and for the item it
 *    holds (itdraw.c), so its joints, its effects, its sword's trail and its
 *    shadow stay where they are. The one who hits does not shake. Nor does a
 *    shield struck, a pummel or a throw's release (none is a knockback hit
 *    in the game's sense), or a Cape, Sleep, Nap or Disable hit (left out).
 *  - A smash attack charging trembles side to side the same way (ft_0DF0.c,
 *    PlCo entry 11), its own table, a step each frame of the charge.
 *  - A hit that launches (knockback level 3, ftCo_8008DCE0) into the air
 *    shakes the camera: the stage's small, medium or large quake by the
 *    knockback (ftCommonData +0x170, +0x174 on the knockback times +0x154).
 *    A move's script asks for quakes of its own (effects 0x513-0x515): every
 *    throw as it lets go, the heavy moves as they land.
 *  - In hitlag the game freezes the fighter's animation (the replay's frame
 *    counter holds, so ours does), not its color animation, not the camera,
 *    the stage, the particles or the other fighters. The effects a fighter's
 *    special move made pause with it (efLib_PauseAll: the moves below set it
 *    as their hitlag's callbacks), from the frame after the hit's to the
 *    frame the hitlag ends.
 *
 * A replay records each fighter's hitlag (Slippi 3.8 on), its percent and
 * whether it is in the air, which is what these need; the floor under a
 * fighter hit on the ground (the shake runs along it) is the line the replay
 * names as its last ground, its slope from the stage's collision data
 * (collision.ts); without them, taken as flat.
 */
import type { PlayerState } from "../common/types";
import { Archive, ptr } from "./hsd";

type V2 = [number, number];

/** the game's numbers these use (ftCommonData and PlCo's tables) */
export interface HitFeel {
  /** ftCommonData +0x198, +0x19C, +0x1A0, +0x194, +0x1A4: hitlag per damage,
   *  its base, its share crouching, its most, an electric hit's factor */
  perDamage: number; base: number; crouch: number; maxHitlag: number; electric: number;
  /** +0x168, +0x16C: shake frames per hitlag frame, and added */
  shakePerHitlag: number; shakeAdd: number;
  /** PlCo entry 9: the shake in the air, on the ground, electric */
  air: V2[]; ground: V2[]; electricShake: V2[];
  /** PlCo entry 11: a smash attack's charge */
  charge: V2[];
  /** +0x100: knockback to speed; +0x154 knockback to its level's scale;
   *  +0x160 the scale from which it launches (level 3); +0x170, +0x174 the
   *  scale of a medium and a large quake */
  kbSpeed: number; kbScale: number; launch: number; medium: number; large: number;
}

/** as PlCo.dat has them (a file that cannot be read leaves these) */
export const HIT_FEEL: HitFeel = {
  perDamage: Math.fround(1 / 3), base: 3, crouch: Math.fround(2 / 3), maxHitlag: 20, electric: 1.5,
  shakePerHitlag: Math.fround(1.3), shakeAdd: 0,
  air: [[0, -3], [0, -1.5], [0, 3], [0, 1.5]],
  ground: [[-3, 0], [-1.5, 0], [3, 0], [1.5, 0]],
  electricShake: [[0, -0.66], [0.5, 0.16], [0, 5], [0.16, 0], [0, 0]].map(([x, y]) => [Math.fround(x), Math.fround(y)] as V2),
  charge: [[-0.16, 0], [0.16, 0], [-0.16, 0], [0.16, 0], [0, 0]].map(([x, y]) => [Math.fround(x), Math.fround(y)] as V2),
  kbSpeed: Math.fround(0.03), kbScale: Math.fround(0.4), launch: 32, medium: 50, large: 70,
};

/** the numbers from PlCo.dat's ftLoadCommonData (`table`: its address) */
export function readHitFeel(a: Archive, table: number): HitFeel {
  const d = a.data, cd = ptr(a, table);
  if (cd === null) return HIT_FEEL;
  const f = (o: number) => d.getFloat32(cd + o);
  const list = (at: number | null, n: number): V2[] | null => {
    if (at === null || n <= 0 || n > 64) return null;
    return Array.from({ length: n }, (_, i) => [d.getFloat32(at + i * 8), d.getFloat32(at + i * 8 + 4)] as V2);
  };
  // entry 9: {Vec2*, count} for the air, the ground, electric (Fighter_804D6530)
  const hit = ptr(a, table + 9 * 4);
  const kinds = [0, 1, 2].map((k) => hit === null ? null : list(ptr(a, hit + k * 8), d.getUint32(hit + k * 8 + 4)));
  // entry 11: {Vec2*, count} (Fighter_SmashChargeShakeTable)
  const ch = ptr(a, table + 11 * 4);
  const charge = ch === null ? null : list(ptr(a, ch), d.getInt32(ch + 4));
  const out: HitFeel = {
    perDamage: f(0x198), base: f(0x19c), crouch: f(0x1a0), maxHitlag: f(0x194), electric: f(0x1a4),
    shakePerHitlag: f(0x168), shakeAdd: f(0x16c),
    air: kinds[0] ?? HIT_FEEL.air, ground: kinds[1] ?? HIT_FEEL.ground, electricShake: kinds[2] ?? HIT_FEEL.electricShake,
    charge: charge ?? HIT_FEEL.charge,
    kbSpeed: f(0x100), kbScale: f(0x154), launch: f(0x160), medium: f(0x170), large: f(0x174),
  };
  // (a file whose numbers are not sane leaves the game's)
  const sane = out.maxHitlag > 0 && out.maxHitlag < 100 && out.shakePerHitlag >= 0 && out.shakePerHitlag < 10 && out.kbSpeed > 0;
  return sane ? out : HIT_FEEL;
}

// the common action states these look at
const SQUAT = 39, SQUAT_WAIT = 40;
const FLY_FIRST = 87, FLY_LAST = 91; // DamageFlyHi, N, Lw, Top, Roll: knockback level 3
const isFly = (s: number) => s >= FLY_FIRST && s <= FLY_LAST;
const isCrouch = (s: number) => s === SQUAT || s === SQUAT_WAIT;
// held to be thrown (ThrownF..ThrownLwWomen, the Ice Climbers', Bowser's,
// Kirby's and Mewtwo's own): a throw's release launches by the thrower's code
const THROWN = new Set([...Array.from({ length: 5 }, (_, i) => 239 + i), 271, 272, 273, 274, 281, 282, 286, 287, 290, 291, 292,
  303, 304]);
/** whether a fighter in this state is held to be thrown */
export const isThrown = (state: number) => THROWN.has(state);
// the moves whose hitbox is a Cape (Mario's and Dr. Mario's side-B), Disable
// (Mewtwo's down-B) or Sleep (Jigglypuff's Sing): internal id -> states
const NO_SHAKE: Record<number, number[]> = { 0: [345, 346], 21: [345, 346], 16: [359, 360], 15: [365, 366, 367, 368] };

/** ftCommon_CalcHitlag: a hit's hitlag frames for its damage (a whole number),
 *  crouching or not, times an electric hit's factor; in the game's single
 *  precision, each step cut to a whole number as the game's are */
export function calcHitlag(damage: number, crouching: boolean, mul: number, hf: HitFeel = HIT_FEEL): number {
  const f = Math.fround;
  const tmp = Math.trunc(f(f(Math.trunc(damage) * hf.perDamage) + hf.base));
  let r = Math.trunc(f(tmp * f(mul)));
  if (crouching) r = Math.trunc(f(r * hf.crouch));
  return r;
}

/** how many frames a hit with this hitlag (before it is capped) shakes the
 *  one hit, from the hit's frame (ftCo_DamageFall.c calcShift: to a u16) */
export function shakeFrames(hitlag: number, hf: HitFeel = HIT_FEEL): number {
  return Math.max(0, Math.trunc(Math.fround(Math.fround(hf.shakePerHitlag * hitlag) + hf.shakeAdd)));
}

/** which of the shake's tables: in the air, on the ground, electric */
export type ShakeKind = 0 | 1 | 2;

/** ftCo_80090690: the offset `k` frames into a hit's shake, facing
 *  `facing`; on the ground it runs along the floor (its normal) */
export function shakeOffset(kind: ShakeKind, k: number, facing: number, hf: HitFeel = HIT_FEEL,
                            normal: V2 = [0, 1]): V2 {
  const t = kind === 0 ? hf.air : kind === 1 ? hf.ground : hf.electricShake;
  const v = t[k % t.length];
  const face = facing < 0 ? -1 : 1;
  if (kind === 1) {
    const x = v[0] * face;
    return [normal[1] * x, -normal[0] * x + v[1]];
  }
  return [v[0] * face, v[1]];
}

/** a hit that shakes the one hit, starting on this frame: its table and how
 *  long, or null. A replay says a fighter took damage (its percent went up)
 *  and, from Slippi 3.8, its hitlag: a hit with knockback always has hitlag
 *  (a grab's pummel and a throw's release have none, and do not shake). The
 *  hitlag is the game's for the hit: electric when only the electric factor
 *  gives it; before its cap it is the shake's count; at the cap (20), the
 *  count is the damage's uncapped. Without hitlag in the replay, the damage's.
 *  `by`: the one who hit, on that frame (a Cape, Disable or Sleep hit, which
 *  the game does not shake, is told by the move) */
export function hitShake(prev: PlayerState | undefined, st: PlayerState | undefined,
                         hf: HitFeel = HIT_FEEL, by?: PlayerState,
                         floorAt?: (y: number) => boolean): { kind: ShakeKind; frames: number } | null {
  if (!prev || !st || st.isDead || prev.isDead) return null;
  const delta = st.percent - prev.percent;
  if (!(delta > 0.001)) return null;
  if (by && NO_SHAKE[by.internalCharacterId]?.includes(by.actionStateId)) return null;
  // the damage the game counts: the hit's, cut to a whole number, at least 1
  const damage = Math.max(1, Math.trunc(delta + 1e-3));
  const crouched = isCrouch(prev.actionStateId);
  const recorded = st.hitlagRemaining;
  let hitlag: number, electric = false;
  if (recorded === undefined || recorded === null || Number.isNaN(recorded)) {
    hitlag = calcHitlag(damage, crouched, 1, hf);
  } else {
    if (!(recorded > 0)) return null;
    hitlag = Math.round(recorded);
    if (hitlag >= hf.maxHitlag) {
      // capped: electric when an ordinary hit of this damage stays under the cap
      const base = calcHitlag(damage, false, 1, hf), elec = calcHitlag(damage, false, hf.electric, hf);
      electric = base < hf.maxHitlag && elec >= hf.maxHitlag;
      hitlag = Math.max(hitlag, electric ? elec : base);
    } else {
      // the hitlag an ordinary and an electric hit of this damage would have,
      // crouching (a crouch cancel) as the frame before says first
      electric = electricByHitlag(delta, crouched, hitlag, hf) === true;
    }
  }
  return { kind: electric ? 2 : inAirWhenHit(prev, st, floorAt) ? 0 : 1, frames: shakeFrames(hitlag, hf) };
}

/** whether a hit was electric, by its hitlag (only an electric hit's factor
 *  gives it that): true or false, or null when the replay cannot say (no
 *  hitlag recorded, or the capped one) */
export function electricByHitlag(delta: number, crouched: boolean, hitlag: number | undefined,
                                 hf: HitFeel = HIT_FEEL): boolean | null {
  if (hitlag === undefined || hitlag === null || Number.isNaN(hitlag) || !(hitlag > 0) || !(delta > 0.001)) return null;
  const damage = Math.max(1, Math.trunc(delta + 1e-3)), h = Math.round(hitlag);
  if (h >= hf.maxHitlag) return null;
  for (const c of [crouched, !crouched]) {
    if (h === calcHitlag(damage, c, 1, hf)) return false;
    if (h === calcHitlag(damage, c, hf.electric, hf)) return true;
  }
  return null;
}

/** whether a fighter was in the air when hit: the game's ground_or_air as the
 *  hit lands, after the frame's own movement. Still on the ground after the
 *  hit, it was on it. In the air after it: from the ground, unless it rose
 *  this frame (a jump leaving it); from the air, unless it rose onto a floor
 *  (`floorAt`: a height fighters stand at in this replay) - a landing lifts
 *  the fighter's position onto the floor it comes down on. (Slippi's
 *  "airborne" flag: the parser's name for it, isGrounded, is the other way round) */
export function inAirWhenHit(prev: PlayerState, st: PlayerState, floorAt?: (y: number) => boolean): boolean {
  // (held to be thrown, the game has the fighter in the air, whatever Slippi's flag says)
  if (THROWN.has(st.actionStateId) || THROWN.has(prev.actionStateId)) return true;
  if (st.isGrounded !== true) return false;
  const rose = st.yPosition > prev.yPosition + 0.01;
  if (prev.isGrounded !== true) return rose;
  return !(rose && (floorAt?.(st.yPosition) ?? false));
}

/** the heights fighters stand at in a replay (its flat floors), for
 *  inAirWhenHit: `states` every fighter's state on every frame */
export function floorHeights(states: Iterable<PlayerState | undefined>): (y: number) => boolean {
  const ys = new Set<number>();
  for (const s of states) if (s && s.isGrounded === false && !s.isDead) ys.add(Math.round(s.yPosition * 100));
  return (y) => ys.has(Math.round(y * 100));
}

/** the longest a hit's shake can last (its hitlag uncapped, a very big hit) */
const MAX_SHAKE = 90;

/** what a fighter's shake is read with, besides its states */
export interface ShakeContext {
  hf?: HitFeel;
  /** the state of player `port` (the one who last hit it) on frame g */
  by?: (g: number, port: number) => PlayerState | undefined;
  /** the heights fighters stand at (floorHeights) */
  floorAt?: (y: number) => boolean;
  /** the table a hit on frame g shook with, and the floor's normal, as the
   *  viewer track has it (its shake's first offset), when it has one */
  said?: (g: number) => { kind: ShakeKind; normal: V2 } | null;
  /** the normal of the floor a fighter stands on in this state (its last
   *  ground's line in the stage's collision data: collision.ts), or null */
  floorNormal?: (st: PlayerState) => V2 | null;
}

/** a fighter's shake on frame `f` from its last hit (null when still):
 *  `stateAt(g)` is its state on frame g */
export function hitShakeAt(stateAt: (g: number) => PlayerState | undefined, f: number, ctx: ShakeContext = {}): V2 | null {
  const hf = ctx.hf ?? HIT_FEEL;
  const now = stateAt(f);
  if (!now || now.isDead) return null;
  for (let g = f; g > f - MAX_SHAKE && g > 0; g--) {
    const st = stateAt(g), prev = stateAt(g - 1);
    if (!st || !prev) return null;
    const h = hitShake(prev, st, hf, ctx.by?.(g, st.lastHitBy), ctx.floorAt);
    if (!h) continue;
    // (the latest hit: a new one starts the shake over)
    const k = f - g;
    if (k >= h.frames) return null;
    const said = ctx.said?.(g);
    if (said) return shakeOffset(said.kind, k, now.facingDirection, hf, said.normal);
    // (on the ground, along the floor it was hit on, as the game keeps it: ftCo_80090594)
    const normal = h.kind === 1 ? ctx.floorNormal?.(st) ?? undefined : undefined;
    return shakeOffset(h.kind, k, now.facingDirection, hf, normal);
  }
  return null;
}

/** what a viewer track's shake offset on a hit's first frame says of it:
 *  its table (the first entry of each, facing `facing`) and, on the ground,
 *  the floor's normal; null when it is none of them */
export function shakeKindOf(v: V2, facing: number, hf: HitFeel = HIT_FEEL): { kind: ShakeKind; normal: V2 } | null {
  const face = facing < 0 ? -1 : 1;
  const near = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const e = hf.electricShake[0], a = hf.air[0], g = hf.ground[0];
  if (near(v, [e[0] * face, e[1]])) return { kind: 2, normal: [0, 1] };
  if (near(v, [a[0] * face, a[1]])) return { kind: 0, normal: [0, 1] };
  // on the ground: (ny x, -nx x + y) with x the entry's across the facing
  const x = g[0] * face;
  if (Math.abs(x) < 1e-6) return null;
  const nx = -(v[1] - g[1]) / x, ny = v[0] / x;
  const len = Math.hypot(nx, ny);
  return len > 0.9 && len < 1.1 ? { kind: 1, normal: [nx / len, ny / len] } : null;
}

/** what a fighter's draw offset is read from in a viewer track (track.ts) */
export interface ShakeTrack {
  has(type: string): boolean;
  valid(frame: number): boolean;
  at(type: string, key: string, frame: number): (number | string)[] | null;
}

/** a fighter's draw offset on game frame `g` as the viewer track has it ("shake", by `port:sub`): the sum
 *  ftCommon_8008021C makes each frame - the hit's shake (ftCo_80090690), the wobble of a held one mashing
 *  (x2224_b5, a step of its table each mash: ftCommon_GrabMash) and a smash attack's charge
 *  (ftCo_800DEEE8) - that ftDrawCommon_8008051C moves the fighter's draw by. The offset, null when it has
 *  none then, undefined when the track does not say (it has no shake, or does not hold on that frame) */
export function trackShake(tr: ShakeTrack | null | undefined, key: string, g: number): V2 | null | undefined {
  if (!tr || !tr.has("shake") || !tr.valid(g)) return undefined;
  const v = tr.at("shake", key, g);
  if (!v) return null;
  const x = Number(v[0]), y = Number(v[1]);
  return x === 0 && y === 0 ? null : [x, y];
}

/** whether a smash attack is charging at the end of frame `g` (its smash_attrs.state Charging,
 *  ftLib_IsChargingSmash): its animation stands at or past its script's charge frame and stays there
 *  the next frame */
export function smashCharging(stateAt: (g: number) => PlayerState | undefined, g: number,
                              chargeFrame: (state: number) => number | null): boolean {
  const a = stateAt(g), b = stateAt(g + 1);
  if (!a || !b || a.isDead || a.actionStateId !== b.actionStateId) return false;
  if ((a.hitlagRemaining ?? 0) > 0 || (b.hitlagRemaining ?? 0) > 0) return false;
  const at = chargeFrame(a.actionStateId);
  return at !== null && a.actionStateFrameCounter >= at - 0.001 && b.actionStateFrameCounter === a.actionStateFrameCounter;
}

/** a smash attack's charge trembling on frame `f` (null when not): the
 *  charge holds the animation from its script's charge frame (`chargeFrame`
 *  of a state, null for one that does not charge) until the button is let
 *  go; the game shakes it from the frame the charge begins to the frame
 *  before it lets go - each frame whose next one holds the animation still -
 *  a step of its table a frame (ftCo_800DEEE8, ftCo_800DEF38) */
export function chargeShakeAt(stateAt: (g: number) => PlayerState | undefined, f: number,
                              chargeFrame: (state: number) => number | null, hf: HitFeel = HIT_FEEL): V2 | null {
  const holds = (g: number): boolean => smashCharging(stateAt, g, chargeFrame);
  if (!holds(f)) return null;
  let from = f;
  while (from > 0 && f - from < 600 && holds(from - 1)) from--;
  const v = hf.charge[(f - from) % hf.charge.length];
  return [v[0], v[1]];
}

/** the camera's quake a hit starts on this frame (Camera_RequestQuake: 1
 *  small, 2 medium, 3 large), or 0. A hit launching the fighter (knockback
 *  level 3: one of the DamageFly states, an upward throw's release too)
 *  that leaves it in the air; its size by the knockback, which the replay's
 *  knockback speed gives (speed = knockback x ftCommonData +0x100) */
export function hitQuake(prev: PlayerState | undefined, st: PlayerState | undefined, hf: HitFeel = HIT_FEEL): number {
  if (!prev || !st || st.isDead || !isFly(st.actionStateId) || st.isGrounded !== true) return 0;
  // (a new hit this frame: a new launch, a new hit's damage or its hitlag starting)
  const hit = !isFly(prev.actionStateId) || st.percent - prev.percent > 0.001 ||
    ((st.hitlagRemaining ?? 0) > 0 && (st.hitlagRemaining ?? 0) >= (prev.hitlagRemaining ?? 0));
  if (!hit) return 0;
  // (the knockback x 0.4 the levels and sizes go by: the replay's hitstun is
  // it, (int) of it, and the thresholds are whole numbers; the knockback
  // speed would say it too, but the game slows that for some in the air -
  // ftCo_Damage_CheckAirMotion, x 0.95: a throw's let go - which put them
  // under a launch here)
  const hitstun = st.isInHitstun !== false && (st.hitstunRemaining ?? 0) > 0 ? st.hitstunRemaining! : null;
  const scaled = hitstun ?? Math.hypot(st.attackBasedXSpeed ?? 0, st.attackBasedYSpeed ?? 0) / hf.kbSpeed * hf.kbScale;
  // (below level 3 only a throw's release is launched: its level is set;
  // an ice hit of level 2 flies too, without a quake)
  if (scaled < hf.launch - 0.01 && !THROWN.has(prev.actionStateId)) return 0;
  return scaled >= hf.large ? 3 : scaled >= hf.medium ? 2 : 1;
}

const DOWN_BOUND = new Set([183, 191]); // DownBoundU, DownBoundD
const FLY_REFLECT = new Set([247, 248]); // FlyReflectWall, FlyReflectCeil

/** a quake a move's script asks for: its frame in the script, and its size
 *  (1 small, 2 medium, 3 large) */
export interface ScriptQuake { frame: number; kind: number }

/** the quakes in a move's script: its effect commands 0x513, 0x514 and 0x515
 *  ask the camera for a small, medium or large quake where the command's
 *  joint is (ftCo_09F7.c: efAsync kind 8, Camera_RequestQuake). Every throw
 *  has one where it lets go, and the heavy moves where they land */
export function scriptQuakes(events: readonly { kind: string; frame: number; gfx?: number }[]): ScriptQuake[] {
  const out: ScriptQuake[] = [];
  for (const e of events) {
    if (e.kind === "gfx" && e.gfx !== undefined && e.gfx >= 0x513 && e.gfx <= 0x515) out.push({ frame: e.frame, kind: e.gfx - 0x512 });
  }
  return out;
}

/** the largest quake a fighter's move script asks for on this frame, or 0.
 *  The script runs as the animation advances, so its commands up to the
 *  replay's frame counter have run: those past last frame's counter, all
 *  from the start in a move begun from its start (a counter of 0 or 1: its
 *  code may advance it a frame as it begins) or one starting over; none in a
 *  move carried on part way through (a ground and air version's switch,
 *  whose script is skipped to there) */
export function scriptQuakeAt(prev: PlayerState | undefined, st: PlayerState | undefined,
                              quakes: (state: number) => readonly ScriptQuake[]): number {
  if (!prev || !st || st.isDead) return 0;
  const list = quakes(st.actionStateId);
  if (!list.length) return 0;
  const c = st.actionStateFrameCounter;
  let from: number;
  if (prev.actionStateId !== st.actionStateId) {
    if (c >= 2) return 0;
    from = -1;
  } else if (c < prev.actionStateFrameCounter) from = -1;
  else if (c === prev.actionStateFrameCounter) return 0;
  else from = prev.actionStateFrameCounter;
  let k = 0;
  for (const q of list) if (q.frame > from && q.frame <= c + 1e-4) k = Math.max(k, q.kind);
  return k;
}

/** the camera's quake a fighter starts on this frame: a hit's (hitQuake), a
 *  launched fighter hitting the floor without teching (ftCo_800976A4: the
 *  large one) or bouncing off a wall or the ceiling (ftCo_800C18A8: the
 *  small one), or one its move's script asks for (scriptQuakeAt); 0 for none */
export function quakeOf(prev: PlayerState | undefined, st: PlayerState | undefined, hf: HitFeel = HIT_FEEL,
                        quakes?: (state: number) => readonly ScriptQuake[]): number {
  if (!prev || !st || st.isDead) return 0;
  const s = st.actionStateId, p = prev.actionStateId;
  const scripted = quakes ? scriptQuakeAt(prev, st, quakes) : 0;
  if (DOWN_BOUND.has(s) && !DOWN_BOUND.has(p)) return 3;
  if (FLY_REFLECT.has(s) && !FLY_REFLECT.has(p)) return Math.max(1, scripted);
  return Math.max(scripted, hitQuake(prev, st, hf));
}

// ------------------------------------------------ effects paused in hitlag

// The moves whose code sets efLib_PauseAll and efLib_ResumeAll as the
// fighter's hitlag callbacks (Fighter_SetEffectHitlagCallbacks, and
// ftCo_AttackS4.c for Pikachu's and Pichu's forward smash): internal
// character id -> the move's action states. A change of state clears the
// callbacks, so one hit out of these moves (into a damage state) pauses
// nothing: it is the one hitting, in the move, whose effects pause.
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const FORWARD_SMASH = range(58, 62);
const FOX_MOVES = [...range(347, 352), ...range(353, 359), ...range(360, 369)]; // Illusion, Fire Fox, Reflector
const CAPTAIN_MOVES = [347, 348, ...range(349, 352), ...range(357, 362)]; // Punch, Raptor Boost, Kick
const SWORD_MOVES = range(341, 348); // Shield Breaker
const PIKA_MOVES = [341, 342, ...range(353, 358), ...FORWARD_SMASH]; // Thunder Jolt, Quick Attack, forward smash
const MARIO_MOVES = [349, 350]; // Mario Tornado
const IC_MOVES = [...range(343, 346), 359, 360]; // Squall Hammer (Popo's, Nana's)
const LINK_MOVES = [356, 357]; // Spin Attack
const PAUSES: Record<number, Set<number>> = {
  0: new Set(MARIO_MOVES), 21: new Set(MARIO_MOVES),
  1: new Set(FOX_MOVES), 22: new Set(FOX_MOVES),
  2: new Set(CAPTAIN_MOVES), 25: new Set(CAPTAIN_MOVES),
  3: new Set(range(369, 386)), // Giant Punch, Headbutt, Spinning Kong, Hand Slap
  // Kirby: Final Cutter; his own inhale (ftkirbyspecialn.c: the start and the loop, ground and air); and the copied
  // moves whose code sets the two callbacks as the fighter's it is copied from does - the Giant Punch
  // (ftkirbyspecialdonkey.c, 455 to 464), Nayru's Love (ftkirbyspecialzelda.c, 465 and 466) and the Shield Breaker
  // and Flare Blade, which share their code (ftkirbyspecialmars.c, 492 to 499 and 530 to 537). Without the copies a
  // Kirby with Zelda's hat whose Nayru's Love hit kept its effect model running through his hitlag: one generator
  // of its animation too many, and 939 frames of that game's lists off after it
  4: new Set([...range(385, 392), 353, 354, 371, 372, ...range(455, 466), ...range(492, 499), ...range(530, 537)]),
  5: new Set(range(359, 363)), // Whirling Fortress, Bomb
  6: new Set(LINK_MOVES), 20: new Set(LINK_MOVES),
  7: new Set(range(355, 364)), // Vanish, Transform
  8: new Set(range(367, 376)), // PSI Magnet
  10: new Set(IC_MOVES), 11: new Set(IC_MOVES),
  12: new Set(PIKA_MOVES), 23: new Set(PIKA_MOVES),
  13: new Set([...range(343, 348), 353, 354]), // Charge Shot, Screw Attack
  15: new Set(range(365, 368)), // Sing
  16: new Set(range(353, 358)), // Teleport
  17: new Set([...range(343, 354), 357, 358]), // Green Missile, Luigi Cyclone
  18: new Set(SWORD_MOVES), 26: new Set(SWORD_MOVES),
  19: new Set([341, 342, ...range(349, 358)]), // Nayru's Love, Farore's Wind, Transform
};

/** whether a fighter in this move pauses its effects in hitlag */
export function pausesEffects(char: number, state: number): boolean {
  return PAUSES[char]?.has(state) ?? false;
}

/** whether a fighter's effects stand still on this frame: its move pauses
 *  them and it was in hitlag coming into the frame with more than this frame
 *  of it left. (The hit's frame paused them after they had run; the frame
 *  the hitlag ends resumed them before: efLib_Update runs after the hit and
 *  after the hitlag's count, eflib.c, fighter.c) */
export function effectsPaused(prev: PlayerState | undefined, st: PlayerState | undefined): boolean {
  if (!prev || !st || st.isDead) return false;
  return (prev.hitlagRemaining ?? 0) >= 2 && pausesEffects(st.internalCharacterId, st.actionStateId);
}
