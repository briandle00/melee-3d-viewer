/* 3D replay viewer: the viewer track's compact form (VTB2, and VTB1, which it
 * still reads).
 *
 * The same events as the simulator's JSON, kept a column at a time: each
 * type's rows split into columns, a column of numbers kept as the steps from
 * one row to the next, the whole gzipped (a host may serve it in this form, and has
 * the layout). This reads it back into the events track.ts takes, in the
 * track's own order.
 *
 * A column's kind byte: 0 whole numbers (the steps, zigzag varints); 1
 * decimals (a byte k, then the steps of round(v * 10^k)); 2 strings (a table,
 * then each value's index); 3 anything else (as 2, each entry its JSON); 4
 * exact floats (each value's IEEE single as its 32-bit word, the steps from
 * one word to the next as zigzag varints: what a track that writes its
 * floats as "0x" words keeps, read back as the floats themselves).
 *
 * VTB2 puts a mode byte before each type's body: 0 the body as VTB1 has it,
 * 1 a pose type, one of the pose lines ("fj", "fp", "jp", "sp", "lm", "fq",
 * "lj", and the debug "wf", "wi", "ws"): a few head numbers and then groups of (ids, mask,
 * one float word for each bit of the mask). Its streams, in order: the frames
 * (steps, zigzag), each head number (a column), for "fp" a byte per event
 * (1: every value of it is the value of the same frame's "fj" line of the
 * same fighter, and is not kept), the number of groups per event (a column),
 * each id of a group (steps from the group before in its event), the masks
 * (varints), a varint for each value of the events not derived (0 the value
 * that followed the owner's last value in this context before; 1 a new one;
 * 2 + r the context's value at rank r of its recently seen ones, a
 * move-to-front list of RANKS), and then the new values' words: their count
 * and byte 0 of each, byte 1, 2, 3. The context is the part (with the
 * character or the stage part) and the bit of the mask; the owner's last
 * value that of the same head, ids and bit. The app's track_codec.py writes
 * it and holds the same description.
 */
import type { TrackData, TrackEvent } from "./track";

const MAGIC = "VTB2", MAGIC1 = "VTB1";
const RANKS = 1024, ID = 4096;
/** the pose types: head numbers, ids before a group's mask, which head number tells the character or the stage part (-1 none) */
const POSE: Record<string, [number, number, number]> = {
  fj: [3, 1, 2], fp: [3, 1, 2], wf: [3, 1, 2], jp: [1, 1, -1], wi: [1, 1, -1], sp: [1, 1, 0], ws: [1, 1, 0], lm: [2, 2, -1],
  // (track version 3: the parts a quaternion turns, a chain link's joints below its root)
  fq: [3, 1, 2], lj: [1, 2, -1],
  // (a fighter's costume hat's joints: Jigglypuff's ribbons)
  fh: [3, 1, 2],
};
/** a type whose values are those of another's line of the same frame and head */
const DERIVE: Record<string, string> = { fp: "fj" };
/** the pose types the player keeps compact (track.ts POSES): read into PoseLines, not events */
const COMPACT = new Set(["fj", "fp", "fq", "fh", "jp", "lm", "lj", "sp"]);

/** A pose type's lines, compact: line l's frame, its h head numbers (heads[l * h ...]) and its groups - each a
 *  group's ids, its mask and a value for each bit of the mask, as the event has them after its heads - in
 *  flat[start[l] .. end[l]). The values are the track's singles (their bits, read so); the ids, masks and heads
 *  are whole numbers well inside a single's 24 bits. */
export interface PoseLines {
  h: number;
  frames: Int32Array;
  heads: Int32Array;
  start: Uint32Array;
  end: Uint32Array;
  flat: Float32Array;
}

/** a pose type's events made compact (a JSON track's; frame order as they come) */
export function poseLinesOf(events: TrackEvent[], h: number): PoseLines {
  const n = events.length;
  let total = 0;
  for (const e of events) total += e.length - 2 - h;
  const frames = new Int32Array(n), heads = new Int32Array(n * h), start = new Uint32Array(n), end = new Uint32Array(n);
  const flat = new Float32Array(total);
  let at = 0;
  events.forEach((e, l) => {
    frames[l] = e[0];
    for (let k = 0; k < h; k++) heads[l * h + k] = Number(e[2 + k]);
    start[l] = at;
    for (let k = 2 + h; k < e.length; k++) flat[at++] = Number(e[k]);
    end[l] = at;
  });
  return { h, frames, heads, start, end, flat };
}

