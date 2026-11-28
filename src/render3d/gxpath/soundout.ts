/* The game's sound to the speakers: each row's sound (the simulator's sound core, 32 kHz stereo: core.ts soundPcm) queued as the
 * player steps it, and played by an AudioWorklet at the device's rate.
 *
 * The sound follows the picture: a row's sound is queued when the row is drawn, and plays from the end of what is queued, so it is heard
 * a little after the picture (the queue is kept short: more than MAX_QUEUE seconds queued and the oldest is dropped; an empty queue
 * plays silence until the next row). A seek, a pause or a step clears it. The rows are played at the player's pace and speed, so the
 * sound is resampled from 32000 * pace / 59.94 * speed (the game's sound is in console time, 60000/1001 frames a second) to the
 * device's rate by linear interpolation (ours: rate conversion of the console's own output).
 *
 * The volume is one gain after the worklet (setVolume: a slider's level from 0 to 1, heard as level squared so equal moves of a slider
 * sound like equal steps). It touches only what the speakers play: a video's sound is the session's own samples (exportsound.ts).
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

/** a volume slider's level (0 to 1) as a gain: squared (halfway is -12 dB), so the slider's moves sound even; a linear gain does
 *  little over the slider's top half */
export const volumeGain = (level: number) => {
  const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
  return v * v;
};
/** seconds a change of volume takes to settle (no click from a sudden step) */
const VOLUME_GLIDE = 0.015;
/** milliseconds after which a start still under way counts as one that waits for good (see start) */
export const STUCK_MS = 1500;

export class SoundOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private starting: Promise<boolean> | null = null;
  /** the start under way: when it began, and its context (closed if the start is let go) */
  private startedAt = 0;
  private pending: AudioContext | null = null;
  private tries = 0;
  private level = 1;
  /** the rows' rate (frames a second) and speed the sound is played at */
  fps = 60;
  speed = 1;

  get on(): boolean { return this.node !== null; }

  /** the volume slider's level, 0 to 1 */
  get volume(): number { return this.level; }
  /** the gain the speakers play at now (null while off) */
  get gainNow(): number | null { return this.gain ? this.gain.gain.value : null; }

  /** the volume: a slider's level from 0 to 1, kept for the next start while off */
  setVolume(level: number): void {
    this.level = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(volumeGain(this.level), this.ctx.currentTime, VOLUME_GLIDE);
  }

  /** Start the output (from a click: browsers start audio only then). False when this browser cannot.
   *  A start asked before the page had any press (a page loaded again with the sound left on) waits for good: the browser holds the
   *  page's audio until a press. A start asked while such a start has waited past STUCK_MS lets it go (its context closed) and starts
   *  again, so the next press is heard; before, every later start returned the one that waited, and the sound stayed silent. */
  start(): Promise<boolean> {
    if (this.node) return Promise.resolve(true);
    if (this.starting && performance.now() - this.startedAt <= STUCK_MS) return this.starting;
    if (this.starting) { const old = this.pending; this.pending = null; void old?.close().catch(() => {}); }
    const me = ++this.tries;
    this.startedAt = performance.now();
    const p = (async () => {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext({ latencyHint: "interactive" });
        this.pending = ctx;
        // (resumed in the click itself, before any await: the browser lets the context run)
        const resumed = ctx.resume();
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        await resumed;
        if (me !== this.tries) { void ctx.close().catch(() => {}); return this.starting ?? Promise.resolve(this.node !== null); }
        const node = new AudioWorkletNode(ctx, "melee-sound", { numberOfInputs: 0, outputChannelCount: [2] });
        const gain = new GainNode(ctx, { gain: volumeGain(this.level) });
        node.connect(gain).connect(ctx.destination);
        this.ctx = ctx;
        this.node = node;
        this.gain = gain;
        return true;
      } catch (e) {
        // (a start let go for a newer one: its answer is the newer start's)
        if (me !== this.tries) return this.starting ?? Promise.resolve(this.node !== null);
        console.warn("gx: the sound could not start", e);
        return false;
      } finally {
        if (me === this.tries) { this.starting = null; this.pending = null; }
      }
    })();
    this.starting = p;
    return p;
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
    this.gain?.disconnect();
    void this.ctx?.close();
    this.node = null;
    this.gain = null;
    this.ctx = null;
  }
}
