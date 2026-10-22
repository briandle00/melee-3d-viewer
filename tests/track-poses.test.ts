// The viewer track's exact floats and poses: a float written as its IEEE
// single's word ("0x3f800000") reads back as that float, from JSON and from
// the compact form (VTB1's column kind 4); the pose lines ("jp", "fp", "lm", "sp", "fj")
// add up, owner by owner, to each joint's values as of a frame.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { decodeTrackFloats, readTrack } from "../src/render3d/trackcodec.ts";
import { ViewerTrack, type TrackEvent } from "../src/render3d/track.ts";

const word = (x: number) => {
  const f = new Float32Array([x]);
  return "0x" + new Uint32Array(f.buffer)[0].toString(16).padStart(8, "0");
};

test("a float's word reads back as the float, bit for bit", () => {
  const values = [1, -0, 0.1, 1e-38, 3.4e38, -123.456, Math.fround(Math.PI), 6e-7];
  const e: TrackEvent = [5, "x", ...values.map(word), "s", "0x12", 7];
  decodeTrackFloats([e]);
  values.forEach((v, i) => assert.ok(Object.is(e[2 + i], Math.fround(v)), `value ${i}`));
  // (other strings and numbers are left as they are)
  assert.deepEqual(e.slice(2 + values.length), ["s", "0x12", 7]);
});

/** a VTB1 buffer (uncompressed) of one type whose rows are a frame and one column of float words */
function vtb1(type: string, rows: [number, number][]): Uint8Array {
  const out: number[] = [];
  const varint = (x: number) => { while (x >= 0x80) { out.push((x % 128) | 0x80); x = Math.floor(x / 128); } out.push(x); };
  const zigzag = (x: number) => varint(x >= 0 ? x * 2 : -x * 2 - 1);
  const text = (s: string) => { const b = new TextEncoder().encode(s); varint(b.length); out.push(...b); };
  out.push(...new TextEncoder().encode("VTB1"));
  text(JSON.stringify({ version: 2 }));
  varint(1); text(type);
  varint(rows.length); for (let i = 0; i < rows.length; i++) varint(0);
  out.push(0); varint(1);
  let last = 0;
  for (const [f] of rows) { zigzag(f - last); last = f; }
  out.push(4);
  let w = 0;
  for (const [, x] of rows) {
    const u = new Uint32Array(new Float32Array([x]).buffer)[0];
    zigzag(u - w); w = u;
  }
  return new Uint8Array(out);
}

test("the compact form's float column (kind 4) gives the floats themselves", () => {
  const xs = [1.5, -2.25, Math.fround(0.3), 0, -0];
  const t = readTrack(vtb1("cam", xs.map((x, i) => [-123 + i, x])));
  assert.equal(t.decoded, true);
  t.events.forEach((e, i) => { assert.equal(e[0], -123 + i); assert.ok(Object.is(e[2], Math.fround(xs[i]))); });
});

test("a track handed over undecoded is read the same", () => {
  const t = new ViewerTrack({ version: 2, events: [[-123, "fod", word(10.5), word(20.25)]] });
  assert.deepEqual(t.at("fod", "", -100), [10.5, 20.25]);
});

