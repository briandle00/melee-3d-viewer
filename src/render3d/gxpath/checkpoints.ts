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
 *
 * Going back without a pass over the memory (rewindFresh): when the match can be opened again in milliseconds (a module that keeps its state
 * after the game data loads: core.ts canReopen), it is opened again - every page then the baseline's - and the checkpoint's pages written:
 * a fifth of the time of the pass over the module's ~0.9 GiB the rewind above starts with. Checkpoints can be kept without a pass too, when
 * the pages that differ from the baseline at that row are known (keepPages: a list made once by a pass at that row, stored.ts), and added
 * whole (add: one made elsewhere, by another instance of the same module playing the same tape, stored.ts).
 */

/** the module's memory as the checkpoints read and write it (the graphics build: its heap top, msl_gxw_heap_top) */
export interface CheckpointMemory { HEAPU8: Uint8Array; _msl_gxw_heap_top(): number }

export interface Checkpoint { row: number; pages: Map<number, Uint8Array> }

export const PAGE = 65536;
/** checkpoints kept, and rows a checkpoint serves for (none is taken within this many rows after another) */
export const KEEP = 10, SPACING = 300;

/** page `p`'s hash as pageHashes makes it (a few pages checked against hashes taken before: a stored set's baseline, stored.ts) */
export function pageHash(m: CheckpointMemory, p: number): number {
  const u32 = new Uint32Array(m.HEAPU8.buffer, 0, m.HEAPU8.length >> 2);
  const P = 16777619;
  let h0 = 2166136261, h1 = 0x01000193, h2 = 0x9e3779b9, h3 = 0x85ebca6b;
  const a = p * (PAGE / 4), end = Math.min(a + PAGE / 4, u32.length);
  let i = a;
  for (; i + 3 < end; i += 4) { h0 = Math.imul(h0 ^ u32[i], P); h1 = Math.imul(h1 ^ u32[i + 1], P); h2 = Math.imul(h2 ^ u32[i + 2], P); h3 = Math.imul(h3 ^ u32[i + 3], P); }
  for (; i < end; i++) h0 = Math.imul(h0 ^ u32[i], P);
  return (Math.imul(h0 ^ (h1 >>> 7 | h1 << 25), P) ^ Math.imul(h2 ^ (h3 >>> 13 | h3 << 19), 0x27d4eb2d)) >>> 0;
}

/** the module's own account of what it keeps after the game data loads (msl_gxw_keep_info): 0/1 its block, 5 the game data's rewrites
 *  logged, 100 + 3r / 101 + 3r the read-only ranges' bounds; -1 without a kept state */
export interface KeepInfoMemory extends CheckpointMemory { _msl_gxw_keep_info?(i: number): number }

/** The pages a match can change: every page of the module's memory but the game data's ranges the match only reads (the translated
 *  files, the DAT graphs, the fighters' sampled animations - msl_gxw_load_game keeps them as hashes, and the game's one write to them is
 *  logged: gameDataWrites); null without a kept state (every page, then). (The block the module keeps its state in is not left out: the
 *  module writes its own record in it as a match plays - 2 of its pages differed from the match opened again on a fixture game.) */
export function matchPages(m: KeepInfoMemory): number[] | null {
  const info = m._msl_gxw_keep_info;
  if (!info || info.call(m, 0) < 0) return null;
  const skip: [number, number][] = [];
  for (let r = 0; r < 6; r++) {
    const b = info.call(m, 100 + 3 * r), e = info.call(m, 101 + 3 * r);
    // (a range's whole pages only: a page it shares with other data is a page a match may change)
    if (e > b) skip.push([Math.ceil(b / PAGE), Math.floor(e / PAGE)]);
  }
  const out: number[] = [];
  for (let p = 0, n = Math.ceil(m.HEAPU8.length / PAGE); p < n; p++) if (!skip.some(([a, z]) => p >= a && p < z)) out.push(p);
  return out;
}

/** Pages a match opened in an instance that played another (msl_gxw_rewind) may hold otherwise than one opened in a fresh instance, with
 *  nothing of the match in them: the stack's unused bytes (emscripten lays the stack just below the heap, whose first block is the game
 *  data's arena, range 0: what earlier calls left there) and the block the module keeps its state in (its own record, rewinds counted).
 *  A stored set made by a fresh instance is checked without them (stored.ts sameBaseline's skip). Without a kept state: none. */
export function notTheMatch(m: KeepInfoMemory, stackPages = 80): (page: number) => boolean {
  const info = m._msl_gxw_keep_info;
  if (!info || info.call(m, 0) < 0) return () => false;
  const selfA = Math.floor(info.call(m, 0) / PAGE), selfB = Math.ceil(info.call(m, 1) / PAGE);
  const heap = Math.floor(info.call(m, 100) / PAGE);
  return (p) => (p >= selfA && p < selfB) || (p <= heap && p >= heap - stackPages);
}

