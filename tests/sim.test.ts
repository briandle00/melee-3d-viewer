// src/sim: the simulator in the browser, without the simulator. The wire
// layouts, a replay read into the simulator's rows (a small replay made
// here, with a rollback), the drives against a fake Wasm module (the track
// stops where the game parts from the replay, and a later drive that goes
// further takes over), and when the page hands the player a longer track.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { COMPARE, CONFIG, INPUT_SIZE, offsetOf, readField, STREAM_FRAME, INPUT_PLAYER, STAGE_EVENTS, ARITHMETIC_SPLIT_FMA, ARITHMETIC_LEGACY_FNMSUBS } from "../src/sim/wire.ts";
import { readTape, processedStick, triggerByte, Unsupported, driveOrder, type Tape } from "../src/sim/tape.ts";
import { SimViewer, writeGameFiles, dropGameFiles, type SimModule } from "../src/sim/engine.ts";
import { runDrives } from "../src/sim/drive.ts";
import type { FromWorker } from "../src/sim/protocol.ts";
import { shouldPublish, LEAD, LOW } from "../src/sim/policy.ts";
import { makeReplay } from "./replay-fixture.ts";

test("wire rows are wire.h's sizes and offsets", () => {
  assert.equal(CONFIG.size, 64);
  assert.equal(INPUT_SIZE, 52);
  assert.equal(STREAM_FRAME.size, 188);
  assert.equal(offsetOf(CONFIG, "camera_mode"), 24);
  assert.equal(offsetOf(CONFIG, "slippi_patches"), 35);
  assert.equal(offsetOf(CONFIG, "players"), 36);
  assert.equal(offsetOf(COMPARE, "pos_x"), 24);
  assert.equal(offsetOf(COMPARE, "action_id"), 149);
  assert.equal(offsetOf(COMPARE, "percent"), 173);
});

test("sticks and triggers as the validator reads them", () => {
  assert.equal(processedStick(0.5), 40);
  assert.equal(processedStick(-0.3125), -25);
  assert.equal(processedStick(-1.2), -80);
  assert.equal(triggerByte(0), 0);
  assert.equal(triggerByte(1), 140);
  assert.equal(triggerByte(0.5), 70);
});

// ---- a small replay (tests/replay-fixture.ts): two players on Battlefield, frames -123..-120, frame -121 played twice (a rollback)
test("a replay read into the simulator's config and rows", () => {
  const tape = readTape(makeReplay(), { playedOn: "dolphin" });
  assert.equal(tape.count, 4);
  assert.equal(tape.firstFrame, -123);
  const cfg = new DataView(tape.config({ ucf: driveOrder(tape, 1)[0].ucf, splitFma: false }).buffer);
  assert.equal(readField(cfg, CONFIG, "stage_id"), 31);
  assert.equal(readField(cfg, CONFIG, "frame_id"), -124);
  assert.equal(readField(cfg, CONFIG, "frame_pre_random_seed"), 1000 - 123);
  assert.equal(readField(cfg, CONFIG, "initial_random_seed"), 0xdeadbeef);
  assert.equal(readField(cfg, CONFIG, "num_players"), 2);
  assert.equal(readField(cfg, CONFIG, "stock_count"), 4);
  assert.equal(readField(cfg, CONFIG, "camera_mode"), 0);
  assert.equal(readField(cfg, CONFIG, "arithmetic_flags"), ARITHMETIC_LEGACY_FNMSUBS);
  assert.equal(readField(cfg, CONFIG, "brawl_offscreen_damage"), 1);
  assert.equal(readField(cfg, CONFIG, "ucf_cardinals_1_0_enabled"), 1); // no code list: the validator's default
  assert.equal(readField(cfg, CONFIG, "stage_event_streams"), 3);
  assert.equal(cfg.getUint8(36 + 2), (1 << 1) | 1); // port 1, facing right
  assert.equal(cfg.getUint8(36 + 7 + 2), 2 << 1);     // port 2, facing left
  const split = new DataView(tape.config({ ucf: driveOrder(tape, 1)[0].ucf, splitFma: true }).buffer);
  assert.equal(readField(split, CONFIG, "arithmetic_flags"), ARITHMETIC_LEGACY_FNMSUBS | ARITHMETIC_SPLIT_FMA);

  const row = new Uint8Array(STREAM_FRAME.size), v = new DataView(row.buffer);
  tape.frame(2, row);
  const input = offsetOf(STREAM_FRAME, "input"), se = offsetOf(STREAM_FRAME, "stage_events");
  assert.equal(readField(v, STREAM_FRAME, "frame_pre_random_seed"), 1000 - 121);
  // (the rolled-back pass's 99 is gone)
  assert.equal(readField(v, INPUT_PLAYER, "main_x", 0, input), 3);
  assert.equal(readField(v, INPUT_PLAYER, "main_y", 0, input), -3);
  assert.equal(readField(v, INPUT_PLAYER, "c_x", 0, input + INPUT_PLAYER.size), 7);
  assert.equal(readField(v, INPUT_PLAYER, "nml_main_x", 0, input), 40);
  assert.equal(readField(v, INPUT_PLAYER, "l", 0, input), 70);
  assert.equal(readField(v, STAGE_EVENTS, "fighter_pre_random_seed", 0, se), 500 - 121);
  assert.deepEqual(tape.expected(2).map((e) => e?.x), [2, 3]);
  tape.frame(1, row);
  assert.equal(readField(v, STAGE_EVENTS, "fod_platform_mask", 0, se), 2);
  assert.equal(readField(v, STAGE_EVENTS, "fod_platform_height", 1, se), 20);
});

