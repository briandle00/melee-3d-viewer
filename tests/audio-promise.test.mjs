import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSource = `export class ReplayPlayer extends EventTarget {
  constructor() { super(); this.ready = false; this.speed = 1; this.audioFrame = 0; this.pending = []; globalThis.players.push(this); }
  async enableAudio() {}
  async open() { this.ready = true; }
  seek(frame, options) {
    if (this.throwSeek) throw new Error('seek failed');
    return new Promise((resolve, reject) => this.pending.push({frame, options, resolve, reject}));
  }
  async play() {}
  pause() {}
  setSpeed(speed) { this.speed = speed; }
  setMusic() {}
  destroy() { this.destroyed = true; }
}`;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('public seek promises ignore stale completion/failure and handle current failures', async () => {
  globalThis.window = new EventTarget();
  globalThis.crossOriginIsolated = true;
  globalThis.players = [];
  globalThis.__MELEE_AUDIO_CONFIG__ = { module: 'data:text/javascript,' + encodeURIComponent(moduleSource), assetsUrl: '' };
  const { sound, soundAvailable, soundState } = await import('../src/audio.ts');
  try {
    const deadline = Date.now() + 5000;
    while (!soundAvailable() && Date.now() < deadline) await flush();
    assert(soundAvailable());
    sound.load(new Blob());
    await sound.enable();
    const p = players[0];
    assert.equal('_videoEpoch' in p, false);
    assert.equal(p.pending[0].frame, -123);
    sound.seek(500);
    p.pending[0].resolve();
    await flush();
    assert.equal(sound.frame(), null);
    p.pending[1].resolve();
    await flush();
    assert.equal(sound.frame(), 123);
    sound.seek(700);
    sound.transport(false, 700, 2); // new seek intent while the old one is pending
    p.pending[2].reject(new Error('superseded'));
    await flush();
    assert.equal(soundState(), 'on');
    assert.equal(sound.frame(), null);
    p.pending[3].resolve();
    await flush();
    assert.equal(sound.frame(), 123);
    sound.seek(800);
    sound.disable();
    p.pending.at(-1).resolve();
    await flush();
    assert.equal(sound.frame(), undefined);
    assert(p.destroyed);
    await sound.enable();
    const next = players[1];
    next.pending[0].reject(new Error('failed'));
    await flush();
    assert.equal(soundState(), 'error');
    assert(next.destroyed);
    await sound.enable();
    players[2].throwSeek = true;
    sound.seek(900);
    assert.equal(soundState(), 'error');
    assert(players[2].destroyed);
  } finally {
    sound.disable();
    delete globalThis.window;
    delete globalThis.crossOriginIsolated;
    delete globalThis.players;
    delete globalThis.__MELEE_AUDIO_CONFIG__;
  }
});
