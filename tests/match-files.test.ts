// One match's game files (src/sim/gamefiles.ts tapeMatch, matchParts): the stage and fighters read from a native tape's config, Zelda
// with Sheik and the other way round, Kirby's copies only of the match's other fighters, and no parts (read every file) for a fighter
// or stage the list does not know.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { matchParts, tapeMatch, type MatchFileList } from "../src/sim/gamefiles.ts";
import { TAPE_CONFIG_SIZE } from "../src/render3d/gxpath/tapebridge.ts";

function head(stage: number, chars: number[]): Uint8Array {
  const t = new Uint8Array(TAPE_CONFIG_SIZE), v = new DataView(t.buffer);
  v.setUint32(0, 0x314c534d, true);
  v.setInt32(4, stage, true);
  t[24] = chars.length;
  chars.forEach((c, p) => { t[41 + 8 * p] = c; });
  return t;
}

const list: MatchFileList = {
  version: 1, module: "0123456789abcdef", always: ["PlCo.dat"],
  fighters: { 1: ["PlFx.dat"], 4: ["PlKb.dat"], 7: ["PlSk.dat"], 19: ["PlZd.dat"], 22: ["PlFc.dat"] },
  kirby: { 1: ["PlKbCpFx.dat"], 7: ["PlKbCpSk.dat"], 19: ["PlKbCpZd.dat"], 22: ["PlKbCpFc.dat"] },
  stages: { 31: ["GrNBa.dat"], 32: [] },
};

test("a tape's stage and fighters, Zelda and Sheik together", () => {
  assert.deepEqual(tapeMatch(head(31, [1, 22])), { stage: 31, chars: [1, 22] });
  assert.deepEqual(tapeMatch(head(32, [19, 1])), { stage: 32, chars: [19, 7, 1] });
  assert.deepEqual(tapeMatch(head(32, [7, 7, 19])), { stage: 32, chars: [7, 19] });
});

test("a match's parts: every match's, its fighters', Kirby's copies of the others, its stage's", () => {
  assert.deepEqual(matchParts(list, head(31, [1, 22])), [["PlCo.dat"], ["PlFx.dat"], ["PlFc.dat"], ["GrNBa.dat"]]);
  assert.deepEqual(matchParts(list, head(32, [4, 19])),
                   [["PlCo.dat"], ["PlKb.dat"], ["PlZd.dat"], ["PlSk.dat"], ["PlKbCpZd.dat"], ["PlKbCpSk.dat"]]);
  // (no copy without Kirby; Kirby against Kirby copies nobody)
  assert.ok(!matchParts(list, head(32, [1, 19]))!.flat().some((n) => n.startsWith("PlKbCp")));
  assert.deepEqual(matchParts(list, head(32, [4, 4])), [["PlCo.dat"], ["PlKb.dat"]]);
});

test("a fighter or stage the list does not know, or another list version: no parts", () => {
  assert.equal(matchParts(list, head(31, [1, 9])), null);
  assert.equal(matchParts(list, head(2, [1, 22])), null);
  assert.equal(matchParts(list, head(32, [4, 9])), null);
  assert.equal(matchParts({ ...list, version: 2 } as unknown as MatchFileList, head(31, [1, 22])), null);
});
