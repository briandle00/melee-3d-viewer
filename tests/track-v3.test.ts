// The viewer track's version 3 lines: the parts a quaternion turns ("fq"), a chain link's joints below its root
// ("lj"), the material frames items' code lays ("imat", "lmat") and the magnifiers' readings ("mag").
// tests/fixtures/track-v3.json is a synthetic track with them, as the simulator writes it; track-v3.vtb is the app's
// encoder's output for it (gzipped). The compact form reads back to the JSON's events bit for bit, and the reader
// answers from either the same; a version 2 track (no "fq") says no part is quaternion-turned.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeTrackFloats, readTrack, trackEvents } from "../src/render3d/trackcodec.ts";
import { LINK_JOINTS, ViewerTrack } from "../src/render3d/track.ts";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const json = () => JSON.parse(readFileSync(dir + "track-v3.json", "utf8"));
const compactRead = () => readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-v3.vtb"))));
// (its pose lines made events again, in order, for the comparisons with the JSON)
const compact = () => { const t = compactRead(); return { ...t, events: trackEvents(t) }; };
const f32 = (x: number) => Math.fround(x);

test("a version 3 track's compact form reads back to its events, bit for bit and in order", () => {
  const want = json();
  decodeTrackFloats(want.events);
  const got = compact();
  assert.equal(got.version, 3);
  assert.equal(got.events.length, want.events.length);
  const kinds = new Set<string>();
  want.events.forEach((a: (number | string)[], i: number) => {
    const b = got.events[i];
    kinds.add(String(a[1]));
    assert.equal(b.length, a.length, `event ${i} (${a[1]})`);
    a.forEach((v, k) => assert.ok(Object.is(v, b[k]), `event ${i} (${a[1]}) value ${k}: ${v} vs ${b[k]}`));
  });
  for (const k of ["fj", "fq", "lj", "lmat", "imat", "mag"]) assert.ok(kinds.has(k), k);
});

for (const [form, data] of [["JSON", json], ["compact", compact]] as const) {
  test(`${form}: a part is quaternion-turned while its latest line is an "fq" one`, () => {
    const t = new ViewerTrack(data());
    assert.equal(t.version, 3);
    // (frames 40-69: part 0 and 1 in "fq", part 2 in "fj"; part 1 back in "fj" from 70)
    assert.equal(t.quatTurned("0:0:9", 1, 39), false);
    assert.equal(t.quatTurned("0:0:9", 1, 40), true);
    assert.equal(t.quatTurned("0:0:9", 1, 69), true);
    assert.equal(t.quatTurned("0:0:9", 1, 70), false);
    assert.equal(t.quatTurned("0:0:9", 0, 55), true);
    assert.equal(t.quatTurned("0:0:9", 2, 55), false);
    assert.equal(t.quatTurned("1:0:9", 1, 55), false);
    // (its values: ten, the quaternion's w fourth; part 0 seven, the rest NaN)
    const want = json().events.find((e: (number | string)[]) => e[0] === 40 && e[1] === "fq");
    const p = t.pose("fq", "0:0:9", 40)!;
    const w = (s: string) => new Float32Array(new Uint32Array([Number(s)]).buffer)[0];
    assert.equal(p.joints.get(0)!.length, 10);
    assert.ok(Object.is(p.joints.get(0)![6], w(want[13])));
    assert.ok(Number.isNaN(p.joints.get(0)![7]));
    assert.ok(Object.is(p.joints.get(1)![3], w(want[19])));
    // (a frame of the stretch after its first: only the quaternion was sent, the rest held)
    const q = t.pose("fq", "0:0:9", 41)!;
    assert.ok(Object.is(q.joints.get(1)![9], w(want[25])));
  });

  test(`${form}: a link's joints, the laid material frames and the magnifiers`, () => {
    const t = new ViewerTrack(data());
    const lj = t.pose("lj", "7", 105)!;
    assert.deepEqual([...lj.joints.keys()], [0 * LINK_JOINTS + 1]);
    assert.equal(lj.joints.get(1)![0], f32(0.436 * 6));
    assert.ok(Number.isNaN(lj.joints.get(1)![1]));
    assert.equal(t.linkMaterial(7, 0, 99), null);
    assert.equal(t.linkMaterial(7, 0, 120), 1);
    assert.equal(t.linkMaterial(7, 0, 139), 0);
    assert.deepEqual(t.itemMaterial(9, 149), null);
    assert.deepEqual(t.itemMaterial(9, 500), [0, 5]);
    assert.deepEqual(t.magnifier(1, 59), { shows: false, x: 609, y: 281, edge: 4 });
    assert.deepEqual(t.magnifier(1, 60), { shows: true, x: 610, y: 280, edge: 4 });
    assert.equal(t.magnifier(0, 60), null);
  });
}

test("a version 2 track: no part is quaternion-turned, no magnifier reading", () => {
  const t = new ViewerTrack({ version: 2, events: [[-123, "fj", 0, 0, 9, 1, 1, "0x3f800000"]] });
  assert.equal(t.version, 2);
  assert.equal(t.quatTurned("0:0:9", 1, 0), false);
  assert.equal(t.magnifier(0, 0), null);
  assert.equal(t.pose("fq", "0:0:9", 0), null);
});
