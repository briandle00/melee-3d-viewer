/* 3D replay viewer: Dream Land's Whispy Woods and its birds.
 *
 * Whispy (part 7, with its face's effects in part 1 and the flowers that
 * bend in its wind in part 6) idles and blinks for ten to twenty seconds,
 * then turns to face the fighters if it must, blows for about five, and
 * idles again (grOldPupupu_802113E0: three phases in turn; each animation
 * is started on the whole part, and its end moves the phase on). With a
 * viewer track the game's own starts are known ("ganim", gr/anims.ts) and
 * this is not used; without one the same rules run here, with a seeded
 * stand-in for the game's random durations and the side taken from where
 * the fighters are.
 *
 * The birds (part 2: ten kinds, one joint each) fly across the back every
 * 50 to 67 seconds, one at a time or, for some kinds, three in a line
 * (grOldPupupu_80210D10). The viewer track has each flight ("bird");
 * without one they come from a seeded stand-in for the game's random
 * numbers - the game's kinds, timing, heights and paths, but not its birds.
 */
import type { ReplayData } from "~/common/types";
import { Rng } from "../fx/particles";
import type { Part, Run, Stage, StageFrame, StageLogic } from "../stage";
import type { ViewerTrack } from "../track";

/** a set started on a part: from which frame (the replay's index) its time is 0 */
interface Start { from: number; anim: number }

// Whispy's sets by facing (0 left, 1 right): idle, turn, blow; its face's; the flowers'
const IDLE = [4, 0], TURN = [2, 3], BLOW = [5, 1], FLOWERS = [1, 0];

/** randrange as the stage codes it: between the two, whichever is larger */
const between = (rng: Rng, a: number, b: number) =>
  a > b ? b + Math.floor(rng.next() * (a - b)) : a < b ? a + Math.floor(rng.next() * (b - a)) : a;

export class Whispy implements StageLogic {
  private starts = new Map<number, Start[]>([[7, []], [1, []], [6, []]]);

  constructor(st: Stage, data: ReplayData) {
    const y = st.file.publics.get("yakumono_param"), d = st.file.data;
    const i32 = (o: number, v: number) => (y === undefined ? v : d.getInt32(y + o));
    const f32 = (o: number, v: number) => (y === undefined ? v : d.getFloat32(y + o));
    const [idleLo, idleHi] = [i32(0x08, 600), i32(0x0c, 1200)], [blinkLo, blinkHi] = [f32(0x2c, 180), f32(0x30, 360)];
    const endOf = (anim: number) => {
      const p = st.partOf(7);
      const set = p ? st.animSet(p, anim) : null;
      return set?.find((a) => a)?.end ?? 35;
    };
    const rng = new Rng(0xd1ea);
    // (one started as the stage is built has been played once more by the
    // first frame than one started during the match: gr/anims.ts)
    const start = (part: number, anim: number, g: number) => this.starts.get(part)!.push({ from: g === -123 ? -1 : g + 123, anim });
    // the stage built: idle, facing right; the face on its first set
    this.starts.get(7)!.push({ from: -1, anim: 0 });
    this.starts.get(1)!.push({ from: -1, anim: 0 });
    let xC4 = 0, phase = 0, count = between(rng, idleHi, idleLo), fresh = true, facing = 1, blink = 0;
    let cur = { from: -124, end: endOf(0) };
    const set7 = (anim: number, g: number) => { start(7, anim, g); cur = { from: g, end: endOf(anim) }; };
    const done = (g: number) => g - cur.from >= cur.end;
    // the face follows (its proc, after this one: the same frame)
    let faceDue = false;
    const sync = () => { faceDue = true; };
    const advance = () => { xC4 = (xC4 + 1) % 3; phase = xC4; fresh = true; };
    const last = data.frames.length - 123;
    for (let g = -123; g < last; g++) {
      faceDue = false;
      if (phase === 0) {
        if (fresh) {
          fresh = false;
          count = between(rng, idleHi, idleLo);
          set7(IDLE[facing], g);
          sync();
          blink = between(rng, blinkHi, blinkLo);
        }
        count--;
        if (done(g)) {
          if (count > 0) {
            if (--blink <= 0) { set7(IDLE[facing], g); blink = between(rng, blinkHi, blinkLo); }
            sync();
          } else { advance(); sync(); }
        }
      } else if (phase === 1) {
        if (fresh) {
          const side = this.side(data, g);
          if (side === facing) {
            set7(BLOW[facing], g);
            advance();
            sync();
          } else {
            facing = side;
            fresh = false;
            set7(TURN[facing], g);
            sync();
          }
        } else if (done(g)) { advance(); sync(); }
      } else {
        if (fresh) {
          fresh = false;
          set7(BLOW[facing], g);
          // (the flowers bend the way it blows, as it starts)
          start(6, FLOWERS[facing], g);
          sync();
        }
        if (done(g)) { advance(); sync(); }
      }
      if (faceDue) start(1, phase === 0 ? IDLE[facing] : phase === 1 ? TURN[facing] : BLOW[facing], g);
    }
  }

