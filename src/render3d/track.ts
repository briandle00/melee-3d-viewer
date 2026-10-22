/* 3D replay viewer: the viewer track.
 *
 * A replay says where each fighter is and what it is doing, not everything
 * the game drew with it: a charge stored before the replay starts, Game &
 * Watch's bucket, the color animation a thrown item's hit started, which
 * background Battlefield changes to and when. The simulator plays a replay
 * exactly, random draws included; run through it once, it writes what the
 * player needs as a short list of events (melee-sim-light's viewer-track
 * export: README.md). The page hands the track over with the replay
 * (files.ts, setTrackUrl). The player uses the track
 * for what it has and works the rest out from the replay as before, type by
 * type: a track without "bg" events leaves Battlefield's background to the
 * replay, and so on.
 *
 * An event is [frame, type, ...values], the frame as the game numbers it
 * (-123 first), sent only when something changes. The ones read here:
 *   ["tint", f, port, sub, slot, index, rgba, flags, light_rgba, rot_x, rot_yz]
 *       a fighter's color animation as the game draws it (slot 0 the main
 *       one, 1 the second, 2 the third); index 0 when the slot ends
 *   ["charge", f, port, sub, field, value]     a stored charge ("dk", "ss",
 *       "mt", "sk", "gw", "kb.*" for Kirby's copies)
 *   ["bg", f, state, curr, prev]               Battlefield's background
 *   ["fd", f, phase, r, g, b, frames]          Final Destination's
 *   ["hook", f, port, sub, tip_x, tip_y, x1, y1, ...]   a hookshot's (or a
 *       grapple beam's) tip and links, every frame it is out
 *   ["irot", f, spawn_id, rx, ry, rz]           a thrown item's turn
 *   ["ij", f, spawn_id, joint, ox, oy, oz, m00, m01, m02, m10, ..., m22]
 *       an item's joint something is made on (a "gen" or an "fxp" names it:
 *       its preorder index in the item's tree): its place from the item's own
 *       and its matrix's turn and size at the frame's end, as it changes
 *   ["anim", f, port, sub, index, kind, frame, rate, blend, blend_at]
 *       a fighter's animation as the game plays it: its index in the
 *       subaction table of the fighter `kind` (its own, or a thrower's), the
 *       frame, the rate, and the blend into it (frames, and how far in)
 *   ["jp", f, spawn_id, (joint, mask, values)...]
 *       an item's joints below its root as the game posed them, each only
 *       as it changes (mask bit k: value k follows, of rot x, y, z, scale x,
 *       y, z, translate x, y, z); a joint not yet sent is at its file's rest
 *   ["fp", f, port, sub, character, (part, mask, values)...]
 *       a fighter's swinging joints the simulator runs (its tail...), the
 *       same nine values, by part
 *   ["lm", f, spawn_id, links, (link, out, mask, values)...]
 *       a chain's links as the item's code turned them: each link's matrix
 *       (rows 0-2 of the 3x4), link 0 the chain's end, out whether it is drawn
 *   ["sp", f, part, (joint, mask, values)...]
 *       a stage part's joints as its animations and code left them, the nine
 *       values of "jp": the part by its number as "gjoint" has it (an extra
 *       copy's plus 1000 for each made before it), the joint by its preorder
 *       index counting the joint the game puts above the file's root as 0 (the
 *       file's root, a part's joint 0 here, is its 1); a joint not yet sent is
 *       at its file's rest
 *   ["fj", f, port, sub, character, (part, mask, values)...]
 *       a fighter's joints as the game left them (its animation, the blend into
 *       it and what its code set after), the nine values, by part: every part
 *       with a live joint but 0; the first line has every value
 * and the ones for later (effects, part switches, stage animations): kept,
 * asked for by type.
 *
 * A float may come as the exact bits of its IEEE single, a string "0x" and
 * eight hex digits (a newer simulator writes every float so, so two hosts'
 * C libraries cannot round it apart): read back as the number it is, once,
 * where a track comes in (decodeTrackFloats).
 *
 * A replay the simulator does not play exactly still has a track, good up to
 * the frame its game and the replay's part (diverged_at): everything asked of
 * it from there on is what a track without it says - nothing - so the player
 * works those frames out from the replay, as it does with no track at all.
 */
