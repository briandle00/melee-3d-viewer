/// <reference lib="dom" />
/* GX renderer: the front half of the draws on worker threads.
 *
 * The main thread decodes the stream; for each draw it copies what the front half reads (the XF unit, BP, the decoded vertices, the primitives)
 * into a shared buffer and publishes a job; worker threads (and the main thread, while it waits) run `FrontCtx.run` on the jobs and leave the
 * words of the triangles in a shared output area. The main thread takes the outputs in draw order (`drain`) when the pass has to be drawn, so
 * the queue holds exactly the words one thread would have made: the same code runs everywhere, and nothing here depends on the order the jobs
 * finish in. Needs a shared buffer (a page that is cross-origin isolated); `FrontPool.available()` says.
 *
 * The buffer: control words, the job table, the XF unit (its words when the first job after a drain was published, then a log of the
 * ranges loaded since, each with its words: a job names the log's end at its draw), the inputs and the outputs. Jobs are numbered
 * from the start of the page, a job sits in slot number % maxJobs, and the inputs and outputs are bump-allocated and start over at each drain.
 */
import { binTriangles, Entries } from "./bin";
import { MEM_SIZE } from "./dff";
import { FrontCtx, FrontRegs, Growable } from "./front";
import { getLastZ, zInfo } from "./setup";
import { bits, XF_SIZE } from "./state";
import { VertexData, vertexLayout, type VertexLayout } from "./vertex";

// control words, by who writes them, a cache line (16 words) apart: the next job to claim (the workers); the jobs published and the stop
// (the main thread); what the jobs leave: jobs done, output words and entries taken, raw jobs decoded and raw jobs whose output did not fit
// (their words are made again by the main thread), jobs run by workers; the workers asleep; the workers started
const C_HEAD = 0, C_TAIL = 16, C_STOP = 17, C_DONE = 32, C_OUT = 33, C_DECODED = 34, C_RAWOVER = 35, C_ENT = 36, C_WJOBS = 37, C_SLEEPERS = 48, C_STARTED = 64;
const CTL_WORDS = 80;
const JW = 24;
// (J_XF: the XF log's end for the job, J_XFGEN: the XF base it starts from)
const J_LAY0 = 0, J_LAY1 = 1, J_XF = 2, J_BP = 3, J_NV = 4, J_VOFF = 5, J_PRIMS = 6, J_NPRIMS = 7, J_ST = 8, J_OUT = 9, J_OUTLEN = 10, J_ZFLAG = 11, J_Z = 12, J_OVER = 15;
// (the job's tile entries follow its words in the output area: J_NENT words of them, for J_TRIS triangles: bin.ts)
const J_NENT = 16, J_TRIS = 17;
// (a raw job: its vertices are the command bytes as sent (J_VOFF: their first word in the inputs, J_NV vertices of vertex attribute
// table entry J_LAY0), decoded by the thread that runs it from those bytes, the CP registers at J_CP and the memory mirror)
const J_KIND = 18, J_CP = 19;
// (where the job's tile entries are in the entry area)
const J_ENT = 20, J_XFGEN = 21;

export interface PoolConfig { maxJobs: number; xfLogWords: number; inWords: number; outWords: number; entWords: number }
export const DEFAULT_POOL: PoolConfig = { maxJobs: 512, xfLogWords: 1 << 21, inWords: 1 << 23, outWords: 1 << 24, entWords: 1 << 22 };
/** set in an entry's triangle field (bin.ts) by gl.ts for the words of its own queue, which follow the output area's in a pass */
export const Q_FLAG = 1 << 30;

