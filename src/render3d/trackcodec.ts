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
};
/** a type whose values are those of another's line of the same frame and head */
const DERIVE: Record<string, string> = { fp: "fj" };

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

type Group = { key: number; mask: number; ids: number[] };
type Pending = [number, number, number[], Group[]][];
type Ctx = [Map<number, number>, number[]];

/** what a pose type's values are predicted from: the same as the writer's */
class Model {
  ctx = new Map<number, Ctx>();
  last = new Map<string, Map<number, number>>();
  owner = new Map<number, number>();
  ch = 0;
  scale: number;
  constructor(private spec: [number, number, number]) { this.scale = ID ** spec[1]; }
  start(head: number[]) {
    const k = head.join(",");
    let o = this.last.get(k);
    if (!o) this.last.set(k, o = new Map());
    this.owner = o;
    this.ch = this.spec[2] >= 0 ? head[this.spec[2]] + 1 : 0;
  }
  /** the state of one value, left in lk, c and prev (the owner's last value there, or -1) */
  lk = 0;
  c: Ctx = [new Map(), []];
  prev = -1;
  slot(idkey: number, b: number) {
    const lk = this.lk = idkey * 16 + b, ck = (this.ch * this.scale + idkey) * 16 + b;
    let c = this.ctx.get(ck);
    if (!c) this.ctx.set(ck, c = [new Map(), []]);
    this.c = c;
    const prev = this.owner.get(lk);
    this.prev = prev === undefined ? -1 : prev;
  }
  /** the value found: it is the context's latest, and the owner's last */
  put(x: number) {
    const c = this.c;
    c[0].set(this.prev, x);
    const recent = c[1], at = recent.indexOf(x);
    if (at !== 0) {
      if (at > 0) recent.splice(at, 1);
      recent.unshift(x);
      if (recent.length > RANKS) recent.length = RANKS;
    }
    this.owner.set(this.lk, x);
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

/** a pose type's events; those whose values another type holds are left null, in `pending` */
function readPose(r: Reader, name: string, frames: number[], pending: Pending): (TrackEvent | null)[] {
  const spec = POSE[name], [h, g] = spec, n = frames.length;
  const heads: (number | string)[][] = [];
  for (let j = 0; j < h; j++) heads.push(column(r, n));
  const derived = new Uint8Array(n);
  if (name in DERIVE) { derived.set(r.b.subarray(r.o, r.o + n)); r.o += n; }
  const counts = column(r, n) as number[];
  let groups = 0;
  for (const c of counts) groups += c;
  const ids: number[][] = [];
  for (let j = 0; j < g; j++) {
    const col = new Array<number>(groups);
    let at = 0;
    for (const c of counts) { let before = 0; for (let i = 0; i < c; i++) { before += r.zigzag(); col[at++] = before; } }
    ids.push(col);
  }
  const masks = new Array<number>(groups);
  for (let i = 0; i < groups; i++) masks[i] = r.varint();
  const plan: [number[], Group[]][] = [];
  let gi = 0, wanted = 0;
  for (let k = 0; k < n; k++) {
    const gs: Group[] = [];
    for (let c = 0; c < counts[k]; c++, gi++) {
      let key = 0;
      const idv: number[] = [];
      for (const col of ids) { key = key * ID + col[gi]; idv.push(col[gi]); }
      gs.push({ key, mask: masks[gi], ids: idv });
      if (!derived[k]) wanted += bitsOf(masks[gi]).length;
    }
    plan.push([heads.map((col) => col[k] as number), gs]);
  }
  const tags = new Array<number>(wanted);
  for (let i = 0; i < wanted; i++) tags[i] = r.varint();
  const nlit = r.varint();
  const p0 = r.o, p1 = p0 + nlit, p2 = p1 + nlit, p3 = p2 + nlit;
  r.o = p3 + nlit;
  const model = new Model(spec);
  let lit = 0, t = 0;
  const events: (TrackEvent | null)[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const [head, gs] = plan[k];
    if (derived[k]) { events[k] = null; pending.push([k, frames[k], head, gs]); continue; }
    const e: TrackEvent = [frames[k], name, ...head];
    model.start(head);
    for (const { key, mask, ids: idv } of gs) {
      for (const v of idv) e.push(v);
      e.push(mask);
      for (const b of bitsOf(mask)) {
        model.slot(key, b);
        const tag = tags[t++];
        let x: number;
        if (tag === 0) x = model.c[0].get(model.prev) as number;
        else if (tag === 1) {
          x = (r.b[p0 + lit] | r.b[p1 + lit] << 8 | r.b[p2 + lit] << 16 | r.b[p3 + lit] << 24) >>> 0;
          lit++;
        } else x = model.c[1][tag - 2];
        model.put(x);
        u32[0] = x;
        e.push(f32[0]);
      }
    }
    events[k] = e;
  }
  return events;
}

/** the events left null by readPose, made with the values of the type that holds them */
function fillDerived(rows: Map<string, (TrackEvent | null)[]>, pending: Map<string, Pending>) {
  for (const [name, todo] of pending) {
    if (!todo.length) continue;
    const [h, g] = POSE[name], index = new Map<string, Map<number, number | string>>();
    for (const s of rows.get(DERIVE[name]) as TrackEvent[]) {
      const have = new Map<number, number | string>();
      let i = 2 + h;
      while (i < s.length) {
        let key = 0;
        for (let j = 0; j < g; j++) key = key * ID + (s[i + j] as number);
        const m = s[i + g] as number, bits = bitsOf(m);
        bits.forEach((b, q) => have.set(key * 16 + b, s[i + g + 1 + q]));
        i += g + 1 + bits.length;
      }
      index.set(s[0] + ":" + s.slice(2, 2 + h).join(","), have);
    }
    for (const [k, frame, head, gs] of todo) {
      const have = index.get(frame + ":" + head.join(",")) as Map<number, number | string>;
      const e: TrackEvent = [frame, name, ...head];
      for (const { key, mask, ids } of gs) {
        for (const v of ids) e.push(v);
        e.push(mask);
        for (const b of bitsOf(mask)) e.push(have.get(key * 16 + b) as number);
      }
      (rows.get(name) as (TrackEvent | null)[])[k] = e;
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
  const rows = new Map<string, (TrackEvent | null)[]>();
  const pending = new Map<string, Pending>();
  names.forEach((name, t) => {
    const n = counts[t];
    if (two && r.byte() === 1) {
      const frames: number[] = new Array(n);
      let at = 0;
      for (let i = 0; i < n; i++) { at += r.zigzag(); frames[i] = at; }
      const todo: Pending = [];
      pending.set(name, todo);
      rows.set(name, readPose(r, name, frames, todo));
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
  fillDerived(rows, pending);
  const at = new Array(names.length).fill(0);
  const byType = names.map((name) => rows.get(name) as TrackEvent[]);
  const events: TrackEvent[] = new Array(total);
  for (let i = 0; i < total; i++) events[i] = byType[order[i]][at[order[i]]++];
  track.events = events;
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
