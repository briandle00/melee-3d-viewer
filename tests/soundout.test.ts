// The game's sound to the speakers (src/render3d/gxpath/soundout.ts): the AudioWorklet's queue run here on a stand-in of the
// worklet's globals - a row's samples played as they are at the device's own rate, interpolated at another, one row after the other
// with no gap or seam, silence when the queue is empty, a clear drops what is queued, and a queue too far ahead loses its oldest rows;
// and the rate a row is played at for the player's pace and speed.
//
//   deno test -A --no-check --sloppy-imports tests/soundout.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_FPS, deinterleave, stepFor, WORKLET } from "../src/render3d/gxpath/soundout.ts";

type Proc = { port: { onmessage: (e: { data: unknown }) => void }; process(i: unknown[], o: Float32Array[][]): boolean };

/** the worklet's processor, made with the stand-in globals (a device at `rate`) */
function processor(rate = 48000): Proc {
  let Made: (new () => Proc) | null = null;
  class AudioWorkletProcessor { port = { onmessage: (_: { data: unknown }) => {} }; }
  const register = (_name: string, c: new () => Proc) => { Made = c; };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", WORKLET)(AudioWorkletProcessor, register, rate);
  return new Made!();
}
const send = (p: Proc, data: unknown) => p.port.onmessage({ data });
const pull = (p: Proc, n: number) => { const L = new Float32Array(n), R = new Float32Array(n); p.process([], [[L, R]]); return { L, R }; };
const chunk = (l: number[], r: number[], step = 1, max = 10) => ({ l: Float32Array.from(l), r: Float32Array.from(r), step, max });

test("a row's samples at the device's own rate are played as they are, the rows one after the other, then silence", () => {
  const p = processor();
  send(p, chunk([0.1, 0.2, 0.3], [-0.1, -0.2, -0.3]));
  send(p, chunk([0.4, 0.5], [-0.4, -0.5]));
  const { L, R } = pull(p, 7);
  assert.deepEqual(Array.from(L).map((x) => +x.toFixed(4)), [0.1, 0.2, 0.3, 0.4, 0.5, 0, 0]);
  assert.deepEqual(Array.from(R).map((x) => +x.toFixed(4)), [-0.1, -0.2, -0.3, -0.4, -0.5, 0, 0]);
});

test("at half the device's rate each sample is followed by the point halfway to the next, across the rows' seam", () => {
  const p = processor();
  send(p, chunk([0, 1], [0, 1], 0.5));
  send(p, chunk([3], [3], 0.5));
  const { L } = pull(p, 5);
  assert.deepEqual(Array.from(L), [0, 0.5, 1, 2, 3]);
});

test("a clear drops what is queued; a queue too far ahead of the device loses its oldest rows", () => {
  const p = processor(10);
  send(p, chunk([1, 1, 1], [1, 1, 1]));
  send(p, { clear: true });
  assert.deepEqual(Array.from(pull(p, 2).L), [0, 0]);
  // (at most 0.5 s at 10 samples a second: 5 samples; of three rows of 3 the oldest go until 5 or fewer are queued: the last one)
  for (const v of [1, 2, 3]) send(p, chunk([v, v, v], [v, v, v], 1, 0.5));
  assert.deepEqual(Array.from(pull(p, 5).L), [3, 3, 3, 0, 0]);
  // (two rows that fit stay)
  for (const v of [4, 5]) send(p, chunk([v, v], [v, v], 1, 0.5));
  assert.deepEqual(Array.from(pull(p, 5).L), [4, 4, 5, 5, 0]);
});

test("the samples a row is played at: the game's 32 kHz in console time, at the player's pace and speed", () => {
  assert.equal(stepFor(CONSOLE_FPS, 1, 32000), 1);
  assert.ok(Math.abs(stepFor(60, 1, 48000) - (32000 * 60 / CONSOLE_FPS) / 48000) < 1e-12);
  assert.equal(stepFor(CONSOLE_FPS, 0.5, 32000), 0.5);
  const { l, r } = deinterleave(Int16Array.from([32767, -32768, 0, 16384]));
  assert.deepEqual([...l], [32767 / 32768, 0]);
  assert.deepEqual([...r], [-1, 0.5]);
});
