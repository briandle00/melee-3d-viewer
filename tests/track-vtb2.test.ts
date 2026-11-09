// The viewer track's compact form, VTB2: the pose lines ("fj", "fp", "jp", "sp", "lm", "wf") kept as streams, an
// "fp" line's values as a reference to the same frame's "fj", values found by what followed the last
// one or by rank. tests/fixtures/track-vtb2.json is a synthetic track (fighters repeating an animation with
// a chain that does not, an item, a stage part, a chain of links, a world line, a decimal of 1.53042e-07) as the
// simulator writes it, with its floats as "0x" words; track-vtb2.vtb is the app's encoder's output for it (gzipped).
// readTrack must give the events the JSON gives once its words are read as floats (decodeTrackFloats), bit for bit.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeTrack, decodeTrackFloats, readTrack, trackEvents } from "../src/render3d/trackcodec.ts";
/** the compact form read, its pose lines (kept compact: TrackData.poses) made events again in the track's order */
const readAll = (b: Uint8Array) => { const t = readTrack(b); return { ...t, events: trackEvents(t) }; };


const python = (() => {
  for (const p of ["python3", "python"]) {
    try { execFileSync(p, ["--version"], { stdio: "ignore" }); return p; } catch { /* the next */ }
  }
  return null;
})();
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const vtb = readFileSync(dir + "track-vtb2.vtb");
const want = JSON.parse(readFileSync(dir + "track-vtb2.json", "utf8"));
decodeTrackFloats(want.events);

test("a VTB2 track reads back to its events, bit for bit and in order", () => {
  const got = readAll(new Uint8Array(gunzipSync(vtb)));
  assert.equal(got.events.length, want.events.length);
  const kinds = new Set<string>();
  want.events.forEach((a: (number | string)[], i: number) => {
    const b = got.events[i];
    kinds.add(String(a[1]));
    assert.equal(b.length, a.length, `event ${i} (${a[1]})`);
    a.forEach((v, k) => assert.ok(Object.is(v, b[k]), `event ${i} (${a[1]}) value ${k}: ${v} vs ${b[k]}`));
  });
  for (const k of ["fj", "fp", "jp", "sp", "lm", "wf", "cam", "fxp"]) assert.ok(kinds.has(k), k);
  assert.equal(got.version, 2);
  assert.equal(got.decoded, true);
});

test("the floats are the single's bits: a -0 stays one, the chain's values are the fighter's", () => {
  const got = readAll(new Uint8Array(gunzipSync(vtb)));
  const lm = got.events.find((e) => e[1] === "lm") as number[];
  assert.ok(Object.is(lm[lm.length - 2], -0));
  // every "fp" value is the value of the "fj" line of its frame and fighter
  const fj = new Map<string, number[]>();
  for (const e of got.events) if (e[1] === "fj") fj.set(`${e[0]}:${e[2]}`, e as number[]);
  let checked = 0;
  for (const e of got.events) {
    if (e[1] !== "fp") continue;
    const line = fj.get(`${e[0]}:${e[2]}`) as number[];
    const values = new Map<string, number>();
    for (let i = 5, v: number; i < line.length; i += 2 + v) {
      const mask = line[i + 1];
      const bits = [...Array(16).keys()].filter((b) => mask >> b & 1);
      v = bits.length;
      bits.forEach((b, q) => values.set(`${line[i]}:${b}`, line[i + 2 + q]));
    }
    for (let i = 5, v: number; i < e.length; i += 2 + v) {
      const mask = e[i + 1] as number;
      const bits = [...Array(16).keys()].filter((b) => mask >> b & 1);
      v = bits.length;
      bits.forEach((b, q) => { assert.ok(Object.is(values.get(`${e[i]}:${b}`), e[i + 2 + q])); checked++; });
    }
  }
  assert.ok(checked > 100);
});

test("a gzipped VTB2 track is read by decodeTrack as a host sends it", async () => {
  const read = await decodeTrack(vtb.buffer.slice(vtb.byteOffset, vtb.byteOffset + vtb.byteLength) as ArrayBuffer);
  const got = { ...read, events: trackEvents(read) };
  assert.equal(got.events.length, want.events.length);
});

test("something that is not a track is refused", () => {
  assert.throws(() => readTrack(new TextEncoder().encode("JSON{}")), /not a VTB2 track/);
});

test("the pose check tool (pose_check.py) reads the same VTB2 track as the JSON gives (its words kept as words)", { skip: !python && "no python3" }, () => {
  const tool = fileURLToPath(new URL("../tools/", import.meta.url));
  const code = "import sys, json; sys.path.insert(0, sys.argv[1]); import pose_check; print(json.dumps(pose_check.read_events(sys.argv[2])))";
  const out = execFileSync(python as string, ["-c", code, tool, dir + "track-vtb2.vtb"], { maxBuffer: 1 << 28 }).toString();
  assert.deepEqual(JSON.parse(out), JSON.parse(readFileSync(dir + "track-vtb2.json", "utf8")).events);
});
