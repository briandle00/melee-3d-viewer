/* A replay played through the game's own draw path: the simulator's graphics build steps the match and runs the game's display pass
 * (core.ts), and the GX renderer (gxr/) draws the stream it hands back. This holds the two together and keeps their order:
 * row i of the tape is stepped, its stream and new memory go to the renderer, and the picture that frame copies to the screen is
 * the frame shown.
 *
 * Seeking (when the module can restart its stream and the renderer can be reset; otherwise the match is started again and played forward
 * through the renderer without drawing), as a host app's player may do: going far forward steps the simulator alone,
 * then starts the stream again LEAD rows before the target (msl_gxw_restart_stream: every register file and memory block sent again) on
 * the renderer started fresh, and draws those rows, so the screens that show the game's own earlier pictures are as the game had them.
 * Going back rewinds the module to a checkpoint: the memory pages the match changed since its first row (64 KiB pages, a hash each),
 * kept a little before the rows sought to (so a frame back or two seconds back finds one near); rewinding writes back the checkpoint's
 * pages and, for every page changed since that it does not hold, the page as it was after the first row (kept once seen; the first
 * rewind that needs one it does not have opens the match again for it).
 * Starting the match again puts the module back to its state right after the game files loaded (GxCore.rewind) and opens the match
 * again, in milliseconds; a fresh instance only when the module cannot be put back.
 *
 * The renderer is anything with gxr's GxBackend (the CPU reference, the WebGL one); its methods used here are listed in SessionBackend below.
 */
import { GxGpu } from "../gxr/gpu";
import type { Dff, GxFrame } from "../gxr/dff";
import type { GxBackend } from "../gxr/gpu";
import { differs } from "../../sim/compare";
import { driveOrder, type DriveOptions, type Tape } from "../../sim/tape";
import { fitCstick, type RawC } from "./cfit";
import { GxCore, type GxCoreFactory, type PlaybackMode } from "./core";
import { nativeRow, nativeTape } from "./tapebridge";

/** what the session needs of a renderer (CpuBackend, GxGl) */
export interface SessionBackend extends GxBackend {
  /** draws are skipped while this is false (registers and memory stay exact) */
  drawing: boolean;
  /** the frame is only played through: no draws, no copies of the frame buffer */
  fastForward?: boolean;
  /** the picture the game copies to the screen: 640 x 480 RGBA, and its number */
  onPicture: ((rgba: Uint8Array, index: number) => void) | null;
  /** the number of pictures the game has copied to the screen so far */
  pictures: number;
  /** (GxGl) memory the renderer mirrors, before the first frame; and the shaders for the features a stream may need */
  prepareMemory?(mem: unknown, regs: unknown): void;
  /** (GxGl) draw the last picture into the renderer's own canvas, no read-back */
  present?(): void;
  /** back to the state before any frame (GxGl has it) */
  reset?(): void;
  stats?: { cpuMs: number; flushMs: number };
}

export interface GameFiles { names: string[]; files: Map<string, Uint8Array> }

/** rows drawn before a sought row when the stream starts again there (as a host app's player draws them) */
export const SEEK_LEAD = 30;
/** a seek this close ahead is played and drawn */
const NEAR = SEEK_LEAD + 6;
/** checkpoints kept, and rows a checkpoint serves for (none is taken within this many rows after another) */
const KEEP = 10, SPACING = 300;
/** a checkpoint kept for a place sought to is this many rows before the row its stream starts again at, and another SPACING further:
 *  a step back from there, up to two seconds (a player's J key), still finds one near (one kept at that row exactly served that place
 *  alone - a frame further back needs one SEEK_LEAD rows before that frame - and each step back played the match from the first row) */
const BACK = 4 * SEEK_LEAD;
const PAGE = 65536;
interface Checkpoint { row: number; pages: Map<number, Uint8Array> }
/** the module's calls the seek uses (in the builds with them) */
interface SeekWasm { HEAPU8: Uint8Array; _msl_gxw_heap_top?: () => number; _msl_gxw_restart_stream?: () => void }

/** where the frame's time went, ms (the last frame and the means since the match opened) */
export interface FrameTimes { step: number; handoff: number; render: number }

