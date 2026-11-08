/* The simulator's graphics build as the page runs it (melee-sim-light built with MSL_GX_RECORD for WebAssembly, tools/replay/gx_wasm_api.c).
 * Each step plays one replay frame and the game's display pass; the build hands back what the game sent to the graphics processor
 * that frame (the write-gather FIFO's bytes) and the memory those commands read that earlier frames did not send. Nothing here
 * draws: gxr/ reads the stream.
 *
 *   msl_gxw_open(tape, size, root)    the match, the game files read from `root` of the module's file system
 *   msl_gxw_set_playback(name)        "slippi" (what Slippi's playback shows: its hook at game frame -123 also sets each fighter's collision
 *                                     position) or "original" (the console's recording); before the first step only (-2 after)
 *   msl_gxw_playback()                the option's current name
 *   msl_gxw_step_frame(frame)         one frame of the tape (tapebridge.ts TapeFrame) and its display pass
 *   msl_gxw_stream_ptr/_len           the frame's FIFO bytes, valid until the next step
 *   msl_gxw_region_*(i)               the memory blocks first referenced by the frame (or rewritten): address, bytes, size, type, and
 *                                     the stream offset they must be in place by
 *   msl_gxw_initial_state(0/1/2)      the register files before the first frame: BP 256 words, CP 256, XF 0x1000 + 0x60
 *   msl_gxw_output_ptr/_size          the step's MslCoreCompare (src/sim/compare.ts holds it against the replay)
 *   msl_gxw_load_game(root)           (newer builds) the game files read once, and the module's state right after kept: msl_gxw_rewind() puts
 *                                     the module back to it, so the next match opens in milliseconds instead of reading the files again
 */
import type { GxUpdate } from "../gxr/dff";
import { DATA_ROOT } from "../../sim/engine";
import { TAPE_CONFIG_SIZE, TAPE_FRAME_SIZE } from "./tapebridge";

export interface GxCoreModule {
  HEAPU8: Uint8Array;
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  _malloc(size: number): number;
  _free(ptr: number): void;
  _msl_gxw_open(tape: number, size: number, root: number): number;
  _msl_gxw_load_game?(root: number): number;
  _msl_gxw_rewind?(): number;
  _msl_gxw_kept_bytes?(): number;
  _msl_gxw_set_playback(name: number): number;
  _msl_gxw_playback(): number;
  _msl_gxw_step_frame(frame: number): number;
  _msl_gxw_tape_frame_size(): number;
  _msl_gxw_stream_ptr(): number;
  _msl_gxw_stream_len(): number;
  _msl_gxw_region_count(): number;
  _msl_gxw_region_addr(i: number): number;
  _msl_gxw_region_ptr(i: number): number;
  _msl_gxw_region_size(i: number): number;
  _msl_gxw_region_type(i: number): number;
  _msl_gxw_region_pos(i: number): number;
  _msl_gxw_initial_state(which: number): number;
  _msl_gxw_output_ptr(): number;
  _msl_gxw_output_size(): number;
  _msl_gxw_out_row(): number;
  _msl_gxw_out_row_size(): number;
  _msl_gxw_cfit_new(lanes: number, count: number): number;
  _msl_gxw_cfit_lane(lane: number, cx: number, cy: number): number;
  _msl_gxw_cfit_raw(lane: number, axis: number): number;
  _msl_gxw_cfit_next(first: number, nearOnly: number): number;
  _msl_gxw_cfit_mode(): number;
  _msl_gxw_set_recorded(buf: number, size: number): number;
  _msl_gxw_set_display(on: number): number;
  _msl_gxw_cfit_result(moved: number): void;
  _msl_gxw_cfit_first(): number;
  _msl_gxw_cfit_flips(): number;
  // (builds with the sound core: the game's own sound code, src/sound in the simulator; off unless started)
  _msl_gxw_sound_start?(root: number): number;
  _msl_gxw_sound_need?(i: number): number;
  _msl_gxw_sound_pcm?(): number;
  _msl_gxw_sound_frames?(): number;
  _msl_gxw_sound_music?(on: number): void;
  _msl_gxw_sound_info?(which: number): number;
  _msl_gxw_sound_log?(): number;
  _msl_gxw_sound_log_count?(): number;
}

/** the sound's sample rate (the console's DSP: 32 kHz), and its channels (left and right interleaved) */
export const SOUND_RATE = 32000;
export const SOUND_CHANNELS = 2;

/** GxCore.soundStart's answer: on; the sound files the module needs and did not find (paths under the game files' folder, e.g.
 *  "audio/us/main.ssm"); or none (the module has no sound, or no memory for it) */
export type SoundStart = { on: true } | { on: false; need: string[] } | { on: false; need: null; reason: string };

