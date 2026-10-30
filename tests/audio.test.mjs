// src/audio.ts against a fake host player: transport, seeks acknowledged by
// epoch (a stale one is ignored), music, teardown, and turning sound off
// while it is still starting.
//
// Run with Deno from the repository root, after `deno install --allow-scripts`
// (solid-js comes from node_modules):
//
//   deno test --no-check --sloppy-imports tests/
//
// Deno runs node:test tests as its own and loads src/audio.ts as TypeScript.
// --no-check: the repository's types are set up for Vite and the browser
// (tsconfig.json), not for Deno's type checker.

import test from "node:test";
import assert from "node:assert/strict";

// a fake host player: records what it is asked, and acknowledges seeks when told
const fakePlayer = `export class ReplayPlayer extends EventTarget {
  constructor(options) {
    super();
    this.options = options;
    this.speed = 1;
    this.ready = false;
    this._videoEpoch = 0;
    this.seeks = [];
    globalThis.__audioPlayers.push(this);
  }
  async enableAudio() {
    this.unlocked = true;
  }
  async open() {
    if (globalThis.__audioOpenGate) await globalThis.__audioOpenGate;
    this.ready = true;
  }
  seek(frame, options) {
    this._videoEpoch++;
    this.seeks.push({ frame, ...options });
  }
  async play() {
    this.plays = (this.plays ?? 0) + 1;
  }
  pause() {
    this.pauses = (this.pauses ?? 0) + 1;
  }
  setSpeed(speed) {
    this.speed = speed;
  }
  setMusic(music) {
    this.music = music;
  }
  destroy() {
    this.destroyed = true;
    this.ready = false;
  }
  ack(epoch = this._videoEpoch) {
    this.dispatchEvent(
      new CustomEvent("position", { detail: { videoEpoch: epoch, seeking: false } })
    );
  }
}`;

test("optional audio follows acknowledged seeks, pauses, speed, music and teardown", async () => {
  // what a browser page has, and the host page's configuration
  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = new EventTarget();
  globalThis.crossOriginIsolated = true;
  globalThis.__audioPlayers = [];
  globalThis.__MELEE_AUDIO_CONFIG__ = {
    module: "data:text/javascript," + encodeURIComponent(fakePlayer),
    assetsUrl: "/test-assets",
  };
  try {
    // (imported here, after the configuration above: audio.ts reads it as it loads)
    const { sound, soundAvailable, soundState } = await import("../src/audio.ts");

    // the host's module loads in the background
    for (let i = 0; i < 20 && !soundAvailable(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert(soundAvailable());
    assert.equal(sound.frame(), undefined);

    // sound on, playing from viewer frame 123 (game frame 0)
    sound.load(new Blob(["test"]));
    sound.seek(123);
    sound.transport(true, 123, 1);
    await sound.enable();
    const p = globalThis.__audioPlayers[0];
    assert.equal(p.options.audioOnly, true);
    assert(p.unlocked);
    assert.deepEqual(p.seeks.at(-1), { frame: 0, resume: true });

    // the picture holds until the seek is acknowledged, then follows the sound
    assert.equal(sound.frame(), null);
    p.audioFrame = 12.8;
    p.ack();
    assert.equal(sound.frame(), 135);

    // an older seek's acknowledgment does not end the latest seek
    sound.seek(1000);
    const old = p._videoEpoch;
    sound.seek(500);
    p.ack(old);
    assert.equal(sound.frame(), null);
    p.ack();
    p.audioFrame = 377;
    assert.equal(sound.frame(), 500);

    // pause, then play at double speed
    // (sent as they are, with no seek)
    const seeksBeforePause = p.seeks.length;
    sound.transport(false, 500, 1);
    assert.equal(p.pauses, 1);
    assert.equal(p.seeks.length, seeksBeforePause);
    sound.transport(true, 500, 2);
    assert.equal(p.speed, 2);
    assert.equal(p.plays, 1);
    assert.equal(p.seeks.length, seeksBeforePause);

    sound.music(false);
    assert.equal(p.music, false);

    // sound off: the host player is destroyed and the viewer's clock is back
    sound.disable();
    assert(p.destroyed);
    assert.equal(sound.frame(), undefined);
    assert.equal(soundState(), "off");

    // a late startup completion cannot resurrect sound after cancellation
    let finish;
    globalThis.__audioOpenGate = new Promise((resolve) => (finish = resolve));
    const opening = sound.enable();
    sound.disable();
    finish();
    await opening;
    assert(globalThis.__audioPlayers[1].destroyed);
    assert.equal(globalThis.__audioPlayers[1].seeks.length, 0);
    assert.equal(soundState(), "off");
  } finally {
    delete globalThis.__MELEE_AUDIO_CONFIG__;
    delete globalThis.__audioPlayers;
    delete globalThis.__audioOpenGate;
    delete globalThis.crossOriginIsolated;
    if (!hadWindow) delete globalThis.window;
  }
});