import type { Tint } from "./fx/colanim";
import { hasTrack, liveTrack, trackAnswer } from "./files";
import { decodeTrackFloats } from "./trackcodec";
import { pageCache, trim } from "../state/pageCache";

export type TrackEvent = [number, string, ...(number | string)[]];
export interface TrackData {
  version: number; sim_build?: number; seconds?: number; events: TrackEvent[];
  /** whether the simulator played the replay exactly, and if not the first
   *  game frame its game was not the replay's */
  exact?: boolean; diverged_at?: number | null;
  /** its floats are numbers already (decodeTrackFloats has been through its events) */
  decoded?: boolean;
}

/** one owner's pose lines ("jp", "fp", "lm"), each with the joints as of it (the streamed ones: PoseStream) */
interface PoseSnap { frame: number; joints: Map<number, Float32Array>; out: Map<number, number> | null; links: number }

/** a pose as of a frame: by joint (an item's preorder joint, a fighter's part, a chain's link) its values -
 *  nine (rot, scale, translate; NaN for one not sent, which is the file's rest) or a link's twelve (its
 *  matrix's rows 0-2) - and for a chain whether each link is out and how many it has */
export interface TrackPose { joints: Map<number, Float32Array>; out: Map<number, number> | null; links: number }

/** how a pose line reads: values before its joints that name the owner, values of a joint, whether a joint
 *  has "out" before its mask, and whether the owner's header has a link count */
const POSES: Record<string, { key: number; width: number; out: boolean; links: boolean }> = {
  jp: { key: 1, width: 9, out: false, links: false },
  fp: { key: 3, width: 9, out: false, links: false },
  lm: { key: 1, width: 12, out: true, links: true },
  sp: { key: 1, width: 9, out: false, links: false },
  fj: { key: 3, width: 9, out: false, links: false },
};

/** the pose types with a line on most frames (a fighter's every joint, an animated stage's): not kept as a
 *  snapshot a line, but as their lines with a snapshot every POSE_EVERY of them, played forward from the
 *  nearest to the frame asked for (PoseStream) */
const STREAMED = new Set(["sp", "fj"]);
const POSE_EVERY = 64;
/** no joint sent (poseSent on a frame the owner has no line) */
const NONE_SENT: ReadonlySet<number> = new Set();

/** one owner's lines of a streamed pose type, and where it was last asked for: asked for frame after frame,
 *  each step plays the lines since, into the one pose it hands out */
class PoseStream {
  readonly frames: number[] = [];
  readonly lines: TrackEvent[] = [];
  /** the joints as of line k * POSE_EVERY (made as they are first passed) */
  private marks: Map<number, Float32Array>[] = [];
  /** the pose handed out, as of line `at` (-1: none yet) */
  private at = -1;
  readonly pose: TrackPose = { joints: new Map(), out: null, links: 0 };

  constructor(private first: number, private width: number) {}

  /** the joints line i and the lines before it on the same frame have values for (one set, made again each ask) */
  private sentSet = new Set<number>();
  sentOn(i: number): ReadonlySet<number> {
    const out = this.sentSet;
    out.clear();
    for (let k = i; k >= 0 && this.frames[k] === this.frames[i]; k--) {
      const e = this.lines[k];
      let at = this.first;
      while (at < e.length) {
        out.add(Number(e[at]));
        let mask = Number(e[at + 1]);
        at += 2;
        while (mask) { at += mask & 1; mask >>>= 1; }
      }
    }
    return out;
  }

  /** the pose as of line i, played forward from where it is or from the mark before i */
  seek(i: number): TrackPose {
    const joints = this.pose.joints;
    const k = Math.min(Math.floor(i / POSE_EVERY), this.marks.length - 1);
    if (i < this.at || (i - this.at > POSE_EVERY && k * POSE_EVERY > this.at)) {
      if (k >= 0) {
        // (to a mark: its joints, into the pose's own arrays)
        const mark = this.marks[k];
        for (const j of joints.keys()) if (!mark.has(j)) joints.delete(j);
        for (const [j, v] of mark) {
          const had = joints.get(j);
          if (had) had.set(v);
          else joints.set(j, Float32Array.from(v));
        }
        this.at = k * POSE_EVERY;
      } else {
        joints.clear();
        this.at = -1;
      }
    }
    while (this.at < i) {
      this.at++;
      this.play(this.lines[this.at]);
      if (this.at % POSE_EVERY === 0 && this.marks.length === this.at / POSE_EVERY) {
        const mark = new Map<number, Float32Array>();
        for (const [j, v] of joints) mark.set(j, Float32Array.from(v));
        this.marks.push(mark);
      }
    }
    return this.pose;
  }