/** a pose type's lines as events again, in their order */
export function poseEvents(type: string, lines: PoseLines): TrackEvent[] {
  const { h, frames, heads, start, end, flat } = lines, out: TrackEvent[] = [];
  for (let l = 0; l < frames.length; l++) {
    const e: TrackEvent = [frames[l], type];
    for (let k = 0; k < h; k++) e.push(heads[l * h + k]);
    for (let k = start[l]; k < end[l]; k++) e.push(flat[k]);
    out.push(e);
  }
  return out;
}

/** every event of a track read from its compact form, its pose lines made events again, in the order the track
 *  had them (the tests, and tools that want the events as the JSON has them) */
export function trackEvents(t: TrackData): TrackEvent[] {
  const lay = t.layout;
  if (!lay || !t.poses) return t.events;
  const byType = lay.names.map((name) => (t.poses![name] ? poseEvents(name, t.poses![name]) : null));
  const at = new Array(lay.names.length).fill(0);
  const out: TrackEvent[] = new Array(lay.order.length);
  let other = 0;
  for (let i = 0; i < lay.order.length; i++) {
    const tIdx = lay.order[i], list = byType[tIdx];
    out[i] = list ? list[at[tIdx]++] : t.events[other++];
  }
  return out;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** a track's exact floats - strings "0x" and the IEEE single's eight hex
 *  digits - as the numbers they are, in place (anything else is left) */
export function decodeTrackFloats(events: TrackEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    for (let k = 2; k < e.length; k++) {
      const v = e[k];
      if (typeof v === "string" && v.length === 10 && v.charCodeAt(0) === 48 && v.charCodeAt(1) === 120) {
        u32[0] = Number(v);
        e[k] = f32[0];
      }
    }
  }
}

