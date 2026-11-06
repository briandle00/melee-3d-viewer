// The GX renderer's own tests (no browser, no outside files): the rules of the spec checked on small scenes whose answers follow from the rule itself, the
// correctly rounded power the fog needs against an exact computation, the depth copy table, and the worker pool of the front half against one thread.
// What needs a GPU (the shader against the CPU reference) or the spec author's files is in gxr-gpu.test.ts and gxr-spec-vectors.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { basicScene, colorVertices, FifoWriter } from "../src/render3d/gxr/encode.ts";
import { copyParams, encodeCopy } from "../src/render3d/gxr/copy.ts";
import { Efb, EFB_W, fogShape } from "../src/render3d/gxr/raster.ts";
import { bitsOf, f, fromBits } from "../src/render3d/gxr/f32.ts";
import { FrontCtx, Growable } from "../src/render3d/gxr/front.ts";
import { FrontPool } from "../src/render3d/gxr/frontpool.ts";
import { GxGpu } from "../src/render3d/gxr/gpu.ts";
import { runStream, emptyDff } from "./gxr/scene.ts";

// ---- a triangle: coverage, color, depth ----------------------------------------------------------------------------

function triangle(verts: number[][]): Efb {
  const w = basicScene();
  w.draw(2, 0, 3, colorVertices(verts.map((p) => ({ x: p[0], y: p[1], z: -100, rgba: [200, 100, 50, 255] }))));
  return runStream(w).be.efb;
}

test("a flat triangle covers the pixels whose centers are inside, in the color it was given", () => {
  const efb = triangle([[10, 10], [50, 10], [10, 50]]);
  assert.equal(efb.color[20 * EFB_W + 15], (200 << 16) | (100 << 8) | 50);
  assert.equal(efb.color[10 * EFB_W + 5], 0, "left of the triangle");
  assert.equal(efb.color[45 * EFB_W + 45], 0, "beyond the hypotenuse");
  let n = 0;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) if (efb.color[y * EFB_W + x] !== 0) n++;
  assert.ok(Math.abs(n - 800) < 60, `area ${n}`);
});

test("with culling off, a triangle draws with either winding", () => {
  const a = triangle([[10, 10], [50, 10], [10, 50]]);
  const b = triangle([[10, 10], [10, 50], [50, 10]]);
  const count = (e: Efb) => { let n = 0; for (let i = 0; i < e.color.length; i++) if (e.color[i] !== 0) n++; return n; };
  assert.ok(count(a) > 0 && count(b) > 0, "with no culling both windings draw");
});

// ---- the exponential fog's power ----------------------------------------------------------------------------------

/** 2^x correctly rounded to binary32, from 220-bit integers (x a binary32 in [-8, 0]) */
function exactExp2(x: number): number {
  const PREC = 220n, ONE = 1n << PREC;
  let ln2 = 0n;
  for (let k = 1n; k < 250n; k++) ln2 += ONE / (k << k);
  const xb = bitsOf(x);
  const e = (xb >>> 23) & 255, m = (xb & 0x7fffff) | 0x800000;
  if (e === 0) return 1;
  const q = 150 - e;
  const y = q >= 0 ? (BigInt(m) << PREC) >> BigInt(q) : (BigInt(m) << PREC) << BigInt(-q);
  const n = y >> PREC, t = y - (n << PREC);
  const w = (t * ln2) / ONE;
  let term = ONE, sum = ONE;
  for (let j = 1n; term !== 0n; j++) { term = (term * w) / ONE / j; sum += j % 2n === 1n ? -term : term; }
  let v = sum, exp = -Number(n);
  while (v >= ONE) { v >>= 1n; exp += 1; }
  while (v < (ONE >> 1n)) { v <<= 1n; exp -= 1; }
  const shift = PREC - 24n;
  let mant = v >> shift;
  const rem = v - (mant << shift), half = 1n << (shift - 1n);
  if (rem > half || (rem === half && (mant & 1n) === 1n)) mant += 1n;
  if (mant === 1n << 24n) { mant >>= 1n; exp += 1; }
  return fromBits((((exp + 126) << 23) | (Number(mant) & 0x7fffff)) >>> 0);
}