/** how the replay is played back: as Slippi's playback shows it, or as the console recorded it (the simulator's msl_gxw_set_playback) */
export type PlaybackMode = "slippi" | "original";
export const PLAYBACK_MODES: PlaybackMode[] = ["slippi", "original"];
export const isPlaybackMode = (v: unknown): v is PlaybackMode => v === "slippi" || v === "original";

/** the module's factory (the ES module's default export, -sMODULARIZE -sEXPORT_ES6) */
export type GxCoreFactory = (options?: Record<string, unknown>) => Promise<GxCoreModule>;

/** the register files the stream starts from (gxr GxInitial) */
export interface GxInitial { bp: Uint32Array; cp: Uint32Array; xfMem: Uint32Array; xfRegs: Uint32Array; texMem: Uint8Array }

const RESULTS: Record<number, string> = { 1: "end of tape", [-1]: "not open", [-2]: "step failed", [-3]: "game data failed", [-4]: "match failed" };

const SNAP_PAGE = 65536;
/** GxCore.snapshot(): the module's memory (its non-zero pages) and the JavaScript side's own state */
export interface CoreSnapshot { length: number; pages: Map<number, Uint8Array>; frameBuf: number; open: boolean; bytes: number }

export class GxCore {
  private frameBuf = 0;
  private open = false;
  /** the game data is loaded and the state after it kept (loadGame): rewind() can start another match in this instance */
  private kept = false;

  private constructor(readonly mod: GxCoreModule) {}

  /** a fresh instance of the module with the game files in its file system (the core copies what it needs when the match opens) */
  static async create(factory: GxCoreFactory, files: Iterable<[string, Uint8Array]>, options: Record<string, unknown> = {}): Promise<GxCore> {
    const mod = await factory({ print: () => {}, printErr: (s: string) => console.debug("simulator:", s), ...options });
    if (mod._msl_gxw_tape_frame_size() !== TAPE_FRAME_SIZE) throw new Error("the simulator's tape frame is not the one this page writes");
    mod.FS.mkdirTree(DATA_ROOT);
    for (const [name, bytes] of files) mod.FS.writeFile(`${DATA_ROOT}/${name}`, bytes);
    return new GxCore(mod);
  }

  /** the match for a whole tape (tapebridge.ts nativeTape: config, every row, the trailers the HUD reads), played back the given way (set
   *  before any step); the game files are dropped from the file system after. Rows are then stepped one at a time (step). */
  openMatch(whole: Uint8Array, names: string[], playback: PlaybackMode = "slippi"): void {
    const m = this.mod;
    this.setPlayback(playback);
    if (whole.length < TAPE_CONFIG_SIZE + TAPE_FRAME_SIZE) throw new Error("bad tape size");
    const tape = m._malloc(whole.length), root = m._malloc(DATA_ROOT.length + 1);
    try {
      m.HEAPU8.set(whole, tape);
      m.HEAPU8.set(new TextEncoder().encode(DATA_ROOT + "\0"), root);
      const r = m._msl_gxw_open(tape, whole.length, root);
      if (r !== 0) throw new Error(`msl_gxw_open: ${RESULTS[r] ?? r}`);
    } finally {
      m._free(tape); m._free(root);
    }
    for (const n of names) {
      try { m.FS.unlink(`${DATA_ROOT}/${n}`); } catch { /* already gone */ }
    }
    this.frameBuf = m._malloc(TAPE_FRAME_SIZE);
    this.open = true;
  }

  /** Read the game files once and keep the module's state right after (builds with msl_gxw_load_game; others: nothing, false). The files
   *  are then dropped from the file system: every later match of this instance opens from the kept game data (rewind, then openMatch). */
  loadGame(names: string[]): boolean {
    const m = this.mod;
    if (!m._msl_gxw_load_game || !m._msl_gxw_rewind) return false;
    const root = m._malloc(DATA_ROOT.length + 1);
    let r: number;
    try {
      m.HEAPU8.set(new TextEncoder().encode(DATA_ROOT + "\0"), root);
      r = m._msl_gxw_load_game(root);
    } finally {
      m._free(root);
    }
    if (r === -3) throw new Error("msl_gxw_load_game: game data failed");
    if (r !== 0) return false;
    for (const n of names) {
      try { m.FS.unlink(`${DATA_ROOT}/${n}`); } catch { /* already gone */ }
    }
    this.kept = true;
    return true;
  }

  /** The module back to its state right after loadGame, for another match (openMatch next): every byte as it was, so the match is
   *  the one a fresh instance would play. False when it cannot be (no kept state, or the game data changed since): make a new instance. */
  rewind(): boolean {
    if (!this.kept || !this.mod._msl_gxw_rewind) return false;
    if (this.mod._msl_gxw_rewind() !== 0) { this.kept = false; return false; }
    // (every allocation made after loadGame is gone with the rewind, the frame buffer too)
    this.frameBuf = 0;
    this.open = false;
    return true;
  }

