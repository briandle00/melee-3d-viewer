// Diagnostic tone only: no game decoding, game sounds, assets, workers or network.
// This implements the public seek-promise contract in src/audio-backend.ts.
export class ReplayPlayer extends EventTarget {
  constructor({ music = true } = {}) {
    super();
    this.ready = false;
    this.speed = 1;
    this.music = music;
    this.at = -123;
    this.since = 0;
    this.playing = false;
    this.closed = false;
  }
  enableAudio() {
    if (this.closed) return Promise.reject(new Error("Audio backend is closed"));
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.context.destination);
      this.oscillator = this.context.createOscillator();
      this.oscillator.frequency.value = 220;
      this.oscillator.connect(this.gain);
      this.oscillator.start();
    }
    // Call resume before any await, inside the Sound button gesture.
    return this.context.resume();
  }
  async open(_gameData) {
    if (this.closed) throw new Error("Audio backend is closed");
    this.ready = true; // A real backend decodes the Blob here.
  }
  get audioFrame() {
    if (!this.ready || !this.context) return null;
    return this.at + (this.playing ? (this.context.currentTime - this.since) * 60 * this.speed : 0);
  }
  pause() {
    this.at = this.audioFrame ?? this.at;
    this.playing = false;
    if (this.gain) this.gain.gain.value = 0;
  }
  async play() {
    if (this.closed || !this.ready || !this.context) throw new Error("Audio backend is not ready");
    this.pause();
    this.since = this.context.currentTime;
    this.playing = true;
    this.gain.gain.value = this.music ? 0.02 : 0;
  }
  async seek(gameFrame, { resume }) {
    this.pause(); // Clear old audio synchronously, before returning the promise.
    this.at = gameFrame;
    // Change pitch each game second so seeks are audible. This is not game audio.
    if (this.oscillator) this.oscillator.frequency.value = 220 + ((Math.floor((gameFrame + 123) / 60) % 12 + 12) % 12) * 20;
    if (resume) await this.play();
  }
  setSpeed(rate) {
    this.at = this.audioFrame ?? this.at;
    this.since = this.context?.currentTime ?? 0;
    this.speed = rate;
  }
  setMusic(on) {
    this.music = on;
    if (this.gain) this.gain.gain.value = this.playing && on ? 0.02 : 0;
  }
  setPlayback(_mode) { /* No simulation in this diagnostic backend. */ }
  async destroy() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.ready = false;
    this.oscillator?.stop();
    this.oscillator?.disconnect();
    this.gain?.disconnect();
    await this.context?.close();
  }
}
