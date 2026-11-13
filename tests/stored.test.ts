// Stored checkpoints (src/render3d/gxpath/stored.ts) and the checkpoints kept without a pass over the module's memory
// (checkpoints.ts keepPages, add, rewindFresh, baseline with known hashes, limit): the encodings read back as written, and - with
// MELEE_ASSETS (tests/game-files.ts) - a set made by one instance of the real module (public/gx), written into another instance opened
// fresh, plays on exactly as a straight play: every row's stream and memory updates equal, and the memory equal at the end.
//   deno test -A --no-check --sloppy-imports tests/stored.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { driveOrder, readTape, type Tape } from "../src/sim/tape.ts";
import { GxCore, type GxCoreFactory } from "../src/render3d/gxpath/core.ts";
import { nativeRow, nativeTape } from "../src/render3d/gxpath/tapebridge.ts";
import { Checkpoints, gameDataWrites, matchPages, PAGE, pageHash, pageHashes, pageHashes2, type CheckpointMemory } from "../src/render3d/gxpath/checkpoints.ts";
import { deadBytes, decodeCheckpoint, decodeManifest, encodeCheckpoint, encodeManifest, extendStored, makeStored, sameBaseline, type StoredManifest } from "../src/render3d/gxpath/stored.ts";
import { fastPageHasher } from "../src/render3d/gxpath/pagehash.ts";
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
const tapeOf = (rows: number): Tape => readTape(makeReplay(rows), {}, { stadiumTransformations: true });

const PAGES = 8;
function memory(): CheckpointMemory {
  const HEAPU8 = new Uint8Array(PAGES * PAGE);
  for (let p = 0; p < PAGES; p++) HEAPU8.fill(p, p * PAGE, (p + 1) * PAGE);
  return { HEAPU8, _msl_gxw_heap_top: () => PAGES * PAGE };
}
const at = (m: CheckpointMemory, p: number) => m.HEAPU8[p * PAGE + 123];
const put = (m: CheckpointMemory, p: number, v: number) => m.HEAPU8.fill(v, p * PAGE, (p + 1) * PAGE);

test("a checkpoint and a manifest read back as written; anything else is refused", async () => {
  const pages = new Map([[3, new Uint8Array(PAGE).fill(7)], [1, new Uint8Array(PAGE).fill(9)]]);
  pages.get(3)![5] = 200;
  const c = await decodeCheckpoint(await encodeCheckpoint({ row: 1234, pages }));
  assert.equal(c.row, 1234);
  assert.deepEqual([...c.pages.keys()], [1, 3]);
  assert.equal(c.pages.get(3)![5], 200);
  assert.equal(c.pages.get(1)![PAGE - 1], 9);
  const m: StoredManifest = { id: "module a, files b, tape c, slippi, outer, silent", rows: 9000, every: 600, dense: 120, base: Uint32Array.from([1, 2, 0xffffffff]),
                              stored: [600, 1200], lists: new Map([[120, Uint32Array.from([2, 3])], [240, Uint32Array.from([])]]) };
  const back = await decodeManifest(await encodeManifest(m));
  assert.deepEqual({ ...back, base: [...back.base], lists: [...back.lists].map(([r, l]) => [r, [...l]]) },
                   { ...m, base: [...m.base], lists: [...m.lists].map(([r, l]) => [r, [...l]]) });
  await assert.rejects(decodeCheckpoint(await encodeManifest(m)));
  await assert.rejects(decodeManifest(await encodeCheckpoint({ row: 1, pages })));
});

test("pageHash is pageHashes' word for one page", () => {
  const m = memory();
  m.HEAPU8[3 * PAGE + 77] = 5;
  const all = pageHashes(m);
  for (let p = 0; p < PAGES; p++) assert.equal(pageHash(m, p), all[p]);
});

