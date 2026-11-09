/* 3D replay viewer: Yoshi's egg roll (side-B), as his code runs it.
 *
 * The roll's states (356 to 363: the starts on the ground and in the air, the
 * loops, the end and the landing) each step the same counter in their
 * animation callback (ftyoshispecials.c ftYs_SpecialS_8012EB48): once the
 * start's script sets the move's first variable to 1 (its frame 8), the
 * counter runs through a table of fourteen, one a frame, flickering part 0
 * between Yoshi (0) and the egg (1) and leaving the egg; the end's script
 * sets it to 2 (its frame 12), which puts Yoshi back. The changes between the
 * roll's states keep the parts (their flags carry Ft_MF_SkipModel).
 *
 * The loops spin the egg: part 3 turned about x by an angle each adds to
 * every frame - 2 pi / 25 x 1.1 x the roll's speed rolling (on the ground the
 * speed the frame before's: the physics step, after the animation's, sets
 * it; in the air what the bounce gave it), 2 pi / 25 x 4 turning around,
 * pi / 30 x 5 forming in the air (the attributes 0xD8, 0xA0, 0x60).
 *
 * Turning around (358) the egg leans (part 2 about z) and turns (part 0 about
 * y) as its speed runs down from what it had and back up the other way
 * (ftYs_SpecialS_UpdateLoop1Rotation and ...Rotation2: attribute 0xE4, pi/4).
 *
 * Meeting the ground from the air (the forming loop's bounce or landing, the
 * air loop's landing) it squashes over the next four frames: its height
 * times 0.65, 0.7, 0.8, 1 and its depth times 1.1, 1.35, 1.3, 1.2
 * (ftYs_Unk3_803CED84, 803CED94).
 */
import type { ScriptEvent } from "./fx/script";

export const YOSHI = 14;
/** the roll's states: the starts, the loops, the end, the landing */
export const ROLL_FIRST = 356, ROLL_LAST = 363;
const LOOP_GROUND = 357, LOOP_TURN = 358, LOOP_FORM = 361, LOOP_AIR = 362;
const STARTS = new Set([356, 360]);
/** ftYs_Unk3_803CED48: part 0's variant on each step of the counter */
const FLICKER = [0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1];
const SQUASH_Y = [0.65, 0.7, 0.8, 1], SQUASH_Z = [1.1, 1.35, 1.3, 1.2];
const LEAN = Math.PI / 4; // attribute 0xE4 (0.7854)
const TAU = Math.PI * 2;
const wrap = (v: number) => ((v % TAU) + TAU) % TAU;

export interface RollFrame { actionStateId: number; actionStateFrameCounter: number; groundSpeed: number; airSpeed: number }

export interface RollHistory {
  /** Yoshi's state on a frame (the replay's index), or undefined */
  at(g: number): RollFrame | undefined;
  /** the events of a state's script */
  script(state: number): readonly ScriptEvent[];
}

export interface EggRoll {
  /** part 0's variant (undefined: the game's switch has not touched it) */
  part0?: number;
  /** part 3's turn about x */
  spin?: number;
  /** turning around: part 2's lean about z and part 0's turn about y */
  lean?: number;
  turn?: number;
  /** the squash: height and depth factors */
  squash?: [number, number];
}