class Shared {
  ctl: Int32Array;
  jobs: Int32Array;
  jobsF: Float32Array;
  xfBase: Uint32Array;
  xfLog: Uint32Array;
  inU: Uint32Array;
  inI: Int32Array;
  inF: Float32Array;
  inB: Uint8Array;
  out: Uint32Array;
  ent: Int32Array;
  /** the mirror of the GX memory the raw jobs' indexed attributes read (gl.ts keeps it equal to the attached memory) */
  mem: Uint8Array;
  memView: DataView;
  constructor(public sab: SharedArrayBuffer, public cfg: PoolConfig, public memSab: SharedArrayBuffer) {
    const l = Shared.layout(cfg);
    this.ctl = new Int32Array(sab, 0, CTL_WORDS);
    this.jobs = new Int32Array(sab, l.jobsAt * 4, cfg.maxJobs * JW);
    this.jobsF = new Float32Array(sab, l.jobsAt * 4, cfg.maxJobs * JW);
    this.xfBase = new Uint32Array(sab, l.xfAt * 4, XF_SIZE);
    this.xfLog = new Uint32Array(sab, (l.xfAt + XF_SIZE) * 4, cfg.xfLogWords);
    this.inU = new Uint32Array(sab, l.inAt * 4, cfg.inWords);
    this.inI = new Int32Array(sab, l.inAt * 4, cfg.inWords);
    this.inF = new Float32Array(sab, l.inAt * 4, cfg.inWords);
    this.inB = new Uint8Array(sab, l.inAt * 4, cfg.inWords * 4);
    this.out = new Uint32Array(sab, l.outAt * 4, cfg.outWords);
    this.ent = new Int32Array(sab, l.entAt * 4, cfg.entWords);
    this.mem = new Uint8Array(memSab);
    this.memView = new DataView(memSab);
  }
  static layout(cfg: PoolConfig): { jobsAt: number; xfAt: number; inAt: number; outAt: number; entAt: number; words: number } {
    const jobsAt = CTL_WORDS, xfAt = jobsAt + cfg.maxJobs * JW, inAt = xfAt + XF_SIZE + cfg.xfLogWords, outAt = inAt + cfg.inWords, entAt = outAt + cfg.outWords;
    return { jobsAt, xfAt, inAt, outAt, entAt, words: entAt + cfg.entWords };
  }
}

/** which layout fields the front half reads, as two words */
function layoutBits(L: VertexLayout): [number, number] {
  const lo = (L.posMtx ? 1 : 0) | (L.pos.kind << 1) | (L.nrm.kind << 3) | (L.nbt ? 32 : 0) | (L.col[0].kind << 6) | (L.col[1].kind << 8);
  let hi = 0;
  for (let t = 0; t < 8; t++) hi |= (L.tex[t].kind << (2 * t)) | ((L.texMtx[t] ? 1 : 0) << (16 + t));
  return [lo, hi];
}

const layoutCache = new Map<string, VertexLayout>();
function layoutOf(lo: number, hi: number): VertexLayout {
  const key = lo + "," + hi;
  let L = layoutCache.get(key);
  if (!L) {
    const A = (kind: number) => ({ kind }) as never;
    L = {
      posMtx: (lo & 1) !== 0, pos: A((lo >> 1) & 3), nrm: A((lo >> 3) & 3), nbt: (lo & 32) !== 0, col: [A((lo >> 6) & 3), A((lo >> 8) & 3)],
      tex: Array.from({ length: 8 }, (_, t) => A((hi >> (2 * t)) & 3)), texMtx: Array.from({ length: 8 }, (_, t) => ((hi >> (16 + t)) & 1) !== 0),
    } as unknown as VertexLayout;
    layoutCache.set(key, L);
  }
  return L;
}

/** where each decoded array of a run of n vertices sits in the input words, from `at` on (-1: not carried) */
interface Plan { pos: number; pmtx: number; nrm: number; nrm1: number; nrm2: number; col: number[]; tex: number[]; tmtx: number[]; end: number }
function plan(lo: number, hi: number, n: number, at: number): Plan {
  const p: Plan = { pos: at, pmtx: at + 3 * n, nrm: -1, nrm1: -1, nrm2: -1, col: [-1, -1], tex: [], tmtx: [], end: 0 };
  let w = at + 4 * n;
  if ((lo >> 3) & 3) { p.nrm = w; w += 3 * n; }
  if (lo & 32) { p.nrm1 = w; w += 3 * n; p.nrm2 = w; w += 3 * n; }
  for (let c = 0; c < 2; c++) if ((lo >> (6 + 2 * c)) & 3) { p.col[c] = w; w += n; }
  for (let t = 0; t < 8; t++) { if ((hi >> (2 * t)) & 3) { p.tex.push(w); w += 2 * n; } else p.tex.push(-1); }
  for (let t = 0; t < 8; t++) { if ((hi >> (16 + t)) & 1) { p.tmtx.push(w); w += n; } else p.tmtx.push(-1); }
  p.end = w;
  return p;
}

