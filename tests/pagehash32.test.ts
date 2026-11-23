// checkpoints.ts pageHash's numbers by SIMD (pagehash.ts pageHashes32, pagehash32.wat): equal to the JavaScript pass's on every page of
// memories of random bytes, of zeros and of single words changed, in blocks of four and alone; and pageHashes, pageHash and PiecedHashes
// give those numbers whichever way they are made. A memory no faster pass was made for keeps the JavaScript pass.
//   deno test -A --no-check --sloppy-imports tests/pagehash32.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { PAGE, PiecedHashes, pageHash, pageHashJs, pageHashes, pageHashesJs, type CheckpointMemory } from "../src/render3d/gxpath/checkpoints.ts";
import { fastPageHasher, pageHashes32 } from "../src/render3d/gxpath/pagehash.ts";

function memoryOf(pages: number, fill: (u8: Uint8Array) => void): { memory: WebAssembly.Memory; m: CheckpointMemory } {
  const memory = new WebAssembly.Memory({ initial: pages });
  const u8 = new Uint8Array(memory.buffer);
  fill(u8);
  // (the heap top a few pages short of the end, not on a page boundary: the last page partly used)
  return { memory, m: { get HEAPU8() { return new Uint8Array(memory.buffer); }, _msl_gxw_heap_top: () => (pages - 3) * PAGE - 12345 } };
}

let seed = 12345;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };

test("the SIMD routine gives the JavaScript pass's numbers, page by page", () => {
  const { memory, m } = memoryOf(37, (u8) => { const u32 = new Uint32Array(u8.buffer); for (let i = 0; i < u32.length; i++) u32[i] = rand(); });
  // (some pages all zero, some with one word changed from another page's)
  new Uint8Array(memory.buffer).fill(0, 5 * PAGE, 9 * PAGE);
  new Uint8Array(memory.buffer).copyWithin(20 * PAGE, 21 * PAGE, 22 * PAGE);
  new Uint32Array(memory.buffer)[20 * PAGE / 4 + 777] ^= 1;
  const js = pageHashesJs(m);
  assert.equal(pageHashes32(memory.buffer), null, "none before a faster pass is made for the memory");
  assert.deepEqual(pageHashes(m), js, "the JavaScript pass when there is none");
  assert.ok(fastPageHasher(memory), "this engine has SIMD");
  const fast = pageHashes32(memory.buffer)!;
  assert.ok(fast);
  const out = new Uint32Array(js.length);
  fast.many(0, js.length, out);
  assert.deepEqual(out, js);
  // (in blocks that do not start at a multiple of four, and one at a time)
  const out2 = new Uint32Array(js.length);
  fast.many(3, js.length - 3, out2);
  for (let p = 3; p < js.length; p++) assert.equal(out2[p], js[p], `page ${p}`);
  for (let p = 0; p < js.length; p++) { assert.equal(fast.one(p), js[p], `page ${p} alone`); assert.equal(pageHash(m, p), pageHashJs(m, p)); }
  assert.deepEqual(pageHashes(m), js);
  assert.notEqual(js[20], js[21], "a word changed changes the page's hash");
  // (the pieced pass, in pieces of any size, the same numbers)
  const pieced = new PiecedHashes(m);
  while (!pieced.step(performance.now() - 1)) { /* one piece at a time */ }
  assert.deepEqual(pieced.hashes, js);
});

test("a memory nobody keeps goes, and its passes with it", async () => {
  // (the passes' instances import the memory they read: kept in a list, they kept every simulator instance's memory a page ever made -
  // most of a GiB each, game after game in a player that stays open. Run in a Deno of its own, whose collector can be asked to run)
  const here = new URL("../src/render3d/gxpath/pagehash.ts", import.meta.url).href;
  const script = `import { fastPageHasher, pageHashes32 } from ${JSON.stringify(here)};
    let ref;
    (() => {
      const memory = new WebAssembly.Memory({ initial: 64 });
      if (!fastPageHasher(memory) || !pageHashes32(memory.buffer)) throw new Error("no faster pass here");
      ref = new WeakRef(memory);
    })();
    for (let i = 0; i < 10 && ref.deref(); i++) { await new Promise((r) => setTimeout(r, 0)); globalThis.gc(); }
    console.log(ref.deref() ? "kept" : "gone");`;
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/gone.ts`, script);
    const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", "--sloppy-imports", "--v8-flags=--expose-gc", `${dir}/gone.ts`],
                                                        stdout: "piped", stderr: "piped" }).output();
    const out = new TextDecoder().decode(r.stdout).trim(), err = new TextDecoder().decode(r.stderr);
    if (/no faster pass here/.test(err)) return;
    assert.equal(out, "gone", err);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("the SIMD routine follows the memory as it grows", () => {
  const { memory, m } = memoryOf(9, (u8) => u8.fill(7));
  fastPageHasher(memory);
  memory.grow(4);
  new Uint8Array(memory.buffer).fill(3, 8 * PAGE);
  const big: CheckpointMemory = { get HEAPU8() { return new Uint8Array(memory.buffer); }, _msl_gxw_heap_top: () => 13 * PAGE };
  assert.ok(pageHashes32(memory.buffer));
  assert.deepEqual(pageHashes(big), pageHashesJs(big));
  assert.deepEqual(pageHashes(m), pageHashesJs(m));
});