test("a gap ends the rows; a stage the simulator does not play is refused", () => {
  assert.equal(readTape(makeReplay({ withGap: true }), {}).count, 3);
  assert.throws(() => readTape(makeReplay({ stage: 4 }), {}), Unsupported);
});

// ---- a fake Wasm module: the viewer API over the tape it is given. Its game
// parts from the replay at frame -121 unless the config asks for split fused
// arithmetic; its track is one "rng" line a frame, and a setup line.
function fakeModule(tape: Tape, log: string[]): SimModule {
  const heap = new Uint8Array(1 << 20);
  let top = 16;
  const files = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  let split = false, step = 0, text = new Uint8Array(0);
  const out = new Uint8Array(4096);
  const mod: SimModule = {
    HEAPU8: heap,
    FS: {
      mkdirTree: () => {},
      writeFile: (p, d) => { files.set(p, d); },
      unlink: (p) => { files.delete(p); },
    },
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    _msl_viewer_create(root, cfg, cfgSize, _prev, inputSize, outPtr) {
      if (cfgSize !== 64 || inputSize !== 52) return 1;
      const r = new TextDecoder().decode(heap.subarray(root, heap.indexOf(0, root)));
      log.push(`create ${r} files=${files.size}`);
      split = (heap[cfg + 25] & ARITHMETIC_SPLIT_FMA) !== 0;
      step = 0;
      text = enc.encode(`[-123,"bg",0,0,0]\n`);
      new DataView(heap.buffer).setUint32(outPtr, 7, true);
      return 0;
    },
    _msl_viewer_step(_v, frame, size) {
      if (size !== 188) return 1;
      const g = tape.gameFrame(step);
      const seed = new DataView(heap.buffer).getUint32(frame, true);
      text = enc.encode(`[${g},"rng",${seed}]\n`);
      out.fill(0);
      const w = new DataView(out.buffer);
      tape.expected(step).forEach((e, s) => {
        if (!e) return;
        const off = !split && g >= -121 ? 5 : 0;
        w.setFloat32(offsetOf(COMPARE, "pos_x") + 4 * s, e.x + off, true);
        w.setFloat32(offsetOf(COMPARE, "pos_y") + 4 * s, e.y, true);
        w.setUint16(offsetOf(COMPARE, "action_id") + 2 * s, e.action, true);
        w.setUint8(offsetOf(COMPARE, "stocks") + s, e.stocks);
        w.setFloat32(offsetOf(COMPARE, "percent") + 4 * s, e.percent, true);
      });
      step++;
      return 0;
    },
    _msl_viewer_track(_v, sizePtr) {
      const p = 200000;
      heap.set(text, p);
      new DataView(heap.buffer).setUint32(sizePtr, text.length, true);
      text = new Uint8Array(0);
      return p;
    },
    _msl_viewer_output(_v, sizePtr) {
      heap.set(out, 300000);
      new DataView(heap.buffer).setUint32(sizePtr, out.length, true);
      return 300000;
    },
    _msl_viewer_destroy: () => { log.push("destroy"); },
  };
  return mod;
}