const EMPTY_F = new Float32Array(0), EMPTY_B = new Uint8Array(0);

/** what the pool reads of the registers' XF unit (state.ts GxRegs): its words, a counter of loads, and the ranges loaded (address,
 *  count) the pool asks it to keep (lost: too many to keep, the pool takes the whole unit again) */
export interface XfRegs { xf: Uint32Array; xfVersion: number; xfLog?: number[] | null; xfLogLost?: boolean }

/** a thread's own XF unit for the jobs it runs: the base, then the log up to the job's end (a thread claims jobs in order, so it only
 *  ever moves forward within a base; a job made again for drain() starts from the base) */
class XfView {
  xf = new Uint32Array(XF_SIZE);
  private gen = -1;
  private pos = 0;
  at(sh: Shared, gen: number, pos: number): Uint32Array {
    const xf = this.xf, L = sh.xfLog;
    if (gen !== this.gen || pos < this.pos) { xf.set(sh.xfBase); this.gen = gen; this.pos = 0; }
    let p = this.pos;
    while (p < pos) { const a = L[p], n = L[p + 1]; xf.set(L.subarray(p + 2, p + 2 + n), a); p += 2 + n; }
    this.pos = p;
    return xf;
  }
}

/** a thread's own decoder for raw jobs: the layouts by vertex attribute table entry (made again when one of the five words they depend on
 *  changes, as gpu.ts does), the decoded vertices */
class RawDecoder {
  vd = new VertexData(null as never);
  private layouts: ({ l: VertexLayout; w0: number; w1: number; w2: number; w3: number; w4: number } | null)[] = Array(8).fill(null);
  private dflt = [0, 0, 0, 0, 0, 0, 0, 0];
  /** the vertices of raw job at b, decoded as gpu.ts decodes a run (VertexData.add over the command bytes) */
  decode(sh: Shared, b: number, xf: Uint32Array): VertexData {
    const J = sh.jobs, vat = J[b + J_LAY0], n = J[b + J_NV];
    const cp = sh.inU.subarray(J[b + J_CP], J[b + J_CP] + 256);
    const w0 = cp[0x50], w1 = cp[0x60], w2 = cp[0x70 + vat], w3 = cp[0x80 + vat], w4 = cp[0x90 + vat];
    let c = this.layouts[vat];
    if (!c || c.w0 !== w0 || c.w1 !== w1 || c.w2 !== w2 || c.w3 !== w3 || c.w4 !== w4) c = this.layouts[vat] = { l: vertexLayout(cp, vat), w0, w1, w2, w3, w4 };
    const d = this.dflt;
    d[0] = bits(xf[0x1018], 6, 6); d[1] = bits(xf[0x1018], 12, 6); d[2] = bits(xf[0x1018], 18, 6); d[3] = bits(xf[0x1018], 24, 6);
    d[4] = bits(xf[0x1019], 0, 6); d[5] = bits(xf[0x1019], 6, 6); d[6] = bits(xf[0x1019], 12, 6); d[7] = bits(xf[0x1019], 18, 6);
    this.vd.setup(c.l, bits(xf[0x1018], 0, 6), d);
    if (n > 0) this.vd.add(sh.inB, J[b + J_VOFF] * 4, n, cp, sh.mem, sh.memView);
    return this.vd;
  }
}

