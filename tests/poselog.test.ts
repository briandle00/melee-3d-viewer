// poselog.ts: the viewer's debug pose log, on made-up skeletons: the lines' layout (rows 0-2 of the column-major
// 4 x 4s, row by row, as float32 words), the masks of what changed, a fighter's parts past its model's gaps, a
// stage part's place as its joint 0, and that a frame drawn again (or one before) is not logged again.

import test from "node:test";
import assertNode from "node:assert/strict";
import { PoseLog, poseLogCommand } from "../src/render3d/poselog.ts";
import { setPartSkips } from "../src/render3d/parts.ts";
import type { Skeleton } from "../src/render3d/skeleton.ts";

const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);

const word = (x: number) => "0x" + new Uint32Array(new Float32Array([x]).buffer)[0].toString(16).padStart(8, "0");

/** n joints, joint k's 4 x 4 (column major) with element (row r, col c) = 100 k + 10 r + c */
function world(n: number): Float32Array {
  const w = new Float32Array(n * 16);
  for (let k = 0; k < n; k++) for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) w[k * 16 + c * 4 + r] = 100 * k + 10 * r + c;
  return w;
}
const rows = (k: number) => [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => word(100 * k + 10 * r + c)));
const lines = (log: PoseLog) => log.take().map((l) => JSON.parse(l));

test("a fighter's joints, rows 0-2 row by row, then only what changed", () => {
  setPartSkips({});
  const log = new PoseLog(), w = world(2), game = {};
  log.begin(-123, game);
  log.fighter(1, 0, 2, w);
  assertEquals(lines(log), [[-123, "wn"], [-123, "wf", 1, 0, 2, 0, 4095, ...rows(0), 1, 4095, ...rows(1)]]);
  // (the next frame: joint 1's m[1][3] moved; joint 0 the same, not written)
  log.begin(-122, game);
  w[16 + 12 + 1] = 0.5;
  log.fighter(1, 0, 2, w);
  assertEquals(lines(log), [[-122, "wn"], [-122, "wf", 1, 0, 2, 1, 1 << 7, word(0.5)]]);
  // (nothing changed: the fighter's head alone, drawn; one not drawn has no line)
  log.begin(-121, game);
  log.fighter(1, 0, 2, w);
  assertEquals(lines(log), [[-121, "wn"], [-121, "wf", 1, 0, 2]]);
  log.begin(-120, game);
  assertEquals(lines(log), [[-120, "wn"]]);
});

test("a part the model leaves out is not written; the ones past it are the model's joint before", () => {
  setPartSkips({ 4: [1] });
  const log = new PoseLog();
  log.begin(0, 1);
  log.fighter(0, 1, 4, world(2));
  assertEquals(lines(log)[1], [0, "wf", 0, 1, 4, 0, 4095, ...rows(0), 2, 4095, ...rows(1)]);
  setPartSkips({});
});

test("an item's joints from its root, its kind once; a stage part's place as joint 0", () => {
  const log = new PoseLog();
  const sk = { n: 2, world: world(2) } as unknown as Skeleton;
  const place = world(1);
  place.set(world(3).subarray(32, 48));
  log.begin(5, 1);
  log.item(7, 0x30, sk);
  log.item(7, 0x30, sk);
  log.stagePart(1004, place, sk);
  assertEquals(lines(log), [[5, "wn"], [5, "wk", 7, 0x30], [5, "wi", 7, 0, 4095, ...rows(0), 1, 4095, ...rows(1)],
                            [5, "ws", 1004, 0, 4095, ...rows(2), 1, 4095, ...rows(0), 2, 4095, ...rows(1)]]);
});

test("a frame drawn again or before is not logged; another replay starts over", () => {
  const log = new PoseLog(), sk = { n: 1, world: world(1) } as unknown as Skeleton;
  assertEquals(log.begin(10, 1), true);
  log.item(1, 2, sk);
  assertEquals(log.begin(10, 1), false);
  log.item(1, 2, sk);
  assertEquals(log.begin(9, 1), false);
  assertEquals(log.take().length, 3);
  assertEquals(log.begin(0, 2), true);
  log.item(1, 2, sk);
  assertEquals(lines(log), [[0, "wn"], [0, "wk", 1, 2], [0, "wi", 1, 0, 4095, ...rows(0)]]);
});

test("the debug handle's command makes, takes and drops the log", () => {
  let held: PoseLog | null = null;
  const cmd = (c: Parameters<typeof poseLogCommand>[2]) => poseLogCommand(() => held, (l) => { held = l; }, c);
  assertEquals(cmd({}), { on: false, lines: 0 });
  assertEquals(cmd({ start: true }), { on: true, lines: 0 });
  held!.begin(0, 1);
  assertEquals(cmd({ take: true }), ['[0,"wn"]']);
  assertEquals(cmd({ stop: true }), { on: false, lines: 0 });
});