test("fastPageHasher: a change to any one word of a page changes its hash, and only that page's", () => {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const h = fastPageHasher(memory)!;
  assert.ok(h, "this engine has SIMD");
  const before = [0, 1, 2, 3].map((p) => h(p));
  const u32 = new Uint32Array(memory.buffer);
  for (const word of [0, 1, 5, 15, 16, 1000, PAGE / 4 - 1]) {
    u32[2 * PAGE / 4 + word] ^= 0x80;
    assert.notEqual(h(2), before[2], `word ${word}`);
    assert.deepEqual([0, 1, 3].map((p) => h(p)), [before[0], before[1], before[3]]);
    u32[2 * PAGE / 4 + word] ^= 0x80;
    assert.equal(h(2), before[2]);
  }
});

test("pageHashes2: equal memory hashes equal; a change to any one word changes its page's pair", () => {
  const a = memory(), b = memory();
  assert.deepEqual(pageHashes2(a), pageHashes2(b));
  for (const word of [0, 1, 2, 3, 5000, PAGE / 4 - 1]) {
    const c = memory();
    new Uint32Array(c.HEAPU8.buffer)[2 * PAGE / 4 + word] ^= 1;
    const h = pageHashes2(c), base = pageHashes2(a);
    assert.ok(h[4] !== base[4] || h[5] !== base[5], `word ${word}`);
    assert.deepEqual([...h.slice(0, 4), ...h.slice(6)], [...base.slice(0, 4), ...base.slice(6)]);
  }
});

test("without a pass: a known baseline, a checkpoint of listed pages, one added whole, a rewind by opening again", async () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m, pageHashes(m));
  assert.equal(k.stats.hashes, 0, "no pass for a baseline whose hashes are known");
  put(m, 2, 50); put(m, 4, 60);
  k.keepPages(m, 600, [2, 4]);
  k.add({ row: 1200, pages: new Map([[5, new Uint8Array(PAGE).fill(70)]]) });
  assert.equal(k.stats.hashes, 0);
  put(m, 2, 51); put(m, 6, 80);
  let reopened = 0;
  const fresh = memory();
  const got = await k.rewindFresh(k.latest(700), async () => { reopened++; return fresh; });
  assert.equal(got, fresh);
  assert.equal(reopened, 1);
  assert.deepEqual([2, 4, 5, 6].map((p) => at(fresh, p)), [50, 60, 5, 6], "the checkpoint's pages on the opened-again memory, the rest its own");
  const again = memory();
  await k.rewindFresh(k.latest(5000), async () => again);
  assert.deepEqual([2, 4, 5].map((p) => at(again, p)), [2, 4, 70]);
  assert.equal(k.stats.hashes, 0, "no pass for any of it");
  assert.equal(await k.rewindFresh(null, async () => null), null, "a caller gone: nothing written");
});

test("limit: more than the limit drops the one farthest from where the match is", () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m);
  let near = 3000;
  k.limit(4, () => near);
  for (const row of [600, 1200, 1800, 2400, 3000]) k.keepPages(m, row, []);
  assert.deepEqual([600, 1200, 1800, 2400, 3000].filter((r) => k.has(r)), [1200, 1800, 2400, 3000]);
  near = 1200;
  k.keepPages(m, 3600, []);
  assert.deepEqual([1200, 1800, 2400, 3000, 3600].filter((r) => k.has(r)), [1200, 1800, 2400, 3000]);
});