/** run job j (its inputs are in the shared buffer) into lq */
function runJob(sh: Shared, ctx: FrontCtx, rd: RawDecoder, xv: XfView, lq: Growable, j: number, again = false): void {
  const J = sh.jobs, b = (j % sh.cfg.maxJobs) * JW;
  const np = J[b + J_NPRIMS], pa = J[b + J_PRIMS];
  const prims: { type: number; base: number; count: number }[] = [];
  for (let i = 0; i < np; i++) prims.push({ type: sh.inI[pa + 3 * i], base: sh.inI[pa + 3 * i + 1], count: sh.inI[pa + 3 * i + 2] });
  const regs: FrontRegs = { bp: sh.inU.subarray(J[b + J_BP], J[b + J_BP] + 256), xf: xv.at(sh, J[b + J_XFGEN], J[b + J_XF]) };
  if (J[b + J_KIND] === 1) {
    const vd = rd.decode(sh, b, regs.xf);
    // (the memory mirror may change from here on: gl.ts waits for this count before it writes the mirror; a job made again is counted once)
    if (!again) Atomics.add(sh.ctl, C_DECODED, 1);
    lq.n = 0;
    zInfo.wrote = false;
    ctx.run(regs, vd, prims, J[b + J_ST], lq);
    return;
  }
  const lo = J[b + J_LAY0], hi = J[b + J_LAY1], n = J[b + J_NV];
  const pl = plan(lo, hi, n, J[b + J_VOFF]);
  const F = sh.inF;
  const vd = {
    n, layout: layoutOf(lo, hi),
    pos: F.subarray(pl.pos, pl.pos + 3 * n), pmtx: F.subarray(pl.pmtx, pl.pmtx + n),
    nrm: pl.nrm >= 0 ? F.subarray(pl.nrm, pl.nrm + 3 * n) : EMPTY_F,
    nrm1: pl.nrm1 >= 0 ? F.subarray(pl.nrm1, pl.nrm1 + 3 * n) : EMPTY_F, nrm2: pl.nrm2 >= 0 ? F.subarray(pl.nrm2, pl.nrm2 + 3 * n) : EMPTY_F,
    col: [pl.col[0] >= 0 ? sh.inB.subarray(pl.col[0] * 4, pl.col[0] * 4 + 4 * n) : EMPTY_B, pl.col[1] >= 0 ? sh.inB.subarray(pl.col[1] * 4, pl.col[1] * 4 + 4 * n) : EMPTY_B],
    tex: pl.tex.map((o) => (o >= 0 ? F.subarray(o, o + 2 * n) : EMPTY_F)),
    tmtx: pl.tmtx.map((o) => (o >= 0 ? F.subarray(o, o + n) : EMPTY_F)),
  } as unknown as VertexData;
  lq.n = 0;
  zInfo.wrote = false;
  ctx.run(regs, vd, prims, J[b + J_ST], lq);
}

const zTmp = new Float32Array(3);

/** run job j on this thread and leave its words in the output area, and their tile entries (bin.ts, the triangles' texel offsets in the
 *  output area: a pass's data starts with the output area) in the entry area */
function doJob(sh: Shared, ctx: FrontCtx, rd: RawDecoder, xv: XfView, lq: Growable, le: Entries, j: number): void {
  runJob(sh, ctx, rd, xv, lq, j);
  const J = sh.jobs, b = (j % sh.cfg.maxJobs) * JW;
  const len = lq.n;
  const off = len ? Atomics.add(sh.ctl, C_OUT, len) : 0;
  let over = off + len > sh.cfg.outWords;
  if (!over) {
    sh.out.set(lq.words.subarray(0, len), off);
    le.n = 0;
    const tris = len ? binTriangles(lq.ints, lq.words, len, off >> 2, le) : 0;
    const eoff = le.n ? Atomics.add(sh.ctl, C_ENT, le.n) : 0;
    over = eoff + le.n > sh.cfg.entWords;
    if (!over) {
      sh.ent.set(le.a.subarray(0, le.n), eoff);
      J[b + J_OUT] = off; J[b + J_OUTLEN] = len; J[b + J_ENT] = eoff; J[b + J_NENT] = le.n; J[b + J_TRIS] = tris; J[b + J_OVER] = 0;
    }
  }
  if (over) { J[b + J_OVER] = 1; if (J[b + J_KIND] === 1) Atomics.add(sh.ctl, C_RAWOVER, 1); }
  J[b + J_ZFLAG] = zInfo.wrote ? 1 : 0;
  if (zInfo.wrote) { getLastZ(zTmp); sh.jobsF[b + J_Z] = zTmp[0]; sh.jobsF[b + J_Z + 1] = zTmp[1]; sh.jobsF[b + J_Z + 2] = zTmp[2]; }
  Atomics.add(sh.ctl, C_DONE, 1);
}

/** claim the next job, or -1 */
function claim(sh: Shared): number {
  const tail = Atomics.load(sh.ctl, C_TAIL);
  const h = Atomics.load(sh.ctl, C_HEAD);
  if (h < tail && Atomics.compareExchange(sh.ctl, C_HEAD, h, h + 1) === h) return h;
  return -1;
}

