// An effect a track's piece makes a "child" of a fighter's joint (efLib_Create_AttachChild) is held to it by a place
// and an orientation constraint (lb_8000C1C0, lb_8000C290). resolveCnsOrientation (FxWorld.jointOrient) takes, for a
// joint with CLASSICAL_SCALE under a parent, its matrix in its parent's, turned by each joint above in its own
// parent's, every one's axes made unit: square axes as long as the held joint's own, however unevenly the joints above
// are stretched - where the joint's own matrix columns, made unit, lean toward one another.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { FxWorld } from "../src/render3d/fx/world.ts";
import { HSD_MtxSRT, mtx, mtxToGL, PSMTXConcat } from "../src/render3d/gxmath.ts";
import { JOBJ } from "../src/render3d/hsd.ts";

const f = Math.fround;
const col = (m: Float32Array, c: number) => [m[c], m[4 + c], m[8 + c]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test("a constraint on a joint under unevenly stretched ones takes square axes, as long as the held joint's own", () => {
  // (a root stretched along y and turned about z, a joint turned again under it - its matrix sheared - and one turned
  // about x under that)
  const w0 = HSD_MtxSRT(mtx(), [1, 2, 1], [0, 0, f(Math.PI / 6)], [3, 4, 5], null);
  const w1 = PSMTXConcat(w0, HSD_MtxSRT(mtx(), [1, 1, 1], [0, 0, f(Math.PI * 2 / 9)], [1, 0, 0], null), mtx());
  const w2 = PSMTXConcat(w1, HSD_MtxSRT(mtx(), [1, 1, 1], [f(Math.PI / 9), 0, 0], [0, 1, 0], null), mtx());
  const world = new Float32Array(48);
  [w0, w1, w2].forEach((m, k) => mtxToGL(m, world, k * 16));
  const w = new FxWorld({ id: 0 } as never, () => -1) as unknown as Record<string, Map<string, unknown>>;
  const flags = [0, JOBJ.CLASSICAL_SCALE, JOBJ.CLASSICAL_SCALE];
  w.worlds.set("0:0", world);
  w.fighters.set("0:0", { skeleton: { n: 3, parent: Int32Array.from([-1, 0, 1]), flags: Uint32Array.from(flags) } });
  w.sts.set("0:0", { internalCharacterId: 2 });
  const orient = (w as unknown as FxWorld).jointOrient("0:0", 2)!;
  assert.ok(orient);
  const own = [f(0.5), f(1.5), f(2)];
  const o = orient(own);
  const c = [0, 1, 2].map((k) => col(o, k));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(Math.hypot(...c[k]) - own[k]) < 1e-5, `axis ${k} length`);
  assert.ok(Math.abs(dot(c[0], c[1])) < 1e-5 && Math.abs(dot(c[0], c[2])) < 1e-5 && Math.abs(dot(c[1], c[2])) < 1e-5);
  // (the joint's own columns, made unit, are not square: what the player took before)
  const u = [0, 1, 2].map((k) => { const v = col(w2, k), n = Math.hypot(...v); return v.map((x) => x / n); });
  assert.ok(Math.abs(dot(u[0], u[1])) > 0.05);
});
