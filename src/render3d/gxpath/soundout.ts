/* The game's sound to the speakers: each row's sound (the simulator's sound core, 32 kHz stereo: core.ts soundPcm) queued as the
 * player steps it, and played by an AudioWorklet at the device's rate.
 *
 * The sound follows the picture: a row's sound is queued when the row is drawn, and plays from the end of what is queued, so it is heard
 * a little after the picture (the queue is kept short: more than MAX_QUEUE seconds queued and the oldest is dropped; an empty queue
 * plays silence until the next row). A seek, a pause or a step clears it. The rows are played at the player's pace and speed, so the
 * sound is resampled from 32000 * pace / 59.94 * speed (the game's sound is in console time, 60000/1001 frames a second) to the
 * device's rate by linear interpolation (ours: rate conversion of the console's own output).
 */
import { SOUND_RATE } from "./core";

/** frames a second of the game's own time (the sound's) */
export const CONSOLE_FPS = 60000 / 1001;
/** at most this many seconds of sound queued ahead of the device */
export const MAX_QUEUE = 0.15;

/** the worklet's code (an inline module): a queue of chunks, each played at its own step (input samples per output sample) */
export const WORKLET = `
class MeleeSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.pos = 0; this.queued = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.clear) { this.q = []; this.pos = 0; this.queued = 0; }
      if (m.l) { this.q.push(m); this.queued += m.l.length / m.step; }
      // (too far ahead of the device: the oldest dropped, the picture is ahead)
      while (this.q.length > 1 && this.queued > m.max * sampleRate) { const c = this.q.shift(); this.queued -= (c.l.length - this.pos) / c.step; this.pos = 0; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      while (this.q.length && this.pos >= this.q[0].l.length) { this.pos -= this.q[0].l.length; this.q.shift(); }
      if (!this.q.length) { L[i] = 0; R[i] = 0; continue; }
      const c = this.q[0], k = Math.floor(this.pos), f = this.pos - k;
      const n = k + 1 < c.l.length ? c : this.q[1];
      const nk = k + 1 < c.l.length ? k + 1 : 0;
      const l1 = n ? n.l[nk] : c.l[k], r1 = n ? n.r[nk] : c.r[k];
      L[i] = c.l[k] + (l1 - c.l[k]) * f;
      R[i] = c.r[k] + (r1 - c.r[k]) * f;
      this.pos += c.step;
      this.queued -= 1;
    }
    if (this.queued < 0) this.queued = 0;
    return true;
  }
}
registerProcessor("melee-sound", MeleeSound);
`;

/** interleaved 16-bit stereo to two float channels */
export function deinterleave(pcm: Int16Array): { l: Float32Array; r: Float32Array } {
  const n = pcm.length >> 1, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = pcm[2 * i] / 32768; r[i] = pcm[2 * i + 1] / 32768; }
  return { l, r };
}

/** input samples per output sample: the sound played at `fps` rows a second and `speed`, on a device at `deviceRate` */
export const stepFor = (fps: number, speed: number, deviceRate: number) => (SOUND_RATE * (fps / CONSOLE_FPS) * speed) / deviceRate;

export class SoundOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<boolean> | null = null;
  /** the rows' rate (frames a second) and speed the sound is played at */
  fps = 60;
  speed = 1;

  get on(): boolean { return this.node !== null; }

  /** Start the output (from a click: browsers start audio only then). False when this browser cannot. */
  start(): Promise<boolean> {
    if (this.node) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const ctx = new AudioContext({ latencyHint: "interactive" });
        // (resumed in the click itself, before any await: the browser lets the context run)
        const resumed = ctx.resume();
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        await resumed;
        const node = new AudioWorkletNode(ctx, "melee-sound", { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(ctx.destination);
        this.ctx = ctx;
        this.node = node;
        return true;
      } catch (e) {
        console.warn("gx: the sound could not start", e);
        return false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** a row's sound to play next */
  push(pcm: Int16Array): void {
    if (!this.node || !this.ctx || pcm.length === 0) return;
    const { l, r } = deinterleave(pcm);
    this.node.port.postMessage({ l, r, step: stepFor(this.fps, this.speed, this.ctx.sampleRate), max: MAX_QUEUE }, [l.buffer, r.buffer]);
  }

  /** what is queued dropped (a seek, a pause, a step) */
  clear(): void { this.node?.port.postMessage({ clear: true }); }

  stop(): void {
    this.node?.disconnect();
    void this.ctx?.close();
    this.node = null;
    this.ctx = null;
  }
}