  private play(e: TrackEvent) {
    const joints = this.pose.joints, w = this.width;
    let i = this.first;
    while (i < e.length) {
      const j = Number(e[i++]);
      const mask = Number(e[i++]);
      let v = joints.get(j);
      if (!v) joints.set(j, (v = new Float32Array(w).fill(NaN)));
      for (let k = 0; k < w; k++) if (mask & (1 << k)) v[k] = Number(e[i++]);
    }
  }
}

/** how many values after the type name an event's thing is (its key): the
 *  rest is its new state. Types not here are instants (an effect started). */
const KEYS: Record<string, number> = {
  tint: 3, charge: 3, part: 3, pos: 2, shake: 2, hide: 2, cns: 2,
  bg: 0, fd: 0, bgcolor: 0, cam: 0, ganim: 1, gcolor: 1, gjoint: 2,
  hook: 2, irot: 1, fdrot: 0, stadscreen: 0, anim: 2, rng: 0, fod: 0, ij: 2,
};

/** a fighter's animation as the game played it ("anim"), as of game frame `since` */
export interface TrackAnim {
  since: number; anim: number; kind: number; frame: number; rate: number; blendFrames: number; blendAt: number;
}

export class ViewerTrack {
  /** changes of state, by type and key, in frame order */
  private states = new Map<string, Map<string, TrackEvent[]>>();
  /** instants (effects started...), by type, in frame order */
  private instants = new Map<string, TrackEvent[]>();
  /** every instant, in the order the track has them (within a frame too) */
  private allInstants: TrackEvent[] = [];
  readonly seconds: number;
  /** the first game frame the track does not hold for (the simulator's game
   *  went another way there): Infinity when it holds for the whole replay */
  readonly until: number;

  constructor(data: TrackData) {
    // (a track handed over with its floats still as words: read them now)
    if (!data.decoded) { decodeTrackFloats(data.events); data.decoded = true; }
    this.seconds = data.seconds ?? 0;
    // (a track that says it is not exact without saying where holds for none of it)
    this.until = typeof data.diverged_at === "number" ? data.diverged_at : data.exact === false ? -Infinity : Infinity;
    // (only the events before it: the rest are of the simulator's other game)
    const events = data.events.filter((e) => Array.isArray(e) && typeof e[0] === "number" && typeof e[1] === "string" &&
                                              e[0] < this.until);
    // (a stable sort: two changes on one frame keep the order they were made in)
    events.sort((a, b) => a[0] - b[0]);
    for (const e of events) {
      const type = e[1], n = KEYS[type];
      if (n === undefined) {
        let list = this.instants.get(type);
        if (!list) this.instants.set(type, (list = []));
        list.push(e);
        this.allInstants.push(e);
        continue;
      }
      let byKey = this.states.get(type);
      if (!byKey) this.states.set(type, (byKey = new Map()));
      const key = e.slice(2, 2 + n).join(":");
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(e);
    }
  }

  /** whether the track says anything of this type (else the replay's way is used) */
  has(type: string): boolean {
    return this.states.has(type) || this.instants.has(type);
  }

  /** whether it holds on this game frame (before the simulator's game went another way) */
  valid(frame: number): boolean {
    return frame < this.until;
  }

  /** whether it parts from the replay somewhere */
  get diverges(): boolean {
    return this.until !== Infinity;
  }

  /** whether it says this type, and holds, on this game frame */
  hasAt(type: string, frame: number): boolean {
    return frame < this.until && this.has(type);
  }

  /** whether it has this type for this thing (key values joined by ":") */
  hasKey(type: string, key: string): boolean {
    return this.states.get(type)?.has(key) ?? false;
  }

  /** the keys it has of a type */
  keys(type: string): string[] {
    return [...(this.states.get(type)?.keys() ?? [])];
  }

