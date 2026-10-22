/* 3D replay viewer: what the game's heads-up display shows at a
 * frame of a replay - the numbers, not the drawing (hud.ts draws them with
 * the game's own HUD art).
 *
 * The game keeps its HUD as state it steps each frame (src/melee/if/ in the
 * decompilation: ifstatus.c, ifstock.c, iftime.c, ifnametag.c). A replay can
 * be scrubbed anywhere, so everything here is worked out for one frame from
 * the replay itself: when each player's display was made (the match's start,
 * each respawn), when it went off in a KO, the last hit before the frame,
 * how long the fighter has stood still. Where the game draws a random number
 * (a hit's shake, a KO's scattered digits) this draws its own, the same for
 * the same frame every time.
 *
 * Frames are the viewer's: an index into the replay's frames (game frame
 * + 123).
 */
import type { PlayerState, ReplayData } from "../common/types";

/** the game frame the viewer's frame 0 is */
export const FIRST_FRAME = -123;
/** GO: the versus intro's "Ready" (its 85-frame animation, a frame ahead
 *  of the replay's first) ends, the players get control, the intro's player
 *  tags go and "GO!" comes up (gm_Scene_Vs_OnEnter, if_802F73C4) */
export const GO_FRAME = -39;

// ---------------------------------------------------------------- color

/** ifStatus_UpdateDamageDisplay: the percent's color, white at 0% to dark
 *  red at 300% and beyond, a straight line in each channel (the game's own
 *  two end colors), each channel cut to a whole number as the game's are */
export function percentColor(percent: number): [number, number, number] {
  const p = Math.max(0, Math.min(300, percent));
  const f = p / 300;
  const ch = (from: number, to: number) => Math.trunc(f * (to - from) + from) / 255;
  return [ch(0xff, 0x50), ch(0xff, 0x00), ch(0xff, 0x00)];
}

/** gm_80160968 by gm_80160854: the color of a player's port (the mark
 *  behind the percent, the magnifier's ring) - teams by team, CPUs gray */