class Reader {
  o = 0;
  constructor(public b: Uint8Array) {}
  byte(): number { return this.b[this.o++]; }
  /** a varint, as a plain number (a column's values stay under 2^52) */
  varint(): number {
    let x = 0, scale = 1, c: number;
    do {
      c = this.b[this.o++];
      x += (c & 0x7f) * scale;
      scale *= 128;
    } while (c >= 0x80);
    return x;
  }
  zigzag(): number {
    const x = this.varint();
    return x % 2 === 0 ? x / 2 : -(x + 1) / 2;
  }
  text(): string {
    const n = this.varint();
    const s = new TextDecoder().decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

const bitsCache: (number[] | undefined)[] = [];
/** the bits set in a mask (16 at most), in order; the array is shared: not to be changed */
const bitsOf = (mask: number): number[] => {
  let out = bitsCache[mask];
  if (!out) {
    out = [];
    for (let b = 0; b < 16; b++) if (mask >> b & 1) out.push(b);
    bitsCache[mask] = out;
  }
  return out;
};

/** A map from 32-bit words (a float's bits, a time, a key) to whole numbers 0 to 2^32 - 1, open addressing in typed
 *  arrays: a JS Map keyed and valued by the words keeps most of them as heap numbers (past 2^30) and hashes them
 *  slowly, which made reading the longest game's track take seconds. The key -1 (no value before) has a slot of its
 *  own. get: -1 when absent. */
export class U32Map {
  private keys: Uint32Array;
  private vals: Float64Array;
  private used: Uint8Array;
  private bits: number;
  private count = 0;
  private minus = -1;
  constructor(bits = 4) {
    this.bits = bits;
    this.keys = new Uint32Array(1 << bits);
    this.vals = new Float64Array(1 << bits);
    this.used = new Uint8Array(1 << bits);
  }
  private slotOf(k: number): number {
    const mask = (1 << this.bits) - 1;
    let i = Math.imul(k, 0x9e3779b1) >>> (32 - this.bits);
    while (this.used[i] && this.keys[i] !== k) i = (i + 1) & mask;
    return i;
  }
  get(k: number): number {
    if (k === -1) return this.minus;
    const i = this.slotOf(k >>> 0);
    return this.used[i] ? this.vals[i] : -1;
  }
  set(k: number, v: number) {
    if (k === -1) { this.minus = v; return; }
    k >>>= 0;
    let i = this.slotOf(k);
    if (!this.used[i]) {
      if ((this.count + 1) * 2 > 1 << this.bits) { this.grow(); i = this.slotOf(k); }
      this.used[i] = 1;
      this.keys[i] = k;
      this.count++;
    }
    this.vals[i] = v;
  }
  /** emptied (the room kept) */
  clear() {
    this.used.fill(0);
    this.count = 0;
    this.minus = -1;
  }
  private grow() {
    const { keys, vals, used } = this;
    this.bits++;
    this.keys = new Uint32Array(1 << this.bits);
    this.vals = new Float64Array(1 << this.bits);
    this.used = new Uint8Array(1 << this.bits);
    for (let i = 0; i < used.length; i++) {
      if (!used[i]) continue;
      const j = this.slotOf(keys[i]);
      this.used[j] = 1;
      this.keys[j] = keys[i];
      this.vals[j] = vals[i];
    }
  }
}

type Ctx = [U32Map, Recent];

/** values met in one walk back through a log (Recent): a set made empty for each walk by a new stamp */
const SEEN_BITS = 12, SEEN_KEYS = new Uint32Array(1 << SEEN_BITS), SEEN_STAMP = new Uint32Array(1 << SEEN_BITS);
let seenStamp = 0;
/** whether x was met in this walk; meets it */
function seen(x: number): boolean {
  const mask = (1 << SEEN_BITS) - 1;
  let i = Math.imul(x, 0x9e3779b1) >>> (32 - SEEN_BITS);
  while (SEEN_STAMP[i] === seenStamp) {
    if (SEEN_KEYS[i] === x) return true;
    i = (i + 1) & mask;
  }
  SEEN_STAMP[i] = seenStamp;
  SEEN_KEYS[i] = x;
  return false;
}
function newWalk() {
  if (++seenStamp === 0xffffffff) { SEEN_STAMP.fill(0); seenStamp = 1; }
}

/** A context's recently seen values, a move-to-front list of RANKS: the RANKS distinct values seen last, the latest
 *  first. Kept as the log of its sightings, latest last: a sighting is one write, not a walk and a shift of the
 *  list (indexOf, splice, unshift - 4.2M of them over lists of 723 on average made the longest game's track take
 *  seconds to read). The list is the log read back from the latest, each value at its latest sighting; the value
 *  at a rank is found so (the reader asks for 1 sighting in 8). A full log keeps the list's RANKS only. Same list,
 *  same ranks. */
export class Recent {
  private log: Uint32Array;
  private n = 0;
  constructor(cap = 64) {
    this.log = new Uint32Array(cap);
  }
  /** the value at rank r (0: the latest), or -1 past the list */
  at(r: number): number {
    newWalk();
    const log = this.log;
    for (let p = this.n - 1; p >= 0; p--) {
      const x = log[p];
      if (!seen(x) && r-- === 0) return x;
    }
    return -1;
  }
  /** a value's rank, or -1 when it is not in the list */
  rank(x: number): number {
    newWalk();
    let r = 0;
    for (let p = this.n - 1; p >= 0 && r < RANKS; p--) {
      const v = this.log[p];
      if (seen(v)) continue;
      if (v === x >>> 0) return r;
      r++;
    }
    return -1;
  }
  /** values in the list */
  get size(): number {
    newWalk();
    let r = 0;
    for (let p = this.n - 1; p >= 0 && r < RANKS; p--) if (!seen(this.log[p])) r++;
    return r;
  }
  /** x seen: to the front, the oldest dropped past RANKS */
  touch(x: number) {
    // (the latest already: the list as it was)
    if (this.n && this.log[this.n - 1] === x) return;
    if (this.n === this.log.length) this.room();
    this.log[this.n++] = x;
  }
  /** the log full: the list's values laid down again at their latest sightings, oldest first, in a log twice as
   *  big when they fill half */
  private room() {
    newWalk();
    const keep: number[] = [];
    for (let p = this.n - 1; p >= 0 && keep.length < RANKS; p--) {
      const x = this.log[p];
      if (!seen(x)) keep.push(x);
    }
    let cap = this.log.length;
    if (keep.length * 2 > cap) cap *= 2;
    const log = cap === this.log.length ? this.log : new Uint32Array(cap);
    for (let k = 0; k < keep.length; k++) log[k] = keep[keep.length - 1 - k];
    this.log = log;
    this.n = keep.length;
  }
}

/** what a pose type's values are predicted from: the same as the writer's */
/** one owner's model state: its last value at each id key and bit (lk), and the context each lk is in - dense
 *  arrays while lk is small (a fighter's parts, a stage's joints), maps past that (a chain's joint and link) */
class Owner {
  last = new Float64Array(64).fill(-1);
  ctx: (Ctx | undefined)[] = [];
  lastFar = new U32Map();
  ctxFar = new Map<number, Ctx>();
  constructor(readonly ch: number) {}
}
const DENSE = 1 << 16;

/** what a pose type's values are predicted from: the same as the writer's */
class Model {
  ctx = new Map<number, Ctx>();
  owners = new Map<string, Owner>();
  owner = new Owner(0);
  scale: number;
  constructor(private spec: [number, number, number]) { this.scale = ID ** spec[1]; }
  start(head: number[]) {
    const k = head.join(",");
    let o = this.owners.get(k);
    if (!o) this.owners.set(k, o = new Owner(this.spec[2] >= 0 ? head[this.spec[2]] + 1 : 0));
    this.owner = o;
  }
  /** the state of one value, left in lk, c and prev (the owner's last value there, or -1) */
  lk = 0;
  c: Ctx = [new U32Map(), new Recent()];
  prev = -1;
  slot(idkey: number, b: number) {
    const o = this.owner, lk = this.lk = idkey * 16 + b;
    let c = lk < DENSE ? o.ctx[lk] : o.ctxFar.get(lk);
    if (!c) {
      // (the context: the part (and the character or stage part) and the bit, shared by the owners)
      const ck = (o.ch * this.scale + idkey) * 16 + b;
      c = this.ctx.get(ck);
      if (!c) this.ctx.set(ck, c = [new U32Map(), new Recent()]);
      if (lk < DENSE) o.ctx[lk] = c;
      else o.ctxFar.set(lk, c);
    }
    this.c = c;
    if (lk < DENSE) this.prev = lk < o.last.length ? o.last[lk] : -1;
    else this.prev = o.lastFar.get(lk);
  }
  /** the value found: it is the context's latest, and the owner's last */
  put(x: number) {
    const c = this.c, o = this.owner, lk = this.lk;
    c[0].set(this.prev, x);
    c[1].touch(x);
    if (lk < DENSE) {
      if (lk >= o.last.length) {
        let n = o.last.length;
        while (n <= lk) n *= 2;
        const grown = new Float64Array(n).fill(-1);
        grown.set(o.last);
        o.last = grown;
      }
      o.last[lk] = x;
    } else o.lastFar.set(lk, x);
  }
}

function column(r: Reader, n: number): (number | string)[] {
  const kind = r.byte();
  const out: (number | string)[] = new Array(n);
  if (kind === 0 || kind === 1) {
    const k = kind === 1 ? r.byte() : 0, s = 10 ** k;
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.zigzag(); out[i] = k ? last / s : last; }
    return out;
  }
  if (kind === 4) {
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.zigzag(); u32[0] = last; out[i] = f32[0]; }
    return out;
  }
  const count = r.varint();
  const table: (number | string)[] = [];
  for (let i = 0; i < count; i++) { const t = r.text(); table.push(kind === 3 ? JSON.parse(t) : t); }
  for (let i = 0; i < n; i++) out[i] = table[r.varint()];
  return out;
}