  /** bytes kept for rewind() */
  get keptBytes(): number { return this.kept ? this.mod._msl_gxw_kept_bytes?.() ?? 0 : 0; }

  /** the playback option (only before the first step: the option decides the very first frames) */
  setPlayback(name: PlaybackMode): void {
    const m = this.mod, s = m._malloc(16);
    try {
      m.HEAPU8.set(new TextEncoder().encode(name + "\0"), s);
      const r = m._msl_gxw_set_playback(s);
      if (r !== 0) throw new Error(`msl_gxw_set_playback(${name}): ${r === -1 ? "unknown name" : r === -2 ? "a frame was already played" : r}`);
    } finally {
      m._free(s);
    }
  }

  /** the playback option the match plays with */
  get playback(): PlaybackMode {
    const m = this.mod, p = m._msl_gxw_playback();
    let e = p;
    while (m.HEAPU8[e]) e++;
    return new TextDecoder().decode(m.HEAPU8.subarray(p, e)) as PlaybackMode;
  }

  /** play one frame (TAPE_FRAME_SIZE bytes) */
  step(frame: Uint8Array): void {
    if (!this.open) throw new Error("no match open");
    this.mod.HEAPU8.set(frame.subarray(0, TAPE_FRAME_SIZE), this.frameBuf);
    const r = this.mod._msl_gxw_step_frame(this.frameBuf);
    if (r !== 0) throw new Error(`msl_gxw_step_frame: ${RESULTS[r] ?? r}`);
  }

  /** the last step's FIFO bytes (a view of the module's memory: valid until the next step) */
  stream(): Uint8Array {
    const m = this.mod, p = m._msl_gxw_stream_ptr();
    return p ? m.HEAPU8.subarray(p, p + m._msl_gxw_stream_len()) : new Uint8Array(0);
  }

  /** the memory the last step's stream reads that the stream before did not (views, valid until the next step), by position */
  updates(): GxUpdate[] {
    const m = this.mod, n = m._msl_gxw_region_count(), out: GxUpdate[] = [];
    for (let i = 0; i < n; i++) {
      const p = m._msl_gxw_region_ptr(i);
      out.push({ pos: m._msl_gxw_region_pos(i), addr: m._msl_gxw_region_addr(i), data: m.HEAPU8.subarray(p, p + m._msl_gxw_region_size(i)), type: m._msl_gxw_region_type(i) });
    }
    return out.sort((a, b) => a.pos - b.pos);
  }

  /** the register files before the first frame (copies) */
  initial(): GxInitial {
    const m = this.mod, words = (which: number, offset: number, n: number) => {
      const p = m._msl_gxw_initial_state(which) + offset * 4;
      return new Uint32Array(m.HEAPU8.slice(p, p + n * 4).buffer);
    };
    return { bp: words(0, 0, 256), cp: words(1, 0, 256), xfMem: words(2, 0, 0x1000), xfRegs: words(2, 0x1000, 0x60), texMem: new Uint8Array(0) };
  }

  /** the last step's MslCoreCompare (a view: valid until the next step) */
  output(): DataView {
    const m = this.mod, p = m._msl_gxw_output_ptr();
    return new DataView(m.HEAPU8.buffer, p, m._msl_gxw_output_size());
  }

  /** gameplay only: the steps run no display pass and record no GX stream (before the first step; the fit's and the drive check's drives) */
  setDisplay(on: boolean): void {
    const r = this.mod._msl_gxw_set_display(on ? 1 : 0);
    if (r !== 0) throw new Error(`msl_gxw_set_display: ${r}`);
  }

  // ---- the game's sound (builds with the sound core) ----

  /** the module has the game's sound code */
  get hasSound(): boolean { return typeof this.mod._msl_gxw_sound_start === "function"; }

  /** a file into the module's file system under the game files' folder (the sound files the module names: soundStart) */
  writeFile(name: string, bytes: Uint8Array): void {
    const m = this.mod, at = `${DATA_ROOT}/${name}`, dir = at.slice(0, at.lastIndexOf("/"));
    (m.FS as unknown as { mkdirTree(p: string): void }).mkdirTree(dir);
    m.FS.writeFile(at, bytes);
  }