const PORT_COLORS: [number, number, number][] = [
  [0x99, 0x1a, 0x1a], [0x33, 0x33, 0x80], [0x80, 0x66, 0x00], [0x1a, 0x66, 0x1a], [0x66, 0x66, 0x66],
  [0x66, 0x4d, 0x4d], [0x4d, 0x4d, 0x66], [0x66, 0x59, 0x33], [0x4d, 0x66, 0x4d],
];
export function portColorIndex(port: number, human: boolean, teams: boolean, team: number): number {
  if (teams) {
    const t = [[0, 5], [1, 6], [3, 8], [2, 7]][team];
    return t ? t[human ? 0 : 1] : 4;
  }
  return human && port >= 0 && port < 4 ? port : 4;
}
export function portColor(i: number): [number, number, number] {
  const c = PORT_COLORS[i] ?? PORT_COLORS[4];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

// ---------------------------------------------------------------- the percent's digits

/** the four pieces of the percent, in the model's order */
export const HUNDREDS = 0, TENS = 1, ONES = 2, SIGN = 3;
/** a narrow "1" pulls its neighbors in (ifStatus_802F4EDC) */
const ONE_GAP = 0.5069;

export interface DigitLayout {
  /** each digit's texture frame (2 x the digit), the sign's 0 */
  frame: [number, number, number, number];
  shown: [boolean, boolean, boolean, boolean];
  /** added to each piece's own x (the model's) */
  dx: [number, number, number, number];
}

export function digitLayout(percent: number): DigitLayout {
  const p = Math.max(0, Math.min(999, Math.trunc(percent)));
  const h = Math.floor(p / 100) % 10, t = Math.floor(p / 10) % 10, o = p % 10;
  const oo = o === 1 ? ONE_GAP : 0, to = t === 1 ? ONE_GAP : 0, ho = h === 1 ? ONE_GAP : 0;
  return {
    frame: [2 * h, 2 * t, 2 * o, 0],
    shown: [h !== 0, !(h === 0 && t === 0), true, true],
    dx: [oo + 2 * to + ho, oo + to, 0, -oo],
  };
}

// ---------------------------------------------------------------- random numbers

/** a number in [0, 1) that is the same for the same seeds (HSD_Randf stands
 *  in: the game's own sequence cannot be known from a replay) */
export function rand(...seed: number[]): number {
  let h = 0x9e3779b9;
  for (const s of seed) {
    h = Math.imul(h ^ (s | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- a hit's shake

/** ifStatus_802F4B84: after a hit the digits shake for nine frames, each by a
 *  random step in x and y, bigger for a bigger hit (0.1014 a percent point,
 *  0.1014 to 1.5207), never less than 0.2028 either way; the tenth frame puts
 *  them back. A new hit starts it again. */
export const SHAKE_FRAMES = 10;
export function shakeOffset(frame: number, hit: number, damage: number, piece: number, port: number,
                            draws: number[] | null = null): [number, number] | null {
  const k = frame - hit;
  if (k < 0 || k > SHAKE_FRAMES - 2) return null;
  const mag = Math.max(0.1014, Math.min(1.5207, 0.1014 * (damage & 0xff)));
  const step = (r: number) => {
    const v = mag * 2 * (r - 0.5);
    return v < 0 ? v - 0.2028 : v + 0.2028;
  };
  // (the game's own draws when known - HSD_Randf, x then y for each piece in turn; else a stand-in of our own)
  if (draws) return [step(draws[piece * 2]), step(draws[piece * 2 + 1])];
  return [step(rand(port, frame, piece, 1)), step(rand(port, frame, piece, 2))];
}

// ---------------------------------------------------------------- a KO's scatter

/** ifStatus_PercentOnDeathAnimationThink: at a KO each piece of the percent
 *  is given a speed - sideways 0.3041 to 0.912, left and right in turn, and
 *  up 1.2165 to 2.0275 - and from the next frame flies with it, falling by
 *  0.2028 a frame, until it is well off the screen (100 either way across,
 *  100 down). Returns each piece's offset from where it was, `frames` after
 *  the KO. */
export function scatter(frames: number, piece: number, port: number, ko: number,
                        draws: number[] | null = null): [number, number] {
  const sign = piece % 2 === 0 ? 1 : -1;
  // (the game's own draws when known - HSD_Randf, x then y for each piece in turn; else a stand-in of our own)
  const vx = sign * (0.6083 * (draws ? draws[piece * 2] : rand(port, ko, piece, 3)) + 0.3041);
  let vy = 0.811 * (draws ? draws[piece * 2 + 1] : rand(port, ko, piece, 4)) + 1.2165;
  let x = 0, y = 0;
  for (let k = 0; k < frames && k < 400; k++) {
    if (Math.abs(x) < 100) x += vx;
    if (y > -100) { y += vy; vy -= 0.2028; } else break;
  }
  return [x, y];
}

// ---------------------------------------------------------------- the timer

export interface TimerDigits { minutes: number; seconds: number; centis: number }

/** The match timer (iftime.c) as the game shows it: minutes and seconds
 *  left, and hundredths, which count 99 down to 0 over a second's 60 frames
 *  (99 - 99 x frame / 59, cut). It shows the count as the frame before left
 *  it (the HUD is posed before the match's clock ticks): the full time
 *  through the intro and at frame 0, then one second less (the reference:
 *  08:00 00 through the intro, 07:59 99 at frame 1, 07:59 00 at 60, 07:58 99
 *  at 61, 07:48 06 at 717). Null without a timer. */
export function timerAt(gameFrame: number, timerType: string, limitSeconds: number): TimerDigits | null {
  if (timerType === "no timer") return null;
  const up = timerType === "counting up";
  const e = gameFrame - 1;
  let secs: number, centis: number;
  if (e < 0) {
    secs = up ? 0 : limitSeconds;
    centis = 0;
  } else {
    const u = e % 60;
    if (up) {
      secs = Math.floor(e / 60);
      centis = Math.trunc((99 * u) / 59);
    } else {
      secs = limitSeconds - 1 - Math.floor(e / 60);
      centis = 99 - Math.trunc((99 * u) / 59);
      if (secs < 0) { secs = 0; centis = 0; }
    }
  }
  return { minutes: Math.floor(secs / 60), seconds: secs % 60, centis };
}

// ---------------------------------------------------------------- icons

/** gm_80168B34: the frame of the character's icon in the HUD's icon strips
 *  (stock icons: + 30 a costume). External character ids; Zelda and Sheik
 *  share one pair of slots and show whichever the fighter is now (internal 7
 *  is Sheik), after the ids Sheik's slot leaves out. */
export function iconFrame(external: number, internalNow: number, costume: number): number {
  let base: number;
  if (external === 18 || external === 19) base = internalNow === 7 ? 25 : 18;
  else if (external > 19) base = external - 1;
  else base = external;
  return base + costume * 30;
}

/** ifStatus_802F61FC: the mark behind the percent, the character's series,
 *  by the same table (Zelda's for Sheik too: it asks without the form) */
export function markFrame(external: number): number {
  return 0.5 + iconFrame(external === 19 ? 18 : external, -1, 0);
}

// ---------------------------------------------------------------- one player's display over a replay

// action states (the common ones every fighter shares)
const DEAD_LAST = 10, REBIRTH = 12, REBIRTH_WAIT = 13, WAIT = 14;
const DEAD_UP_STAR = 4, DEAD_UP_STAR_ICE = 5, DEAD_UP_FALL = 6, DEAD_UP_FALL_ICE = 9;
const CLIFF_CATCH = 252, DAMAGE_FLY_FIRST = 87, DAMAGE_FLY_LAST = 91;
/** states entered without clearing the name tag's count (Ft_MF_SkipNametagVis) */
const KEEPS_TAG = new Set([REBIRTH_WAIT, 253, 183, 184, 185, 191, 192, 193, 247, 248]);
/** states whose start sets the count to 1 (ThrownKirbyStar, ThrownCopyStar, YoshiEgg, KirbyYoshiEgg, BarrelWait,
 *  Barrel) */
const TAG_AT_ONCE = new Set([290, 291, 277, 332, 293, 340]);
/** ftCommonData +0x5F0, +0x5EC and +0x5E8: standing still (or on the
 *  ledge) this many frames brings the tag up; so does a launch (a DamageFly
 *  state) at a knockback speed of at least 3, this many frames after it
 *  (ftCo_Damage). The game's own values; the viewer reads them from PlCo.dat
 *  when it can. */
export const TAG_IDLE = 50, TAG_LAUNCH = 4, TAG_LAUNCH_SPEED = 3;

const dead = (s: number) => s <= DEAD_LAST;

export interface Life {
  /** the display was made (the match's start, a respawn): its entry animation's frame 0 */
  from: number;
  /** it went off (the percent scattered, a stock icon fell), or null */
  ko: number | null;
}

export interface PercentView {
  /** the percent shown, and its color */
  percent: number;
  color: [number, number, number];
  /** which of the model's animations the digits play (0 made, 1 fell) and its frame */
  anim: 0 | 1;
  animFrame: number;
  layout: DigitLayout;
  /** per piece: added to its place (x, y) - a hit's shake, a KO's scatter */
  offset: [number, number][];
  /** the narrow-1 spacing is off while shaking (the game sets the pieces
   *  from their stored places then) */
  spaced: boolean;
  /** frames since the KO, when the percent is scattering */
  scatter: number | null;
}

export interface StockView {
  /** each of the five icons: its animation frame (0 there, 1-10 falling) or -1 hidden */
  icons: number[];
  /** how many stocks, when more than five (the game then shows one icon and a count) */
  count: number;
  iconFrame: number;
}

export class PlayerHud {
  readonly pct: Int16Array;
  readonly lives: Life[] = [];
  private hitAt: Int32Array; // per frame: the last hit at or before it within its life (-1: none)
  private hitDmg: Uint8Array;
  private dropAt: Int32Array;
  /** per frame: the stocks the game counts (a KO counts a frame early) */
  readonly stocks: Int8Array;
  /** per icon slot: the frames it was lost (sorted) */
  private losses: number[][] = [[], [], [], [], []];
  readonly tag: Uint8Array;
  readonly n: number;

  constructor(data: ReplayData, readonly port: number,
              tags: { idle: number; launch: number; launchSpeed: number } = { idle: TAG_IDLE, launch: TAG_LAUNCH, launchSpeed: TAG_LAUNCH_SPEED },
              goFrame = GO_FRAME, nametag = false) {
    const tagIdle = tags.idle;
    const frames = data.frames;
    const n = (this.n = frames.length);
    const st = (i: number): PlayerState | undefined => frames[i]?.players[port]?.state;
    this.pct = new Int16Array(n).fill(-1);
    this.stocks = new Int8Array(n);
    this.tag = new Uint8Array(n);
    this.hitAt = new Int32Array(n).fill(-1);
    this.hitDmg = new Uint8Array(n);
    this.dropAt = new Int32Array(n).fill(-1);
    const start = data.settings.playerSettings[port]?.startStocks ?? 4;
    // the display's lives: made at the start, off at each KO, made again at each respawn
    let life: Life = { from: 0, ko: null };
    this.lives.push(life);
    // The KO is when the game counts it (Player_UpdateKOsBySlot): the frame
    // the replay's stock count drops - through a blast line that is the first
    // dead frame, a star KO only once it has flown into the background (the
    // stock icon's hop and the percent's scatter start there in the reference
    // frames). With no stocks to lose (a timed match), the first dead frame.
    let prevState = -1, prevStocks = -1, deadAt = -1;
    for (let i = 0; i < n; i++) {
      const s = st(i);
      const now = s?.actionStateId ?? prevState;
      const stocks = s?.stocksRemaining ?? prevStocks;
      if (dead(now) && !dead(prevState) && i > 0) deadAt = i;
      // (a star or screen KO is counted in a later part of the game's frame
      // than a blast line's: after Slippi takes the frame, so a frame before
      // the replay's stock drops - the reference frames)
      if (life.ko === null && i > 0 && prevStocks >= 0 && stocks < prevStocks) {
        life.ko = prevState >= DEAD_UP_STAR && prevState <= DEAD_LAST ? i - 1 : i;
      }
      if (now === REBIRTH && prevState !== REBIRTH && i > 0) {
        if (life.ko === null && deadAt > life.from) life.ko = deadAt;
        if (life.ko !== null) {
          life = { from: i, ko: null };
          this.lives.push(life);
        }
      }
      prevState = now;
      prevStocks = stocks;
    }
    // the percent, and the hits and falls within each life, by the damage the
    // game holds when the HUD's procs run (game())
    for (let i = 0; i < n; i++) {
      const s = st(i);
      this.pct[i] = s ? Math.max(0, Math.min(999, Math.trunc(s.percent))) : (i > 0 ? this.pct[i - 1] : 0);
    }
    let lastHit = -1, lastDrop = -1, dmg = 0;
    for (let i = 0; i < n; i++) {
      const l = this.lifeAt(i);
      const alive = l.ko === null || i < l.ko;
      if (i === l.from) { lastHit = -1; lastDrop = -1; }
      else if (alive && i > 0) {
        const d = this.game(i) - this.game(i - 1);
        if (d > 0) { lastHit = i; dmg = d; }
        else if (d < 0) lastDrop = i;
      }
      this.hitAt[i] = lastHit;
      this.hitDmg[i] = dmg & 0xff;
      this.dropAt[i] = lastDrop;
    }
    // the stocks, and when each icon went
    const raw = (i: number) => st(i)?.stocksRemaining ?? (i > 0 ? this.stocks[i - 1] : start);
    for (let i = 0; i < n; i++) {
      this.stocks[i] = raw(i);
      // (a star or screen KO's stock goes a frame early, as its KO does)
      const s = st(i)?.actionStateId ?? -1;
      if (i + 1 < n && s >= DEAD_UP_STAR && s <= DEAD_LAST && raw(i + 1) < this.stocks[i]) this.stocks[i] = raw(i + 1);
      if (i > 0 && this.stocks[i] < this.stocks[i - 1]) {
        for (let k = this.stocks[i]; k < this.stocks[i - 1] && k < 5; k++) this.losses[k].push(i);
      }
    }
    // the player tag over the fighter (ifnametag.c): shown while the count is 1.
    // Fighter_procAnim steps it down only out of hitlag (x2219_b5): not on the
    // frames after a hit's while its hitlag lasts (hitlag left at the frame
    // and at the frame before; Fighter_procHitlag, before it, lets go on the
    // frame the count runs out)
    const frozen = (i: number) => (st(i)?.hitlagRemaining ?? 0) > 0 && i > 0 && (st(i - 1)?.hitlagRemaining ?? 0) > 0;
    let count = 0;
    prevState = -1;
    for (let i = 0; i < n; i++) {
      const s = st(i)?.actionStateId ?? prevState;
      if (s !== prevState) {
        const kb = Math.hypot(st(i)?.attackBasedXSpeed ?? 0, st(i)?.attackBasedYSpeed ?? 0);
        if (s === WAIT || s === CLIFF_CATCH) count = tagIdle;
        // (the launch's count from the frame the hit landed, the frame the
        // replay shows it: see game())
        else if (s >= DAMAGE_FLY_FIRST && s <= DAMAGE_FLY_LAST && kb >= tags.launchSpeed) count = tags.launch;
        else if (s === REBIRTH || s === DEAD_UP_STAR || s === DEAD_UP_STAR_ICE || s === DEAD_UP_FALL || s === DEAD_UP_FALL_ICE) count = 1;
        // (Kirby's stars, Yoshi's eggs and the barrel set it to 1 as they start: ftCo_ThrownKirby.c inlineB2,
        // ftCo_YoshiEgg.c, ftkirbyyoshiegg.c, ftCo_Barrel_Enter, ftCo_BarrelWait.c)
        else if (TAG_AT_ONCE.has(s)) count = 1;
        else if (!KEEPS_TAG.has(s)) count = 0;
      } else if (count > 1 && i + FIRST_FRAME >= goFrame && !frozen(i)) count--; // (not while the intro holds the players still)
      const gameFrame = i + FIRST_FRAME;
      // (a player with a nametag has it over the fighter the whole game: fn_802FCC44)
      this.tag[i] = (count === 1 || gameFrame < goFrame || nametag) && this.stocks[i] > 0 ? 1 : 0;
      prevState = s;
    }
  }

  /** the life the display is in at a frame */
  lifeAt(i: number): Life {
    let out = this.lives[0];
    for (const l of this.lives) if (l.from <= i) out = l;
    return out;
  }

  /** the damage the game holds at a frame when the HUD's procs (17) run: the frame's hits are taken in
   *  Fighter_procCollResolve (14) before them, and Slippi takes the frame's state after both - the replay's percent
   *  of the frame itself (the game's captures: the percent's color, digits and shake come with the frame whose
   *  replay percent has the hit, at every hit in their windows) */
  private game(i: number): number {
    return this.pct[Math.max(0, Math.min(i, this.n - 1))] ?? 0;
  }

  /** The percent at a frame (percentAt below). Its color, the narrow-1 spacing, which digits show and the shake
   *  follow the game's damage at once; the digits' pictures are the damage of the frame before (ifStatus_802F4EDC
   *  asks for them after the frame's animation has run, and the pictures change a frame after that). */
  /** whether the digits shake at frame i (and so draw eight random numbers there: ifStatus_802F4B84) */
  shakingAt(i: number): boolean {
    const l = this.lifeAt(i);
    // (a percent going off takes no shake's draws: the HUD's proc runs ifStatus_PercentOnDeathAnimationThink and
    // returns before ifStatus_802F4B84)
    if (l.ko !== null && i >= l.ko) return false;
    const at = i;
    const hit = this.hitAt[at];
    return hit >= 0 && at - hit >= 0 && at - hit <= SHAKE_FRAMES - 2;
  }

  /** the game's own random numbers for the shake at a frame (eight: x and y of each piece), or null */
  shakeDraws: ((i: number) => number[] | null) | null = null;
  /** and for the KO's scatter, drawn on the KO's frame */
  scatterDraws: ((i: number) => number[] | null) | null = null;

  /** whether the percent's scatter starts at frame i (its eight draws: ifStatus_PercentOnDeathAnimationThink) */
  scatterStartsAt(i: number): boolean {
    return this.lifeAt(i).ko === i;
  }

  percentAt(i: number): PercentView {
    const l = this.lifeAt(i);
    const exploding = l.ko !== null && i >= l.ko;
    // (scattering, it shows what it showed just before)
    const at = exploding ? Math.max(l.from, l.ko! - 1) : i;
    const percent = this.pct[at] ?? 0;
    const now = this.game(at);
    const drop = this.dropAt[at];
    const anim: 0 | 1 = drop > l.from ? 1 : 0;
    const animFrame = anim === 1 ? at - drop : at - l.from;
    // (the digits' pictures are the number of the frame before: the game's captures show a new number's digits a frame
    // after the replay's percent has it - the request the HUD makes for them after the frame's animation has run is
    // taken up by the next frame's)
    const layout = { ...digitLayout(now), frame: digitLayout(this.pct[Math.max(l.from, at - 1)] ?? 0).frame };
    const offset: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const hit = this.hitAt[at];
    let spaced = true;
    if (hit >= 0 && at - hit <= SHAKE_FRAMES - 1) {
      spaced = false;
      const draws = this.shakeDraws?.(at) ?? null;
      for (let p = 0; p < 4; p++) offset[p] = shakeOffset(at, hit, this.hitDmg[at], p, this.port, draws) ?? [0, 0];
    }
    if (exploding) {
      const sd = this.scatterDraws?.(l.ko!) ?? null;
      for (let p = 0; p < 4; p++) {
        const [sx, sy] = scatter(i - l.ko!, p, this.port, l.ko!, sd);
        offset[p] = [offset[p][0] + sx, offset[p][1] + sy];
      }
    }
    return { percent, color: percentColor(now), anim, animFrame, layout, offset, spaced,
             scatter: exploding ? i - l.ko! : null };
  }

  /** the stock icons lost from `from` to `to` (frames): which icon, when */
  lossesBetween(from: number, to: number): { icon: number; frame: number }[] {
    const out: { icon: number; frame: number }[] = [];
    this.losses.forEach((list, icon) => { for (const f of list) if (f >= from && f <= to) out.push({ icon, frame: f }); });
    return out;
  }

  stocksAt(i: number, external: number, internalNow: number, costume: number): StockView {
    const have = this.stocks[i];
    const icons: number[] = [];
    const l = this.lifeAt(i);
    for (let k = 0; k < 5; k++) {
      if (k < have) { icons.push(0); continue; }
      // a lost one falls, and is gone when the display is made again
      let lost = -1;
      for (const f of this.losses[k]) if (f <= i) lost = f;
      icons.push(lost >= 0 && lost >= l.from ? Math.min(10, 1 + (i - lost)) : -1);
    }
    return { icons, count: have, iconFrame: iconFrame(external, internalNow, costume) };
  }
}

// ---------------------------------------------------------------- the magnifier and the tags

/** the frame the bubbles sit on: 67.3 pixels in from the screen's sides and
 *  77.3 from its top and bottom (ifMagnify_802FB73C's 252.7 and 162.7 from
 *  the middle of 640 x 480). The game measures it from the screen's edges, so
 *  a picture wider than the game's keeps the side margins: edgeWidth(k) for
 *  a picture k times the game's width. */
export const EDGE_W = 252.70001, EDGE_H = 162.7;
export function edgeWidth(k: number): number {
  return EDGE_W + 320 * (k - 1);
}

/** ifMagnify_802FB73C: where a direction from the screen's middle meets the
 *  frame the bubbles sit on (252.7 x 162.7 pixels from the middle) */
export function edgePoint(x: number, y: number, W = EDGE_W): [number, number] {
  const H = EDGE_H;
  if (x === 0) return [0, y > 0 ? H : -H];
  const k = y / x, c = H / W;
  if (k > c || k < -c) {
    const oy = y > 0 ? H : -H;
    return [Math.max(-W, Math.min(W, (oy * x) / y)), oy];
  }
  const ox = x > 0 ? W : -W;
  return [ox, Math.max(-H, Math.min(H, (ox * y) / x))];
}

/** ifnametag.c: the tag's frame in its strip - its port's color, by team in
 *  teams, a CPU's gray */
export function tagFrame(slot: number, human: boolean, teams: boolean, team: number): number {
  const table = [[0, 1, 3, 0, 16], [4, 5, 7, 5, 17], [8, 9, 11, 10, 18], [12, 13, 15, 15, 19], [16, 17, 19, 18, 18]];
  const row = table[Math.min(4, Math.max(0, slot))];
  if (teams) return human ? row[Math.min(4, team)] : table[4][Math.min(4, team)];
  return human ? row[3] : 18;
}

/** inlineA1 of ifnametag.c: with a nametag the tag is the plain arrow in
 *  its color (frames 20-23), a CPU's gray one (28), over the name */
export function nametagFrame(tag: number): number {
  return tag >= 16 ? 28 : (tag % 4) + 20;
}

/** the edge chevrons' blink (Stc_rarwmdls, 16 frames round): the game starts
 *  it with the HUD, a frame before the replay's first frame, and steps it
 *  every frame after (fn_802FDA78) - the phase of the game's captures, all
 *  sixteen phases over 322 windows */
export function chevronFrame(f: number): number {
  return (f + 1) % 16;
}


// ---------------------------------------------------------------- the edge arrows' table

/** if_2FD9.c's table of the four edge arrows (un_804A1F10), one model each, all four drawn every frame: each
 *  arrow's kind (x28: 0 unused, 1 the left edge's, 2 the right's), the port it went to (x2C) and its color
 *  (x14, zero until it is first given), which of ports 0-3 hold one (x24), and where it was last put
 *  (fn_802FDA78 leaves an unused arrow where it was and sends it 10000 back) */
export interface ArrowTable {
  kind: number[]; port: number[]; color: [number, number, number][]; held: boolean[];
  x: number[]; y: number[]; rot: number[];
}
export function arrowTable(): ArrowTable {
  return { kind: [0, 0, 0, 0], port: [0, 0, 0, 0], color: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
           held: [false, false, false, false], x: [0, 0, 0, 0], y: [0, 0, 0, 0], rot: [0, 0, 0, 0] };
}
export function copyArrowTable(t: ArrowTable): ArrowTable {
  return { kind: [...t.kind], port: [...t.port], color: t.color.map((c) => [...c] as [number, number, number]),
           held: [...t.held], x: [...t.x], y: [...t.y], rot: [...t.rot] };
}

/** one port's magnifier draw (ifMagnify_802FB8C0): `kind` its arrow this frame (1 left, 2 right; 0 none).
 *  With one, un_802FD928: the first unused arrow, unless the port is a CPU's or already holds one (which
 *  keeps its kind until it is let go); without, un_802FD9D8: the port's arrows let go. */
export function arrowsAssign(t: ArrowTable, port: number, kind: number, cpu: boolean, color: [number, number, number]) {
  if (port >= 4) return;
  if (kind === 0) {
    for (let i = 0; i < 4; i++) if (t.port[i] === port) { t.held[port] = false; t.kind[i] = 0; }
    return;
  }
  for (let i = 0; i < 4; i++) {
    if (cpu || t.kind[i] !== 0 || t.held[port]) continue;
    t.held[port] = true;
    t.port[i] = port;
    t.kind[i] = kind;
    t.color[i] = [...color];
    return;
  }
}

/** fn_802FDA78, each arrow by the table as the frame before left it: a left one at x -25, a right one at 25
 *  turned half round, stacked 2.6 apart from the top of those of its kind (y 0, -1.3, -2.6 or -3.9 for one to
 *  four); returns the z each is drawn at (10000 for an unused one, which stays where it was) */
export function arrowsPlace(t: ArrowTable): number[] {
  const V = [0, -1.3, -2.6, -3.9].map(Math.fround);
  return t.kind.map((kind, i) => {
    if (kind === 0) return 10000;
    let j = 0, k = 0;
    for (let n = 0; n < 4; n++) if (t.kind[n] === kind) { if (n < i) j++; k++; }
    t.rot[i] = kind === 1 ? 0 : Math.fround(3.1415927);
    t.y[i] = Math.fround(Math.fround(Math.fround(2.6) * j) + V[k !== 0 ? k - 1 : 0]);
    t.x[i] = kind === 1 ? -25 : 25;
    return 0;
  });
}