/** the bits set in each mask, counted (masks are 16 bits at most) */
const POP = new Uint8Array(1 << 16);
for (let m = 1; m < POP.length; m++) POP[m] = POP[m >> 1] + (m & 1);

/** a pose type's lines, compact; those whose values another type holds (DERIVE) are left to fillDerived, listed
 *  in `pending` (their ids and masks are in place, their values not yet) */
function readPose(r: Reader, name: string, frames: Int32Array, pending: number[]): PoseLines {
  const spec = POSE[name], [h, g] = spec, n = frames.length;
  const heads = new Int32Array(n * h);
  for (let j = 0; j < h; j++) {
    const col = column(r, n);
    for (let k = 0; k < n; k++) heads[k * h + j] = col[k] as number;
  }
  const derived = new Uint8Array(n);
  if (name in DERIVE) { derived.set(r.b.subarray(r.o, r.o + n)); r.o += n; }
  const counts = column(r, n) as number[];
  let groups = 0;
  for (const c of counts) groups += c;
  const ids = new Int32Array(groups * g);
  for (let j = 0; j < g; j++) {
    let at = 0;
    for (const c of counts) { let before = 0; for (let i = 0; i < c; i++) { before += r.zigzag(); ids[(at++) * g + j] = before; } }
  }
  const masks = new Int32Array(groups);
  for (let i = 0; i < groups; i++) masks[i] = r.varint();
  // (each line's room: its groups' ids, masks and values)
  const start = new Uint32Array(n), end = new Uint32Array(n);
  let total = 0, wanted = 0;
  for (let k = 0, gi = 0; k < n; k++) {
    start[k] = total;
    for (let c = 0; c < counts[k]; c++, gi++) {
      const pc = POP[masks[gi]];
      total += g + 1 + pc;
      if (!derived[k]) wanted += pc;
    }
    end[k] = total;
  }
  const flat = new Float32Array(total), bits = new Uint32Array(flat.buffer);
  const tags = new Uint16Array(wanted);
  for (let i = 0; i < wanted; i++) tags[i] = r.varint();
  const nlit = r.varint();
  const p0 = r.o, p1 = p0 + nlit, p2 = p1 + nlit, p3 = p2 + nlit;
  r.o = p3 + nlit;
  const model = new Model(spec);
  const head: number[] = new Array(h);
  let lit = 0, t = 0;
  for (let k = 0, gi = 0; k < n; k++) {
    let at = start[k];
    if (derived[k]) {
      pending.push(k);
      // (the ids and masks now; the values from the line that holds them)
      for (let c = 0; c < counts[k]; c++, gi++) {
        for (let j = 0; j < g; j++) flat[at++] = ids[gi * g + j];
        flat[at++] = masks[gi];
        at += POP[masks[gi]];
      }
      continue;
    }
    for (let j = 0; j < h; j++) head[j] = heads[k * h + j];
    model.start(head);
    for (let c = 0; c < counts[k]; c++, gi++) {
      let key = 0;
      for (let j = 0; j < g; j++) { const v = ids[gi * g + j]; key = key * ID + v; flat[at++] = v; }
      const mask = masks[gi];
      flat[at++] = mask;
      for (const b of bitsOf(mask)) {
        model.slot(key, b);
        const tag = tags[t++];
        let x: number;
        if (tag === 0) x = model.c[0].get(model.prev);
        else if (tag === 1) {
          x = (r.b[p0 + lit] | r.b[p1 + lit] << 8 | r.b[p2 + lit] << 16 | r.b[p3 + lit] << 24) >>> 0;
          lit++;
        } else x = model.c[1].at(tag - 2);
        model.put(x);
        // (the single's own bits, as the writer had them)
        bits[at++] = x;
      }
    }
  }
  return { h, frames, heads, start, end, flat };
}

