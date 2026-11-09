// shadow.ts shadowCamera: a fighter's shadow camera bit for bit as the game makes it (lbShadow_8000F38C,
// HSD_ViewingRectInit / HSD_ViewingRectAddRect, HSD_ShadowSetViewingRect, C_MTXLookAt, C_MTXOrtho). The cases are the
// game's own, read from the memory of a running match (the shadow camera's CObj: its view_mtx and its ortho box; the
// shadow light's LObj; the camera's interest, which is the fighter's camera box bone_pos it was made with), as float32
// bits: Pokemon Stadium (a light nearer than 100, put 100 away), Final Destination (two fighters, one a frame further
// on), Battlefield and Dream Land.

import test from "node:test";
import assertNode from "node:assert/strict";
import { shadowCamera } from "../src/render3d/shadow.ts";
import { C_MTXOrtho, mtxFromGL } from "../src/render3d/gxmath.ts";

const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);
const bits = new DataView(new ArrayBuffer(4));
const f = (h: string) => { bits.setUint32(0, parseInt(h, 16)); return bits.getFloat32(0); };
const hex = (x: number) => { bits.setFloat32(0, x); return bits.getUint32(0).toString(16).padStart(8, "0"); };

// light place, camera bone, camera box depth (target_ext.v.z); the game's view_mtx (3 x 4) and ortho top/bottom/left/right
const CASES: [string[], string[], string, string[], string[]][] = [
  [["c0400000", "3f800000", "00000000"], ["c215f41a", "42125c07", "3e225864"], "41800000",
   ["00000000", "80000000", "3f7fffff", "be225863", "3ea1e89b", "3f72dce8", "80000000", "c1b6dbd0", "bf72dce9", "3ea1e89c", "00000000", "c31322a5"],
   ["4199999b", "c1999999", "c199999a", "4199999a"]],
  [["419c0000", "40f00000", "41f80000"], ["c0d16398", "40c19e26", "3d4ad1e4"], "41333333",
   ["3f58b1a6", "324c0e80", "bf084eb6", "40b21550", "bddac60d", "3f7acb86", "be2de5a1", "c0d3c79a", "3f05893d", "3e4d70ac", "3f5449c5", "c2c3aef9"],
   ["41570a3d", "c1570a3f", "c1570a42", "41570a3a"]],
  [["419c0000", "40f00000", "41f80000"], ["40078de6", "40bb7db7", "3cb7e788"], "41333333",
   ["3f58b1a5", "31bd56f4", "bf084eb6", "bfe3f400", "bddac60c", "3f7acb84", "be2de5a0", "c0b05122", "3f05893d", "3e4d70ac", "3f5449c4", "c2cc990a"],
   ["41570a3e", "c1570a3e", "c1570a3d", "41570a3f"]],
  [["3e23d70b", "3f4ccccd", "3f4ccccd"], ["c21b0a1f", "428f90c9", "3d8b030d"], "41600000",
   ["3f7b0755", "b1d0a269", "be48d2ac", "421814ff", "be0c9aac", "3f36c911", "bf2fc156", "c2621d79", "3e0f6382", "3f333c62", "3f333c61", "c310e0c8"],
   ["41866667", "c1866667", "c1866667", "41866667"]],
  [["419c0000", "40f00000", "41f80000"], ["c250e3f6", "40a9b8b4", "3e56fd1c"], "41333333",
   ["3f58b1a5", "31bd56f4", "bf084eb6", "423143c6", "bddac60c", "3f7acb84", "be2de5a0", "c12bd279", "3f05893d", "3e4d70ac", "3f5449c4", "c293febd"],
   ["41570a3e", "c1570a3e", "c1570a3d", "41570a3f"]],
];

test("the shadow camera is the game's, bit for bit (view and projection)", () => {
  for (const [light, bone, depth, view, ortho] of CASES) {
    const cam = shadowCamera(light.map(f), null, bone.map(f), f(depth))!;
    assertEquals([...mtxFromGL(cam.view, new Float32Array(12))].map(hex), view);
    const o = ortho.map(f);
    assertEquals([...cam.gx].map(hex), [...C_MTXOrtho(new Float32Array(16), o[0], o[1], o[2], o[3], 0.001, 5000)].map(hex));
  }
});

test("a light where its interest is makes no shadow camera", () => {
  assertEquals(shadowCamera([1, 2, 3], [1, 2, 3], [0, 0, 0], 10), null);
});