/** the worker thread's loop (frontworker.ts) */
export function workerMain(sab: SharedArrayBuffer, cfg: PoolConfig, memSab: SharedArrayBuffer): void {
  const sh = new Shared(sab, cfg, memSab);
  const ctx = new FrontCtx(), rd = new RawDecoder(), xv = new XfView(), lq = new Growable(), le = new Entries();
  Atomics.add(sh.ctl, C_STARTED, 1);
  let idle = 0;
  for (;;) {
    if (Atomics.load(sh.ctl, C_STOP)) return;
    const j = claim(sh);
    if (j >= 0) { doJob(sh, ctx, rd, xv, lq, le, j); Atomics.add(sh.ctl, C_WJOBS, 1); idle = 0; continue; }
    // draws come a few tens of microseconds apart: look for the next one for a moment before sleeping (a sleeping worker costs the main thread a wake-up call)
    if (++idle < 3000) continue;
    Atomics.add(sh.ctl, C_SLEEPERS, 1);
    const tail = Atomics.load(sh.ctl, C_TAIL);
    if (Atomics.load(sh.ctl, C_HEAD) >= tail) Atomics.wait(sh.ctl, C_TAIL, tail);
    Atomics.sub(sh.ctl, C_SLEEPERS, 1);
    idle = 0;
  }
}

export class FrontPool {
  private sh: Shared;
  private workers: Worker[] = [];
  private ctx = new FrontCtx();
  private rd = new RawDecoder();
  private xv = new XfView();
  private lq = new Growable();
  private le = new Entries();
  /** raw jobs published (C_DECODED counts those decoded) */
  private rawSubmitted = 0;
  /** jobs from `base` on are not merged yet */
  private base = 0;
  private tail = 0;
  private inUsed = 0;
  /** the XF base published for this drain's jobs (gen), the regs it is of, its log's end, and the version that end is at */
  private xfGen = 0;
  private xfBased = false;
  private xfRegs: XfRegs | null = null;
  private xfLogN = 0;
  private xfVersion = -1;
  /** the inputs' last BP and CP copies (a job whose registers are the same names them again) */
  private bpAt = -1;
  private cpAt = -1;
  /** the depth plane the last merged job left (for draws that run on the main thread), when there was one */
  zPlane: Float32Array | null = null;
  /** set by `drain` when a merged job left a depth plane (`zPlane`); the caller clears it */
  zFresh = false;
  /** jobs run by the main thread while it waited, and jobs published, and the ms it waited */
  stats = { mainJobs: 0, jobs: 0, waitMs: 0, mergeMs: 0, rawJobs: 0, memWrites: 0, memWaits: 0, memWaitMs: 0 };

  static available(): boolean {
    // a page has `crossOriginIsolated` (false unless its headers allow shared buffers); outside a page it is not defined and shared buffers just work
    return typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
  }

  constructor(count: number, factory: () => Worker, cfg: PoolConfig = DEFAULT_POOL) {
    const sab = new SharedArrayBuffer(Shared.layout(cfg).words * 4), memSab = new SharedArrayBuffer(MEM_SIZE);
    this.sh = new Shared(sab, cfg, memSab);
    for (let i = 0; i < count; i++) {
      const w = factory();
      w.onerror = (e) => console.error("front worker: " + e.message);
      w.postMessage({ sab, cfg, memSab });
      this.workers.push(w);
    }
  }

