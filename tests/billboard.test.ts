// The billboards (gxmath.ts mkBillBoardMtx, displayfunc.c's mkBillBoardMtx and kin) on hand-worked modelviews, and
// the renderer's test for loading a billboard's modelview as the game made it (skeleton.ts billboardViewOf).

import test from "node:test";
import assertNode from "node:assert/strict";
import { mkBillBoardMtx, PSMTXConcat, PSMTXRotAxisRad, PSMTXScale } from "../src/render3d/gxmath.ts";
import { billboardViewOf, setBillboardView } from "../src/render3d/skeleton.ts";

const near = (a: ArrayLike<number>, b: number[], eps = 1e-5) => b.every((v, i) => Math.abs(a[i] - v) <= eps * Math.max(1, Math.abs(v)));

test("a billboard faces the screen, its scale kept, its place kept", () => {
  // a joint 10 in front of the camera, scaled 2, 3, 4 and turned about an axis
  const s = PSMTXScale(new Float32Array(12), 2, 3, 4), r = PSMTXRotAxisRad(new Float32Array(12), [0.3, 1, 0.2], 0.7);
  const src = PSMTXConcat(r, s, new Float32Array(12));
  src[3] = 1; src[7] = -2; src[11] = -10;
  const out = mkBillBoardMtx(0x200, false, 0, src, new Float32Array(12));
  // (its z axis toward the screen, 4 long; its x axis in the screen's plane; the place as it was)
  assertNode.ok(near([out[2], out[6], out[10]], [0, 0, 4]), `z ${[out[2], out[6], out[10]]}`);
  assertNode.ok(Math.abs(out[8]) < 1e-6, "x axis in the screen's plane");
  assertNode.ok(near([out[3], out[7], out[11]], [1, -2, -10], 0));
  // (the y axis's lean in the screen kept: y and x turn together)
  assertNode.ok(Math.abs(Math.hypot(out[1], out[5], out[9]) - 3) < 1e-5);
  // upright (VBILLBOARD): the y axis as it was
  const v = mkBillBoardMtx(0x400, false, 0, src, new Float32Array(12));
  assertNode.deepEqual([v[1], v[5], v[9]], [src[1], src[5], src[9]]);
  // turned by its own z (RBILLBOARD): a quarter turn takes x to y
  const rb = mkBillBoardMtx(0x800, false, Math.PI / 2, src, new Float32Array(12));
  assertNode.ok(near([rb[0], rb[4]], [0, 2], 1e-4) && near([rb[1], rb[5]], [-3, 0], 1e-4), `${Array.from(rb)}`);
});

test("the renderer loads a billboard's own modelview only under the view it was made under", () => {
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -5, -100, 1]);
  setBillboardView(view);
  const id = billboardViewOf(view);
  assertNode.ok(id >= 0);
  const other = view.slice();
  other[14] = -99;
  assertNode.equal(billboardViewOf(other), -1);
});