// ---- the real module
async function realModule(): Promise<{ open: (whole: Uint8Array) => Promise<GxCore>; names: string[]; memory: () => WebAssembly.Memory }> {
  const dir = path.join(import.meta.dirname!, "..", "public", "gx");
  const names = gxNames(fs.readdirSync(gameFiles!));
  const files = new Map(names.map((n) => [n, new Uint8Array(fs.readFileSync(path.join(gameFiles!, n)))]));
  const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dir, "gx-core.wasm")));
  const factory = (await import(new URL("../public/gx/gx-core.js", import.meta.url).href)).default as GxCoreFactory;
  let memory: WebAssembly.Memory | null = null;
  const options = { instantiateWasm: (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance) => void) => {
    WebAssembly.instantiate(wasm, imports).then((i) => { memory = i.exports.memory as WebAssembly.Memory; ok(i); }); return {}; } };
  return {
    names,
    // (the last instance's memory, for the faster pass)
    memory: () => memory!,
    // (a fresh instance, the game data loaded and put back at once, as the players open a match: session.ts openIn)
    async open(whole) {
      const core = await GxCore.create(factory, files, options);
      if (core.loadGame(names)) core.rewind();
      core.openMatch(whole, names, "slippi");
      core.step(nativeRow(whole, 0));
      return core;
    },
  };
}
const rowKey = async (c: GxCore) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", c.stream().slice()));
  return [...d].join(",") + "|" + c.updates().map((u) => `${u.pos}:${u.addr}:${u.type}:${u.data.join(",")}`).join(";");
};

test("the real module: a stored set written into a fresh instance plays on as the straight play", withGameFiles, async () => {
  const ROWS = 420, tape = tapeOf(ROWS), whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const mod = await realModule();
  // made by one instance
  const maker = await mod.open(whole);
  const made = new Map<number, Uint8Array>();
  const hasher = fastPageHasher(mod.memory());
  assert.ok(hasher, "this engine has SIMD");
  const times = { step: 0, pass: 0, copy: 0, give: 0 };
  const manifest = (await makeStored(maker, whole, tape.count, { id: "t", every: 120, dense: 40, pageHash: hasher!, times,
                                                                 onCheckpoint: async (c) => { made.set(c.row, await encodeCheckpoint(c)); } }))!;
  maker.destroy();
  assert.ok(times.step > 0 && times.pass > 0 && times.copy > 0, JSON.stringify(times));
  // (the faster pass's lists are the JavaScript pass's)
  const slow = await mod.open(whole);
  const again = (await makeStored(slow, whole, tape.count, { id: "t", every: 120, dense: 40, onCheckpoint: () => {} }))!;
  slow.destroy();
  assert.deepEqual([...again.lists].map(([r, l]) => [r, [...l]]), [...manifest.lists].map(([r, l]) => [r, [...l]]));
  assert.deepEqual(manifest.stored, [120, 240, 360]);
  assert.deepEqual([...manifest.lists.keys()], [40, 80, 120, 160, 200, 240, 280, 320, 360, 400]);
  const m = await decodeManifest(await encodeManifest(manifest));
  // the reference: a straight play in another instance, each row's stream and updates
  const ref = await mod.open(whole);
  assert.deepEqual([...pageHashes(ref.mod as unknown as CheckpointMemory)], [...m.base], "the first row's state is the same bytes in every instance");
  assert.ok(sameBaseline(ref.mod as unknown as CheckpointMemory, m), "the sample of the baseline holds");
  const other = { ...m, base: m.base.slice() };
  other.base[[...m.lists.get(40)!][0]] ^= 1;
  assert.ok(!sameBaseline(ref.mod as unknown as CheckpointMemory, other), "a baseline that differs in a page a match changes fails it");
  const odd = [...m.lists.get(40)!][0];
  assert.ok(sameBaseline(ref.mod as unknown as CheckpointMemory, other, 256, (p) => p === odd), "unless the host says that page may differ");
  const want = new Map<number, string>();
  for (let r = 1; r < tape.count; r++) { ref.step(nativeRow(whole, r)); want.set(r, await rowKey(ref)); }
  const end = ref.snapshot();
  // a fresh instance: the manifest's baseline, the stored checkpoint at 240 written in, on from there
  const play = await mod.open(whole);
  const reopen = async () => {
    play.rewind(); play.openMatch(whole, mod.names, "slippi"); play.step(nativeRow(whole, 0));
    return play.mod as unknown as CheckpointMemory;
  };
  const k = new Checkpoints(120);
  k.baseline(play.mod as unknown as CheckpointMemory, m.base);
  k.add(await decodeCheckpoint(made.get(240)!));
  await k.rewindFresh(k.latest(300), reopen);
  for (let r = 240; r < tape.count; r++) {
    // (and a checkpoint of the listed pages kept on the way, as a player keeps them)
    const list = m.lists.get(r);
    if (list) k.keepPages(play.mod as unknown as CheckpointMemory, r, list);
    play.step(nativeRow(whole, r));
    assert.equal(await rowKey(play), want.get(r), `row ${r}`);
  }
  const got = play.snapshot();
  const differ = [...new Set([...got.pages.keys(), ...end.pages.keys()])]
    .filter((p) => { const a = got.pages.get(p), b = end.pages.get(p); return !a || !b || a.some((v, i) => v !== b[i]); });
  // (the stack's unused bytes below its base are what calls left there, which a rewind leaves as they are: at most that page)
  assert.ok(differ.length <= 1, `the memory at the end: pages that differ ${differ.join(", ")}`);
  // back to the kept one at 320 (listed pages, no pass), on to the end again
  await k.rewindFresh(k.latest(330), reopen);
  for (let r = 320; r < tape.count; r++) { play.step(nativeRow(whole, r)); assert.equal(await rowKey(play), want.get(r), `again row ${r}`); }
  assert.equal(k.stats.hashes, 0, "no pass over the memory by the player");
  for (const x of [ref, play]) x.destroy();
});

