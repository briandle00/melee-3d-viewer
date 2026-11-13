// What a renderer started fresh mid-game cannot have (src/render3d/gxr/fresh.ts): a picture copied from a frame buffer cleared whole in
// the stream and drawn with textures the stream wrote is the game's; one drawn before such a clear, or reading memory nobody wrote since
// the start (a copy the game made before it), a copy made from a frame not drawn, a palette not loaded, or a preloaded texture, is not -
// until the next whole clear.
//   deno test -A --no-check --sloppy-imports tests/fresh-watch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { FreshWatch } from "../src/render3d/gxr/fresh.ts";
import type { GxRegs } from "../src/render3d/gxr/state.ts";

// BP registers: a 640x480 frame, the scissor over it, one TEV stage reading texture map 0 (an RGBA8 64x64 at `tex`)
function regs(tex: number, o: { fmt?: number; preloaded?: boolean; tlut?: number } = {}): GxRegs {
  const bp = new Uint32Array(256);
  bp[0x20] = (0 << 12) | 0; bp[0x21] = (639 << 12) | 479;
  bp[0x00] = 0;                                        // one TEV stage, no indirect stages
  bp[0x28] = (1 << 6) | 0;                             // stage 0: texture map 0, enabled
  bp[0x88] = ((o.fmt ?? 6) << 20) | (63 << 10) | 63;   // 64 x 64
  bp[0x8c] = o.preloaded ? 1 << 21 : 0;
  bp[0x94] = tex >> 5;
  bp[0x98] = o.tlut ?? 0;
  return { bp } as unknown as GxRegs;
}
// a copy: to the screen or to memory at `dest`, the rectangle, with or without its clear (of color, alpha and depth: whole)
function copy(r: GxRegs, o: { screen?: boolean; dest?: number; x?: number; y?: number; w?: number; h?: number; clear?: boolean; whole?: boolean }) {
  const bp = r.bp;
  bp[0x49] = ((o.y ?? 0) << 10) | (o.x ?? 0);
  bp[0x4a] = (((o.h ?? 480) - 1) << 10) | ((o.w ?? 640) - 1);
  bp[0x4b] = (o.dest ?? 0) >> 5;
  bp[0x4d] = 1024 >> 5;                                 // a 64-wide RGBA8 row of 4x4 blocks: 16 blocks of 64 bytes
  bp[0x52] = (o.screen ? 1 << 14 : 0) | (o.clear ? 1 << 11 : 0) | (12 << 3);   // (an RGBA8 copy)
  bp[0x41] = o.whole === false ? 1 << 3 : (1 << 3) | (1 << 4);
  bp[0x40] = o.whole === false ? 0 : 1 << 4;
  return bp;
}

test("a frame drawn after a whole clear, with textures the stream sent, is the game's picture", () => {
  const w = new FreshWatch(), r = regs(0x10000);
  w.wrote(0x10000, 64 * 64 * 4);
  w.copied(copy(r, { screen: true, clear: true }), false);   // the hand-over row: not drawn, its clear
  assert.equal(w.pictures, 0);
  w.draw(r);
  w.copied(copy(r, { screen: true, clear: true }), true);
  assert.deepEqual([w.pictures, w.exact], [1, true]);
});

test("a draw before any whole clear, or after a clear of some channels only, makes the picture not the game's", () => {
  const w = new FreshWatch(), r = regs(0x10000);
  w.wrote(0x10000, 64 * 64 * 4);
  w.draw(r);
  w.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(w.exact, false, "drawn on what the frames before left");
  const v = new FreshWatch();
  v.wrote(0x10000, 64 * 64 * 4);
  v.copied(copy(r, { screen: true, clear: true, whole: false }), false);
  v.draw(r);
  v.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(v.exact, false, "alpha and depth not cleared");
  // and the next whole clear makes the frame after it the game's again
  v.draw(r);
  v.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(v.exact, true);
});

test("a texture of memory nobody wrote in the stream (a copy made before it) is not had; a copy of a drawn frame is", () => {
  const w = new FreshWatch(), r = regs(0x200000);
  w.copied(copy(r, { screen: true, clear: true }), false);
  w.draw(r);
  w.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(w.exact, false);
  assert.match(w.why, /not written in this stream/);
  // this frame copies its picture there (a drawn frame, from the cleared frame buffer): the next frame reading it is the game's
  w.copied(copy(r, { dest: 0x200000, w: 64, h: 64 }), true);
  w.draw(r);
  w.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(w.exact, true);
});

test("a copy of a frame not drawn, or skipped, is not had; a copy of a frame drawn on what was not had is not either", () => {
  const w = new FreshWatch(), r = regs(0x200000);
  w.copied(copy(r, { dest: 0x200000, w: 64, h: 64 }), false);
  w.copied(copy(r, { screen: true, clear: true }), false);
  w.draw(r);
  w.copied(copy(r, { screen: true, clear: true }), true);
  assert.equal(w.exact, false, "the hand-over row's copy");
  const v = new FreshWatch(), s = regs(0x10000);
  v.wrote(0x10000, 64 * 64 * 4);
  v.copied(copy(s, { screen: true, clear: true }), false);
  v.skipped(copy(s, { screen: true, clear: true }));
  v.draw(s);
  v.copied(copy(s, { screen: true, clear: true }), true);
  assert.equal(v.exact, false, "a clear skipped (fast-forward): the frame buffer is not the game's");
  // a draw that read memory not had, then a copy of that frame: the copy is not had either
  const u = new FreshWatch(), q = regs(0x300000);
  u.copied(copy(q, { screen: true, clear: true }), false);
  u.draw(q);
  u.copied(copy(q, { dest: 0x10000, w: 64, h: 64 }), true);
  u.copied(copy(q, { screen: true, clear: true }), true);
  u.draw(regs(0x10000));
  u.copied(copy(q, { screen: true, clear: true }), true);
  assert.equal(u.exact, false);
});

test("a palette not loaded in the stream, or a preloaded texture, makes the picture not the game's", () => {
  for (const [r, loaded, why] of [[regs(0x10000, { fmt: 9, tlut: 5 }), false, /palette/], [regs(0x10000, { fmt: 9, tlut: 5 }), true, null],
                                  [regs(0x10000, { preloaded: true }), false, /preloaded/]] as const) {
    const w = new FreshWatch();
    w.wrote(0x10000, 64 * 64 * 4);
    if (loaded) w.tlut(5);
    w.copied(copy(r, { screen: true, clear: true }), false);
    w.draw(r);
    w.copied(copy(r, { screen: true, clear: true }), true);
    assert.equal(w.exact, !why);
    if (why) assert.match(w.why, why);
  }
});