  /** which way the fighters are from the tree: 1 right, 0 left (the nearest one) */
  private side(data: ReplayData, g: number): number {
    let best = Infinity, x = 1;
    for (const p of data.frames[g + 123]?.players ?? []) {
      if (!p || p.state.isDead) continue;
      const dx = p.state.xPosition;
      if (Math.abs(dx) < best) { best = Math.abs(dx); x = dx; }
    }
    return x >= 0 ? 1 : 0;
  }

  apply(st: Stage, frame: number) {
    for (const [part, list] of this.starts) {
      let s: Start | null = null;
      for (const x of list) { if (x.from > frame) break; s = x; }
      if (s) st.runs.set(part, [{ anim: s.anim, joint: 0, deep: true, from: s.from, rate: 1 }]);
    }
  }
}

/** a flight of birds: the kind (its joint), where the first starts, how many, from when */
interface Flight { joint: number; x: number; step: number; y: number; z: number; count: number; from: number }

// the birds' kinds: which side they come from, whether they may come in threes, their joint (grOp_803E67B0)
const KINDS: [number, boolean, number][] = [[-1, true, 1], [1, true, 3], [1, true, 5], [-1, true, 7], [-1, false, 9],
  [1, false, 11], [-1, false, 13], [1, false, 15], [-1, false, 17], [1, false, 19]];
/** birds on screen at once: two flights of three */
const POOL = 6;

export class Birds implements StageLogic {
  private flights: Flight[] = [];
  private pool: Part[] = [];
  private end = 3999;
  private placed = new Map<Part, { f: Flight; i: number }>();

  constructor(st: Stage, data: ReplayData, tr: ViewerTrack | null = null) {
    const y = st.file.publics.get("yakumono_param"), d = st.file.data;
    const lo = y === undefined ? 3000 : d.getInt16(y), hi = y === undefined ? 4000 : d.getInt16(y + 2);
    // the viewer track's birds ("bird": the kind's row, how many, where the first starts)
    const fromTrack = tr?.has("bird") ?? false;
    for (const [f, kind, count, bx, by, bz] of fromTrack ? tr!.between("bird", -1000, 1e9) .map((e) => [e[0], ...e.slice(2)]) : []) {
      const k = KINDS[Number(kind)];
      if (!k) continue;
      this.flights.push({ joint: k[2], x: Number(bx), step: (st.scale || 1) * (k[0] === 1 ? -10 : 10), y: Number(by), z: Number(bz),
                          count: Number(count), from: Number(f) + 123 });
    }
    const spread = y === undefined ? 30 : d.getInt16(y + 4);
    const p2 = st.partOf(2) ?? null;
    this.end = (p2 && st.animSet(p2, 0)?.find((a) => a)?.end) || 3999;
    const s = st.scale || 1;
    const rng = new Rng(0xb1d5);
    const last = data.frames.length;
    // (the first comes as the spawner's timer, set as the stage is built, runs out)
    let at = fromTrack ? last : between(rng, hi, lo);
    while (at < last) {
      const [side, flock, joint] = KINDS[Math.floor(rng.next() * 10)];
      const count = flock && rng.next() < 0.2 ? 3 : 1;
      // from beyond the camera's reach on its side (the camera's edge, no nearer than 200)
      const step = side === 1 ? -10 : 10;
      const x = side === 1 ? 50 + 200 + count * 10 : -200 - 50 - count * 10;
      const yy = s * (spread * (2 * rng.next() - 1) + 20);
      this.flights.push({ joint, x: s * x, step: s * step, y: yy, z: -150 * s, count, from: at + 1 });
      at += 1 + between(rng, hi, lo);
    }
    // the copies they are drawn with (made once per stage)
    this.pool = pools.get(st) ?? [];
    if (!pools.has(st)) {
      for (let i = 0; i < POOL; i++) {
        const e = st.copyOf(2, `stage${st.stageId}:bird${i}`);
        if (e) { this.pool.push(e); st.extras.push(e); }
      }
      pools.set(st, this.pool);
    }
  }

  apply(st: Stage, frame: number) {
    this.placed.clear();
    let k = 0;
    for (const f of this.flights) {
      if (f.from > frame) break;
      for (let i = 0; i < f.count; i++) {
        // each bird of a flight is 40 frames further along its path than the one before. Made by part 8's
        // proc (grOldPupupu_80210D10, on link 4), a bird's own animation proc (Ground_801C1CD0, link 1) has
        // run for the frame already: it stands as the file has it on the frame it is made, and plays its
        // animation from the next (grAnime_801C7FF8 only requests it)
        const from = f.from + 1 - 40 * i;
        if (frame - from >= this.end || k >= this.pool.length) continue;
        const e = this.pool[k++];
        const run: Run = { anim: 0, joint: 0, deep: true, from, rate: 1 };
        st.extraRuns.set(e, frame === f.from ? [] : [run]);
        this.placed.set(e, { f, i });
      }
    }
  }

  pose(_st: Stage, _frame: number, _sf: StageFrame | undefined) {
    for (const [e, { f, i }] of this.placed) {
      const sk = e.skeleton;
      // only its kind's joint shows
      for (let j = 1; j < sk.n; j++) sk.shown[j] = j === f.joint || sk.parent[j] === f.joint ? 1 : 0;
      e.place[12] = f.x + f.step * i; e.place[13] = f.y; e.place[14] = f.z;
    }
  }
}

const pools = new WeakMap<Stage, Part[]>();
