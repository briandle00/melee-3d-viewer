// The players' shared caches (src/state/pageCache.ts) keep nothing of a frame that is gone: a page that made a player frame for each
// game it opened kept every one of them - a frame's objects keep its whole realm alive, the 3D player's simulator memory with it (about
// 1 GiB a game). A frame is a realm of its own here (node:vm: its own Object, Map, WeakMap), its page above this test's realm: the
// frame's module puts entries in pageCache and pageWeak, the containers are the page's own (its Map, WeakMap, a null-prototype object
// of its realm), and when the frame goes (pagehide) what it put in leaves with it while the page's own entries and plain values stay.
//   deno test -A --no-check --sloppy-imports tests/pagecache.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const SRC = ts.transpileModule(readFileSync(new URL("../src/state/pageCache.ts", import.meta.url), "utf8"),
                               { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

/** a frame of the page `top` (same origin): its own realm running pageCache.ts; `leave()` fires its pagehide */
function frameOf(top: Record<string, unknown>) {
  const listeners: Record<string, ((e: { persisted: boolean }) => void)[]> = {};
  const ctx: Record<string, unknown> = {
    exports: {}, console, performance,
    location: { origin: "http://page.test" },
    addEventListener: (t: string, f: (e: { persisted: boolean }) => void) => { (listeners[t] ??= []).push(f); },
  };
  ctx.globalThis = ctx;
  ctx.top = top;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const pc = ctx.exports as { pageCache<V>(n: string): Map<string, V>; pageWeak<K extends object, V>(n: string): WeakMap<K, V> };
  return { pc, run: (code: string) => vm.runInContext(code, ctx), leave: (persisted = false) => { for (const f of listeners.pagehide ?? []) f({ persisted }); } };
}

test("a frame's entries leave the page's caches with the frame; the caches are the page's own", () => {
  const top: Record<string, unknown> = { location: { origin: "http://page.test" }, Object, Map, WeakMap };
  const a = frameOf(top), b = frameOf(top);
  const key = new ArrayBuffer(8);
  (a.run("globalThis") as Record<string, unknown>).key = key;
  a.run(`exports.pageCache("replays").set("a.slp", { frames: [1, 2, 3] });
         exports.pageCache("replays").set("count", 42);
         exports.pageCache("players3d").set("a", { seen: true });
         exports.pageWeak("pixels").set(globalThis.key, new Map([["x", new Uint8Array(4)]]));`);
  const S = top.__viewerShared as Record<string, Map<string, unknown>>, W = top.__viewerWeak as Record<string, WeakMap<object, unknown>>;
  // the page's own containers: its Map and WeakMap, made in its realm
  assert.ok(S.replays instanceof Map && S.players3d instanceof Map && W.pixels instanceof WeakMap);
  assert.equal(Object.getPrototypeOf(S), null);
  // (the other frame sees them, and puts its own in)
  assert.equal(b.pc.pageCache("replays").get("count"), 42);
  b.run(`exports.pageCache("players3d").set("b", { seen: false });`);
  S.replays.set("page's own", { mine: true });
  assert.equal(W.pixels.has(key), true);
  // (a page put in the back-forward cache keeps its frames: nothing taken out)
  a.leave(true);
  assert.deepEqual([...S.players3d.keys()], ["a", "b"]);
  a.leave();
  assert.deepEqual([...S.replays.keys()], ["count", "page's own"]);
  assert.deepEqual([...S.players3d.keys()], ["b"]);
  assert.equal(W.pixels.has(key), false);
  b.leave();
  assert.deepEqual([...S.players3d.keys()], []);
  assert.deepEqual([...S.replays.keys()], ["count", "page's own"]);
});

test("a player on its own (no page above) keeps its caches in its own realm and nothing is taken out", () => {
  const listeners: (() => void)[] = [];
  const ctx: Record<string, unknown> = { exports: {}, location: { origin: "http://page.test" }, addEventListener: (_: string, f: () => void) => listeners.push(f) };
  ctx.globalThis = ctx;
  ctx.top = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`exports.pageCache("replays").set("a.slp", { frames: [] });`, ctx);
  assert.equal(listeners.length, 0);
  assert.equal((ctx.__viewerShared as Record<string, Map<string, unknown>>).replays.size, 1);
});