/** the lines readPose left to another type (DERIVE): their values, that type's line's of the same frame and head */
function fillDerived(lines: Map<string, PoseLines>, pending: Map<string, number[]>) {
  for (const [name, todo] of pending) {
    if (!todo.length) continue;
    const [h, g] = POSE[name], dst = lines.get(name)!, src = lines.get(DERIVE[name])!;
    const sbits = new Uint32Array(src.flat.buffer), dbits = new Uint32Array(dst.flat.buffer);
    // (the source's line by frame and head)
    const index = new Map<string, number>();
    for (let l = 0; l < src.frames.length; l++) {
      let k = String(src.frames[l]);
      for (let j = 0; j < h; j++) k += ":" + src.heads[l * h + j];
      index.set(k, l);
    }
    const have = new U32Map(8);
    for (const k of todo) {
      let key0 = String(dst.frames[k]);
      for (let j = 0; j < h; j++) key0 += ":" + dst.heads[k * h + j];
      const l = index.get(key0)!;
      // (its values by id key and bit: the words, as they are)
      have.clear();
      let i = src.start[l];
      while (i < src.end[l]) {
        let key = 0;
        for (let j = 0; j < g; j++) key = key * ID + src.flat[i + j];
        const m = src.flat[i + g];
        i += g + 1;
        for (const b of bitsOf(m)) have.set(key * 16 + b, sbits[i++]);
      }
      i = dst.start[k];
      while (i < dst.end[k]) {
        let key = 0;
        for (let j = 0; j < g; j++) key = key * ID + dst.flat[i + j];
        const m = dst.flat[i + g];
        i += g + 1;
        for (const b of bitsOf(m)) dbits[i++] = have.get(key * 16 + b);
      }
    }
  }
}