test("the real module: rows given whole checkpoints when the set is made, or added to it later, are the same checkpoints", withGameFiles, async () => {
  const ROWS = 420, tape = tapeOf(ROWS), whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const mod = await realModule();
  const keep = new Map<number, Map<number, Uint8Array>>();
  // made with them
  const a = await mod.open(whole);
  const withExtra = (await makeStored(a, whole, tape.count, { id: "t", every: 120, dense: 40, extra: [200, 330, 360],
                                                              onCheckpoint: (c) => { keep.set(c.row, c.pages); } }))!;
  a.destroy();
  assert.deepEqual(withExtra.stored, [120, 200, 240, 330, 360]);
  // made without, then added: from the stored one nearest before each, the simulator alone
  const b = await mod.open(whole);
  const plainKept = new Map<number, Map<number, Uint8Array>>();
  const plain = (await makeStored(b, whole, tape.count, { id: "t", every: 120, dense: 40, onCheckpoint: (c) => { plainKept.set(c.row, c.pages); } }))!;
  b.destroy();
  const c = await mod.open(whole);
  const added = new Map<number, Map<number, Uint8Array>>();
  let gets = 0, reopens = 0;
  const extended = await extendStored(c, whole, plain, [330, 200, 360], {
    get: async (row) => { gets++; return { row, pages: plainKept.get(row)! }; },
    reopen: async () => { reopens++; c.rewind(); c.openMatch(whole, mod.names, "slippi"); c.step(nativeRow(whole, 0)); },
    onCheckpoint: (k) => { added.set(k.row, k.pages); },
  });
  c.destroy();
  assert.deepEqual(extended.stored, [120, 200, 240, 330, 360]);
  assert.ok(gets >= 2 && reopens >= 2, JSON.stringify({ gets, reopens }));
  for (const row of [200, 330]) {
    assert.deepEqual([...extended.lists.get(row)!], [...withExtra.lists.get(row)!], `list ${row}`);
    const x = added.get(row)!, y = keep.get(row)!;
    // (the stack's unused bytes: at most that page differs)
    const differ = [...x.keys()].filter((p) => !y.has(p) || x.get(p)!.some((v, i) => v !== y.get(p)![i]));
    assert.ok(differ.length <= 1, `checkpoint ${row}: pages ${differ.join(", ")}`);
  }
});

