// A costume hat's joints as the game posed them, the simulator's track's "fh": Jigglypuff's costume 2 and 3 hats
// swing their ribbons on chains of their own (ftCo_8009DC54 lays them on the hat ftPr_Init_8013C360 loads, solved
// from the matrix ftPr_Init_UnkMtxFunc0 copies onto the hat). The player drew the ribbons at the file's rest
// (diamond-platinum-682b9c84 13067: the bow's meshes 10 and 13 about 1 off).
//
//   deno test --no-check --sloppy-imports -A tests/   (the last test needs MELEE_ASSETS)

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeTrackFloats, readTrack, trackEvents } from "../src/render3d/trackcodec.ts";
import { ViewerTrack } from "../src/render3d/track.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

test("the hat's joints add up per fighter, a value never sent the file's rest (NaN)", () => {
  const t = new ViewerTrack({
    version: 3, decoded: true,
    events: [
      // port 0, not Nana, Jigglypuff (15): the bow's joint 3, then only its rot z
      [10, "fh", 0, 0, 15, 3, 0x7, 0.1, 0.2, 0.3],
      [11, "fh", 0, 0, 15, 3, 1 << 2, 0.5],
    ],
  });
  assert.equal(t.pose("fh", "0:0:15", 9), null);
  const j = t.pose("fh", "0:0:15", 11)!.joints.get(3)!;
  assert.deepEqual([...j.subarray(0, 3)].map((v) => Math.fround(v)), [Math.fround(0.1), Math.fround(0.2), 0.5]);
  assert.ok(Number.isNaN(j[3]));
});

// (tests/fixtures/track-fh.json: the "fj", "fh" and "egg" lines of the app's tests/test_track_codec.py v3_track(seed=7,
// frames=80); track-fh.vtb the app's encoder's output for it: "fh" a pose type, its words as streams)
test("the compact form's \"fh\" lines read back to the JSON's, bit for bit", () => {
  const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const want = JSON.parse(readFileSync(dir + "track-fh.json", "utf8"));
  decodeTrackFloats(want.events);
  const got = readTrack(new Uint8Array(gunzipSync(readFileSync(dir + "track-fh.vtb"))));
  const all = trackEvents(got);
  assert.equal(all.length, want.events.length);
  want.events.forEach((a: (number | string)[], i: number) => {
    a.forEach((v, k) => assert.ok(Object.is(v, all[i][k]), `event ${i} (${a[1]}) value ${k}`));
  });
  assert.ok(new ViewerTrack(got).pose("fh", "1:0:15", 59)!.joints.has(3));
});

test("game files: the bow's ribbons posed by the track's joints under the hat's root", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const PURIN = 15, files = fighterFiles(PURIN, 2)!;
  const f = new Fighter(PURIN, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 2,
                        motionTableFromDol(readGameFile("main.dol")), "test");
  const sk = f.hat!.prop.skeleton, root = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1]);
  f.hat!.prop.poseMatrix(root);
  const rest = sk.world.slice(3 * 16, 4 * 16);
  const v = new Float32Array(9).fill(NaN);
  v[2] = 0.5;
  f.hat!.prop.poseMatrix(root, undefined, new Map([[3, v]]));
  assert.equal(sk.rot[3 * 3 + 2], Math.fround(0.5));
  assert.notDeepEqual([...sk.world.slice(3 * 16, 4 * 16)], [...rest]);
  // (a value not sent is the file's rest: joint 3's own translate)
  assert.deepEqual([...sk.trans.subarray(9, 12)], [...sk.restOf(3, "trans")].map((x) => Math.fround(x)));
});
