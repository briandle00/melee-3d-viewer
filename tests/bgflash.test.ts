// fx/bgflash.ts: the screen flash as lbBgFlash plays it, from made-up "bgflash" starts and a made-up script (no game files).

import test from "node:test";
import assert from "node:assert/strict";
import { ColAnimTables } from "../src/render3d/fx/colanim.ts";
import { BgFlash, flashQuad } from "../src/render3d/fx/bgflash.ts";
import type { Archive } from "../src/render3d/hsd.ts";

const op = (o: number, v = 0) => ((o << 26) | v) >>> 0;
/** entry 2: set white at 128, blend to clear over 4 frames, wait 4, end (lb_80013BB0) */
function tables(): ColAnimTables {
  const words = [op(0x12), 0xffffff80, op(0x13, 4), 0x00000000, op(1, 4), op(0xa)];
  const d = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach((w, i) => d.setUint32(i * 4, w));
  const a = { data: d, reloc: new Set<number>() } as unknown as Archive;
  const none = { cmds: null, pri: 0, slot: 0 };
  return new ColAnimTables(a, [none, none, { cmds: 0, pri: 1, slot: 0 }], []);
}

test("nothing before the match's first flash; its color while it runs; black at alpha 0 ever after", () => {
  const b = new BgFlash(tables(), [[100, 2, 0]]);
  assert.equal(b.stateAt(50).drawn, false);
  assert.equal(b.stateAt(99).drawn, false);
  // (started on its frame, then run once by lbBgFlash_Proc: the blend's first step already in)
  const s = b.stateAt(100);
  assert.equal(s.drawn, true);
  const step = Math.fround(Math.fround(Math.fround(0.5 + 0) - 255) / 4);
  assert.deepEqual(s.color, [Math.trunc(255 + step), Math.trunc(255 + step), Math.trunc(255 + step),
                             Math.trunc(128 + Math.fround(Math.fround(0.5 - 128) / 4))]);
  // (the script ends on the fifth frame: its color off, fn_800208B0(0))
  const end = b.stateAt(104);
  assert.equal(end.drawn, true);
  assert.deepEqual(end.color, [0, 0, 0, 0]);
  assert.deepEqual(b.stateAt(5000).color, [0, 0, 0, 0]);
  assert.equal(b.stateAt(5000).drawn, true);
  // (an earlier frame asked again: played from the start)
  assert.equal(b.stateAt(10).drawn, false);
  assert.equal(b.stateAt(100).color[3], s.color[3]);
});

test("the flash's quad: 640 x 480 at z = 0, from 0,0 to 640,-480, its color, every pixel passing", () => {
  const q = flashQuad(new Float32Array(68), [255, 0, 0, 51]);
  const corner = (v: number) => [q[v * 17], q[v * 17 + 1], q[v * 17 + 2]];
  assert.deepEqual([0, 1, 2, 3].map(corner), [[0, 0, 0], [640, 0, 0], [640, -480, 0], [0, -480, 0]]);
  assert.equal(q[5], 1); assert.equal(q[8], Math.fround(0.2)); assert.equal(q[13], 63); assert.equal(q[16], 0);
});
