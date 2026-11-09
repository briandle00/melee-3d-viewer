// A constant track's last key: once its frame comes the track gives its value from there on. HSD_FObjInterpretAnim
// reaches the end of the FObj's data (state 6) and FObjUpdateAnim gives the constant's p1. Battlefield's wireframe
// (map_head part 3) shows through its background change and hides itself at frame 400 of its animation, its
// branch track's last key; the player dropped that key and drew the wireframe on for the rest of the change.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { decodeKeys, sample } from "../src/render3d/hsd.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

test("a constant track's last value holds from its key's frame", () => {
  // (op 1 CON, three values as u8 with 7 bits of fraction: 1 wait 0, 1 wait 400, 0 wait 0)
  const keys = decodeKeys(new Uint8Array([0x21, 0x80, 0x00, 0x80, 0x90, 0x03, 0x00, 0x00]), 0x87, 0x88);
  assert.deepEqual([0, 399, 400, 401, 565].map((t) => sample(keys, t)), [1, 1, 0, 0, 0]);
  // (a linear one's last value was there already: its segment ends on it)
  const lin = decodeKeys(new Uint8Array([0x12, 0x00, 0x0a, 0x80, 0x00]), 0x87, 0x88);
  assert.deepEqual([0, 5, 10, 20].map((t) => sample(lin, t)), [0, 0.5, 1, 1]);
});

test("game files: Battlefield's wireframe hides itself at frame 400", withGameFiles, async () => {
  const { parseArchive, loadAnimJoint, aobjFrame, ptr } = await import("../src/render3d/hsd.ts");
  const a = parseArchive(readGameFile("GrNBa.dat"));
  const arr = ptr(a, a.publics.get("map_head")! + 8)!;
  const anim = loadAnimJoint(a, ptr(a, ptr(a, arr + 3 * 0x34 + 4)!)!);
  const ao = anim[1]!;
  assert.equal(ao.tracks[0].type, 12);
  assert.deepEqual([0, 399, 400, 565].map((t) => sample(ao.tracks[0].keys, aobjFrame(ao, t, false))), [1, 1, 0, 0]);
});