  /** Start the game's sound for the open match (after openMatch, before its first step). Files it names and does not find are listed:
   *  write them (writeFile), open the match again (rewind, openMatch) and start again. */
  soundStart(): SoundStart {
    const m = this.mod;
    if (!this.hasSound) return { on: false, need: null, reason: "this simulator build has no sound" };
    if (!this.open) throw new Error("no match open");
    const root = m._malloc(DATA_ROOT.length + 1);
    let r: number;
    try {
      m.HEAPU8.set(new TextEncoder().encode(DATA_ROOT + "\0"), root);
      r = m._msl_gxw_sound_start!(root);
    } finally { m._free(root); }
    if (r === 0) return { on: true };
    if (r < 0) return { on: false, need: null, reason: r === -2 ? "a frame was already played" : "no memory for the sound" };
    const need: string[] = [];
    for (let i = 0; i < r; i++) {
      const p = m._msl_gxw_sound_need!(i);
      let e = p;
      while (m.HEAPU8[e]) e++;
      need.push(new TextDecoder().decode(m.HEAPU8.subarray(p, e)));
    }
    return { on: false, need };
  }

  /** the last step's sound: interleaved stereo 16-bit samples at SOUND_RATE (a copy; empty while the sound is off) */
  soundPcm(): Int16Array {
    const m = this.mod;
    const n = m._msl_gxw_sound_frames?.() ?? 0;
    if (n <= 0) return new Int16Array(0);
    const p = m._msl_gxw_sound_pcm!();
    return new Int16Array(m.HEAPU8.slice(p, p + n * 2 * SOUND_CHANNELS).buffer);
  }

  /** the game's music heard or not (its voices play on either way: the sound's state stays the game's) */
  soundMusic(on: boolean): void { this.mod._msl_gxw_sound_music?.(on ? 1 : 0); }

  /** (the checks) the game's sound requests since the sound started: [game row, kind (1 a sound: id, volume, pan, track, channel, voice;
   *  2 the music: file entry, volume, track), values...] */
  soundLog(): number[][] {
    const m = this.mod, n = m._msl_gxw_sound_log_count?.() ?? 0, out: number[][] = [];
    if (n <= 0) return out;
    const p = m._msl_gxw_sound_log!(), v = new Int32Array(m.HEAPU8.buffer.slice(p, p + n * 32));
    for (let i = 0; i < n; i++) out.push(Array.from(v.subarray(i * 8, i * 8 + 8)));
    return out;
  }

  /** (a resynced drive) the recording's positions, one record per tape frame (replay_drive.py recorded_positions); before the first step.
   *  Each step then puts back a position within RESYNC_MOST of the recording's, as the native driver's MSL_RECORDED does */
  setRecorded(bytes: Uint8Array): void {
    const m = this.mod, p = m._malloc(bytes.length);
    try {
      m.HEAPU8.set(bytes, p);
      const r = m._msl_gxw_set_recorded(p, bytes.length);
      if (r !== 0) throw new Error(`msl_gxw_set_recorded: ${r}`);
    } finally { m._free(p); }
  }

  /** the last step's row as the native driver writes it (replay_drive.c OutFrame: framediff.ts reads it; a view, valid until the next step) */
  outRow(): DataView {
    const m = this.mod, p = m._msl_gxw_out_row();
    return new DataView(m.HEAPU8.buffer, p, m._msl_gxw_out_row_size());
  }

  /** The module's whole state as it is now (between calls everything it holds is in its memory: the stack is back at its base): the
   *  memory's non-zero 64 KiB pages and its length. restore() puts it back. */
  snapshot(): CoreSnapshot {
    const h = this.mod.HEAPU8, length = h.length, pages = new Map<number, Uint8Array>();
    const words = new Int32Array(h.buffer, 0, length >> 2), per = SNAP_PAGE >> 2;
    for (let p = 0; p * SNAP_PAGE < length; p++) {
      const a = p * per, b = Math.min(a + per, words.length);
      for (let i = a; i < b; i++) if (words[i] !== 0) { pages.set(p, h.slice(p * SNAP_PAGE, Math.min(length, (p + 1) * SNAP_PAGE))); break; }
    }
    return { length, pages, frameBuf: this.frameBuf, open: this.open, bytes: pages.size * SNAP_PAGE };
  }

  /** Put back a snapshot of this instance: its memory byte for byte as it was, and every byte the memory has grown by since zero (as a
   *  fresh instance's memory would be where it grows) */
  restore(s: CoreSnapshot): void {
    const h = this.mod.HEAPU8;
    for (let p = 0; p * SNAP_PAGE < s.length; p++) {
      const page = s.pages.get(p);
      if (page) h.set(page, p * SNAP_PAGE);
      else h.fill(0, p * SNAP_PAGE, Math.min(s.length, (p + 1) * SNAP_PAGE));
    }
    h.fill(0, s.length);
    this.frameBuf = s.frameBuf;
    this.open = s.open;
  }

  /** bytes the module holds (its memory, wasm pages) */
  get memoryBytes(): number { return this.mod.HEAPU8.byteLength; }

  destroy(): void {
    if (this.frameBuf) this.mod._free(this.frameBuf);
    this.frameBuf = 0;
    this.open = false;
  }
}