export interface SessionOptions {
  factory: GxCoreFactory;
  /** the module's own options (locateFile, instantiateWasm) */
  coreOptions?: Record<string, unknown>;
  files: GameFiles;
  tape: Tape;
  drive?: DriveOptions;
  /** how the replay is played back (core.ts PlaybackMode; default slippi): fixed for the session, a change is a new session */
  playback?: PlaybackMode;
  /** what the page is doing before the match can start (the C-stick fit of playback original), or null when that is over */
  onProgress?: (text: string | null) => void;
  /** at most this many drive choices are tried when the game parts from the replay (default 3, as the track simulator) */
  maxDrives?: number;
  /** a renderer, made with the way to the GPU's memory it reads (the CPU reference needs it); the same one is used for every restart
   *  when it has reset(), else this is called again */
  makeBackend: (env: () => { mem: Uint8Array; tmem: Uint8Array; tluts: Map<number, Uint8Array> }) => SessionBackend | Promise<SessionBackend>;
}

export class GxSession {
  /** tape rows stepped so far (the frame shown is index - 1) */
  index = 0;
  /** the first row the simulator's game parted from the replay's, and the lane */
  diverged: { row: number; frame: number; lane: string } | null = null;
  /** pictures are read back from the renderer (the CPU reference always; WebGL only for a display that needs the pixels, such as the CRT pass: a read-back waits for the GPU) */
  wantPictures = true;
  /** called with each picture the game copies to the screen (rgba is the renderer's own buffer: copy to keep) */
  onPicture: ((rgba: Uint8Array, row: number) => void) | null = null;
  times: FrameTimes = { step: 0, handoff: 0, render: 0 };
  /** sums over every frame stepped since the match opened */
  totals = { frames: 0, step: 0, handoff: 0, render: 0, streamBytes: 0, regionBytes: 0, maxStep: 0, maxFrame: 0 };
  /** which of the tape's drive choices (UCF switches, arithmetic: tape.ts driveOrder) the match plays, and how far each held */
  driveIndex = 0;
  drivesTried: { index: number; row: number }[] = [];
  private retried = false;
  private core: GxCore | null = null;
  private gpu: GxGpu | null = null;
  private backend: SessionBackend | null = null;
  /** the whole tape the match plays (tapebridge.ts nativeTape), and the C-stick fit made for each drive choice (playback original) */
  private whole: Uint8Array | null = null;
  private fits = new Map<number, RawC | null>();
  /** (playback original) drives and kept trials the C-stick fit took, for the drive choice playing */
  fitStats: { drives: number; flips: number } | null = null;
  private picturedRow = -1;
  private closed = false;
  private firstStepped = false;
  /** the renderer is fed the stream (false while the simulator is stepped alone, a seek on its way) */
  private feeding = true;
  /** page hashes after the first row (the checkpoints' baseline), the pages as they were then, the checkpoints and the rows to keep one at */
  private base: Uint32Array | null = null;
  private basePages = new Map<number, Uint8Array>();
  private checkpoints: Checkpoint[] = [];
  private marks = new Set<number>();
  /** (the checks) rewinds, fresh instances they opened, ms spent hashing the module's memory, rows stepped without the renderer */
  seekStats = { rewinds: 0, fresh: 0, hashMs: 0, simOnly: 0, restarts: 0 };

  constructor(private o: SessionOptions) {}

  get frameCount(): number { return this.o.tape.count; }
  get tape(): Tape { return this.o.tape; }
  get playback(): PlaybackMode { return this.o.playback ?? "slippi"; }
  get core_(): GxCore | null { return this.core; }

  /** The match of `whole` opened, played back `mode`: in `reuse` rewound when it can be (GxCore.rewind: the game data kept from its
   *  first load), else in a fresh instance that loads the game data (GxCore.loadGame). */
  private async openIn(reuse: GxCore | null, whole: Uint8Array, mode: PlaybackMode): Promise<GxCore> {
    let core = reuse;
    if (!core?.rewind()) {
      core?.destroy();
      core = await GxCore.create((opt) => this.o.factory({ ...opt, ...this.o.coreOptions }), this.o.files.files);
      // (and put back to the state the load kept at once: the load's own call frees memory after it keeps the state, so a match opened
      // straight after it has its allocator elsewhere - pages of the match's memory differ from those of every later opening of this
      // instance, which all follow a rewind; the first match is then one of those)
      if (core.loadGame(this.o.files.names)) core.rewind();
    }
    core.openMatch(whole, this.o.files.names, mode);
    return core;
  }