test("rewindPass: back to a checkpoint by a pass over the pages a match can change, the match opened again only when it must", async () => {
  const m = memory(), k = new Checkpoints(120);
  const h = (p: number) => BigInt(pageHash(m, p)) * 7919n + BigInt(m.HEAPU8[p * PAGE + 9]);
  k.baseline(m);
  put(m, 2, 50); put(m, 4, 60);
  k.keep(m, 600);
  put(m, 2, 51); put(m, 5, 70);
  let reopens = 0, unchanged = true;
  const reopen = async () => { reopens++; for (let p = 0; p < PAGES; p++) put(m, p, p); return m; };
  const o = { hash: h, pages: [0, 1, 2, 3, 4, 5, 6], unchanged: () => unchanged, reopen };
  // the first: opened again (the baseline's hashes taken from it)
  await k.rewindPass(m, k.latest(700), o);
  assert.equal(reopens, 1);
  assert.deepEqual([2, 4, 5].map((p) => at(m, p)), [50, 60, 5]);
  // then by the pass alone: pages changed since back as they started (page 5 seen at the first), the checkpoint's written
  put(m, 2, 52); put(m, 4, 61);
  await k.rewindPass(m, k.latest(700), o);
  assert.equal(reopens, 1);
  assert.deepEqual([2, 4, 5].map((p) => at(m, p)), [50, 60, 5]);
  // a page never seen as it started: opened again, then kept
  put(m, 5, 71); put(m, 6, 80);
  await k.rewindPass(m, null, o);
  assert.equal(reopens, 2);
  assert.deepEqual([2, 4, 5, 6].map((p) => at(m, p)), [2, 4, 5, 6]);
  put(m, 5, 72); put(m, 6, 81);
  await k.rewindPass(m, null, o);
  assert.equal(reopens, 2, "pages 5 and 6 were seen as they started: no reopen");
  assert.deepEqual([5, 6].map((p) => at(m, p)), [5, 6]);
  // a page outside the ones the host says a match can change is never looked at (the game data the module keeps)
  put(m, 7, 90);
  await k.rewindPass(m, k.latest(700), o);
  assert.equal(at(m, 7), 90);
  // the game data the pass leaves out changed (the host says so): opened again
  unchanged = false;
  await k.rewindPass(m, k.latest(700), o);
  assert.equal(reopens, 3);
  assert.deepEqual([2, 4].map((p) => at(m, p)), [50, 60]);
});

test("the real module: rewinds by the pass over the pages a match can change play on as the straight play", withGameFiles, async () => {
  const ROWS = 420, tape = tapeOf(ROWS), whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const mod = await realModule();
  const ref = await mod.open(whole);
  const want = new Map<number, string>();
  for (let r = 1; r < tape.count; r++) { ref.step(nativeRow(whole, r)); want.set(r, await rowKey(ref)); }
  const play = await mod.open(whole), mem = play.mod as unknown as CheckpointMemory;
  const hash = fastPageHasher(mod.memory())!;
  const pages = matchPages(play.mod as never)!;
  assert.ok(pages && pages.length < Math.ceil(mem.HEAPU8.length / PAGE) * 0.8, "the game data's ranges are left out");
  const writes0 = gameDataWrites(play.mod as never);
  const k = new Checkpoints(120);
  k.baseline(mem);
  let reopens = 0, at = 1;
  const o = { hash, pages, unchanged: () => gameDataWrites(play.mod as never) === writes0,
              reopen: async () => { reopens++; play.rewind(); play.openMatch(whole, mod.names, "slippi"); play.step(nativeRow(whole, 0)); return mem; } };
  const go = async (to: number) => { for (; at < to; at++) { play.step(nativeRow(whole, at)); assert.equal(await rowKey(play), want.get(at), `row ${at}`); } };
  for (const r of [100, 200, 300]) { await go(r); k.keep(mem, r); }
  await go(400);
  // back and forth: 200, 100, 300, 200 - each played on and held to the straight play
  for (const r of [200, 100, 300, 200, 300]) {
    await k.rewindPass(mem, k.latest(r), o);
    at = r;
    await go(Math.min(r + 60, tape.count));
  }
  assert.ok(reopens <= 2, `reopens ${reopens}`);
  // back to the first row's state by the pass: the memory the match opened again has, every page (the stack's unused bytes aside: at most
  // that page) - the module's own kept block included, which it writes as a match plays
  await k.rewindPass(mem, null, o);
  const passed = mem.HEAPU8.slice();
  await o.reopen();
  const differ: number[] = [];
  for (let p = 0; p * PAGE < passed.length; p++) {
    const x = passed.subarray(p * PAGE, (p + 1) * PAGE), y = mem.HEAPU8.subarray(p * PAGE, (p + 1) * PAGE);
    if (x.some((v, i) => v !== y[i])) differ.push(p);
  }
  assert.ok(differ.length <= 1, `pages that differ from the match opened again: ${differ.join(", ")}`);
  for (const x of [ref, play]) x.destroy();
});

