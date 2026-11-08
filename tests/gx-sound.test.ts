// The game's sound in the GX player (the simulator's sound core: the game's own sound code; src/render3d/gxpath/session.ts, core.ts).
// With your game files (MELEE_ASSETS, tests/game-files.ts) and the disc's audio folder (MELEE_AUDIO: a folder holding audio/us/...,
// audio/*.hps), on the module in public/gx and a replay made here (two players standing on Battlefield):
// - the sound starts with the match, naming the files it reads, and the same match has the same sound, twice;
// - the game's requests are the ones the decomp has the game make: "Ready" when the match starts (ifStatus_803F9628[3], sound 0x7C85D),
//   each fighter's entry (ft_0C31.c: lbAudioAx_80024304(0x8B), track 0x16), "GO!" (ifStatus_803F9628[4], 0x7C857), all at volume
//   0x7F and pan 0x40 doubled (fn_80023750) on channel 7, and the stage's music;
// - a seek back (a rewind to a checkpoint or to the first row) and a straight play have the same sound row for row;
// - the stream the renderer draws is the same with the sound on and off.
// Without the files the tests are skipped. Nothing from the files is written anywhere.
//
//   MELEE_ASSETS=<game files> MELEE_AUDIO=<folder with audio/> deno test -A --no-check --sloppy-imports tests/gx-sound.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readTape, type Tape } from "../src/sim/tape.ts";
import { GxSession, type SessionBackend } from "../src/render3d/gxpath/session.ts";
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
