// The gx player's seeking (src/render3d/gxpath/session.ts) on a stand-in simulator module: a seek back to the first row, sought rows
// against the rows of a straight play, and a first open against a match opened again.
// With MELEE_ASSETS (tests/game-files.ts) the same first-open check runs on the real module (public/gx).
//   deno test -A --no-check --sloppy-imports tests/gxpath-seek.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readTape, type Tape } from "../src/sim/tape.ts";
import { GxSession, SEEK_LEAD, type SessionBackend } from "../src/render3d/gxpath/session.ts";
import { TAPE_FRAME_SIZE } from "../src/render3d/gxpath/tapebridge.ts";
import type { GxCoreModule } from "../src/render3d/gxpath/core.ts";
import { gxNames } from "../src/sim/gamefiles.ts";
import { gameFiles, withGameFiles } from "./game-files.ts";

// ---- a replay: two players on Battlefield standing still, `rows` frames from -123 on
const SIZES: [number, number][] = [[0x36, 0x1a4], [0x37, 0x42], [0x38, 0x48], [0x3a, 0x8]];
function makeReplay(rows: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(2 + 3 * SIZES.length);
  head[0] = 0x35; head[1] = 1 + 3 * SIZES.length;
  SIZES.forEach(([c, n], i) => { head[2 + 3 * i] = c; head[3 + 3 * i] = n >> 8; head[4 + 3 * i] = n & 0xff; });
  parts.push(head);
  const ev = (cmd: number, fill: (v: DataView) => void) => {
    const n = SIZES.find(([c]) => c === cmd)![1];
    const b = new Uint8Array(n + 1); b[0] = cmd;
    fill(new DataView(b.buffer));
    parts.push(b);
  };
  ev(0x36, (v) => {
    v.setUint8(1, 3); v.setUint8(2, 18); v.setUint8(3, 0);
    v.setUint16(0x13, 31);
    v.setFloat32(0x35, 1);
    for (let i = 0; i < 4; i++) {
      const b = 0x65 + 0x24 * i;
      v.setUint8(b + 1, i < 2 ? 0 : 3);
      v.setUint8(b + 2, 4);
      v.setUint8(0x6d + 0x24 * i, 9);
    }
    v.setUint32(0x13d, 0x1234567);
    v.setUint8(0x1a4, 8);
  });
  for (let r = 0; r < rows; r++) {
    const f = r - 123;
    ev(0x3a, (v) => { v.setInt32(1, f); v.setUint32(5, 1000 + 7 * f); });
    for (let p = 0; p < 2; p++) {
      ev(0x37, (v) => { v.setInt32(1, f); v.setUint8(5, p); v.setUint32(7, 500 + f); });
      ev(0x38, (v) => {
        v.setInt32(1, f); v.setUint8(5, p); v.setUint8(7, 1); v.setUint16(8, 14);
        v.setFloat32(0xa, p ? 40 : -40); v.setFloat32(0x12, p ? -1 : 1); v.setUint8(0x21, 4);
      });
    }
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- a stand-in for the simulator's graphics build. Its whole state is in its memory, as the real one's is between calls: a bump
// allocator (its top at TOP), the match's state where the open allocated it (its address at MATCH), and game memory pages each row
// writes into. A row's stream is two BP writes: register 0x4b holding the row's state, then a copy (0x52); the stand-in renderer's
// "picture" is that state, so a sought row shows what the straight play showed only when the module was put back exactly.
// Like the real one, loading the game data keeps the state and then frees memory it used for the load: a match opened straight after
// the load stands elsewhere than one opened after a rewind.
const PAGE = 65536, PAGES = 128, TOP = 0x100, MATCH = 0x104, PLAYBACK = 0x200, STREAM = 0x1000, INITIAL = 0x2000;
const GAME_PAGES = { first: 8, count: 40 }, HEAP_START = 64 * PAGE;
function fakeModule(stats: { restarts: number; loads: number }): GxCoreModule {
  const heap = new Uint8Array(PAGES * PAGE), dv = new DataView(heap.buffer);
  let kept: Uint8Array | null = null, streamLen = 0, restart = false;
  dv.setUint32(TOP, HEAP_START, true);
  heap.set(new TextEncoder().encode("slippi\0"), PLAYBACK);
  const malloc = (n: number) => { const p = dv.getUint32(TOP, true); dv.setUint32(TOP, p + ((n + 15) & ~15), true); return p; };
  const mix = (a: number, b: number) => Math.imul(a ^ b, 16777619) >>> 0;
  const mod = {
    HEAPU8: heap,
    FS: { mkdirTree() {}, writeFile() {}, unlink() {} },
    _malloc: malloc,
    _free() {},
    _msl_gxw_tape_frame_size: () => TAPE_FRAME_SIZE,
    _msl_gxw_load_game() {
      stats.loads++;
      for (let p = 0; p < GAME_PAGES.count; p++) heap.fill(p + 1, (GAME_PAGES.first + p) * PAGE, (GAME_PAGES.first + p + 1) * PAGE);
      const tmp = malloc(2 * PAGE);
      kept = heap.slice();
      // (the load's own memory freed after the state is kept)
      dv.setUint32(TOP, tmp, true);
      return 0;
    },
    _msl_gxw_rewind() { if (!kept) return -1; heap.set(kept); return 0; },
    _msl_gxw_kept_bytes: () => kept?.length ?? 0,
    _msl_gxw_set_playback: () => 0,
    _msl_gxw_playback: () => PLAYBACK,
    _msl_gxw_open() {
      const m = malloc(64);
      dv.setUint32(MATCH, m, true);
      dv.setUint32(m, 0, true);
      dv.setUint32(m + 4, 2166136261, true);
      return 0;
    },
    _msl_gxw_step_frame(frame: number) {
      const m = dv.getUint32(MATCH, true), row = dv.getUint32(m, true);
      let x = dv.getUint32(m + 4, true);
      for (let i = 0; i < 8; i++) x = mix(x, heap[frame + i]);
      // (the game's memory: a word in one of the pages, and the state reads one of them back)
      const p = GAME_PAGES.first + (row % GAME_PAGES.count), at = p * PAGE + ((row * 4) % PAGE);
      x = mix(x, dv.getUint32(GAME_PAGES.first * PAGE + (((x >>> 8) % (GAME_PAGES.count * PAGE)) & ~3), true));
      dv.setUint32(at, x, true);
      dv.setUint32(m, row + 1, true);
      dv.setUint32(m + 4, x, true);
      const s = new DataView(heap.buffer, STREAM, 16);
      s.setUint8(0, 0x61); s.setUint32(1, (0x4b << 24) | (x & 0xffffff));
      s.setUint8(5, 0x61); s.setUint32(6, (0x52 << 24) | (restart ? 1 : 0));
      streamLen = 10;
      restart = false;
      return 0;
    },
    _msl_gxw_stream_ptr: () => STREAM,
    _msl_gxw_stream_len: () => streamLen,
    _msl_gxw_region_count: () => 0,
    _msl_gxw_region_addr: () => 0, _msl_gxw_region_ptr: () => 0, _msl_gxw_region_size: () => 0, _msl_gxw_region_type: () => 0,
    _msl_gxw_region_pos: () => 0,
    _msl_gxw_initial_state: () => INITIAL,
    _msl_gxw_output_ptr: () => INITIAL,
    _msl_gxw_output_size: () => 256,
    _msl_gxw_heap_top: () => dv.getUint32(TOP, true),
    _msl_gxw_restart_stream() { stats.restarts++; restart = true; },
    _msl_gxw_set_display: () => 0,
  };
  return mod as unknown as GxCoreModule;
}

/** a renderer that keeps the last picture's value (the register 0x4b the copy saw); as GxGl and the CPU reference, a copy is made
 *  when the frame is not drawn too (only a fast-forwarded one skips it: gpu.ts) */
function fakeBackend() {
  return {
    drawing: false, fastForward: false, pictures: 0, last: -1, onPicture: null as SessionBackend["onPicture"],
    reset() { this.pictures = 0; },
    draw() {},
    copy(regs: { bp: Uint32Array }) {
      this.last = regs.bp[0x4b];
      this.onPicture?.(new Uint8Array(4), this.pictures);
      this.pictures++;
      return { toXfb: true, rect: [0, 0, 640, 480], clear: false };
    },
    copyClear() {},
  };
}

const ROWS = 4000;
const tapeOf = (rows: number): Tape => readTape(makeReplay(rows), {}, { stadiumTransformations: true });

function fakeSession(tape: Tape) {
  const stats = { restarts: 0, loads: 0 }, backend = fakeBackend();
  const s = new GxSession({
    factory: async () => fakeModule(stats), files: { names: [], files: new Map() }, tape, drive: undefined, maxDrives: 1,
    makeBackend: () => backend as unknown as SessionBackend,
  });
  return { s, backend, stats };
}

/** the session at `row` the way the page's player gets there (playback.ts tick) */
async function seekTo(s: GxSession, row: number): Promise<void> {
  if (s.needsRestart(row)) await s.rewindFor(row);
  while (!s.seekStep(row, 1e9)) { /* one call does it */ }
}

/** the picture of each row of a straight play from the first row (every row drawn), as the reference */
async function straight(tape: Tape, last: number): Promise<number[]> {
  const { s, backend } = fakeSession(tape);
  await s.warmup();
  const out: number[] = [];
  while (s.index <= last) { const row = s.index; s.step(true); out[row] = s.shown === row ? backend.last : -1; }
  s.close();
  return out;
}

test("a seek back to the first row shows the first row (the stream's start: its copy of the empty frame buffer)", async () => {
  const tape = tapeOf(800);
  const { s } = fakeSession(tape);
  await s.warmup();
  await seekTo(s, 0);
  assert.equal(s.shown, 0, "at load");
  for (const from of [500, 20, 1]) {
    await seekTo(s, from);
    assert.equal(s.shown, from);
    await seekTo(s, 0);
    assert.equal(s.shown, 0, `back to the first row from ${from}`);
    await seekTo(s, 1);
    assert.equal(s.shown, 1, `the second row drawn from the first (from ${from})`);
  }
  s.close();
});

test("every sought row shows the straight play's picture of it", async () => {
  const tape = tapeOf(ROWS);
  const rows = [3000, 2999, 2880, 2760, 1000, 3600, 3550, 200, 20, 0, 1, 2000, 2010, 3900, 3899, 3779, 3659, 5, 3000];
  const ref = await straight(tape, Math.max(...rows));
  const { s, backend } = fakeSession(tape);
  await s.warmup();
  const differ: string[] = [];
  for (const row of rows) {
    await seekTo(s, row);
    if (s.shown !== row || backend.last !== ref[row]) differ.push(`${row}: shown ${s.shown}, ${backend.last} against ${ref[row]}`);
  }
  assert.deepEqual(differ, []);
  s.close();
});

/** the module's pages that differ between two of its snapshots */
function pagesDiffer(a: { length: number; pages: Map<number, Uint8Array> }, b: { length: number; pages: Map<number, Uint8Array> }): number[] {
  const out: number[] = [];
  for (let p = 0; p * PAGE < Math.max(a.length, b.length); p++) {
    const x = a.pages.get(p), y = b.pages.get(p);
    if (!x && !y) continue;
    if (!x || !y || x.length !== y.length || x.some((v, i) => v !== y[i])) out.push(p);
  }
  return out;
}

test("the first open is the match a reopen opens: the same memory after the first row", async () => {
  const { s, stats } = fakeSession(tapeOf(100));
  await s.warmup();
  const first = s.core_!.snapshot();
  await s.start();
  assert.equal(stats.loads, 1, "the game data read once");
  assert.deepEqual(pagesDiffer(first, s.core_!.snapshot()), []);
  s.close();
});

test("the real module: the first open is the match a reopen opens", withGameFiles, async () => {
  const dir = path.join(import.meta.dirname!, "..", "public", "gx");
  const names = gxNames(fs.readdirSync(gameFiles!));
  const files = new Map(names.map((n) => [n, new Uint8Array(fs.readFileSync(path.join(gameFiles!, n)))]));
  const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dir, "gx-core.wasm")));
  const factory = (await import(new URL("../public/gx/gx-core.js", import.meta.url).href)).default;
  const backend = fakeBackend();
  const s = new GxSession({
    factory, files: { names, files }, tape: tapeOf(200), maxDrives: 1,
    coreOptions: { instantiateWasm: (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance) => void) => { WebAssembly.instantiate(wasm, imports).then(ok); return {}; } },
    makeBackend: () => ({ ...backend, rawVertices: true }) as unknown as SessionBackend,
  });
  await s.warmup();
  const first = s.core_!.snapshot();
  await s.start();
  const again = pagesDiffer(first, s.core_!.snapshot());
  // (the stack's unused bytes below its base are what calls left there, which a rewind leaves as they are: at most that page)
  assert.ok(again.length <= 1, `pages that differ: ${again.join(", ")}`);
  s.close();
});