  dispose(): void {
    Atomics.store(this.sh.ctl, C_STOP, 1);
    Atomics.notify(this.sh.ctl, C_TAIL);
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  /** jobs the worker threads have run, and how many of them have started (a worker counts in [9] when its loop begins) */
  get workerJobs(): number { return Atomics.load(this.sh.ctl, C_WJOBS); }
  get workersStarted(): number { return Atomics.load(this.sh.ctl, C_STARTED); }

  /** the output area or the entry area is half full: the caller draws a pass (a pass's data is the output area; resetOut starts it over) */
  get outFull(): boolean { const sh = this.sh; return Atomics.load(sh.ctl, C_OUT) > sh.cfg.outWords / 2 || Atomics.load(sh.ctl, C_ENT) > sh.cfg.entWords / 2; }
  /** words of the output area in use (at most its size), after a drain */
  get outUsed(): number { return Math.min(Atomics.load(this.sh.ctl, C_OUT), this.sh.cfg.outWords); }
  /** the first n words of the output area */
  outView(n: number): Uint32Array { return this.sh.out.subarray(0, n); }
  /** the output and entry areas start over (after a drain, once a pass has taken the words) */
  resetOut(): void {
    if (this.tail !== this.base) throw new Error("the output area started over with jobs outstanding");
    Atomics.store(this.sh.ctl, C_OUT, 0); Atomics.store(this.sh.ctl, C_ENT, 0);
  }

  /** whether jobs are outstanding */
  get busy(): boolean { return this.tail > this.base; }

  /** the XF unit as the next job sees it: the base (after a drain, or for other registers) or the log of the ranges loaded since */
  private publishXf(regs: XfRegs, onFull: () => void): void {
    const sh = this.sh;
    if (this.xfBased && (regs !== this.xfRegs || regs.xfLogLost)) this.rebase(onFull);
    if (!this.xfBased) {
      sh.xfBase.set(regs.xf.subarray(0, XF_SIZE));
      this.xfGen++; this.xfLogN = 0; this.xfBased = true; this.xfRegs = regs;
      regs.xfLog = regs.xfLog ?? []; regs.xfLog.length = 0; regs.xfLogLost = false;
      this.xfVersion = regs.xfVersion;
      return;
    }
    if (regs.xfVersion === this.xfVersion) return;
    const R = regs.xfLog!, L = sh.xfLog;
    let need = 0;
    for (let i = 0; i < R.length; i += 2) need += 2 + R[i + 1];
    if (this.xfLogN + need > sh.cfg.xfLogWords) { this.rebase(onFull); this.publishXf(regs, onFull); return; }
    let w = this.xfLogN;
    for (let i = 0; i < R.length; i += 2) {
      const a = R[i], n = Math.min(R[i + 1], XF_SIZE - a);
      if (n <= 0) continue;
      L[w] = a; L[w + 1] = n; L.set(regs.xf.subarray(a, a + n), w + 2);
      w += 2 + n;
    }
    this.xfLogN = w;
    R.length = 0;
    this.xfVersion = regs.xfVersion;
  }

  /** the next job gets a new XF base: the jobs published are drained first (they read the one there) */
  private rebase(onFull: () => void): void {
    if (this.busy) onFull();
    if (this.busy) throw new Error("the XF base would change under published jobs");
    this.xfBased = false;
  }

  /** 256 register words into the inputs, or the last copy's place when they are the same words */
  private regsAt(src: Uint32Array, last: number): number {
    const I = this.sh.inU;
    if (last >= 0) {
      let same = true;
      for (let i = 0; i < 256; i++) if (I[last + i] !== src[i]) { same = false; break; }
      if (same) return last;
    }
    const at = this.inUsed;
    I.set(src.subarray(0, 256), at);
    this.inUsed = at + 256;
    return at;
  }

  /** publish a draw; `onFull` drains when the buffer is full */
  submit(regs: XfRegs & { bp: Uint32Array }, vd: VertexData, prims: { type: number; base: number; count: number }[], st: number, onFull: () => void): void {
    const sh = this.sh, n = vd.n;
    const [lo, hi] = layoutBits(vd.layout);
    const need = 256 + 3 * prims.length + plan(lo, hi, n, 0).end;
    if (this.tail - this.base >= sh.cfg.maxJobs || this.inUsed + need > sh.cfg.inWords) onFull();
    this.publishXf(regs, onFull);
    const bpAt = this.bpAt = this.regsAt(regs.bp, this.bpAt);
    let w = this.inUsed;
    const primAt = w;
    for (let i = 0; i < prims.length; i++) { sh.inI[w++] = prims[i].type; sh.inI[w++] = prims[i].base; sh.inI[w++] = prims[i].count; }
    const vAt = w;
    const p = plan(lo, hi, n, vAt);
    const F = sh.inF;
    F.set(vd.pos.subarray(0, 3 * n), p.pos); F.set(vd.pmtx.subarray(0, n), p.pmtx);
    if (p.nrm >= 0) F.set(vd.nrm.subarray(0, 3 * n), p.nrm);
    if (p.nrm1 >= 0) { F.set(vd.nrm1.subarray(0, 3 * n), p.nrm1); F.set(vd.nrm2.subarray(0, 3 * n), p.nrm2); }
    for (let c = 0; c < 2; c++) if (p.col[c] >= 0) sh.inB.set(vd.col[c].subarray(0, 4 * n), p.col[c] * 4);
    for (let t = 0; t < 8; t++) {
      if (p.tex[t] >= 0) F.set(vd.tex[t].subarray(0, 2 * n), p.tex[t]);
      if (p.tmtx[t] >= 0) F.set(vd.tmtx[t].subarray(0, n), p.tmtx[t]);
    }
    this.inUsed = p.end;
    const J = sh.jobs, b = (this.tail % sh.cfg.maxJobs) * JW;
    J[b + J_LAY0] = lo; J[b + J_LAY1] = hi; J[b + J_XF] = this.xfLogN; J[b + J_XFGEN] = this.xfGen; J[b + J_BP] = bpAt; J[b + J_NV] = n; J[b + J_VOFF] = vAt;
    J[b + J_PRIMS] = primAt; J[b + J_NPRIMS] = prims.length; J[b + J_ST] = st; J[b + J_OVER] = 0; J[b + J_OUTLEN] = 0; J[b + J_ZFLAG] = 0;
    J[b + J_KIND] = 0;
    this.tail++;
    Atomics.store(sh.ctl, C_TAIL, this.tail);
    // only a worker that went to sleep needs a call
    if (Atomics.load(sh.ctl, C_SLEEPERS) > 0) Atomics.notify(sh.ctl, C_TAIL, 1);
  }

  /** publish a draw whose vertices are still the command bytes (`segs`: the command's bytes, the offset of its first vertex, its vertex
   *  count, for each draw command of the run; `size` bytes a vertex): the thread that runs it decodes them (RawDecoder), reading the
   *  memory mirror for the indexed attributes. `onFull` drains when the buffer is full. */
  submitRaw(regs: XfRegs & { bp: Uint32Array; cp: Uint32Array }, vat: number, size: number, n: number, segs: (Uint8Array | number)[], prims: { type: number; base: number; count: number }[], st: number, onFull: () => void): void {
    const sh = this.sh;
    const need = 512 + 3 * prims.length + ((n * size + 3) >> 2);
    if (this.tail - this.base >= sh.cfg.maxJobs || this.inUsed + need > sh.cfg.inWords) onFull();
    this.publishXf(regs, onFull);
    const bpAt = this.bpAt = this.regsAt(regs.bp, this.bpAt);
    const cpAt = this.cpAt = this.regsAt(regs.cp, this.cpAt);
    let w = this.inUsed;
    const primAt = w;
    for (let i = 0; i < prims.length; i++) { sh.inI[w++] = prims[i].type; sh.inI[w++] = prims[i].base; sh.inI[w++] = prims[i].count; }
    const vAt = w;
    let o = vAt * 4;
    const B = sh.inB;
    for (let i = 0; i < segs.length; i += 3) {
      const data = segs[i] as Uint8Array, at = segs[i + 1] as number, len = (segs[i + 2] as number) * size;
      B.set(data.subarray(at, at + len), o);
      o += len;
    }
    this.inUsed = (o + 3) >> 2;
    const J = sh.jobs, b = (this.tail % sh.cfg.maxJobs) * JW;
    J[b + J_LAY0] = vat; J[b + J_LAY1] = 0; J[b + J_XF] = this.xfLogN; J[b + J_XFGEN] = this.xfGen; J[b + J_BP] = bpAt; J[b + J_NV] = n; J[b + J_VOFF] = vAt;
    J[b + J_PRIMS] = primAt; J[b + J_NPRIMS] = prims.length; J[b + J_ST] = st; J[b + J_OVER] = 0; J[b + J_OUTLEN] = 0; J[b + J_ZFLAG] = 0;
    J[b + J_KIND] = 1; J[b + J_CP] = cpAt;
    this.rawSubmitted++;
    this.stats.rawJobs++;
    this.tail++;
    Atomics.store(sh.ctl, C_TAIL, this.tail);
    if (Atomics.load(sh.ctl, C_SLEEPERS) > 0) Atomics.notify(sh.ctl, C_TAIL, 1);
  }

  /** Before the memory mirror changes: every raw job published has decoded its vertices (this thread helps with the jobs meanwhile).
   *  Returns true when a raw job's output did not fit (drain() would make its words again from the mirror): the caller drains first. */
  private beforeMirrorWrite(): boolean {
    const sh = this.sh;
    if (Atomics.load(sh.ctl, C_DECODED) < this.rawSubmitted) {
      const t0 = performance.now();
      this.stats.memWaits++;
      while (Atomics.load(sh.ctl, C_DECODED) < this.rawSubmitted) {
        const j = claim(sh);
        if (j >= 0) { doJob(sh, this.ctx, this.rd, this.xv, this.lq, this.le, j); this.stats.mainJobs++; }
      }
      this.stats.memWaitMs += performance.now() - t0;
    }
    if (Atomics.load(sh.ctl, C_RAWOVER) === 0) return false;
    // (a raw job that has not finished may still find the output area full: wait for every job, then let the caller drain)
    while (Atomics.load(sh.ctl, C_DONE) < this.tail) {
      const j = claim(sh);
      if (j >= 0) { doJob(sh, this.ctx, this.rd, this.xv, this.lq, this.le, j); this.stats.mainJobs++; }
    }
    return true;
  }

  /** bytes [a, a + n) of `src` (a memory of MEM_SIZE bytes) into the mirror; `drainFirst` is called when published jobs must be drained before */
  writeMirror(src: Uint8Array, a: number, n: number, drainFirst: () => void): void {
    this.stats.memWrites++;
    if (this.beforeMirrorWrite()) drainFirst();
    const end = Math.min(a + n, MEM_SIZE);
    if (end > a) this.sh.mem.set(src.subarray(a, end), a);
  }

  /** wait for every published job (helping with them), then hand the outputs over in draw order and start the inputs over: each job's
   *  tile entries and its triangle count (its words stay in the output area), or, for a job whose output did not fit, its words (made
   *  again here: the caller queues and bins them) */
  drain(entries: (entries: Int32Array, tris: number, words: Uint32Array) => void, words: (words: Uint32Array) => void): void {
    const sh = this.sh;
    if (this.tail === this.base) return;
    const target = this.tail;
    const t0 = performance.now();
    this.stats.jobs += target - this.base;
    for (;;) {
      const j = claim(sh);
      if (j >= 0) { doJob(sh, this.ctx, this.rd, this.xv, this.lq, this.le, j); this.stats.mainJobs++; continue; }
      if (Atomics.load(sh.ctl, C_DONE) >= target) break;
    }
    const t1 = performance.now();
    this.stats.waitMs += t1 - t0;
    for (let j = this.base; j < target; j++) {
      const b = (j % sh.cfg.maxJobs) * JW;
      if (sh.jobs[b + J_OVER]) {
        // the output area was full: run it again here (its inputs are still in the buffer)
        runJob(sh, this.ctx, this.rd, this.xv, this.lq, j, true);
        words(this.lq.words.subarray(0, this.lq.n));
        if (zInfo.wrote) { this.zPlane = this.zPlane ?? new Float32Array(3); getLastZ(this.zPlane); this.zFresh = true; }
      } else {
        const e = sh.jobs[b + J_ENT], o = sh.jobs[b + J_OUT];
        entries(sh.ent.subarray(e, e + sh.jobs[b + J_NENT]), sh.jobs[b + J_TRIS], sh.out.subarray(o, o + sh.jobs[b + J_OUTLEN]));
        if (sh.jobs[b + J_ZFLAG]) { this.zPlane = this.zPlane ?? new Float32Array(3); this.zPlane[0] = sh.jobsF[b + J_Z]; this.zPlane[1] = sh.jobsF[b + J_Z + 1]; this.zPlane[2] = sh.jobsF[b + J_Z + 2]; this.zFresh = true; }
      }
    }
    this.stats.mergeMs += performance.now() - t1;
    this.base = target;
    this.inUsed = 0; this.xfBased = false; this.bpAt = -1; this.cpAt = -1;
    Atomics.store(sh.ctl, C_RAWOVER, 0);
  }
}
