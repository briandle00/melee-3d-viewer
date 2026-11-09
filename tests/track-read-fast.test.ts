// Reading a track's compact form fast, with the same answers. The pose types' values are predicted by a model the
// writer shares (app/track_codec.py): a context's recently seen values are a move-to-front list of 1024 (Recent),
// kept now as a log of sightings rather than a list walked and shifted on every value, and the model's maps are
// typed-array tables (U32Map) rather than Maps of heap numbers - the longest game's track (4.2M values) took 10 to
// 15 s to read in a page. Its pose lines are kept compact (TrackData.poses: frames, heads and one Float32Array of
// ids, masks and values) rather than as millions of event arrays. These hold that the list is the same list, and
// that a ViewerTrack answers the same from the compact lines as from the JSON's events, its floats read first or not.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeTrackFloats, readTrack, Recent, trackEvents, U32Map } from "../src/render3d/trackcodec.ts";
import { ViewerTrack } from "../src/render3d/track.ts";

const RANKS = 1024;

test("Recent is the move-to-front list of 1024: every rank and every value, sighting after sighting", () => {
  let seed = 1;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (const range of [5, 50, 1500, 5000]) {
    const r = new Recent(), list: number[] = [];
    for (let i = 0; i < 60000; i++) {
      if (list.length && rnd(3) === 0) {
        const k = rnd(list.length);
        assert.equal(r.at(k), list[k], `range ${range} sighting ${i} rank ${k}`);
      }
      const x = (rnd(range) * 2654435761) >>> 0;
      assert.equal(r.rank(x), list.indexOf(x), `range ${range} sighting ${i}`);
      r.touch(x);
      const at = list.indexOf(x);
      if (at !== 0) {
        if (at > 0) list.splice(at, 1);
        list.unshift(x);
        if (list.length > RANKS) list.length = RANKS;
      }
      assert.equal(r.size, list.length);
    }
  }
});

test("U32Map: words for keys and values, -1 for one never set, the key -1 its own", () => {
  const m = new U32Map(2);
  assert.equal(m.get(7), -1);
  const keys = [0, 1, 0x3f800000, 0xbf800000, 0xffffffff, 12345678];
  keys.forEach((k, i) => m.set(k, 4294967295 - i));
  m.set(-1, 5);
  keys.forEach((k, i) => assert.equal(m.get(k), 4294967295 - i));
  assert.equal(m.get(-1), 5);
  m.set(0xbf800000, 1);
  assert.equal(m.get(0xbf800000), 1);
  m.clear();
  assert.equal(m.get(1), -1);
  assert.equal(m.get(-1), -1);
});

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));

for (const [name, json, vtb] of [["VTB2", "track-vtb2.json", "track-vtb2.vtb"], ["version 3", "track-v3.json", "track-v3.vtb"],
                                  ["fh", "track-fh.json", "track-fh.vtb"]]) {
  test(`${name}: the pose lines stay compact, and a ViewerTrack answers from them as from the JSON's events`, () => {
    const text = readFileSync(dir + json, "utf8");
    const want = JSON.parse(text);
    decodeTrackFloats(want.events);
    want.decoded = true;
    const got = readTrack(new Uint8Array(gunzipSync(readFileSync(dir + vtb))));
    // (no pose type's events among the events: they are in poses)
    const posed = Object.keys(got.poses ?? {});
    assert.ok(posed.length > 0);
    assert.ok(!got.events.some((e) => posed.includes(e[1])));
    assert.equal(trackEvents(got).length, want.events.length);
    // (c: the JSON as a page is handed it, its floats still words - ViewerTrack reads them, a pose line's straight in)
    const a = new ViewerTrack(want), b = new ViewerTrack(got), c = new ViewerTrack(JSON.parse(text));
    const owners = new Map<string, Set<string>>();
    for (const e of want.events) {
      if (!posed.includes(e[1])) continue;
      const k = e[1] === "fj" || e[1] === "fp" || e[1] === "fq" || e[1] === "fh" ? 3 : 1;
      let s = owners.get(e[1]);
      if (!s) owners.set(e[1], (s = new Set()));
      s.add(e.slice(2, 2 + k).join(":"));
    }
    const frames = want.events.map((e: (number | string)[]) => e[0] as number);
    const lo = Math.min(...frames), hi = Math.max(...frames);
    const same = (p: ReturnType<ViewerTrack["pose"]>, q: ReturnType<ViewerTrack["pose"]>, what: string) => {
      assert.equal(!p, !q, what);
      if (!p || !q) return;
      assert.deepEqual([...p.joints.keys()].sort(), [...q.joints.keys()].sort(), what);
      for (const [j, v] of p.joints) {
        const w = q.joints.get(j)!;
        v.forEach((x, k) => assert.ok(Object.is(x, w[k]), `${what} joint ${j} value ${k}`));
      }
      assert.deepEqual(p.out && [...p.out], q.out && [...q.out], what);
      assert.equal(p.links, q.links, what);
    };
    for (const [type, keys] of owners) {
      for (const key of keys) {
        for (let f = lo - 1; f <= hi + 1; f += Math.max(1, Math.floor((hi - lo) / 97))) {
          same(a.pose(type, key, f), b.pose(type, key, f), `${type} ${key} frame ${f}`);
          same(c.pose(type, key, f), b.pose(type, key, f), `${type} ${key} frame ${f} (words)`);
          const sa = a.poseSent(type, key, f), sb = b.poseSent(type, key, f);
          assert.deepEqual(sa && [...sa].sort(), sb && [...sb].sort(), `${type} ${key} sent ${f}`);
          if (type === "fj" || type === "fq") {
            for (let part = 0; part < 40; part++) assert.equal(a.quatTurned(key, part, f), b.quatTurned(key, part, f));
          }
        }
      }
    }
  });
}