test("the exponential fog's 2^x is the correctly rounded binary32 power", () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 3000; i++) {
    const fog = f((rnd() >>> 8) / 16777216);
    // fsel 4: 1 - 2^(-8 fog)
    const got = fogShape(4, fog);
    const want = f(1 - exactExp2(f(-8 * fog)));
    assert.equal(bitsOf(got), bitsOf(want), `fog ${fog}`);
  }
  assert.equal(fogShape(4, 0), 0);
  assert.equal(bitsOf(fogShape(6, 0)), bitsOf(0.00390625), "2^-8");
});

// ---- depth copies ----------------------------------------------------------------------------------------------------

/** copy a 4 x 4 (or 8 x 4, 8 x 8) block of EFB pixels whose depth is z everywhere in format code cf (full or half size) and return the first bytes */
function depthCopy(cf: number, half: boolean, z: number, bytes: number): number[] {
  const efb = new Efb();
  efb.depth.fill(z);
  const bp = new Uint32Array(256);
  bp[0x43] = 3;
  bp[0x49] = 0; bp[0x4a] = (15) | (7 << 10);
  bp[0x4b] = 0x100; bp[0x4d] = 4;
  const tp = cf < 8 ? cf * 2 : (cf - 8) * 2 + 1;
  bp[0x52] = (tp << 3) | (half ? 1 << 9 : 0);
  const mem = new Uint8Array(1 << 20);
  encodeCopy(efb, copyParams(bp), mem);
  return Array.from(mem.slice(0x2000, 0x2000 + bytes));
}

test("depth copy formats write the depth's bytes in the order of the spec's table", () => {
  const z = 0x123456;   // z2 = 0x12, z1 = 0x34, z0 = 0x56
  assert.deepEqual(depthCopy(1, false, z, 4), [0x12, 0x12, 0x12, 0x12], "Z8");
  assert.deepEqual(depthCopy(9, false, z, 4), [0x34, 0x34, 0x34, 0x34], "Z8M");
  assert.deepEqual(depthCopy(10, false, z, 4), [0x56, 0x56, 0x56, 0x56], "Z8L");
  assert.deepEqual(depthCopy(11, false, z, 4), [0x34, 0x12, 0x34, 0x12], "Z16");
  assert.deepEqual(depthCopy(3, false, z, 4), [0x34, 0x12, 0x34, 0x12], "Z16 at cf 3 too");
  assert.deepEqual(depthCopy(12, false, z, 4), [0x56, 0x34, 0x56, 0x34], "Z16L");
  assert.deepEqual(depthCopy(6, false, z, 2), [255, 0x12], "Z24X8, first 32 bytes: (255, z2)");
  assert.deepEqual(depthCopy(0, false, z, 2), [0x11, 0x11], "Z4: (z2 & F0) | (z2 >> 4) per pair");
  // half size reverses the byte order of Z16, Z16L and Z24X8
  assert.deepEqual(depthCopy(11, true, z, 4), [0x12, 0x34, 0x12, 0x34], "Z16, half size");
  assert.deepEqual(depthCopy(12, true, z, 4), [0x34, 0x56, 0x34, 0x56], "Z16L, half size");
  const z24 = depthCopy(6, true, z, 64);
  assert.deepEqual([z24[0], z24[1], z24[32], z24[33]], [255, 0x56, 0x34, 0x12], "Z24X8, half size: (255, z0), (z1, z2)");
  assert.deepEqual(depthCopy(2, false, z, 4), [0, 0, 0, 0], "a code with no depth format writes nothing");
});

// ---- the front half on worker threads ---------------------------------------------------------------------------------

