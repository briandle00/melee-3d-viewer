// A whole load's record of the console bases (src/sim/gamefiles.ts datBasesOf) and the module factory a host gives one load
// (ownModules): no module, or one without the record, has no bases and never throws; two loads that overlap on a page each read the
// module their own open made, never the other's; once read, a load keeps no module. Made-up modules: no game file is read.
//
//   deno test -A --no-check --sloppy-imports tests/dat-bases.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { datBasesOf, ownModules } from "../src/sim/gamefiles.ts";

/** a made-up module whose load recorded `n` bases (keys i, bases 0x1000 * (i + 1)) */
function made(n: number) {
  return { _msl_native_dat_base_count: () => n, _msl_native_dat_base_at: (i = 0) => 0x1000 * (i + 1),
           _msl_native_dat_base_key_lo: (i = 0) => i, _msl_native_dat_base_key_hi: () => 0 };
}

test("no module, or one without the record, has no bases (never a throw)", () => {
  assert.equal(datBasesOf(null), null);
  assert.equal(datBasesOf(undefined), null);
  assert.equal(datBasesOf({}), null);
  assert.equal(datBasesOf(made(0)), null);
  const b = datBasesOf(made(3))!;
  assert.equal(new TextDecoder().decode(b.subarray(0, 4)), "MSLB");
  assert.equal(new DataView(b.buffer).getUint32(4, true), 3);
});

test("two loads that overlap each read the module their own open made", async () => {
  const a = made(2), b = made(5);
  // (one factory for the page: the first load's module is made after the second load's, as a slower open's is)
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const make = async (o: { which: string }) => { if (o.which === "a") await slow; return o.which === "a" ? a : b; };
  const ownA = ownModules(make), ownB = ownModules(make);
  const openA = ownA.make({ which: "a" });
  const gotB = await ownB.make({ which: "b" });
  release();
  await openA;
  assert.ok(ownB.take() === gotB, "the second load read another load's module");
  assert.ok(ownA.take() === a, "the first load read another load's module");
});

test("once read, a load keeps no module: one its engine makes on a reopen is not held", async () => {
  const own = ownModules(async (o: number) => made(o));
  await own.make(1);
  assert.notEqual(datBasesOf(own.take()), null);
  await own.make(4);
  assert.equal(own.take(), null);
});