  /** the match from its first row (the module rewound, or a fresh instance; the renderer back to its start) */
  async start(): Promise<void> {
    const { tape, files } = this.o;
    const old = this.core;
    this.core = null;
    const whole = await this.tapeFor(this.driveIndex);
    if (this.closed) { old?.destroy(); return; }
    const core = await this.openIn(old, whole, this.playback);
    if (this.closed) { core.destroy(); return; }
    this.whole = whole;
    this.core = core;
    if (this.backend?.reset) this.backend.reset();
    else this.backend = await this.o.makeBackend(() => {
      const g = this.gpu!;
      return { mem: g.mem.data, tmem: g.regs.tmem, tluts: g.regs.tluts as unknown as Map<number, Uint8Array> };
    });
    const backend = this.backend;
    backend.drawing = false;
    backend.onPicture = this.wantPictures ? (rgba) => { this.onPicture?.(rgba, this.index - 1); } : null;
    // (the register files the stream starts from are taken when the first frame is stepped: row 0 is stepped here and fed first)
    core.step(nativeRow(whole, 0));
    this.firstStepped = true;
    this.gpu = new GxGpu(backend, core.initial() as unknown as Dff);
    backend.prepareMemory?.(this.gpu.mem, this.gpu.regs);
    this.feeding = true;
    this.checkpoints = []; this.marks.clear(); this.basePages.clear();
    // the checkpoints' baseline, the module's pages after the first row: taken here (a pass over the module's memory, a tenth of a
    // second or two), so a far seek forward keeps checkpoints on its way and the first seek back from there is a rewind to one near.
    // (Taken at the first seek back instead, that seek played the match from the first row with the simulator alone: seconds far in
    // the game. The first open is a reopen's match - openIn - so a reopen's pages are this baseline's.)
    this.base = this.canRewind ? this.hashes() : null;
    this.index = 0;
    this.diverged = null;
    this.picturedRow = -1;
    this.totals = { frames: 0, step: 0, handoff: 0, render: 0, streamBytes: 0, regionBytes: 0, maxStep: 0, maxFrame: 0 };
  }

  /** step the next row; draw it (or only keep the renderer's registers and memory exact) */
  step(draw: boolean): boolean {
    const core = this.core, gpu = this.gpu;
    if (!core || !gpu || this.index >= this.frameCount) return false;
    this.atMark();
    const i = this.index;
    const t0 = performance.now();
    if (i === 0 && this.firstStepped) this.firstStepped = false;
    else core.step(nativeRow(this.whole!, i));
    const t1 = performance.now();
    this.index = i + 1;
    this.checkDiverged(i);
    if (!this.feeding) { this.seekStats.simOnly++; return true; }
    const frame: GxFrame = { fifo: core.stream(), updates: core.updates() };
    const t2 = performance.now();
    // (frame 0 sets the registers up and draws nothing, as the reference player's first frame)
    // (frame 0 sets the registers up and draws nothing; a frame only played through for a seek is fast-forwarded: no draws, no copies)
    this.backend!.drawing = i > 0;
    this.backend!.fastForward = !draw;
    const before = this.backend!.pictures;
    gpu.runFrame(frame);
    if (this.backend!.pictures > before) this.picturedRow = i;
    const t3 = performance.now();
    this.times = { step: t1 - t0, handoff: t2 - t1, render: t3 - t2 };
    const T = this.totals;
    T.frames++; T.step += t1 - t0; T.handoff += t2 - t1; T.render += t3 - t2;
    T.streamBytes += frame.fifo.length;
    for (const u of frame.updates) T.regionBytes += u.data.length;
    if (t1 - t0 > T.maxStep) T.maxStep = t1 - t0;
    if (t3 - t0 > T.maxFrame) T.maxFrame = t3 - t0;
    return true;
  }

  private checkDiverged(i: number): void {
    if (i > 0 && !this.diverged) {
      const lane = differs(this.core!.output(), this.o.tape.expected(i));
      if (lane) this.diverged = { row: i, frame: this.o.tape.gameFrame(i), lane };
    }
  }

  // ---- checkpoints and the stream started again ----