test("rewindKnown: back to a checkpoint with the pages changed since known, no pass; a page never kept as it started refuses", () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m, pageHashes(m));
  k.keepBase(m, [2, 4, 5]);
  put(m, 2, 50); put(m, 4, 60);
  k.keepPages(m, 600, [2, 4]);
  put(m, 2, 51); put(m, 5, 70);
  assert.ok(k.rewindKnown(m, k.latest(700), [2, 4, 5]));
  assert.deepEqual([2, 4, 5].map((p) => at(m, p)), [50, 60, 5]);
  put(m, 4, 61); put(m, 5, 71);
  assert.ok(k.rewindKnown(m, null, [2, 4, 5]));
  assert.deepEqual([2, 4, 5].map((p) => at(m, p)), [2, 4, 5]);
  put(m, 6, 80);
  assert.equal(k.rewindKnown(m, null, [6]), false, "page 6 was never kept as it started");
  assert.equal(at(m, 6), 80, "nothing written");
  assert.equal(k.stats.hashes, 0);
  assert.equal(k.stats.known, 2);
});

test("the real module: rewinds by a set's lists (the module stepped on to a listed row, no pass) play on as the straight play", withGameFiles, async () => {
  const ROWS = 420, tape = tapeOf(ROWS), whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const mod = await realModule();
  const maker = await mod.open(whole);
  const made = new Map<number, Uint8Array>();
  const manifest = (await makeStored(maker, whole, tape.count, { id: "t", every: 120, dense: 20, pageHash: fastPageHasher(mod.memory())!,
                                                                 onCheckpoint: async (c) => { made.set(c.row, await encodeCheckpoint(c)); } }))!;
  maker.destroy();
  const ref = await mod.open(whole);
  const want = new Map<number, string>();
  for (let r = 1; r < tape.count; r++) { ref.step(nativeRow(whole, r)); want.set(r, await rowKey(ref)); }
  const play = await mod.open(whole), mem = play.mod as unknown as CheckpointMemory;
  const k = new Checkpoints(120);
  k.baseline(mem, manifest.base);
  const union = new Set<number>();
  for (const l of manifest.lists.values()) for (const p of l) union.add(p);
  k.keepBase(mem, union);
  k.add(await decodeCheckpoint(made.get(240)!));
  const listed = [...manifest.lists.keys()].sort((a, b) => a - b);
  let at = 1;
  const go = async (to: number) => {
    for (; at < to; at++) {
      const l = manifest.lists.get(at);
      if (l) k.keepPages(mem, at, l);
      play.step(nativeRow(whole, at));
      assert.equal(await rowKey(play), want.get(at), `row ${at}`);
    }
  };
  // (a drag: each place sought back to is reached from the latest checkpoint before it; before each rewind the module is stepped on to the
  // next listed row, whose list says every page that differs from the first row's state)
  const back = async (to: number) => {
    const e = listed.find((r) => r >= at)!;
    await go(e);
    assert.ok(k.rewindKnown(mem, k.latest(to), manifest.lists.get(e)!), `rewind to ${to} from ${e}`);
    at = k.latest(to)?.row ?? 1;
  };
  await go(373);
  for (const r of [365, 333, 301, 250, 247, 200, 120, 60, 5, 380, 290]) { await back(r); await go(r + 3); }
  assert.equal(k.stats.hashes, 0, "no pass over the memory");
  // the memory then, against the same checkpoint written into the match opened again: every page equal (the stack's unused bytes aside)
  await back(250);
  const known = mem.HEAPU8.slice();
  await k.rewindFresh(k.latest(250), async () => { play.rewind(); play.openMatch(whole, mod.names, "slippi"); play.step(nativeRow(whole, 0)); return mem; });
  const differ: number[] = [];
  for (let p = 0; p * PAGE < known.length; p++) {
    const x = known.subarray(p * PAGE, (p + 1) * PAGE), y = mem.HEAPU8.subarray(p * PAGE, (p + 1) * PAGE);
    if (x.some((v, i) => v !== y[i])) differ.push(p);
  }
  assert.ok(differ.length <= 1, `pages that differ from the checkpoint written into the match opened again: ${differ.join(", ")}`);
  for (const x of [ref, play]) x.destroy();
});

