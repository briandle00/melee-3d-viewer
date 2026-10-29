import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayPlayer } from '../public/audio-example/tone-player.mjs';

test('diagnostic backend uses the audio clock and releases its resources', async () => {
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: { value: 0 }, start() {}, stop() {}, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  };
  try {
    const p = new ReplayPlayer();
    await Promise.all([p.enableAudio(), p.open(new Blob())]);
    await p.seek(0, { resume: true });
    p.context.currentTime = 1;
    assert.equal(p.audioFrame, 60);
    p.setSpeed(2);
    p.context.currentTime = 2;
    assert.equal(p.audioFrame, 180);
    p.pause();
    p.context.currentTime = 3;
    assert.equal(p.audioFrame, 180);
    await p.seek(20, { resume: false });
    assert.equal(p.audioFrame, 20);
    await p.play();
    p.setMusic(false);
    assert.equal(p.gain.gain.value, 0);
    await p.destroy();
    await p.destroy();
    assert(p.context.closed);
    assert.equal(p.audioFrame, null);
    await assert.rejects(p.enableAudio(), /closed/);
  } finally { globalThis.AudioContext = saved; }
});