test("pose lines add up per owner: a joint's last values, a value never sent at the rest (NaN)", () => {
  const t = new ViewerTrack({
    version: 2, decoded: true,
    events: [
      // item 7: joint 2's rot y and translate x; then only its rot y; joint 3 at frame 12
      [10, "jp", 7, 2, (1 << 1) | (1 << 6), 0.5, 3],
      [11, "jp", 7, 2, 1 << 1, 0.75],
      [12, "jp", 7, 3, 1 << 8, -1],
      // two lines of one owner on a frame: both count
      [12, "jp", 7, 2, 1 << 0, 0.25],
      // a fighter's tail: port 1, Nana no, Fox (1)
      [10, "fp", 1, 0, 1, 18, 0x1ff, 1, 2, 3, 1, 1, 1, 0, 0, 0],
      [11, "fp", 1, 0, 1, 18, 1 << 2, 4],
    ],
  });
  assert.equal(t.pose("jp", "7", 9), null);
  const p10 = t.pose("jp", "7", 10)!;
  assert.deepEqual([...p10.joints.get(2)!].map((v) => (Number.isNaN(v) ? null : v)), [null, 0.5, null, null, null, null, 3, null, null]);
  const p11 = t.pose("jp", "7", 11)!.joints.get(2)!;
  assert.equal(p11[1], 0.75);
  assert.equal(p11[6], 3);
  // (an earlier frame's pose is as it was then)
  assert.equal(t.pose("jp", "7", 10)!.joints.get(2)![1], 0.5);
  const p12 = t.pose("jp", "7", 99)!;
  assert.equal(p12.joints.get(2)![0], 0.25);
  assert.equal(p12.joints.get(2)![1], 0.75);
  assert.equal(p12.joints.get(3)![8], -1);
  const fp = t.pose("fp", "1:0:1", 20)!.joints.get(18)!;
  assert.deepEqual([...fp], [1, 2, 4, 1, 1, 1, 0, 0, 0]);
  assert.equal(t.pose("fp", "1:0:2", 20), null);
});

test("a chain's links: each link's matrix and whether it is out, and the chain's length", () => {
  const m = (base: number) => Array.from({ length: 12 }, (_, k) => base + k);
  const t = new ViewerTrack({
    version: 2, decoded: true,
    events: [
      [20, "lm", 9, 3, 0, 0, 0xfff, ...m(0), 1, 1, 0xfff, ...m(100), 2, 0, 0xfff, ...m(200)],
      // link 1 moves its place (row 0's last value) only; link 2 comes out (written whole)
      [21, "lm", 9, 3, 1, 1, 1 << 3, 50, 2, 1, 0xfff, ...m(300)],
    ],
  });
  const a = t.pose("lm", "9", 20)!;
  assert.equal(a.links, 3);
  assert.equal(a.out!.get(1), 1);
  assert.equal(a.out!.get(2), 0);
  const b = t.pose("lm", "9", 21)!;
  assert.equal(b.joints.get(1)![3], 50);
  assert.equal(b.joints.get(1)![4], 104);
  assert.equal(b.out!.get(2), 1);
  assert.equal(b.joints.get(2)![0], 300);
  assert.equal(b.joints.get(0)![11], 11);
});

test("streamed poses (\"sp\", \"fj\") read the same as the lines added up, asked in any order", () => {
  // a fighter's joints on most frames, a stage part's now and then: seeded, each line a few joints' values
  let seed = 0x2545f491;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const events: TrackEvent[] = [];
  const want = new Map<string, Map<number, number[]>[]>();
  const frames = new Map<string, number[]>();
  for (let f = -123; f < 600; f++) {
    for (const [type, owner, n] of [["fj", [2, 0, 9], 40], ["sp", [1004], 6]] as const) {
      if (type === "sp" && rnd() < 0.7) continue;
      const key = `${type}/${owner.join(":")}`;
      const list = want.get(key) ?? [];
      const prev = list.length ? list[list.length - 1] : new Map<number, number[]>();
      const now = new Map([...prev].map(([j, v]) => [j, [...v]]));
      const e: TrackEvent = [f, type, ...owner];
      for (let j = 1; j < n; j++) {
        if (list.length && rnd() < 0.6) continue;
        const v = now.get(j) ?? new Array(9).fill(NaN);
        let mask = 0;
        for (let k = 0; k < 9; k++) if (!list.length || rnd() < 0.3) { mask |= 1 << k; v[k] = Math.fround(rnd() * 10 - 5); }
        if (!mask) continue;
        now.set(j, v);
        e.push(j, mask);
        for (let k = 0; k < 9; k++) if (mask & (1 << k)) e.push(v[k]);
      }
      if (e.length === 2 + owner.length) continue;
      events.push(e);
      list.push(now);
      want.set(key, list);
      frames.set(key, [...(frames.get(key) ?? []), f]);
    }
  }
  const t = new ViewerTrack({ version: 2, decoded: true, events });
  const check = (type: string, owner: string, frame: number) => {
    const key = `${type}/${owner}`, fs = frames.get(key)!;
    let i = -1;
    while (i + 1 < fs.length && fs[i + 1] <= frame) i++;
    const p = t.pose(type, owner, frame);
    if (i < 0) return assert.equal(p, null, `${key} at ${frame}`);
    const w = want.get(key)![i];
    assert.equal(p!.joints.size, w.size, `${key} at ${frame}: joints`);
    for (const [j, v] of w) {
      const got = [...p!.joints.get(j)!];
      assert.deepEqual(got.map((x) => (Number.isNaN(x) ? null : x)), v.map((x) => (Number.isNaN(x) ? null : x)),
                       `${key} at ${frame}, joint ${j}`);
    }
  };
  // (frame by frame, as a replay plays; then back, far ahead, and at random)
  for (let f = -130; f < 610; f++) { check("fj", "2:0:9", f); check("sp", "1004", f); }
  for (const f of [599, 0, -123, 300, 5, 450, 449, 64, 63, 65, 128]) { check("fj", "2:0:9", f); check("sp", "1004", f); }
  for (let n = 0; n < 200; n++) { const f = Math.floor(rnd() * 740) - 130; check("fj", "2:0:9", f); check("sp", "1004", f); }
  assert.equal(t.pose("fj", "2:0:10", 100), null);
  // (one owner's pose is the same object frame to frame: nothing made per frame)
  assert.equal(t.pose("fj", "2:0:9", 200), t.pose("fj", "2:0:9", 201));
});

