// The game's sound in the GX player (the simulator's sound core: the game's own sound code; src/render3d/gxpath/session.ts, core.ts).
// With your game files (MELEE_ASSETS, tests/game-files.ts) and the disc's audio folder (MELEE_AUDIO: a folder holding audio/us/...,
// audio/*.hps), on the module in public/gx and a replay made here (two players standing on Battlefield):
// - the sound starts with the match, naming the files it reads, and the same match has the same sound, twice;
// - the game's requests are the ones the decomp has the game make: "Ready" when the match starts (ifStatus_803F9628[3], sound 0x7C85D),
//   each fighter's entry (ft_0C31.c: lbAudioAx_80024304(0x8B), track 0x16), "GO!" (ifStatus_803F9628[4], 0x7C857), all at volume
//   0x7F and pan 0x40 doubled (fn_80023750) on channel 7, and the stage's music;
// - a seek back (a rewind to a checkpoint or to the first row) and a straight play have the same sound row for row;
// - a second start of the sound in the same module (after a start that named missing files, without a rewind) sounds as a first
//   start does: the module puts the sound's own statics back (the decomp sets them once, at boot);
// - the stream the renderer draws is the same with the sound on and off, and the stage's music plays (read from the stage's table
//   by the module, with no write to the game's stage state).
// Without the files the tests are skipped. Nothing from the files is written anywhere.
//
//   MELEE_ASSETS=<game files> MELEE_AUDIO=<folder with audio/> deno test -A --no-check --sloppy-imports tests/gx-sound.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { driveOrder, readTape, type Tape } from "../src/sim/tape.ts";
import { GxSession, type SessionBackend } from "../src/render3d/gxpath/session.ts";
import { GxCore } from "../src/render3d/gxpath/core.ts";
import { SessionSound } from "../src/render3d/gxpath/exportsound.ts";
import { nativeRow, nativeTape } from "../src/render3d/gxpath/tapebridge.ts";
import { gxNames } from "../src/sim/gamefiles.ts";
import { gameFiles } from "./game-files.ts";

const audio: string | undefined = (() => { try { return process.env.MELEE_AUDIO || undefined; } catch { return undefined; } })();
const withSound = { skip: !gameFiles || !audio };

// ---- a replay: two players on Battlefield standing still, `rows` frames from -123 on (as tests/gxpath-seek.test.ts makes it)
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

const ROWS = 400;
const tapeOf = (rows: number): Tape => readTape(makeReplay(rows), {}, { stadiumTransformations: true });

/** a renderer that draws nothing and says every copy made a picture; it keeps the stream it was handed (hashed), row by row */
function fakeBackend() {
  return {
    drawing: false, fastForward: false, pictures: 0, onPicture: null as SessionBackend["onPicture"],
    reset() { this.pictures = 0; },
    draw() {},
    copy() { this.onPicture?.(new Uint8Array(4), this.pictures); this.pictures++; return { toXfb: true, rect: [0, 0, 640, 480], clear: false }; },
    copyClear() {},
  };
}

let module_: { factory: unknown; coreOptions: Record<string, unknown> } | null = null;
async function moduleOf() {
  if (module_) return module_;
  const dir = path.join(import.meta.dirname!, "..", "public", "gx");
  const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dir, "gx-core.wasm")));
  const factory = (await import(new URL("../public/gx/gx-core.js", import.meta.url).href)).default;
  module_ = { factory, coreOptions: { instantiateWasm: (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance) => void) => { WebAssembly.instantiate(wasm, imports).then(ok); return {}; } } };
  return module_;
}

let filesOf: { names: string[]; files: Map<string, Uint8Array> } | null = null;
const asked: string[][] = [];
/** a session on the real module with the game's sound; every row's sound kept (by row), and the hashed stream of each row drawn */
async function soundSession(tape: Tape) {
  const { factory, coreOptions } = await moduleOf();
  if (!filesOf) {
    const names = gxNames(fs.readdirSync(gameFiles!));
    filesOf = { names, files: new Map(names.map((n) => [n, new Uint8Array(fs.readFileSync(path.join(gameFiles!, n)))])) };
  }
  const s = new GxSession({
    factory: factory as never, coreOptions, files: filesOf, tape, maxDrives: 1,
    makeBackend: () => fakeBackend() as unknown as SessionBackend,
    sound: { files: async (names) => { asked.push(names); return new Map(names.map((n) => [n, new Uint8Array(fs.readFileSync(path.join(audio!, n)))])); } },
  });
  const pcm = new Map<number, Int16Array>();
  s.onSound = (p, row) => { pcm.set(row, p); };
  return { s, pcm };
}

const sha = (parts: Int16Array[]) => { const h = crypto.createHash("sha256"); for (const p of parts) h.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); return h.digest("hex"); };

