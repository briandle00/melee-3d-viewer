// Fetches that get through a moment's trouble (src/render3d/net.ts): the player's replay, its viewer track and the game files are
// asked again over a few seconds when there is no answer or the server is busy, and never when the server said the file is not
// there or not given; what could not be had says why (FetchFailed's kind). One failed request once left the embedded player on
// "No replay loaded" for good.
//
//   deno test -A --no-check --sloppy-imports tests/net.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { failKind, failOf, FetchFailed, fetchRetry, pause, RETRY_MS, worthRetry } from "../src/render3d/net.ts";

/** fetch answering in turn: a status, or "down" (no answer: the request fails, as fetch's TypeError) */
function serve(...answers: (number | "down")[]) {
  const asked: string[] = [];
  const was = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    asked.push(String(url));
    if (init?.signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a === "down") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(new Response(a === 200 ? "replay" : "not found", { status: a }));
  }) as typeof fetch;
  return { asked, restore: () => { globalThis.fetch = was; } };
}
const quick = [0, 0, 0, 0, 0];

test("what a status says: no answer and a busy server may pass; 404/410 is gone; another 4xx is refused", () => {
  assert.equal(failKind(null), "network");
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(failKind(s), "server", String(s));
  assert.equal(failKind(404), "gone");
  assert.equal(failKind(410), "gone");
  for (const s of [400, 401, 403, 422]) assert.equal(failKind(s), "refused", String(s));
  assert.deepEqual(["network", "server", "gone", "refused"].map((k) => worthRetry(k as never)), [true, true, false, false]);
  assert.equal(failOf(new TypeError("Failed to fetch")).kind, "network");
  const f = new FetchFailed("gone", 404, "HTTP 404");
  assert.equal(failOf(f), f);
});

test("a few quick tries over a few seconds: about 7 s in all, the first soon", () => {
  assert.deepEqual(RETRY_MS, [250, 500, 1000, 2000, 3000]);
  assert.ok(RETRY_MS[0] <= 250 && RETRY_MS.reduce((a, b) => a + b, 0) <= 8000);
});

test("no answer twice, then the replay: it is had, on the third try", async () => {
  const s = serve("down", "down", 200);
  const tries: number[] = [];
  try {
    const r = await fetchRetry("/api/slp?path=a", undefined, { delays: quick, onRetry: (n) => tries.push(n) });
    assert.equal(await r.text(), "replay");
    assert.equal(s.asked.length, 3);
    assert.deepEqual(tries, [1, 2]);
  } finally { s.restore(); }
});

test("a busy server (503) is asked again", async () => {
  const s = serve(503, 200);
  try {
    assert.equal((await fetchRetry("/x", undefined, { delays: quick })).status, 200);
    assert.equal(s.asked.length, 2);
  } finally { s.restore(); }
});

test("not there (404) is said at once, never asked again; nor is a refusal", async () => {
  for (const [status, kind] of [[404, "gone"], [403, "refused"]] as const) {
    const s = serve(status);
    try {
      await assert.rejects(fetchRetry("/x", undefined, { delays: quick }), (e: unknown) => e instanceof FetchFailed && e.kind === kind && e.status === status);
      assert.equal(s.asked.length, 1);
    } finally { s.restore(); }
  }
});

test("no answer through every try: a FetchFailed saying so, after the first try and one a wait", async () => {
  const s = serve("down");
  try {
    await assert.rejects(fetchRetry("/x", undefined, { delays: quick }), (e: unknown) => e instanceof FetchFailed && e.kind === "network" && e.status === null);
    assert.equal(s.asked.length, quick.length + 1);
  } finally { s.restore(); }
});

test("an abort stops the tries and is passed on as the abort, not as a failure", async () => {
  const s = serve("down");
  const stop = new AbortController();
  try {
    const p = fetchRetry("/x", undefined, { delays: [10000, 10000], signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    await assert.rejects(p, (e: unknown) => e instanceof DOMException && e.name === "AbortError");
    assert.equal(s.asked.length, 1);
  } finally { s.restore(); }
});

test("a wait between tries ends at once when the browser is back online", async () => {
  const t0 = performance.now();
  const p = pause(10000);
  setTimeout(() => globalThis.dispatchEvent(new Event("online")), 10);
  await p;
  assert.ok(performance.now() - t0 < 2000);
});
