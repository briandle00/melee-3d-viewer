// kirby.ts: a colored hat's joints on made-up part lists - each joint's part in Kirby's list (his own, and the
// room his list keeps for a copy's extra joints), and the extra joints posed by the viewer track's swung parts.

import test from "node:test";
import assertNode from "node:assert/strict";
import { hatJointMap, hatJointParts, poseSkin, type KirbyHat } from "../src/render3d/kirby.ts";
import { setPartSkips } from "../src/render3d/parts.ts";
import type { Skeleton } from "../src/render3d/skeleton.ts";

const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);

/** a skeleton's pose arrays alone (what poseSkin reads and writes), n joints at rest 0 */
function fakeSkeleton(n: number): Skeleton {
  const sk = {
    n, rot: new Float32Array(n * 3), scale: new Float32Array(n * 3), trans: new Float32Array(n * 3),
    shown: new Uint8Array(n).fill(1), updated: 0,
    resetPose() { sk.rot.fill(0); sk.scale.fill(1); sk.trans.fill(0); },
    update() { sk.updated++; },
  };
  return sk as unknown as Skeleton;
}

test("a colored hat's joints' parts: his own, and the room the copy's mask fills", () => {
  // (room at parts 2 and 3 for one copy, 5 for another; the hat's mask names the first two)
  setPartSkips({ 4: [2, 3, 5] });
  assertEquals(hatJointMap(6, 0b011), [0, 1, -1, -1, 2, 3]);
  assertEquals(hatJointParts(6, 0b011), [0, 1, 2, 3, 4, 6]);
  // (without the mask the room is left out)
  assertEquals(hatJointMap(4, 0), [0, 1, 2, 3]);
  assertEquals(hatJointParts(4, 0), [0, 1, 4, 6]);
  setPartSkips({});
});

test("the hat's extra joints take the track's swung parts, the rest Kirby's pose", () => {
  setPartSkips({ 4: [2, 3, 5] });
  const kirby = fakeSkeleton(4), skin = fakeSkeleton(6);
  kirby.resetPose();
  for (let j = 0; j < 4; j++) kirby.rot[j * 3 + 2] = j + 1;
  const hat: KirbyHat = { prop: null, skin, mask: 0b011 };
  const N = NaN;
  // (part 2's turn about z from "fp", part 3's x place from "fj" and its turn from "fp"; a NaN keeps the rest)
  const fj = new Map([[3, new Float32Array([N, N, N, N, N, N, 7, N, N])]]);
  const fp = new Map([[2, new Float32Array([N, N, 0.5, N, N, N, N, N, N])], [3, new Float32Array([0.25, N, N, N, N, N, N, N, N])]]);
  poseSkin(hat, kirby, fj, fp);
  assertEquals(Array.from(skin.rot), [0, 0, 1, 0, 0, 2, 0, 0, 0.5, 0.25, 0, 0, 0, 0, 3, 0, 0, 4]);
  assertEquals(Array.from(skin.trans.subarray(9, 12)), [7, 0, 0]);
  assertEquals(Array.from(skin.scale.subarray(6, 12)), [1, 1, 1, 1, 1, 1]);
  // (no track: at rest)
  poseSkin(hat, kirby);
  assertEquals(Array.from(skin.rot.subarray(6, 12)), [0, 0, 0, 0, 0, 0]);
  setPartSkips({});
});
