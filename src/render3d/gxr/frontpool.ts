/// <reference lib="dom" />
/* GX renderer: the front half of the draws on worker threads.
 *
 * The main thread decodes the stream; for each draw it copies what the front half reads (the XF unit, BP, the decoded vertices, the primitives)
 * into a shared buffer and publishes a job; worker threads (and the main thread, while it waits) run `FrontCtx.run` on the jobs and leave the
 * words of the triangles in a shared output area. The main thread takes the outputs in draw order (`drain`) when the pass has to be drawn, so
 * the queue holds exactly the words one thread would have made: the same code runs everywhere, and nothing here depends on the order the jobs
 * finish in. Needs a shared buffer (a page that is cross-origin isolated); `FrontPool.available()` says.
 *
 * The buffer: control words, the job table, the XF unit's copies (one per change), the inputs and the outputs. Jobs are numbered
 * from the start of the page, a job sits in slot number % maxJobs, and the inputs and outputs are bump-allocated and start over at each drain.
 */
import { binTriangles, Entries } from "./bin";
import { FrontCtx, FrontRegs, Growable } from "./front";
import { getLastZ, zInfo } from "./setup";
import { XF_SIZE } from "./state";
import type { VertexData, VertexLayout } from "./vertex";

const C_HEAD = 0, C_TAIL = 1, C_DONE = 2, C_OUT = 3, C_STOP = 4, C_SLEEPERS = 10;
const CTL_WORDS = 16;
const JW = 20;
const J_LAY0 = 0, J_LAY1 = 1, J_XF = 2, J_BP = 3, J_NV = 4, J_VOFF = 5, J_PRIMS = 6, J_NPRIMS = 7, J_ST = 8, J_OUT = 9, J_OUTLEN = 10, J_ZFLAG = 11, J_Z = 12, J_OVER = 15;
// (the job's tile entries follow its words in the output area: J_NENT words of them, for J_TRIS triangles: bin.ts)
const J_NENT = 16, J_TRIS = 17;

export interface PoolConfig { maxJobs: number; xfSlots: number; inWords: number; outWords: number }
export const DEFAULT_POOL: PoolConfig = { maxJobs: 512, xfSlots: 512, inWords: 1 << 23, outWords: 1 << 24 };