  private get wasm(): SeekWasm | null { return (this.core?.mod as unknown as SeekWasm) ?? null; }
  /** the module has the calls and the renderer can start fresh: seeks rewind and restart the stream */
  private get canRewind(): boolean { const m = this.wasm; return !!m && !!m._msl_gxw_heap_top && !!m._msl_gxw_restart_stream && !!this.backend?.reset; }

  /** a hash of each 64 KiB page of the module's memory up to its heap top (four FNV-1a chains over the words in turn, for speed) */
  private hashes(): Uint32Array {
    const t0 = performance.now();
    const m = this.wasm!, top = m._msl_gxw_heap_top!(), n = Math.ceil(top / PAGE), out = new Uint32Array(n);
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
    this.seekStats.hashMs += performance.now() - t0;
    return out;
  }
  private changed(now: Uint32Array): number[] {
    const out: number[] = [], b = this.base!;
    for (let p = 0; p < now.length; p++) if (p >= b.length || now[p] !== b[p]) out.push(p);
    return out;
  }
  private page(p: number): Uint8Array { const h = this.wasm!.HEAPU8; return h.slice(p * PAGE, Math.min((p + 1) * PAGE, h.length)); }

  /** keep a checkpoint at row `row` (before it is stepped) when the match gets there */
  private markAt(row: number): void {
    const near = (r: number) => r <= row && r > row - SPACING;
    if (this.base && row >= 1 && !this.checkpoints.some((c) => near(c.row)) && ![...this.marks].some(near)) this.marks.add(row);
  }
  private atMark(): void { if (this.marks.delete(this.index)) this.checkpoint(); }
  /** checkpoints to keep before row `from`, where the stream starts again for a place sought to: BACK rows before it and SPACING
   *  further (each a pass over the module's memory when the match gets there) */
  private backMarks(from: number): void {
    this.markAt(from - BACK - SPACING);
    this.markAt(from - BACK);
  }
  /** keep the state before row `index` (the next to step) as a checkpoint */
  private checkpoint(): void {
    if (!this.base || this.checkpoints.some((c) => c.row === this.index)) return;
    const pages = new Map<number, Uint8Array>();
    for (const p of this.changed(this.hashes())) pages.set(p, this.page(p));
    this.checkpoints.push({ row: this.index, pages });
    this.checkpoints.sort((a, b) => a.row - b.row);
    while (this.checkpoints.length > KEEP) this.checkpoints.splice(Math.floor(Math.random() * this.checkpoints.length), 1);
  }

  /** the module back to a checkpoint (null: the state after the first row); the renderer is not fed until the stream starts again */
  private async rewind(c: Checkpoint | null): Promise<void> {
    this.seekStats.rewinds++;
    const now = this.changed(this.hashes());
    const want = c ? c.pages : new Map<number, Uint8Array>();
    const need = now.filter((p) => !want.has(p) && !this.basePages.has(p));
    if (need.length) {
      // pages this instance changed that were never seen as they started: the match opened again has them (openIn: this module rewound
      // to its state after the game files loaded, or a fresh instance that loads them - the same bytes as the instance the baseline came
      // from; a fresh instance without the game data kept would lay its memory out differently), its first row stepped
      this.seekStats.fresh++;
      const old = this.core!;
      this.core = null;
      const core = await this.openIn(old, this.whole!, this.playback);
      core.step(nativeRow(this.whole!, 0));
      this.core = core;
      if (this.closed) { core.destroy(); this.core = null; return; }
      const h = (core.mod as unknown as SeekWasm).HEAPU8;
      for (const p of need) this.basePages.set(p, h.slice(p * PAGE, Math.min((p + 1) * PAGE, h.length)));
      for (const [p, bytes] of want) h.set(bytes, p * PAGE);
    } else {
      const h = this.wasm!.HEAPU8;
      for (const p of now) if (!want.has(p)) h.set(this.basePages.get(p)!, p * PAGE);
      for (const [p, bytes] of want) h.set(bytes, p * PAGE);
    }
    this.index = c ? c.row : 1;
    this.firstStepped = false;
    this.feeding = false;
  }

  /** the stream starts again at the next row, on the renderer started fresh (that row sets it up and is not drawn) */
  private restartFeed(): void {
    this.atMark();
    this.seekStats.restarts++;
    this.wasm!._msl_gxw_restart_stream!();
    const i = this.index;
    this.core!.step(nativeRow(this.whole!, i));
    this.index = i + 1;
    this.checkDiverged(i);
    this.feedHere();
  }

