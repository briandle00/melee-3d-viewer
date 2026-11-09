// hud.ts magnifierView and the magnifier pictures' lights: the game's own numbers, read from the memory of a running
// match (Fountain of Dreams, Mewtwo off the screen): ifMagnify's CObj with its interest the camera box bone and its eye
// that point at z 300, its view_mtx; and the fighters' first light (an infinite one at (-1.5, -2.25, 6.75)) as GX had it
// in the next frame's picture: set up through that view - the one the last picture left - before the camera moves on.

import test from "node:test";
import assertNode from "node:assert/strict";
import { magnifierView } from "../src/render3d/hud.ts";
import { mtxFromGL, PSMTXMultVec } from "../src/render3d/gxmath.ts";

const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);
const bits = new DataView(new ArrayBuffer(4));
const f = (h: string) => { bits.setUint32(0, parseInt(h, 16)); return bits.getFloat32(0); };
const hex = (x: number) => { bits.setFloat32(0, x); return bits.getUint32(0).toString(16).padStart(8, "0"); };

const BONE = ["43258437", "c2d53aaf", "3f5566ec"];
const VIEW = ["3f7fffff", "80000000", "80000000", "c3258436", "00000000", "3f7fffff", "80000000", "42d53aae",
              "00000000", "00000000", "3f800000", "c3960000"];

test("the magnifier's camera is the game's, bit for bit", () => {
  const V = mtxFromGL(magnifierView(new Float32Array(16), BONE.map(f)), new Float32Array(12));
  assertEquals([...V].map(hex), VIEW);
});

test("the pictures' lights go through the view the last picture left (setup_infinite_lightobj)", () => {
  const V = mtxFromGL(magnifierView(new Float32Array(16), BONE.map(f)), new Float32Array(12));
  const p = [-1.5, -2.25, 6.75].map((v) => Math.fround(v * 1048576));
  assertEquals(Array.from(PSMTXMultVec(V, p, [0, 0, 0])).map(hex), ["c9c0052b", "ca0ffe55", "4ad7fda8"]);
});