class Shared {
  ctl: Int32Array;
  jobs: Int32Array;
  jobsF: Float32Array;
  xf: Uint32Array;
  inU: Uint32Array;
  inI: Int32Array;
  inF: Float32Array;
  inB: Uint8Array;
  out: Uint32Array;
  constructor(public sab: SharedArrayBuffer, public cfg: PoolConfig) {
    const l = Shared.layout(cfg);
    this.ctl = new Int32Array(sab, 0, CTL_WORDS);
    this.jobs = new Int32Array(sab, l.jobsAt * 4, cfg.maxJobs * JW);
    this.jobsF = new Float32Array(sab, l.jobsAt * 4, cfg.maxJobs * JW);
    this.xf = new Uint32Array(sab, l.xfAt * 4, cfg.xfSlots * XF_SIZE);
    this.inU = new Uint32Array(sab, l.inAt * 4, cfg.inWords);
    this.inI = new Int32Array(sab, l.inAt * 4, cfg.inWords);
    this.inF = new Float32Array(sab, l.inAt * 4, cfg.inWords);
    this.inB = new Uint8Array(sab, l.inAt * 4, cfg.inWords * 4);
    this.out = new Uint32Array(sab, l.outAt * 4, cfg.outWords);
  }
  static layout(cfg: PoolConfig): { jobsAt: number; xfAt: number; inAt: number; outAt: number; words: number } {
    const jobsAt = CTL_WORDS, xfAt = jobsAt + cfg.maxJobs * JW, inAt = xfAt + cfg.xfSlots * XF_SIZE, outAt = inAt + cfg.inWords;
    return { jobsAt, xfAt, inAt, outAt, words: outAt + cfg.outWords };
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

/** run job j (its inputs are in the shared buffer) into lq */
function runJob(sh: Shared, ctx: FrontCtx, lq: Growable, j: number): void {
  const J = sh.jobs, b = (j % sh.cfg.maxJobs) * JW;
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
  const np = J[b + J_NPRIMS], pa = J[b + J_PRIMS];
  const prims: { type: number; base: number; count: number }[] = [];
  for (let i = 0; i < np; i++) prims.push({ type: sh.inI[pa + 3 * i], base: sh.inI[pa + 3 * i + 1], count: sh.inI[pa + 3 * i + 2] });
  const slot = J[b + J_XF];
  const regs: FrontRegs = { bp: sh.inU.subarray(J[b + J_BP], J[b + J_BP] + 256), xf: sh.xf.subarray(slot * XF_SIZE, (slot + 1) * XF_SIZE) };
  lq.n = 0;
  zInfo.wrote = false;
  ctx.run(regs, vd, prims, J[b + J_ST], lq);
}

const zTmp = new Float32Array(3);

/** run job j on this thread and leave its words, then their tile entries (bin.ts, triangle offsets from the job's first word), in the output area */
function doJob(sh: Shared, ctx: FrontCtx, lq: Growable, le: Entries, j: number): void {
  runJob(sh, ctx, lq, j);
  const J = sh.jobs, b = (j % sh.cfg.maxJobs) * JW;
  const len = lq.n;
  le.n = 0;
  const tris = binTriangles(lq.ints, lq.words, len, 0, le);
  const off = Atomics.add(sh.ctl, C_OUT, len + le.n);
  if (off + len + le.n > sh.cfg.outWords) J[b + J_OVER] = 1;
  else {
    sh.out.set(lq.words.subarray(0, len), off);
    sh.out.set(new Uint32Array(le.a.buffer, 0, le.n), off + len);
    J[b + J_OUT] = off; J[b + J_OUTLEN] = len; J[b + J_NENT] = le.n; J[b + J_TRIS] = tris; J[b + J_OVER] = 0;
  }
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
export function workerMain(sab: SharedArrayBuffer, cfg: PoolConfig): void {
  const sh = new Shared(sab, cfg);
  const ctx = new FrontCtx(), lq = new Growable(), le = new Entries();
  Atomics.add(sh.ctl, 9, 1);
  let idle = 0;
  for (;;) {
    if (Atomics.load(sh.ctl, C_STOP)) return;
    const j = claim(sh);
    if (j >= 0) { doJob(sh, ctx, lq, le, j); Atomics.add(sh.ctl, 8, 1); idle = 0; continue; }
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
  private lq = new Growable();
  private le = new Entries();
  /** jobs from `base` on are not merged yet */
  private base = 0;
  private tail = 0;
  private inUsed = 0;
  private xfUsed = 0;
  private xfVersion = -1;
  private xfSlot = -1;
  /** the depth plane the last merged job left (for draws that run on the main thread), when there was one */
  zPlane: Float32Array | null = null;
  /** set by `drain` when a merged job left a depth plane (`zPlane`); the caller clears it */
  zFresh = false;
  /** jobs run by the main thread while it waited, and jobs published, and the ms it waited */
  stats = { mainJobs: 0, jobs: 0, waitMs: 0, mergeMs: 0 };

  static available(): boolean {
    // a page has `crossOriginIsolated` (false unless its headers allow shared buffers); outside a page it is not defined and shared buffers just work
    return typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
  }

  constructor(count: number, factory: () => Worker, cfg: PoolConfig = DEFAULT_POOL) {
    const sab = new SharedArrayBuffer(Shared.layout(cfg).words * 4);
    this.sh = new Shared(sab, cfg);
    for (let i = 0; i < count; i++) {
      const w = factory();
      w.onerror = (e) => console.error("front worker: " + e.message);
      w.postMessage({ sab, cfg });
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
  get workerJobs(): number { return Atomics.load(this.sh.ctl, 8); }
  get workersStarted(): number { return Atomics.load(this.sh.ctl, 9); }

  /** whether jobs are outstanding */
  get busy(): boolean { return this.tail > this.base; }

  /** publish a draw; `onFull` drains when the buffer is full */
  submit(regs: { bp: Uint32Array; xf: Uint32Array; xfVersion: number }, vd: VertexData, prims: { type: number; base: number; count: number }[], st: number, onFull: () => void): void {
    const sh = this.sh, n = vd.n;
    const [lo, hi] = layoutBits(vd.layout);
    const need = 256 + 3 * prims.length + plan(lo, hi, n, 0).end;
    if (this.tail - this.base >= sh.cfg.maxJobs || this.inUsed + need > sh.cfg.inWords || this.xfUsed >= sh.cfg.xfSlots || Atomics.load(sh.ctl, C_OUT) > sh.cfg.outWords / 2) onFull();
    if (this.xfSlot < 0 || this.xfVersion !== regs.xfVersion) {
      this.xfSlot = this.xfUsed++;
      sh.xf.set(regs.xf.subarray(0, XF_SIZE), this.xfSlot * XF_SIZE);
      this.xfVersion = regs.xfVersion;
    }
    let w = this.inUsed;
    const bpAt = w;
    sh.inU.set(regs.bp.subarray(0, 256), w); w += 256;
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
    J[b + J_LAY0] = lo; J[b + J_LAY1] = hi; J[b + J_XF] = this.xfSlot; J[b + J_BP] = bpAt; J[b + J_NV] = n; J[b + J_VOFF] = vAt;
    J[b + J_PRIMS] = primAt; J[b + J_NPRIMS] = prims.length; J[b + J_ST] = st; J[b + J_OVER] = 0; J[b + J_OUTLEN] = 0; J[b + J_ZFLAG] = 0;
    this.tail++;
    Atomics.store(sh.ctl, C_TAIL, this.tail);
    // only a worker that went to sleep needs a call
    if (Atomics.load(sh.ctl, C_SLEEPERS) > 0) Atomics.notify(sh.ctl, C_TAIL, 1);
  }

  /** wait for every published job (helping with them), then hand the outputs over in draw order and start the buffers over: each job's
   *  words, and its tile entries with their triangle count (null when they were not made: the caller bins the words) */
  drain(merge: (words: Uint32Array, entries: Int32Array | null, tris: number) => void): void {
    const sh = this.sh;
    if (this.tail === this.base) return;
    const target = this.tail;
    const t0 = performance.now();
    this.stats.jobs += target - this.base;
    for (;;) {
      const j = claim(sh);
      if (j >= 0) { doJob(sh, this.ctx, this.lq, this.le, j); this.stats.mainJobs++; continue; }
      if (Atomics.load(sh.ctl, C_DONE) >= target) break;
    }
    const t1 = performance.now();
    this.stats.waitMs += t1 - t0;
    for (let j = this.base; j < target; j++) {
      const b = (j % sh.cfg.maxJobs) * JW;
      if (sh.jobs[b + J_OVER]) {
        // the output area was full: run it again here (its inputs are still in the buffer)
        runJob(sh, this.ctx, this.lq, j);
        merge(this.lq.words.subarray(0, this.lq.n), null, 0);
        if (zInfo.wrote) { this.zPlane = this.zPlane ?? new Float32Array(3); getLastZ(this.zPlane); this.zFresh = true; }
      } else {
        const o = sh.jobs[b + J_OUT], len = sh.jobs[b + J_OUTLEN];
        merge(sh.out.subarray(o, o + len), new Int32Array(sh.out.buffer, sh.out.byteOffset + (o + len) * 4, sh.jobs[b + J_NENT]), sh.jobs[b + J_TRIS]);
        if (sh.jobs[b + J_ZFLAG]) { this.zPlane = this.zPlane ?? new Float32Array(3); this.zPlane[0] = sh.jobsF[b + J_Z]; this.zPlane[1] = sh.jobsF[b + J_Z + 1]; this.zPlane[2] = sh.jobsF[b + J_Z + 2]; this.zFresh = true; }
      }
    }
    this.stats.mergeMs += performance.now() - t1;
    this.base = target;
    this.inUsed = 0; this.xfUsed = 0; this.xfSlot = -1;
    Atomics.store(sh.ctl, C_OUT, 0);
  }
}