  /** the renderer started fresh on the stream of the row the module last stepped (not drawn); true when that row's copy to the screen
   *  made a picture */
  private feedHere(): boolean {
    const b = this.backend!;
    b.reset!();
    this.gpu = new GxGpu(b, this.core!.initial() as unknown as Dff);
    b.prepareMemory?.(this.gpu.mem, this.gpu.regs);
    b.drawing = false;
    b.fastForward = false;
    const before = b.pictures;
    this.gpu.runFrame({ fifo: this.core!.stream(), updates: this.core!.updates() });
    this.feeding = true;
    return b.pictures > before;
  }

  /** Before showing row `row` behind the match (needsRestart): the module back to the latest checkpoint at or before row - SEEK_LEAD
   *  (the first row's state when none), or, without checkpoints, the match started again */
  async rewindFor(row: number): Promise<void> {
    if (!this.core || !this.canRewind || !this.base) { await this.start(); return; }
    const from = row - SEEK_LEAD;
    const c = [...this.checkpoints].reverse().find((k) => k.row <= Math.max(1, from)) ?? null;
    await this.rewind(c);
    if (this.closed) return;
    // (back at the first rows: the stream from its start again, as when the match opened - row 0 is the hand-over and draws nothing;
    // its copy to the screen, of the frame buffer the renderer starts with, is row 0's picture as when the match opened: the row shown)
    if (!c && row <= NEAR) this.picturedRow = this.feedHere() ? 0 : -1;
    // (going back here again, or a few frames further, is then a rewind to one of these, not a play from further back)
    this.backMarks(from);
  }

  /** read pictures back (or not) from now on: the backend's onPicture is set or cleared at once */
  setPictures(on: boolean): void {
    this.wantPictures = on;
    if (this.backend) this.backend.onPicture = on ? (rgba) => { this.onPicture?.(rgba, this.index - 1); } : null;
  }

  /** The match from its first row, with the renderer warm: a renderer with warmUp() (GxGl) has drawn its built-in scene, so the JavaScript
   *  engine has compiled the draw path before the first row shown. The simulator is not stepped for it: the match is opened once. (Before,
   *  the first rows were drawn hidden and the match opened again, which took over a second.) */
  async warmup(): Promise<void> {
    await this.start();
  }

  /** the row whose picture the screen shows now (-1: none yet) */
  get shown(): number { return this.picturedRow; }

  /**
   * Show row `row`: forward from where the match is (rows in between are stepped and not drawn, the last `tail` drawn), or from the
   * start when it is behind. `budgetMs` bounds one call; it returns true when the row is reached.
   */
  seekStep(row: number, budgetMs = 8, tail = 2): boolean {
    const end = Math.min(row, this.frameCount - 1);
    const t0 = performance.now();
    if (this.canRewind && this.core) {
      // (far ahead: checkpoints a little before here when the match gets there, so going back near here is a rewind)
      if (this.feeding && end - this.index > NEAR) this.backMarks(end - SEEK_LEAD);
      while (this.index <= end) {
        if (!this.feeding) {
          if (this.index < end - SEEK_LEAD) this.step(false);
          else this.restartFeed();
        } else if (end - this.index > NEAR) { this.feeding = false; continue; }
        else this.step(this.index > end - Math.max(tail, SEEK_LEAD));
        if (performance.now() - t0 > budgetMs && this.index <= end) return false;
      }
      return true;
    }
    while (this.index <= end) {
      this.step(this.index > end - tail);
      if (performance.now() - t0 > budgetMs && this.index <= end) return false;
    }
    return true;
  }

  /** true when `row` is behind the match: the caller must start() again first */
  needsRestart(row: number): boolean {
    return row < this.index - 1 || !this.core;
  }

  /** (the checks) checkpoints kept and their pages, MiB, with the first row's pages kept */
  get checkpointMiB(): number { let n = 0; for (const c of this.checkpoints) for (const b of c.pages.values()) n += b.length; for (const b of this.basePages.values()) n += b.length; return n / 1048576; }