async function drive(maxDrives: number) {
  const tape = readTape(makeReplay(), {});
  const log: string[] = [], got: FromWorker[] = [];
  let t = 0;
  await runDrives(tape, {
    async open(tp, options) {
      const mod = fakeModule(tp, log);
      const names = writeGameFiles(mod, [["PlCo.dat", new Uint8Array(4)], ["GrNBa.dat", new Uint8Array(4)]]);
      try { return SimViewer.create(mod, tp.config(options), tp.previous()); } finally { dropGameFiles(mod, names); }
    },
    post: (m) => got.push(m),
    stopped: () => false,
    pause: async () => {},
    now: () => (t += 1),
  }, maxDrives, 2);
  return { log, got };
}

test("one drive: the track stops where the game parts from the replay", async () => {
  const { log, got } = await drive(1);
  assert.deepEqual(log, ["create /data/raw files=2", "destroy"]);
  const chunks = got.filter((m) => m.type === "chunk") as Extract<FromWorker, { type: "chunk" }>[];
  const events = chunks.flatMap((c) => (c.text ? JSON.parse("[" + c.text + "]") : []));
  // (the setup line and frames -123, -122: frame -121 is the other game's)
  assert.deepEqual(events.map((e: unknown[]) => e[1] + ":" + e[0]), ["bg:-123", "rng:-123", "rng:-122"]);
  assert.equal(chunks.at(-1)!.until, -121);
  assert.deepEqual(got.find((m) => m.type === "diverged"), { type: "diverged", drive: 0, frame: -121, lane: "pos_x:0" });
  const done = got.at(-1) as Extract<FromWorker, { type: "done" }>;
  assert.equal(done.type, "done");
  assert.equal(done.exact, false);
  assert.equal(done.until, -121);
});

test("a later drive that goes further takes over with all it has", async () => {
  const { got } = await drive(2);
  const r = got.findIndex((m) => m.type === "restart");
  assert.ok(r > 0);
  const after = got.slice(r).filter((m) => m.type === "chunk") as Extract<FromWorker, { type: "chunk" }>[];
  const events = after.flatMap((c) => (c.text ? JSON.parse("[" + c.text + "]") : []));
  assert.deepEqual(events.map((e: unknown[]) => e[0]), [-123, -123, -122, -121, -120]);
  const done = got.at(-1) as Extract<FromWorker, { type: "done" }>;
  assert.deepEqual([done.exact, done.drive, done.drives], [true, 1, 2]);
});

test("the player gets a longer track seldom: well ahead first, then near its end", () => {
  const base = { published: null, frontier: 0, playhead: 0, done: false, rate: 3000, remaining: 20000 };
  assert.equal(shouldPublish({ ...base, frontier: LEAD - 1 }), false);
  assert.equal(shouldPublish({ ...base, frontier: LEAD }), true);
  // (nearly done: the whole track instead)
  assert.equal(shouldPublish({ ...base, frontier: LEAD, remaining: 1000 }), false);
  assert.equal(shouldPublish({ ...base, done: true }), true);
  const later = { ...base, published: 2000, frontier: 6000 };
  assert.equal(shouldPublish({ ...later, playhead: 2000 - LOW - 1 }), false);
  assert.equal(shouldPublish({ ...later, playhead: 2000 - LOW }), true);
  // (a jump past the simulator: handed over once it is well ahead of the frame shown again)
  assert.equal(shouldPublish({ ...later, playhead: 5900 }), false);
  assert.equal(shouldPublish({ ...later, playhead: 5000 }), true);
  assert.equal(shouldPublish({ ...later, frontier: 2000, done: true }), false);
});