  /** the last change of this thing at or before game frame `frame`: its values after the key, or null */
  at(type: string, key: string, frame: number): (number | string)[] | null {
    const list = this.states.get(type)?.get(key);
    if (!list || !list.length || list[0][0] > frame || frame >= this.until) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid][0] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return list[lo].slice(2 + KEYS[type]);
  }

  /** this thing's values when it has an event on exactly game frame `frame`
   *  (one sent every frame it lasts: a hookshot's links), else null */
  exact(type: string, key: string, frame: number): (number | string)[] | null {
    const list = this.states.get(type)?.get(key);
    if (!list || !list.length || frame >= this.until) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] < frame) lo = mid + 1;
      else hi = mid;
    }
    return list[lo][0] === frame ? list[lo].slice(2 + KEYS[type]) : null;
  }

  /** a fighter's animation as the game played it on game frame `frame`
   *  (its last change at or before it), or null */
  animAt(port: number, sub: number, frame: number): TrackAnim | null {
    const list = this.states.get("anim")?.get(`${port}:${sub}`);
    if (!list || !list.length || list[0][0] > frame || frame >= this.until) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid][0] <= frame) lo = mid;
      else hi = mid - 1;
    }
    const e = list[lo].map(Number);
    return { since: e[0], anim: e[4], kind: e[5], frame: e[6], rate: e[7], blendFrames: e[8], blendAt: e[9] };
  }

  /** how far off the stage's plane a fighter stands on game frame `frame`:
   *  the game moves fighters that overlap apart in depth (Nana behind Popo
   *  by 3.8), a little each frame while they overlap (ftCommon_8007DD7C's
   *  nudges, added in Fighter_procUpdate), and nothing brings it back: a few
   *  nudges can leave one a fraction of a unit off the plane for good.
   *  "pos" is sent while a fighter is off the plane, only as it changes, and
   *  once more the frame it is back on it (its depth 0): its last depth
   *  holds while it stands still out there (`x`, `y`: where the replay has
   *  it now), however near the plane. 0 without one */
  depthAt(port: number, sub: number, frame: number, x: number, y: number): number {
    const list = this.states.get("pos")?.get(`${port}:${sub}`);
    if (!list || !list.length || list[0][0] > frame || frame >= this.until) return 0;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid][0] <= frame) lo = mid;
      else hi = mid - 1;
    }
    const e = list[lo], z = Number(e[6]) || 0;
    if (e[0] === frame) return z;
    // (nothing sent since: it stands where it stood, out there - or it left
    // the depth at once, and has moved on since)
    const near = (p: number, q: number) => Math.abs(p - q) <= 1e-3 * Math.max(1, Math.abs(q));
    return near(Number(e[4]), x) && near(Number(e[5]), y) ? z : 0;
  }

  /** the game's random state after game frame `frame`'s gameplay ("rng", one
   *  every frame: what the particles' update draws from), or null where the
   *  track has none (one made before the simulator wrote them) */
  rngAt(frame: number): number | null {
    const v = this.exact("rng", "", frame);
    return v && typeof v[0] === "number" ? v[0] >>> 0 : null;
  }

  /** the frame of the last change of this thing at or before `frame`, or null */
  since(type: string, key: string, frame: number): number | null {
    if (frame >= this.until) return null;
    const list = this.states.get(type)?.get(key);
    let out: number | null = null;
    for (const e of list ?? []) {
      if (e[0] > frame) break;
      out = e[0];
    }
    return out;
  }

  /** every change of this thing, in order: [frame, ...values] */
  changes(type: string, key: string): [number, ...(number | string)[]][] {
    const n = KEYS[type] ?? 0;
    return (this.states.get(type)?.get(key) ?? []).map((e) => [e[0], ...e.slice(2 + n)] as [number, ...(number | string)[]]);
  }

  /** the instants of any of these types in the game frames (from, to], in
   *  the order the game made them (an effect started, the fighter's effects
   *  ended, another started, all on one frame) */
  betweenOf(types: string[], from: number, to: number): TrackEvent[] {
    const list = this.allInstants;
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] <= from) lo = mid + 1;
      else hi = mid;
    }
    const out: TrackEvent[] = [];
    for (let i = lo; i < list.length && list[i][0] <= to; i++) if (types.includes(list[i][1])) out.push(list[i]);
    return out;
  }

  /** the instants of a type in the game frames (from, to] */
  between(type: string, from: number, to: number): TrackEvent[] {
    const list = this.instants.get(type);
    if (!list) return [];
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] <= from) lo = mid + 1;
      else hi = mid;
    }
    const out: TrackEvent[] = [];
    for (let i = lo; i < list.length && list[i][0] <= to; i++) out.push(list[i]);
    return out;
  }

  /** a fighter's color animation as the game drew it on this frame (the main one
   *  while it runs, else the second), or undefined when the track has none for it */
  tint(port: number, sub: number, frame: number, facing: number): Tint | null | undefined {
    const main = `${port}:${sub}:0`, second = `${port}:${sub}:1`;
    if ((!this.hasKey("tint", main) && !this.hasKey("tint", second)) || frame >= this.until) return undefined;
    let v = this.at("tint", main, frame);
    if (!v || !v[0]) v = this.at("tint", second, frame);
    if (!v || !v[0]) return null;
    return tintOf(v.slice(1) as number[], facing);
  }

  /** the poses of one type ("jp", "fp", "lm"), by owner, made the first time they are asked for */
  private poseSnaps = new Map<string, Map<string, PoseSnap[]>>();

  private posesOf(type: string): Map<string, PoseSnap[]> {
    let byKey = this.poseSnaps.get(type);
    if (byKey) return byKey;
    byKey = new Map();
    this.poseSnaps.set(type, byKey);
    const how = POSES[type];
    if (!how) return byKey;
    for (const e of this.instants.get(type) ?? []) {
      const key = e.slice(2, 2 + how.key).join(":");
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      const prev = list.length ? list[list.length - 1] : null;
      const joints = new Map(prev?.joints);
      const out = how.out ? new Map(prev?.out) : null;
      let i = 2 + how.key;
      const links = how.links ? Number(e[i++]) : 0;
      while (i < e.length) {
        const j = Number(e[i++]);
        if (out) out.set(j, Number(e[i++]));
        const mask = Number(e[i++]);
        const had = joints.get(j);
        const v = had ? Float32Array.from(had) : new Float32Array(how.width).fill(NaN);
        for (let k = 0; k < how.width; k++) if (mask & (1 << k)) v[k] = Number(e[i++]);
        joints.set(j, v);
      }
      // (two lines of one owner on a frame: the second holds both)
      if (prev && prev.frame === e[0]) list.pop();
      list.push({ frame: e[0], joints, out, links });
    }
    return byKey;
  }

  /** the streamed poses ("sp", "fj"), by type and owner, made the first time they are asked for */
  private poseStreams = new Map<string, Map<string, PoseStream>>();

  private streamsOf(type: string): Map<string, PoseStream> {
    let byKey = this.poseStreams.get(type);
    if (byKey) return byKey;
    byKey = new Map();
    this.poseStreams.set(type, byKey);
    const how = POSES[type];
    for (const e of this.instants.get(type) ?? []) {
      const key = e.slice(2, 2 + how.key).join(":");
      let s = byKey.get(key);
      if (!s) byKey.set(key, (s = new PoseStream(2 + how.key, how.width)));
      s.frames.push(e[0]);
      s.lines.push(e);
    }
    return byKey;
  }

  /** an owner's pose as of game frame `frame` (its last line at or before it), or null: "jp" and "lm" by
   *  item spawn id, "fp" and "fj" by `port:sub:character`, "sp" by stage part. A streamed type's ("sp",
   *  "fj") is the owner's one pose, played to the frame: good until the next ask for the same owner */
  pose(type: string, key: string, frame: number): TrackPose | null {
    if (frame >= this.until || !this.instants.has(type)) return null;
    if (STREAMED.has(type)) {
      const s = this.streamsOf(type).get(key);
      if (!s || !s.frames.length || s.frames[0] > frame) return null;
      let lo = 0, hi = s.frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s.frames[mid] <= frame) lo = mid;
        else hi = mid - 1;
      }
      return s.seek(lo);
    }
    const list = this.posesOf(type).get(key);
    if (!list || !list.length || list[0].frame > frame) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].frame <= frame) lo = mid;
      else hi = mid - 1;
    }
    return list[lo];
  }

  /** the joints a streamed pose type ("sp", "fj") has a line with values for on exactly game frame `frame`:
   *  empty when the owner has no line then, null when the track has no lines of the owner's at or before it.
   *  Good until the next ask */
  poseSent(type: string, key: string, frame: number): ReadonlySet<number> | null {
    if (frame >= this.until || !STREAMED.has(type)) return null;
    const s = this.streamsOf(type).get(key);
    if (!s || !s.frames.length || s.frames[0] > frame) return null;
    let lo = 0, hi = s.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.frames[mid] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return s.frames[lo] === frame ? s.sentOn(lo) : NONE_SENT;
  }

  /** a fighter's stored charge (the fighter's own field: "dk", "ss", ...), or undefined */
  charge(port: number, sub: number, field: string, frame: number): number | undefined {
    const v = this.at("charge", `${port}:${sub}:${field}`, frame);
    return v ? Number(v[0]) : undefined;
  }
}

