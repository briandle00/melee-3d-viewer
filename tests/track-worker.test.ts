// A replay's viewer track read and prepared in a worker (track.worker.ts, files.ts preparedTrackAnswer), so the page
// stays responsive while the longest game's takes seconds to read: what the worker hands over is what the page's
// thread makes of the same track, bit for bit - every state, instant and pose line - and a ViewerTrack answers the
// same from it. Also: the host's own answers pass through, a stopped read answers null, and with no worker the track
// is read on the page's thread.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PoseLines, type PreparedTrack, prepareTrack, readTrack, TrackAssembly, trackPieces } from "../src/render3d/trackcodec.ts";
import { ViewerTrack } from "../src/render3d/track.ts";
import { preparedTrackAnswer, setTrackUrl, setTrackWorker } from "../src/render3d/files.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const dir = fileURLToPath(fixtures);
// (the messages the workers sent, and their errors: the page's-thread fallback must not pass for the worker)
let answered = 0, failed = 0;
const worker = () => {
  const w = new Worker(new URL("../src/render3d/track.worker.ts", import.meta.url).href, { type: "module" });
  w.addEventListener("message", () => answered++);
  w.addEventListener("error", () => failed++);
  return w;
};

/** every value the same, by Object.is (a -0 stays one); typed arrays by their bits */
function same(a: unknown, b: unknown, at: string) {
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    assert.equal(a.constructor, b.constructor, at);
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    assert.equal(x.length, y.length, at);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) assert.fail(`${at}: byte ${i}`);
    return;
  }
  if (a instanceof Map && b instanceof Map) {
    assert.deepEqual([...a.keys()], [...b.keys()], at);
    for (const [k, v] of a) same(v, b.get(k), `${at}.${k}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, at);
    a.forEach((v, i) => same(v, b[i], `${at}[${i}]`));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), at);
    for (const k of Object.keys(a)) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    return;
  }
  assert.ok(Object.is(a, b), `${at}: ${a} vs ${b}`);
}

const cases: [string, string, () => PreparedTrack][] = [
  ["the compact form (VTB2)", "track-vtb2.vtb", () => prepareTrack(readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-vtb2.vtb")))))],
  ["the compact form (version 3)", "track-v3.vtb", () => prepareTrack(readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-v3.vtb")))))],
  ["the compact form (fh)", "track-fh.vtb", () => prepareTrack(readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-fh.vtb")))))],
  ["the simulator's JSON", "track-v3.json", () => prepareTrack(JSON.parse(readFileSync(dir + "track-v3.json", "utf8")))],
];

for (const [what, file, here] of cases) {
  test(`${what}: the track a worker prepares is the page's own, bit for bit, and answers the same`, async () => {
    setTrackWorker(worker);
    try {
      setTrackUrl(`replay-${file}`, new URL(file, fixtures).href);
      const before = answered;
      const a = (await preparedTrackAnswer(`replay-${file}`)) as { state: string; track: PreparedTrack };
      assert.equal(a?.state, "ready");
      assert.ok(answered >= before + 2, "the worker answered, in pieces");
      assert.equal(failed, 0);
      const want = here();
      same(a.track, want, "prepared");
      assert.ok(want.poses.size > 0 || file.endsWith(".json"));
      // (and the player's answers from it)
      const p = new ViewerTrack(a.track), q = new ViewerTrack(want);
      for (const [type, lines] of want.poses as Map<string, PoseLines>) {
        const owners = new Set<string>();
        for (let l = 0; l < lines.frames.length; l++) owners.add(String(lines.heads[l * lines.h]));
        for (let l = 0; l < lines.frames.length; l += Math.max(1, Math.floor(lines.frames.length / 50))) {
          const f = lines.frames[l];
          for (const key of [...p["ownersOf"](type).keys()]) {
            const x = p.pose(type, key, f), y = q.pose(type, key, f);
            same(x && { j: x.joints, o: x.out, l: x.links }, y && { j: y.joints, o: y.out, l: y.links }, `${type} ${key} ${f}`);
          }
        }
      }
    } finally {
      setTrackWorker(null);
    }
  });
}

test("a host's own answer passes through the worker; a stopped read answers null; no worker: read on the page's thread", async () => {
  setTrackWorker(worker);
  try {
    setTrackUrl("replay-pending", `data:application/json,${encodeURIComponent(JSON.stringify({ state: "pending" }))}`);
    const before = answered;
    assert.deepEqual(await preparedTrackAnswer("replay-pending"), { state: "pending" });
    assert.equal(answered, before + 1, "the worker answered");
    setTrackUrl("replay-gone", new URL("no-such-track.vtb", fixtures).href);
    assert.equal(await preparedTrackAnswer("replay-gone"), null);
    setTrackUrl("replay-stopped", new URL("track-v3.vtb", fixtures).href);
    const stop = new AbortController();
    const asked = preparedTrackAnswer("replay-stopped", stop.signal);
    stop.abort();
    assert.equal(await asked, null);
    assert.deepEqual(await preparedTrackAnswer("replay-never-given"), { state: "none", reason: "no viewer track given" });
    assert.equal(failed, 0);
  } finally {
    setTrackWorker(null);
  }
  const a = (await preparedTrackAnswer("replay-track-v3.vtb")) as { state: string; track: PreparedTrack };
  same(a.track, prepareTrack(readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-v3.vtb"))))), "on the page's thread");
});

test("a prepared track in pieces (runs of events, several to one key and to the instants) is put together as it was", () => {
  const events: [number, string, ...(number | string)[]][] = [];
  for (let f = 0; f < 9000; f++) {
    events.push([f, "cam", f * 0.5, -0, 1]);
    if (f % 2) events.push([f, "anim", 0, f % 3, f, 1.5]);
    events.push([f, "fx", f, "x"]);
    if (f % 5 === 0) events.push([f, "gen", 1, f]);
  }
  const want = prepareTrack({ version: 3, events, decoded: true });
  const pieces = trackPieces(structuredClone(want));
  assert.ok(pieces.length > 6);
  const put = new TrackAssembly();
  let got: PreparedTrack | null = null;
  for (const { piece } of pieces) {
    assert.equal(got, null, "nothing after the end");
    got = put.take(structuredClone(piece));
  }
  same(got, want, "assembled");
});