  /** the whole tape of drive choice d: its config, every row, the trailers; played back `mode`, for a recording without raw C-stick bytes
   *  in playback original, the raw bytes the simulator's fit chooses for that choice (cfit.ts; made once per choice) */
  private async tapeFor(d: number, mode: PlaybackMode = this.playback): Promise<Uint8Array> {
    const { tape } = this.o;
    const drive = this.o.drive ?? driveOrder(tape, this.o.maxDrives ?? 3)[d] ?? driveOrder(tape, 1)[0];
    if (mode !== "original" || !tape.rawCAbsent) return nativeTape(tape, drive);
    if (!this.fits.has(d)) {
      const fit = await fitCstick({
        factory: this.o.factory, coreOptions: this.o.coreOptions, files: this.o.files, tape, drive,
        onProgress: (text) => this.o.onProgress?.(text),
      });
      this.o.onProgress?.(null);
      this.fits.set(d, fit?.rawC ?? null);
      if (d === this.driveIndex) this.fitStats = fit ? { drives: fit.drives, flips: fit.flips } : null;
    }
    return nativeTape(tape, drive, this.fits.get(d) ?? undefined);
  }
  /** the whole tape the match plays now (the checks compare it with the native driver's) */
  get wholeTape(): Uint8Array | null { return this.whole; }

  /** bytes the simulator's memory holds */
  get memoryBytes(): number { return this.core?.memoryBytes ?? 0; }

  close(): void {
    this.closed = true;
    this.core?.destroy();
    this.core = null;
    this.gpu = null;
  }

  /** the game parted from the replay and the other drive choices have not been tried */
  get wantsRetry(): boolean { return this.diverged !== null && !this.retried && (this.o.maxDrives ?? 3) > 1 && !this.o.drive; }

  /**
   * The game parted from the replay at `diverged.row` with this drive choice. Which choice (UCF switches, arithmetic) the recorded game had
   * is judged against the recording, so always with playback original (the game Slippi's playback shows differs from the recording by
   * design: playback slippi's divergence alone says nothing): each choice is driven from the start, the simulator alone (sliced so the page
   * stays alive, the match on screen goes on), and the one that holds longest is kept (src/sim/drive.ts does the same for the track).
   * Resolves the better choice's index, or null when the one playing is as good; switchDrive() then starts the match again on it.
   */
  async bestDrive(onProgress?: (text: string) => void, now = () => performance.now(), pause = () => new Promise<void>((r) => setTimeout(r, 0))): Promise<number | null> {
    this.retried = true;
    const { tape, files } = this.o;
    const choices = driveOrder(tape, this.o.maxDrives ?? 3);
    // (one module for the drives, rewound between them)
    let driveCore: GxCore | null = null;
    const reach = async (d: number): Promise<number> => {
      let core: GxCore | null = null;
      try {
        const whole = await this.tapeFor(d, "original");
        core = driveCore = await this.openIn(driveCore, whole, "original");
        core.setDisplay(false); // (only the gameplay rows matter)
        let t0 = now();
        for (let i = 0; i < tape.count; i++) {
          core.step(nativeRow(whole, i));
          if (i > 0 && differs(core.output(), tape.expected(i))) return i;
          if (now() - t0 > 12) { await pause(); t0 = now(); if (this.closed) return -1; }
        }
        return tape.count;
      } catch {
        (core ?? driveCore)?.destroy();
        driveCore = null;
        return 0; // (a build that cannot play this choice)
      }
    };
    try {
      onProgress?.(`checking this replay's game settings against the recording`);
      const current = this.playback === "original" ? this.diverged?.row ?? tape.count : await reach(this.driveIndex);
      this.drivesTried = [{ index: this.driveIndex, row: current }];
      let best = this.drivesTried[0];
      for (let d = 0; d < choices.length && best.row < tape.count; d++) {
        if (d === this.driveIndex) continue;
        onProgress?.(`trying game setting ${d + 1} of ${choices.length}`);
        const row = await reach(d);
        if (this.closed) return null;
        this.drivesTried.push({ index: d, row });
        if (row > best.row) best = this.drivesTried[this.drivesTried.length - 1];
      }
      return best.index === this.driveIndex ? null : best.index;
    } finally {
      (driveCore as GxCore | null)?.destroy();
    }
  }

  /** play drive choice d from now on: the match starts again from its first row (the caller seeks back) */
  async switchDrive(d: number): Promise<void> {
    this.driveIndex = d;
    await this.start();
  }
}