const byte = (v: number) => (v & 0xff) / 255;

/** an overlay's drawn state (rgba, flags, light rgba, rot x, rot yz) as the renderer takes it:
 *  0x80 its color is on, 0x40 its light, 0x20 the light adds its color (ftmaterial.c) */
export function tintOf([rgba, flags, light, rotX, rotYZ]: number[], facing: number): Tint | null {
  const colorOn = (flags & 0x80) !== 0, lightOn = (flags & 0x40) !== 0;
  if (!colorOn && !lightOn) return null;
  const c = (w: number) => [byte(w >>> 24), byte(w >>> 16), byte(w >>> 8), byte(w)] as [number, number, number, number];
  let l: Tint["light"] = null;
  if (lightOn) {
    const lc = c(light >>> 0);
    const yz = ((rotYZ ?? 0) * Math.PI) / 180, x = (((rotX ?? 0) * Math.PI) / 180) * (facing < 0 ? -1 : 1);
    const z = Math.cos(yz);
    l = { rgb: [lc[0], lc[1], lc[2]], a: lc[3], adds: (flags & 0x20) !== 0, dir: [z * Math.sin(x), Math.sin(yz), z * Math.cos(x)] };
  }
  return { color: colorOn ? c(rgba >>> 0) : null, light: l };
}

