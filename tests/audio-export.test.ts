import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAudio } from '../src/audio-export.ts';

function fixture() {
  const calls: number[] = [];
  let destroyed = 0;
  const backend = {
    sampleRate: 32000, channels: 2,
    async prepare(frame: number) { calls.push(frame); },
    async capture(gameFrame: number) {
      calls.push(gameFrame);
      // Variable blocks avoid rounding each game frame to a fixed sample count.
      return { gameFrame, pcm: new Int16Array((gameFrame === 11 ? 534 : 533) * 2) };
    },
    async destroy() { destroyed++; },
  };
  return { backend, calls, get destroyed() { return destroyed; } };
}

test('offline audio is sequential, sample-timestamped, pull-driven and cleaned up', async () => {
  const f = fixture(), stream = captureAudio(async () => f.backend, 10, 12);
  assert.deepEqual(f.calls, []);
  const first = await stream.next();
  assert.deepEqual(f.calls, [9, 10]);
  assert.equal(first.value.timestamp, 0);
  const rest = [];
  for await (const block of stream) rest.push(block);
  assert.deepEqual(f.calls, [9, 10, 11, 12]);
  assert.equal(rest[0].timestamp, 16656);
  assert.equal(rest[1].timestamp + rest[1].duration, 50000);
  assert.equal(f.destroyed, 1);
});

test('consumer early return and capture errors release the backend', async () => {
  const f = fixture();
  for await (const _ of captureAudio(async () => f.backend, 10, 12)) break;
  assert.equal(f.destroyed, 1);
  const g = fixture();
  g.backend.capture = async () => { throw new Error('capture failed'); };
  await assert.rejects(async () => { for await (const _ of captureAudio(async () => g.backend, 10, 12)) {} }, /capture failed/);
  assert.equal(g.destroyed, 1);
});

test('aborting during capture discards the result and releases the backend', async () => {
  const f = fixture(), controller = new AbortController();
  f.backend.capture = async gameFrame => { controller.abort(); return { gameFrame, pcm: new Int16Array(2) }; };
  await assert.rejects(async () => { for await (const _ of captureAudio(async () => f.backend, 10, 12, controller.signal)) {} }, { name: 'AbortError' });
  assert.equal(f.destroyed, 1);
});

test('invalid PCM and mismatched frames are rejected before encoding', async () => {
  for (const result of [{ gameFrame: 11, pcm: new Int16Array(2) }, { gameFrame: 10, pcm: new Int16Array(1) }]) {
    const f = fixture();
    f.backend.capture = async () => result;
    await assert.rejects(async () => { for await (const _ of captureAudio(async () => f.backend, 10, 10)) {} }, /invalid frame or PCM/);
    assert.equal(f.destroyed, 1);
  }
});
