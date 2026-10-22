// fx/colanim.ts: a color animation's color in float32 as lb_80014258 keeps it (made-up script, no game files).

import test from "node:test";
import assert from "node:assert/strict";
import { ColAnimTables, Overlay } from "../src/render3d/fx/colanim.ts";
import type { Archive } from "../src/render3d/hsd.ts";

/** a script of words at offset 0 in a made-up file, as the table's one entry (entry 1) */
function scriptTables(words: number[]): ColAnimTables {
  const buf = new ArrayBuffer(words.length * 4 + 16);
  const d = new DataView(buf);
  words.forEach((w, i) => d.setUint32(i * 4, w >>> 0));
  const a = { data: d, reloc: new Set<number>() } as unknown as Archive;
  return new ColAnimTables(a, [{ cmds: null, pri: 0, slot: 0 }, { cmds: 0, pri: 1, slot: 0 }], []);
}
const op = (o: number, v = 0) => ((o << 26) | v) >>> 0;

test("a color blend: its step ((0.5 + target) - the byte) / frames and each frame's sum, in float32", () => {
  const f32 = Math.fround;
  // (set 10,20,30,0; blend to 255,0,7,200 over 7 frames; wait)
  const t = scriptTables([op(0x12), 0x0a141e00, op(0x13, 7), 0xff0007c8, op(1, 50), op(0)]);
  const o = new Overlay();
  assert.ok(o.start(t, 1, 0, 0));
  const from = [10, 20, 30, 0], to = [255, 0, 7, 200];
  const step = from.map((c, k) => f32(f32(f32(0.5 + to[k]) - c) / 7));
  const want = [...from];
  for (let i = 0; i < 7; i++) {
    o.step(t, null);
    for (let k = 0; k < 4; k++) want[k] = f32(want[k] + step[k]);
    assert.deepEqual([...o.color], want);
  }
  assert.deepEqual(o.color.map((c) => (c | 0) & 0xff), to);
});