test("the match starts with the game's sound: the files it names are read, and the same match sounds the same twice", withSound, async () => {
  const tape = tapeOf(ROWS);
  const runs: { log: number[][]; sound: string; samples: number }[] = [];
  for (let k = 0; k < 2; k++) {
    asked.length = 0;
    const { s, pcm } = await soundSession(tape);
    await s.warmup();
    assert.equal(s.soundState, "on");
    if (k === 0) {
      // (the first opening names every file it reads: the macros, the common banks, the two fighters', the stage's music)
      const names = asked.flat();
      assert.ok(names.includes("audio/us/smash2.sem"), names.join(" "));
      assert.ok(names.includes("audio/us/main.ssm"), names.join(" "));
      assert.ok(names.some((n) => /^audio\/[a-z0-9_]+\.hps$/.test(n)), `a music file among ${names.join(" ")}`);
    }
    while (s.index < ROWS) s.step(false);
    const rows = [...Array(ROWS).keys()];
    assert.ok(rows.every((r) => pcm.has(r)), "every row's sound");
    const total = rows.reduce((n, r) => n + pcm.get(r)!.length / 2, 0);
    // (32 kHz at the console's 59.94 frames a second: 533.87 stereo samples a row, AX frames of 160)
    assert.equal(total, Math.floor((ROWS * 8008) / 15 / 160 + (((ROWS * 8008) % (15 * 160)) ? 1 : 0)) * 160);
    runs.push({ log: s.core_!.soundLog(), sound: sha(rows.map((r) => pcm.get(r)!)), samples: total });
    s.close();
  }
  assert.deepEqual(runs[1].log, runs[0].log, "the same requests");
  assert.equal(runs[1].sound, runs[0].sound, "the same sound");
  assert.ok(runs[0].log.length > 4);
});

test("the game's requests are the decomp's: Ready, each fighter's entry, GO!, the stage's music", withSound, async () => {
  const tape = tapeOf(ROWS);
  const { s } = await soundSession(tape);
  await s.warmup();
  while (s.index < ROWS) s.step(false);
  const log = s.core_!.soundLog();
  s.close();
  const sounds = log.filter((l) => l[1] === 1).map(([row, , id, vol, pan, track, channel]) => ({ row, id, vol, pan, track, channel }));
  // (lbAudioAx_800237A8 / 80024304 -> fn_80023750: volume and pan doubled, 0x7F -> 254, 0x40 -> 128; channel 7)
  const ready = sounds.find((x) => x.id === 0x7c85d);
  assert.deepEqual(ready, { row: 0, id: 0x7c85d, vol: 254, pan: 128, track: 0, channel: 7 }, "Ready when the match starts");
  const entries = sounds.filter((x) => x.id === 0x8b);
  assert.equal(entries.length, 2, "one entry sound a fighter");
  for (const e of entries) assert.deepEqual({ vol: e.vol, pan: e.pan, track: e.track, channel: e.channel }, { vol: 254, pan: 128, track: 0x16, channel: 7 });
  const go = sounds.find((x) => x.id === 0x7c857);
  assert.ok(go, "GO!");
  assert.ok(go!.row > entries[1].row && entries[0].row > ready!.row, `in order: ${JSON.stringify(sounds.slice(0, 6))}`);
  // (the music: started with the match, before its first row)
  assert.ok(log.some((l) => l[1] === 2 && l[0] === 0), "the stage's music");
});

test("a seek back has the sound of a straight play, row for row", withSound, async () => {
  const tape = tapeOf(ROWS);
  const straight = await soundSession(tape);
  await straight.s.warmup();
  while (straight.s.index < ROWS) straight.s.step(false);
  straight.s.close();

  const { s, pcm } = await soundSession(tape);
  await s.warmup();
  const seekTo = async (row: number) => {
    if (s.needsRestart(row)) await s.rewindFor(row);
    while (!s.seekStep(row, 1e9)) { /* one call does it */ }
  };
  await seekTo(350);
  for (const back of [300, 20, 120]) {
    pcm.clear();
    await seekTo(back);
    await seekTo(back + 40);
    for (let r = back; r <= back + 40; r++) {
      if (!pcm.has(r)) continue; // (rows the seek does not step again: before a checkpoint it rewound to)
      assert.equal(sha([pcm.get(r)!]), sha([straight.pcm.get(r)!]), `row ${r} after a seek back to ${back}`);
    }
    assert.ok(pcm.has(back + 40), `row ${back + 40} stepped again`);
  }
  s.close();
});