/** the key a replay's viewer track is found by (the URL the replay was
 *  loaded from), when the page gave one for it (files.ts, setTrackUrl) */
export function replayPath(url: string): string | null {
  return hasTrack(url) ? url : null;
}

export type TrackAnswer = { state: "ready"; track: TrackData } | { state: "pending" } | { state: "none"; reason?: string };

/** the track for a replay: reads it, again every few seconds while a host says it is being made,
 *  until it is ready (then `got`) or cannot be had; `stop` ends the asking */
export function fetchTrack(path: string, got: (t: ViewerTrack) => void, why?: (reason: string) => void): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  // (one made on the page as the replay plays: each longer one as it comes, src/sim/feed.ts)
  const live = liveTrack(path);
  if (live) return live.subscribe((t) => { if (!stopped) got(t); }, (r) => { if (!stopped) why?.(r); });
  // (one read of a replay's track for every player on the page)
  const shared = pageCache<ViewerTrack>("tracks");
  const have = shared.get(path);
  if (have) { queueMicrotask(() => { if (!stopped) got(have); }); return () => { stopped = true; }; }
  const ask = async (wait: number) => {
    if (stopped) return;
    const a = (await trackAnswer(path)) as TrackAnswer | null;
    if (stopped) return;
    if (!a) { why?.("the track could not be read"); return; }
    if (a.state === "ready") {
      const t = shared.get(path) ?? new ViewerTrack(a.track);
      shared.set(path, t);
      trim(shared, 6);
      got(t);
    }
    // (asked again soon at first - a player waits for it before playing - then less often)
    else if (a.state === "pending") { why?.("being made"); timer = setTimeout(() => void ask(Math.min(wait * 1.5, 15000)), wait); }
    else why?.(a.reason ?? "");
  };
  void ask(500);
  return () => { stopped = true; clearTimeout(timer); };
}