/** Yoshi's egg roll on frame f, from his history in the replay (null outside one) */
export function eggRollAt(h: RollHistory, f: number): EggRoll | null {
  const now = h.at(f);
  if (!now || now.actionStateId < ROLL_FIRST || now.actionStateId > ROLL_LAST) return null;
  // back to the roll's first frame
  let e = f;
  while (e > 0 && f - e < 1200) {
    const q = h.at(e - 1);
    if (!q || q.actionStateId < ROLL_FIRST || q.actionStateId > ROLL_LAST) break;
    e--;
  }
  const out: EggRoll = {};
  let counter = -1, v0 = 0, x14 = 0, speed = 0, x10 = 0, x8 = -1;
  let prevState = -1, prevT = -1;
  for (let g = e; g <= f; g++) {
    const st = h.at(g)!;
    const s = st.actionStateId, t = st.actionStateFrameCounter;
    const before = g > e ? h.at(g - 1)! : null;
    // (a frame the state changed on ran the state before's animation
    // callback: the change came in it, or after it in the collision)
    const cb = before && before.actionStateId !== s ? before.actionStateId : s;
    // the speed the callback reads: the frame before's
    const gv = before ? before.groundSpeed : 0;
    // turning around begins from the speed it had
    if (s === LOOP_TURN && before?.actionStateId !== LOOP_TURN) x10 = gv;
    if (s !== LOOP_TURN) x10 = 0;
    // the script up to this frame (a new state's from its start)
    const from = s === prevState && t > prevT ? prevT : -1;
    for (const ev of h.script(s)) {
      if (ev.kind === "cmdVar" && ev.index === 0 && ev.frame > from && ev.frame <= t) v0 = ev.value;
    }
    // the animation callback's step (ftYs_SpecialS_8012EB48)
    if (v0 === 1) counter++;
    else if (v0 === 2) counter = 0;
    if (counter >= 0 && counter < FLICKER.length) {
      out.part0 = FLICKER[counter];
      if (v0 === 2) { counter = -1; v0 = 0; }
    } else v0 = 0;
    // the squash (not in the starts)
    out.squash = undefined;
    if (!STARTS.has(cb) && x8 >= 0 && x8 < 4) { out.squash = [SQUASH_Y[x8], SQUASH_Z[x8]]; x8++; }
    // the spin
    if (cb === LOOP_GROUND || cb === LOOP_AIR) x14 += (TAU / 25) * 1.1 * Math.abs(speed);
    else if (cb === LOOP_TURN) x14 += (TAU / 25) * 4;
    else if (cb === LOOP_FORM) x14 += (Math.PI / 30) * 5;
    x14 = wrap(x14);
    if (cb === LOOP_GROUND || cb === LOOP_AIR || cb === LOOP_TURN || cb === LOOP_FORM) out.spin = x14;
    // turning around: the lean and the turn (put back as it rolls on)
    out.lean = out.turn = undefined;
    if (s === LOOP_TURN && cb === LOOP_TURN && x10 !== 0) {
      const a10 = Math.abs(x10), av = Math.abs(gv);
      const sameWay = x10 > 0 ? gv > 0 : gv < 0;
      out.lean = LEAN * (av / (sameWay ? a10 : 0.7 * a10)) - LEAN;
      const delta = sameWay ? a10 - av : a10 + av;
      out.turn = wrap((delta / (1.7 * a10)) * Math.PI + (x10 > 0 ? Math.PI / 2 : (3 * Math.PI) / 2));
    }
    // after the frame's physics and collision: the speed the next step
    // reads, and meeting the ground from the air (the next frames squash)
    if (s === LOOP_GROUND || s === LOOP_TURN) speed = st.groundSpeed;
    if (before && ((before.actionStateId === LOOP_FORM && (s === LOOP_GROUND || s === LOOP_AIR)) ||
                   (before.actionStateId === LOOP_AIR && s === LOOP_GROUND))) {
      x8 = 0;
      speed = s === LOOP_AIR ? st.airSpeed : st.groundSpeed;
    }
    prevState = s; prevT = t;
  }
  return out;
}

/** Yoshi's egg's colors are set from his shield by his code (ftYs_Init_8012B8A4) in the animation callback of each
 *  frame of his shield coming up (GuardOn 341, GuardOn_1 345) and held (GuardHold 342) and of his rolls and dodge in
 *  the egg (EscapeF, EscapeB, Escape: ftCo_80099644), and to the full shield's in his egg roll (ftYs_Init_8012B918);
 *  between those they stay as they were left. The callback runs before the frame's shield regains or takes damage
 *  (Fighter_procCollResolve): in the shield's states after the hold's own wear (ftCo_800925A4, called first), so the
 *  frame's own shield; in a roll the frame before's. Per frame, the shield that last set them (null: none yet, the
 *  file's colors) */
export const EGG_GUARD = new Set([341, 342, 345]), EGG_ROLL = new Set([233, 234, 235]);
export function eggShields(frames: ({ internalCharacterId: number; actionStateId: number; shieldSize: number } | undefined)[]):
    (number | null)[] {
  let now: number | null = null;
  return frames.map((st, k) => {
    if (st && st.internalCharacterId === YOSHI) {
      const before = frames[k - 1];
      if (EGG_GUARD.has(st.actionStateId)) now = st.shieldSize;
      else if (EGG_ROLL.has(st.actionStateId)) now = before ? before.shieldSize : st.shieldSize;
      else if (st.actionStateId >= ROLL_FIRST && st.actionStateId <= ROLL_LAST) now = 60;
    }
    return now;
  });
}
