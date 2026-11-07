// The checkpoints of the simulator module's memory (src/render3d/gxpath/checkpoints.ts) on a stand-in memory: a rewind puts every
// page back as it was at the checkpoint (pages changed since that it does not hold back to the baseline), a page never seen as it
// started asks for the match opened again, at most KEEP are kept and a host may keep its earliest, the latest one before a row (and
// after another), and the pages that differ from the baseline.
//   deno test -A --no-check --sloppy-imports tests/checkpoints.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Checkpoints, KEEP, PAGE, SPACING, type CheckpointMemory } from "../src/render3d/gxpath/checkpoints.ts";

const PAGES = 8;
function memory(): CheckpointMemory {
  const HEAPU8 = new Uint8Array(PAGES * PAGE);
  for (let p = 0; p < PAGES; p++) HEAPU8.fill(p, p * PAGE, (p + 1) * PAGE);
  return { HEAPU8, _msl_gxw_heap_top: () => PAGES * PAGE };
}
const at = (m: CheckpointMemory, p: number) => m.HEAPU8[p * PAGE + 123];
const put = (m: CheckpointMemory, p: number, v: number) => m.HEAPU8.fill(v, p * PAGE, (p + 1) * PAGE);

test("a rewind writes the checkpoint's pages back, and the baseline's for pages changed since", async () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m);
  put(m, 2, 50);
  k.keep(m, 400);
  put(m, 3, 60);
  k.keep(m, 900);
  assert.deepEqual(k.differs(m), [2, 3]);
  // pages 2 and 3 were never seen as they started: the match is opened again for them (a fresh memory, the baseline's)
  put(m, 2, 51); put(m, 5, 70);
  let reopened = 0;
  const fresh = memory();
  const got = await k.rewind(m, k.latest(500), async () => { reopened++; return fresh; });
  assert.equal(got, fresh);
  assert.equal(reopened, 1);
  assert.deepEqual([at(fresh, 2), at(fresh, 3), at(fresh, 5)], [50, 3, 5]);
  // now every page is known as it started: no reopen, the memory given is written
  put(fresh, 2, 52); put(fresh, 3, 61); put(fresh, 5, 80);
  const back = await k.rewind(fresh, k.latest(900), async () => { reopened++; return null; });
  assert.equal(back, fresh);
  assert.equal(reopened, 1);
  assert.deepEqual([at(fresh, 2), at(fresh, 3), at(fresh, 5)], [50, 60, 5]);
  // a page never seen as it started (6) asks again; the caller gone, nothing is written
  put(fresh, 6, 90);
  assert.equal(await k.rewind(fresh, null, async () => { reopened++; return null; }), null);
  assert.equal(reopened, 2);
  assert.equal(at(fresh, 6), 90);
  assert.equal(k.stats.rewinds, 3);
  assert.equal(k.stats.reopens, 2);
});

test("the latest checkpoint at or before a row, and after another (a jump forward to one ahead)", () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m);
  for (const row of [100, 500, 900]) k.keep(m, row);
  assert.equal(k.latest(99), null);
  assert.equal(k.latest(100)?.row, 100);
  assert.equal(k.latest(899)?.row, 500);
  assert.equal(k.latest(5000)?.row, 900);
  assert.equal(k.latest(5000, 600)?.row, 900);
  assert.equal(k.latest(899, 500), null);
  assert.equal(k.latest(899, 499)?.row, 500);
});

test("marks: none within SPACING rows after another; a place sought to marks two before its restart row", () => {
  const m = memory(), k = new Checkpoints(120);
  k.baseline(m);
  k.backMarks(3000);
  for (let row = 1; row <= 3000; row++) k.passing(m, row);
  assert.equal(k.latest(3000 - 120)?.row, 3000 - 120);
  assert.equal(k.latest(3000 - 121)?.row, 3000 - 120 - SPACING);
  k.markAt(3000 - 120 + 10);
  k.passing(m, 3000 - 120 + 10);
  assert.equal(k.latest(3000)?.row, 3000 - 120, "a mark within SPACING after a checkpoint is not kept");
});

test("at most KEEP are kept; with keepEarliest the earliest is never the one dropped", () => {
  for (const keepEarliest of [false, true]) {
    let earliestKept = 0;
    for (let run = 0; run < 40; run++) {
      const m = memory(), k = new Checkpoints(120, keepEarliest);
      k.baseline(m);
      for (let i = 0; i < KEEP + 15; i++) k.keep(m, 1000 + i * 400);
      let n = 0;
      for (let row = 1000; row <= 1000 + (KEEP + 15) * 400; row += 400) if (k.latest(row)?.row === row) n++;
      assert.equal(n, KEEP);
      if (k.latest(1000)?.row === 1000) earliestKept++;
    }
    if (keepEarliest) assert.equal(earliestKept, 40);
    else assert.ok(earliestKept < 40, "without keepEarliest the earliest may go");
  }
});