test("deadBytes: the last frame's FIFO bytes zeroed in a checkpoint's copies, nothing else", () => {
  const pages = new Map([[2, new Uint8Array(PAGE).fill(7)], [3, new Uint8Array(PAGE).fill(8)], [5, new Uint8Array(PAGE).fill(9)]]);
  const m = { ...memory(), _msl_gxw_stream_ptr: () => 2 * PAGE + 100, _msl_gxw_stream_len: () => PAGE + 50 };
  deadBytes(m, pages);
  const p2 = pages.get(2)!, p3 = pages.get(3)!, p5 = pages.get(5)!;
  assert.equal(p2[99], 7);
  assert.ok(p2.subarray(100).every((v) => v === 0));
  assert.ok(p3.subarray(0, 150).every((v) => v === 0));
  assert.equal(p3[150], 8);
  assert.ok(p5.every((v) => v === 9));
});

test("the real module: the game data arenas' unused parts are left out of the pages a match can change, and nothing writes them", withGameFiles, async () => {
  const ROWS = 300, tape = tapeOf(ROWS), whole = nativeTape(tape, driveOrder(tape, 1)[0]);
  const mod = await realModule();
  const core = await mod.open(whole), m = core.mod as unknown as CheckpointMemory & { _msl_gxw_keep_info(i: number): number };
  const sealed: [number, number][] = [0, 1].map((r) => [m._msl_gxw_keep_info(200 + 2 * r), m._msl_gxw_keep_info(201 + 2 * r)]);
  const pages = new Set(matchPages(m as never)!);
  for (const [b, e] of sealed) {
    assert.ok(e > b && b > 0, `a sealed part: ${b}..${e}`);
    for (let p = Math.ceil(b / PAGE); p < Math.floor(e / PAGE); p++) assert.ok(!pages.has(p), `page ${p} is left out`);
  }
  const hash = fastPageHasher(mod.memory())!;
  const inside: number[] = [];
  for (const [b, e] of sealed) for (let p = Math.ceil(b / PAGE); p < Math.floor(e / PAGE); p++) inside.push(p);
  const before = inside.map((p) => hash(p));
  for (let r = 1; r < tape.count; r++) core.step(nativeRow(whole, r));
  assert.deepEqual(inside.map((p) => hash(p)), before, "the match wrote none of them");
  core.destroy();
});
