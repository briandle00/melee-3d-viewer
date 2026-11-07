/* Checkpoints of the simulator module's memory, for going back in a match (session.ts; a host's own player over GxCore can keep its
 * checkpoints the same way). Between calls everything the module holds is in its memory, so a checkpoint is only the memory the match
 * changed: the memory is compared with its state after the match's first row (the baseline) page by page, 64 KiB pages with a hash
 * each, and the pages that differ are kept - a few MiB of the module's ~1 GiB. Going back writes the checkpoint's pages back and, for
 * every page changed since that the checkpoint does not hold, the page as it was after the first row (kept once seen; the first rewind
 * that needs one not seen yet opens the match again for it, which puts every page back to the first row's state).
 *
 * Where they are kept: a checkpoint is a pass over the module's memory (a tenth of a second or two), so they are kept at marked rows as
 * the match passes them, none within SPACING rows after another. A place sought to marks two, a little before the row its stream starts
 * again at (backMarks): BACK rows before it and SPACING further, so a frame back or two seconds back from there rewinds to one near
 * instead of playing the match again from far.
 */

/** the module's memory as the checkpoints read and write it (the graphics build: its heap top, msl_gxw_heap_top) */
export interface CheckpointMemory { HEAPU8: Uint8Array; _msl_gxw_heap_top(): number }

export interface Checkpoint { row: number; pages: Map<number, Uint8Array> }

export const PAGE = 65536;
/** checkpoints kept, and rows a checkpoint serves for (none is taken within this many rows after another) */
export const KEEP = 10, SPACING = 300;

/** a hash of each 64 KiB page of the module's memory up to its heap top (four FNV-1a chains over the words in turn, for speed) */
export function pageHashes(m: CheckpointMemory): Uint32Array {
  const top = m._msl_gxw_heap_top(), n = Math.ceil(top / PAGE), out = new Uint32Array(n);
  // (whole pages: a page is kept and written back whole)
  const u32 = new Uint32Array(m.HEAPU8.buffer, 0, Math.min(n * (PAGE / 4), m.HEAPU8.length >> 2));
  const P = 16777619;
  for (let p = 0; p < n; p++) {
    let h0 = 2166136261, h1 = 0x01000193, h2 = 0x9e3779b9, h3 = 0x85ebca6b;
    const a = p * (PAGE / 4), end = Math.min(a + PAGE / 4, u32.length);
    let i = a;
    for (; i + 3 < end; i += 4) { h0 = Math.imul(h0 ^ u32[i], P); h1 = Math.imul(h1 ^ u32[i + 1], P); h2 = Math.imul(h2 ^ u32[i + 2], P); h3 = Math.imul(h3 ^ u32[i + 3], P); }
    for (; i < end; i++) h0 = Math.imul(h0 ^ u32[i], P);
    out[p] = Math.imul(h0 ^ (h1 >>> 7 | h1 << 25), P) ^ Math.imul(h2 ^ (h3 >>> 13 | h3 << 19), 0x27d4eb2d);
  }
  return out;
}

export class Checkpoints {
  /** (the checks) passes over the module's memory and their ms; rewinds, and those that opened the match again */
  stats = { hashes: 0, hashMs: 0, rewinds: 0, reopens: 0 };
  /** page hashes after the first row, and the pages as they were then (those seen changed since) */
  private base: Uint32Array | null = null;
  private basePages = new Map<number, Uint8Array>();
  private kept: Checkpoint[] = [];
  /** rows to keep a checkpoint at when the match gets there */
  private marks = new Set<number>();

  /** `back`: the rows between a place's restart row and the nearer of the two checkpoints kept for it (backMarks). `keepEarliest`: when
   *  more than KEEP are kept, the earliest is never the one dropped (a host that goes back to one place again and again, the start of a
   *  range it loops, marks it first: each loop back stays a rewind to it) */
  constructor(readonly back: number, readonly keepEarliest = false) {}

  /** a baseline is taken: checkpoints can be kept and rewound to */
  get ready(): boolean { return this.base !== null; }

  /** The baseline: the module's memory now, after the match's first row. Every checkpoint and mark of an earlier baseline is dropped. */
  baseline(m: CheckpointMemory): void {
    this.drop();
    this.base = this.hashes(m);
  }

  /** nothing kept, no baseline */
  drop(): void { this.base = null; this.basePages.clear(); this.kept = []; this.marks.clear(); }