/** the game data's rewrites logged so far (msl_gxw_keep_info 5): the same count, the ranges matchPages leaves out are as they were */
export function gameDataWrites(m: KeepInfoMemory): number { return m._msl_gxw_keep_info ? m._msl_gxw_keep_info(5) : -1; }

/** a pass over the module's memory with two 32-bit hashes a page: the [2p] and [2p + 1] words are page p's. A list of the pages that
 *  differ from the baseline made from it is kept for good (stored.ts), so a page is taken as unchanged only when 64 bits say so */
export function pageHashes2(m: CheckpointMemory): Uint32Array {
  const top = m._msl_gxw_heap_top(), n = Math.ceil(top / PAGE), out = new Uint32Array(2 * n);
  const u32 = new Uint32Array(m.HEAPU8.buffer, 0, Math.min(n * (PAGE / 4), m.HEAPU8.length >> 2));
  const P = 16777619;
  for (let p = 0; p < n; p++) {
    let h0 = 2166136261, h1 = 0x01000193, h2 = 0x9e3779b9, h3 = 0x85ebca6b;
    const a = p * (PAGE / 4), end = Math.min(a + PAGE / 4, u32.length);
    let i = a;
    for (; i + 3 < end; i += 4) { h0 = Math.imul(h0 ^ u32[i], P); h1 = Math.imul(h1 ^ u32[i + 1], P); h2 = Math.imul(h2 ^ u32[i + 2], P); h3 = Math.imul(h3 ^ u32[i + 3], P); }
    for (; i < end; i++) h0 = Math.imul(h0 ^ u32[i], P);
    // (each word is two of the four chains, each chain over every fourth word: a change to any word changes its chain, and so its half)
    out[2 * p] = Math.imul(h0 ^ (h1 >>> 7 | h1 << 25), P);
    out[2 * p + 1] = Math.imul(h2 ^ (h3 >>> 13 | h3 << 19), 0x27d4eb2d);
  }
  return out;
}

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
  /** (the checks) passes over the module's memory and their ms; rewinds, and those that opened the match again; the faster passes over
   *  the pages a match can change (rewindPass) and their ms */
  stats = { hashes: 0, hashMs: 0, rewinds: 0, reopens: 0, passes: 0, passMs: 0 };
  /** page hashes after the first row, and the pages as they were then (those seen changed since) */
  private base: Uint32Array | null = null;
  private basePages = new Map<number, Uint8Array>();
  private kept: Checkpoint[] = [];
  /** rows to keep a checkpoint at when the match gets there */
  private marks = new Set<number>();
  /** how many are kept (KEEP unless the host says), and, when the host says where its match is (near), which one is dropped when there
   *  are more: the farthest from there (else one at random) */
  private max = KEEP;
  private near: (() => number) | null = null;

  /** `back`: the rows between a place's restart row and the nearer of the two checkpoints kept for it (backMarks). `keepEarliest`: when
   *  more than KEEP are kept, the earliest is never the one dropped (a host that goes back to one place again and again, the start of a
   *  range it loops, marks it first: each loop back stays a rewind to it) */
  constructor(readonly back: number, readonly keepEarliest = false) {}

  /** keep up to `max`, and when there are more drop the one farthest from the row `near` says (the row the host's match is at: the ones a
   *  seek or a scrub around it needs stay) */
  limit(max: number, near?: () => number): void {
    this.max = Math.max(1, max);
    this.near = near ?? null;
    this.trim();
  }

  private trim(): void {
    const from = this.keepEarliest ? 1 : 0;
    while (this.kept.length > this.max) {
      let drop = from + Math.floor(Math.random() * (this.kept.length - from));
      if (this.near) {
        const at = this.near();
        let far = -1;
        for (let i = from; i < this.kept.length; i++) {
          const d = Math.abs(this.kept[i].row - at);
          if (d > far) { far = d; drop = i; }
        }
      }
      this.kept.splice(drop, 1);
    }
  }

  /** a baseline is taken: checkpoints can be kept and rewound to */
  get ready(): boolean { return this.base !== null; }

  /** The baseline: the module's memory now, after the match's first row. Every checkpoint and mark of an earlier baseline is dropped.
   *  `hashes`: this very state's page hashes taken before (pageHashes: a stored set's, made by the same module playing the same tape - the
   *  state after the first row is the same bytes in every instance), so no pass is made now. */
  baseline(m: CheckpointMemory, hashes?: Uint32Array): void {
    this.drop();
    this.base = hashes ? hashes.slice() : this.hashes(m);
  }

  /** the baseline's page hashes (null before one is taken) */
  get baseHashes(): Uint32Array | null { return this.base; }

  /** nothing kept, no baseline */
  drop(): void { this.base = null; this.base64 = null; this.basePages.clear(); this.kept = []; this.marks.clear(); }

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
    this.put({ row: index, pages });
  }

  /** keep the module's state before row `index` as a checkpoint of exactly `pages`, the pages that differ from the baseline at that row,
   *  known without a pass (a stored set's list, made by a pass at that row when the same module played the same tape: stored.ts) */
  keepPages(m: CheckpointMemory, index: number, pages: Iterable<number>): void {
    if (!this.base || this.kept.some((c) => c.row === index)) return;
    const out = new Map<number, Uint8Array>();
    for (const p of pages) out.set(p, this.page(m, p));
    this.put({ row: index, pages: out });
  }

  /** a checkpoint made elsewhere (by another instance of the same module playing the same tape, against the same first row: stored.ts) */
  add(c: Checkpoint): void {
    if (!this.base || this.kept.some((k) => k.row === c.row)) return;
    this.put(c);
  }

  /** whether a checkpoint at row `row` is kept */
  has(row: number): boolean { return this.kept.some((c) => c.row === row); }

  private put(c: Checkpoint): void {
    this.kept.push(c);
    this.kept.sort((a, b) => a.row - b.row);
    this.trim();
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

  /**
   * The module's memory back to checkpoint `c` (null: the state after the first row) without a pass over it: `reopen` opens the match
   * again (every page then the baseline's) and resolves the module's memory, or null when the caller has gone; the checkpoint's pages are
   * written into it. For a module that opens a match again in milliseconds (core.ts canReopen). Resolves the memory written, or null.
   */
  async rewindFresh(c: Checkpoint | null, reopen: () => Promise<CheckpointMemory | null>): Promise<CheckpointMemory | null> {
    this.stats.rewinds++;
    this.stats.reopens++;
    const m = await reopen();
    if (!m) return null;
    if (c) for (const [p, bytes] of c.pages) m.HEAPU8.set(bytes, p * PAGE);
    return m;
  }

  /** the faster pass's baseline: each page's 64-bit hash after the first row, for the pages a match can change (rewindPass) */
  private base64: Map<number, bigint> | null = null;

  /**
   * The module's memory back to checkpoint `c` (null: the state after the first row) by a faster pass over only the pages a match can
   * change (`pages`: the module's memory but the game data it reads and never writes, and the module's own record of its kept state),
   * each hashed (`hash`: pagehash.ts) and held to its hash after the first row - a few hundredths of a second, against the match opened
   * again (rewindFresh, a fifth of a second in a page). A page changed since is written back as it was after the first row (kept once
   * seen: the first rewind that needs a page it has not seen, and the first of all, which takes the baseline's hashes, open the match
   * again - every page then the first row's - and keep them from it), then the checkpoint's pages. `unchanged` says the game data the
   * pass leaves out is as it was (the module logs the one write the game makes to it): when it says no, the match is opened again.
   * Resolves the memory written, or null when the caller has gone.
   */
  async rewindPass(m: CheckpointMemory, c: Checkpoint | null, o: { hash: (p: number) => bigint; pages: number[]; unchanged: () => boolean;
                                                                  reopen: () => Promise<CheckpointMemory | null> }): Promise<CheckpointMemory | null> {
    const want = c ? c.pages : new Map<number, Uint8Array>();
    if (this.base64 && o.unchanged()) {
      const t0 = performance.now();
      const changed: number[] = [];
      for (const p of o.pages) if (o.hash(p) !== this.base64.get(p)) changed.push(p);
      this.stats.passMs += performance.now() - t0;
      this.stats.passes++;
      if (changed.every((p) => want.has(p) || this.basePages.has(p))) {
        this.stats.rewinds++;
        for (const p of changed) if (!want.has(p)) m.HEAPU8.set(this.basePages.get(p)!, p * PAGE);
        for (const [p, bytes] of want) m.HEAPU8.set(bytes, p * PAGE);
        return m;
      }
      // (pages never seen as they started: the match opened again has them, kept from here on - every page changed now, the
      // checkpoint's too, so a rewind to it or past it later needs no other)
      const r = await this.rewindFresh(null, o.reopen);
      if (!r) return null;
      for (const p of changed) if (!this.basePages.has(p)) this.basePages.set(p, this.page(r, p));
      for (const p of want.keys()) if (!this.basePages.has(p)) this.basePages.set(p, this.page(r, p));
      for (const [p, bytes] of want) r.HEAPU8.set(bytes, p * PAGE);
      return r;
    }
    // (the first: the match opened again, the baseline's hashes of those pages taken from it - and its pages the checkpoint holds)
    const r = await this.rewindFresh(null, o.reopen);
    if (!r) return null;
    const t0 = performance.now();
    this.base64 = new Map();
    for (const p of o.pages) this.base64.set(p, o.hash(p));
    this.stats.passMs += performance.now() - t0;
    this.stats.passes++;
    for (const p of want.keys()) if (!this.basePages.has(p)) this.basePages.set(p, this.page(r, p));
    for (const [p, bytes] of want) r.HEAPU8.set(bytes, p * PAGE);
    return r;
  }

  /** (the checks) the checkpoints' pages and the first row's pages kept, MiB */
  get MiB(): number { let n = 0; for (const c of this.kept) for (const b of c.pages.values()) n += b.length; for (const b of this.basePages.values()) n += b.length; return n / 1048576; }
}