test("a video from the first row has every row's sound from it, the first row's too: as the match opened, shown, and rewound to", withSound, async () => {
  // (Export Video of the whole game seeks to row 0 and steps a row a frame, keeping each row's sound as it is handed out - exportsound.ts.
  // Row 0 is stepped when the match opens, and a seek back to it rewinds to the state after it: its sound was never handed out again,
  // and every video from the first row with the sound failed with "the sound of game frame -123 was not made")
  const tape = tapeOf(ROWS);
  const straight = await soundSession(tape);
  await straight.s.warmup();
  while (straight.s.index < 120) straight.s.step(false);
  straight.s.close();

  const { s } = await soundSession(tape);
  await s.warmup();
  const video = async () => {
    const snd = new SessionSound(tape.gameFrame(0), tape.gameFrame(119), (row) => tape.gameFrame(row));
    s.onSound = (p, row) => snd.take(p, row);
    // (as the page's export seeks: tests/gxpath-export.test.ts, src/gxpage.ts seekForExport)
    if (s.needsRestart(0)) await s.rewindFor(0);
    while (!s.seekStep(0, 1e9)) { /* one call */ }
    for (let r = 1; r < 120; r++) s.step(true);
    const got: Int16Array[] = [];
    for await (const b of snd.blocks()) got.push(b.pcm);
    s.onSound = null;
    return got;
  };
  // (the match as it opened; row 0 shown and nothing after it; rewound to from far on)
  for (const before of [-1, 0, 300]) {
    if (before >= 0) {
      if (s.needsRestart(before)) await s.rewindFor(before);
      while (!s.seekStep(before, 1e9)) { /* */ }
    }
    const got = await video();
    assert.equal(got.length, 120, `a block a row (from ${before})`);
    for (let r = 0; r < 120; r++) assert.equal(sha([got[r]]), sha([straight.pcm.get(r)!]), `row ${r}'s sound (from ${before})`);
  }
  s.close();
});

/** a bare module instance (no session: no kept game data, so no rewind) with the game files; `sound` written into it first */
async function bareCore(sound: string[] = []): Promise<GxCore> {
  const { factory, coreOptions } = await moduleOf();
  if (!filesOf) {
    const names = gxNames(fs.readdirSync(gameFiles!));
    filesOf = { names, files: new Map(names.map((n) => [n, new Uint8Array(fs.readFileSync(path.join(gameFiles!, n)))])) };
  }
  const core = await GxCore.create((o) => (factory as (o: Record<string, unknown>) => Promise<never>)({ ...o, ...coreOptions }), filesOf.files);
  for (const n of sound) core.writeFile(n, new Uint8Array(fs.readFileSync(path.join(audio!, n))));
  return core;
}

/** `rows` rows stepped: the sound of all of them (hashed), the stream of each row (hashed), the requests, the music voices at the end */
function playRows(core: GxCore, whole: Uint8Array, rows: number) {
  const streams: string[] = [], pcm: Int16Array[] = [];
  for (let i = 0; i < rows; i++) {
    core.step(nativeRow(whole, i));
    streams.push(crypto.createHash("sha256").update(core.stream()).digest("hex"));
    pcm.push(core.soundPcm());
  }
  return { sound: sha(pcm), streams, log: core.soundLog(), music: core.mod._msl_gxw_sound_info?.(3) ?? -1 };
}

test("a second start of the sound in the same module sounds as a first start", withSound, async () => {
  const tape = tapeOf(ROWS);
  const whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  // (the module names the files it needs at the first start; the page writes them and starts the sound again)
  const twice = await bareCore();
  twice.openMatch(whole, filesOf!.names, "slippi");
  const first = twice.soundStart();
  assert.ok(first.need && first.need.length > 0, `the first start names the sound files: ${JSON.stringify(first)}`);
  for (const n of first.need!) twice.writeFile(n, new Uint8Array(fs.readFileSync(path.join(audio!, n))));
  // (no rewind and no new opening: the second start runs in the same module, over the first start's state)
  assert.deepEqual(twice.soundStart(), { on: true }, "a second start in the same module starts");
  const again = playRows(twice, whole, ROWS);
  twice.destroy();

  const once = await bareCore(first.need!);
  once.openMatch(whole, filesOf!.names, "slippi");
  assert.deepEqual(once.soundStart(), { on: true }, "one start with every file there");
  const fresh = playRows(once, whole, ROWS);
  once.destroy();

  assert.equal(again.sound, fresh.sound, "the same sound as a first start");
  assert.deepEqual(again.log, fresh.log, "the same requests as a first start");
  assert.ok(fresh.log.length > 4);
});

test("the stream drawn is the same with the sound on and off, and the stage's music plays", withSound, async () => {
  const tape = tapeOf(ROWS);
  const whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const off = await bareCore();
  off.openMatch(whole, filesOf!.names, "slippi");
  const silent = playRows(off, whole, ROWS);
  off.destroy();
  assert.equal(silent.log.length, 0, "no requests while the sound is off");

  const probe = await bareCore();
  probe.openMatch(whole, filesOf!.names, "slippi");
  const need = probe.soundStart().need ?? [];
  probe.destroy();
  const on = await bareCore(need);
  on.openMatch(whole, filesOf!.names, "slippi");
  assert.deepEqual(on.soundStart(), { on: true });
  const heard = playRows(on, whole, ROWS);
  on.destroy();

  // (the start wrote nothing of the match's state: the stage's music is read from its table, not through Ground_801C24F8)
  for (let r = 0; r < ROWS; r++) assert.equal(heard.streams[r], silent.streams[r], `row ${r}: the same stream with the sound on`);
  assert.ok(need.some((n) => /^audio\/[a-z0-9_]+\.hps$/.test(n)), `the stage's music file among ${need.join(" ")}`);
  assert.ok(heard.log.some((l) => l[1] === 2 && l[0] === 0), "the stage's music, started with the match");
  assert.ok(heard.music > 0, `the music's voices play at row ${ROWS} (${heard.music})`);
});
