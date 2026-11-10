// A fighter held or thrown has its XRotN at its holder's TransN2: ftCo_800DB368 ties the joint with lb_8000C1C0, a
// position constraint, so the joint matrix's translation is the holder's point itself and the joints under it are
// made on that matrix. The player once moved the joint by a difference taken from an earlier pose of the same frame;
// whenever the pose it was added to was not that one to the bit, the point came out a ulp off and every joint
// under it with it (one full gate draw in five: Roy thrown by Marth, bot-tp_marth_roy-1565, 2026-11-10).
//
//   deno test --no-check --sloppy-imports tests/hold-position.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton } from "../src/render3d/skeleton.ts";
import type { Archive, JObj } from "../src/render3d/hsd.ts";

const joint = (index: number, parent: number, rot: [number, number, number], trans: [number, number, number]): JObj =>
  ({ offset: 100 * (index + 1), index, parent, flags: 0, rot, scale: [1, 1, 1], trans, invBind: null, children: [], dobjs: [] });

// TopN, TransN, XRotN, a joint under it (a hand)
const fighter = () => new Skeleton(null as unknown as Archive, [
  joint(0, -1, [0, 1.5707963, 0], [12.345678, 3.2109876, 0]),
  joint(1, 0, [0.1, 0, 0], [0, 7.4, 0.3]),
  joint(2, 1, [0, 0.2, 0.05], [0.25, 1.1, 0]),
  joint(3, 2, [0.3, 0.1, 0], [2.5, 0.75, -1.25]),
], [], "held");

const point = (sk: Skeleton, j: number) => [...sk.world.subarray(j * 16 + 12, j * 16 + 15)];

test("a held fighter's XRotN is at its holder's point to the bit, whatever the pose under it", () => {
  const to: [number, number, number] = [Math.fround(-41.73), Math.fround(18.006), Math.fround(0.5)];
  const sk = fighter();
  sk.shift = { joint: 2, to };
  sk.update();
  assert.deepEqual(point(sk, 2), to);
  const hand = point(sk, 3);
  // the same frame posed again with the joints over it a little elsewhere (a pose not to the bit the one before:
  // its root a ulp along, its TransN 0.001 up): the joint and every joint under it are where they were
  const x = new Float32Array([sk.trans[0]]), bits = new Uint32Array(x.buffer);
  bits[0] += 1;
  sk.trans[0] = x[0];
  sk.trans[4] = Math.fround(sk.trans[4] + 0.001);
  sk.update();
  assert.deepEqual(point(sk, 2), to);
  assert.deepEqual(point(sk, 3), hand);
});

test("without a hold the joint is where its pose puts it", () => {
  const sk = fighter();
  sk.update();
  const was = point(sk, 2);
  sk.shift = { joint: 2, to: [1, 2, 3] };
  sk.update();
  sk.shift = null;
  sk.update();
  assert.deepEqual(point(sk, 2), was);
});