  private hashes(m: CheckpointMemory): Uint32Array {
    const t0 = performance.now();
    const out = pageHashes(m);
    this.stats.hashMs += performance.now() - t0;
    this.stats.hashes++;
    return out;
  }
  private changed(now: Uint32Array): number[] {
    const out: number[] = [], b = this.base!;
    for (let p = 0; p < now.length; p++) if (p >= b.length || now[p] !== b[p]) out.push(p);
    return out;
  }
  private page(m: CheckpointMemory, p: number): Uint8Array { const h = m.HEAPU8; return h.slice(p * PAGE, Math.min((p + 1) * PAGE, h.length)); }

  /** keep a checkpoint at row `row` (before it is stepped) when the match gets there (one a little before it serves as well: a rewind
   *  steps the rest, so none is kept within SPACING rows after another, marked or kept) */
  markAt(row: number): void {
    const near = (r: number) => r <= row && r > row - SPACING;
    if (this.base && row >= 1 && !this.kept.some((c) => near(c.row)) && ![...this.marks].some(near)) this.marks.add(row);
  }

  /** checkpoints to keep before row `from`, where the stream starts again for a place sought to: `back` rows before it and SPACING
   *  further (going back here again, or a few frames further, is then a rewind to one of these, not a play from further back; marks
   *  are kept as the match passes them, which it does when the checkpoint it rewound to is older) */
  backMarks(from: number): void {
    this.markAt(from - this.back - SPACING);
    this.markAt(from - this.back);
  }

  /** the match is at row `index` (the next to step): a checkpoint kept when one is marked here */
  passing(m: CheckpointMemory, index: number): void { if (this.marks.delete(index)) this.keep(m, index); }

  /** keep the module's state before row `index` (the next to step) as a checkpoint */
  keep(m: CheckpointMemory, index: number): void {
    if (!this.base || this.kept.some((c) => c.row === index)) return;
    const pages = new Map<number, Uint8Array>();
    for (const p of this.changed(this.hashes(m))) pages.set(p, this.page(m, p));
    this.kept.push({ row: index, pages });
    this.kept.sort((a, b) => a.row - b.row);
    const from = this.keepEarliest ? 1 : 0;
    while (this.kept.length > KEEP) this.kept.splice(from + Math.floor(Math.random() * (this.kept.length - from)), 1);
  }

  /** (the checks) the pages that differ from the baseline now: after the match is opened again, those it does not put back */
  differs(m: CheckpointMemory): number[] { return this.changed(this.hashes(m)); }

  /** the latest checkpoint at or before row `row` and after row `after` (null: none) */
  latest(row: number, after = -1): Checkpoint | null {
    for (let i = this.kept.length - 1; i >= 0; i--) if (this.kept[i].row <= row) return this.kept[i].row > after ? this.kept[i] : null;
    return null;
  }

  /**
   * The module's memory back to checkpoint `c` (null: the state after the first row). When a page changed since was never seen as it
   * started, `reopen` opens the match again (the module put back to its state after the game data loaded, the match opened and its first
   * row stepped) and resolves the module's memory then, or null when the caller has gone (nothing more is done). Resolves the memory
   * written (the one given, or the reopened one), or null.
   */
  async rewind(m: CheckpointMemory, c: Checkpoint | null, reopen: () => Promise<CheckpointMemory | null>): Promise<CheckpointMemory | null> {
    this.stats.rewinds++;
    const now = this.changed(this.hashes(m));
    const want = c ? c.pages : new Map<number, Uint8Array>();
    const need = now.filter((p) => !want.has(p) && !this.basePages.has(p));
    if (need.length) {
      // pages the match changed that were never seen as they started: the match opened again has them (and is the first row's state
      // everywhere else)
      this.stats.reopens++;
      const r = await reopen();
      if (!r) return null;
      m = r;
      for (const p of need) this.basePages.set(p, this.page(m, p));
    } else {
      for (const p of now) if (!want.has(p)) m.HEAPU8.set(this.basePages.get(p)!, p * PAGE);
    }
    for (const [p, bytes] of want) m.HEAPU8.set(bytes, p * PAGE);
    return m;
  }

  /** (the checks) the checkpoints' pages and the first row's pages kept, MiB */
  get MiB(): number { let n = 0; for (const c of this.kept) for (const b of c.pages.values()) n += b.length; for (const b of this.basePages.values()) n += b.length; return n / 1048576; }
}