/** a scene of several draws with different matrices and colors */
function sceneStream(): Uint8Array {
  const w = basicScene();
  for (let k = 0; k < 12; k++) {
    w.xfFloats(0, [1, 0, 0, 3 * k, 0, 1, 0, 2 * k, 0, 0, 1, 0]);
    const v = [[20 + k, 20], [90 + 5 * k, 30], [30, 100 + 3 * k], [120, 120 + k]];
    w.draw(3, 0, 4, colorVertices(v.map((p, i) => ({ x: p[0], y: p[1], z: -50 - 10 * i - k, rgba: [(k * 40) & 255, 255 - 20 * i, 90 + k, 255] }))));
  }
  return w.bytes();
}

test("the front half gives the same words on worker threads as on one", async () => {
  if (!FrontPool.available()) return;
  // a worker needs to read its module: without read access (a plain `deno test`) this check is skipped
  if (Deno.permissions.querySync({ name: "read" }).state !== "granted") return;
  const stream = sceneStream();
  // one thread: a backend that sets every draw up with a FrontCtx
  const ctx = new FrontCtx(), want = new Growable();
  const mkBackend = (draw: (regs: never, vd: never, prims: never) => void) => ({
    drawing: true, fastForward: false,
    draw: (regs: never, _m: never, vd: never, _t: never, _l: never, _p: never, prims: never) => draw(regs, vd, prims),
    copy: () => ({ toXfb: false, rect: [], clear: false }), copyClear: () => {},
  });
  new GxGpu(mkBackend((regs: never, vd: never, prims: never) => ctx.run(regs, vd, prims, 7, want)) as never, emptyDff(), null).runFrame({ fifo: stream, updates: [] });
  // the pool: the main thread publishes, two workers and the waiting main thread run, the outputs come back in draw order
  const pool = new FrontPool(2, () => new Worker(new URL("../src/render3d/gxr/frontworker.ts", import.meta.url), { type: "module" }));
  try {
    const got = new Growable();
    // (each job's words, in draw order: from the output area, or made again when they did not fit)
    const collect = (g: Growable) => { const add = (words: Uint32Array) => { g.ensure(words.length); g.words.set(words, g.n); g.n += words.length; }; return () => pool.drain((_e, _t, w) => add(w), add); };
    const drainGot = collect(got);
    const be = mkBackend((regs: never, vd: never, prims: never) => pool.submit(regs, vd, prims, 7, drainGot));
    new GxGpu(be as never, emptyDff(), null).runFrame({ fifo: stream, updates: [] });
    drainGot();
    assert.ok(want.n > 0);
    assert.equal(got.n, want.n);
    assert.deepEqual(Array.from(got.words.subarray(0, got.n)), Array.from(want.words.subarray(0, want.n)));
    // the same draws handed over undecoded (gpu.ts RawRun): the threads decode the command bytes, the same words come back
    const raw = new Growable();
    pool.resetOut();
    const take = collect(raw);
    let mirrored = false;
    const rb = {
      ...mkBackend(() => {}), rawVertices: true,
      draw: (regs: never, mem: { data: Uint8Array }, _vd: never, _t: never, _l: never, _p: never, prims: never, r: { vat: number; size: number; n: number; segs: (Uint8Array | number)[] }) => {
        if (!mirrored) { pool.writeMirror(mem.data, 0, mem.data.length, take); mirrored = true; }
        pool.submitRaw(regs, r.vat, r.size, r.n, r.segs, prims, 7, take);
      },
    };
    new GxGpu(rb as never, emptyDff(), null).runFrame({ fifo: stream, updates: [] });
    take();
    assert.equal(pool.stats.rawJobs > 0, true);
    assert.deepEqual(Array.from(raw.words.subarray(0, raw.n)), Array.from(want.words.subarray(0, want.n)));
  } finally {
    pool.dispose();
  }
});