test("a fighter's last depth off the plane holds while it stands there, however near the plane", () => {
  // (nudged apart in depth, then left a third of a unit off the plane: the track's "pos" line, then nothing
  // until the line that brings it back to depth 0)
  const t = new ViewerTrack({ version: 2, decoded: true, events: [
    [10, "pos", 1, 0, -18.5, 0.0001, -0.3, 0, 1.57, 0, 0.94],
    [11, "pos", 1, 0, -18.8, 0.0001, -0.3223, 0, 1.57, 0, 0.94],
    [40, "pos", 1, 0, -18.8, 0.0001, 0, 0, 1.57, 0, 0.94],
  ] });
  assert.equal(t.depthAt(1, 0, 11, -18.8, 0.0001), -0.3223);
  assert.equal(t.depthAt(1, 0, 30, -18.8, 0.0001), -0.3223);
  // (moved on with no line: not where the line has it, so back on the plane)
  assert.equal(t.depthAt(1, 0, 30, -10, 0.0001), 0);
  assert.equal(t.depthAt(1, 0, 41, -18.8, 0.0001), 0);
});

test("the joints a streamed pose's line has on exactly a frame (a joint left out keeps its last values)", () => {
  const t = new ViewerTrack({ version: 2, events: [
    // (part 1 every value, part 3 its x turn and z place; then part 3 alone, twice on one frame; then nothing)
    [10, "fj", 0, 0, 25, 1, 0x1ff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 3, 0x101, 0.5, 2.5],
    [11, "fj", 0, 0, 25, 3, 0x4, 0.25],
    [11, "fj", 0, 0, 25, 4, 0x80, 1.5],
    [14, "fj", 0, 0, 25, 1, 0x1, 0.75],
  ] });
  assert.equal(t.poseSent("fj", "0:0:25", 9), null);
  assert.deepEqual([...t.poseSent("fj", "0:0:25", 10)!].sort(), [1, 3]);
  assert.deepEqual([...t.poseSent("fj", "0:0:25", 11)!].sort(), [3, 4]);
  assert.deepEqual([...t.poseSent("fj", "0:0:25", 12)!], []);
  assert.deepEqual([...t.poseSent("fj", "0:0:25", 14)!], [1]);
  // (the pose as of a frame with no line is the one before's, all joints)
  assert.deepEqual([...t.pose("fj", "0:0:25", 12)!.joints.keys()].sort(), [1, 3, 4]);
  assert.equal(t.poseSent("fj", "0:0:26", 11), null);
  assert.equal(t.poseSent("jp", "0:0:25", 11), null);
});