/** the events and the rest of a track from its compact form, once ungzipped */
export function readTrack(b: Uint8Array): TrackData {
  const magic = new TextDecoder().decode(b.subarray(0, 4));
  if (magic !== MAGIC && magic !== MAGIC1) throw new Error("not a VTB2 track");
  const two = magic === MAGIC;
  const r = new Reader(b);
  r.o = 4;
  const track = JSON.parse(r.text()) as TrackData;
  const names: string[] = [];
  for (let i = r.varint(); i > 0; i--) names.push(r.text());
  const total = r.varint();
  const order = new Uint16Array(total);
  const counts = new Array(names.length).fill(0);
  for (let i = 0; i < total; i++) { order[i] = r.varint(); counts[order[i]]++; }
  const rows = new Map<string, TrackEvent[]>();
  const lines = new Map<string, PoseLines>();
  const pending = new Map<string, number[]>();
  names.forEach((name, t) => {
    const n = counts[t];
    if (two && r.byte() === 1) {
      const frames = new Int32Array(n);
      let at = 0;
      for (let i = 0; i < n; i++) { at += r.zigzag(); frames[i] = at; }
      const todo: number[] = [];
      pending.set(name, todo);
      lines.set(name, readPose(r, name, frames, todo));
      return;
    }
    const same = r.byte() === 0;
    const lengths = new Array<number>(n);
    if (same) lengths.fill(r.varint());
    else for (let i = 0; i < n; i++) lengths[i] = r.varint();
    const events: TrackEvent[] = new Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.zigzag(); events[i] = [last, name]; }
    let most = 0;
    for (const m of lengths) if (m > most) most = m;
    for (let j = 0; j < most; j++) {
      const have: TrackEvent[] = [];
      for (let i = 0; i < n; i++) if (lengths[i] > j) have.push(events[i]);
      const v = column(r, have.length);
      for (let i = 0; i < have.length; i++) have[i].push(v[i]);
    }
    rows.set(name, events);
  });
  fillDerived(lines, pending);
  // (the pose types the player keeps compact stay so; any other - the debug "wf", "wi", "ws" - made events)
  const poses: Record<string, PoseLines> = {};
  for (const [name, l] of lines) {
    if (COMPACT.has(name)) poses[name] = l;
    else rows.set(name, poseEvents(name, l));
  }
  const at = new Array(names.length).fill(0);
  const byType = names.map((name) => rows.get(name) ?? null);
  const events: TrackEvent[] = [];
  for (let i = 0; i < total; i++) {
    const list = byType[order[i]];
    if (list) events.push(list[at[order[i]]++]);
  }
  track.events = events;
  track.poses = poses;
  track.layout = { names, order };
  // (a writer that kept the "0x" words as strings: read as the floats they are)
  decodeTrackFloats(events);
  track.decoded = true;
  return track;
}

/** a track's compact form as a host may send it (gzipped) */
export async function decodeTrack(buf: ArrayBuffer): Promise<TrackData> {
  // (the browser's own gunzip; the page's TypeScript library predates its type)
  const Gunzip = (globalThis as unknown as { DecompressionStream: new (f: string) => TransformStream<Uint8Array, Uint8Array> })
    .DecompressionStream;
  const plain = await new Response(new Blob([buf]).stream().pipeThrough(new Gunzip("gzip"))).arrayBuffer();
  return readTrack(new Uint8Array(plain));
}
