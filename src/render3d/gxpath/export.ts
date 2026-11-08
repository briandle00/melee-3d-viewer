/* A video of a replay drawn by the game's own draw path: every frame of a stretch of rows (the whole game, or a clip) drawn offscreen as
 * fast as the graphics card allows, not in real time, encoded with the browser's own H.264 encoder (WebCodecs; the graphics card's when
 * it has one) and put in an MP4 file (mp4-muxer). Nothing leaves the browser: the file is handed back to the page, which saves it.
 *
 * The picture is the renderer's own: the game's 640 x 480 copy to the screen, the same pixels the player shows. A size of 2x or 4x
 * scales that finished picture up, each pixel made a square of 2 x 2 or 4 x 4 (nearest, nothing blended): the game is never drawn at
 * another internal resolution, so the pixels are the game's at any size. A TV (the Console view's CRT) is a display layer over the
 * finished picture, drawn at the video's size, as the page draws it at the screen's.
 *
 * One row of the tape is one frame of the video, at 60 frames a second or the console's 60000/1001 (the Speed setting).
 *
 * The sound (when the page gives it: `audio`, one block of each row's sound in the video's order - audio-export.ts captureAudio over an
 * OfflineAudioBackend, the player's own session's sound for the page's) is the MP4's audio track: each row's samples are the game's for
 * that frame of console time, played at the video's rate (resampled from rate * fps / 59.94 to 48 kHz, a 4-tap Catmull-Rom
 * interpolation: ours), encoded with the browser's AAC encoder (WebCodecs AudioEncoder; Opus when there is no AAC), its timestamps
 * from the samples written, so the sound of row i starts with frame i.
 *
 * The host does the stepping (the page's own player: GxSession on the public page, the app's engine): `seek` brings the picture of the
 * first row to the source canvas, `next` steps one row and brings its picture there.
 */
import { Muxer, StreamTarget } from "mp4-muxer";
import { Crt, CRT_LOOKS, type CrtPreset } from "../crt";
import type { PcmBlock } from "../../audio-export";

export const EXPORT_SCALES = [1, 2, 4] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

export interface ExportOptions {
  /** the rows of the tape to put in the video, both included */
  from: number;
  to: number;
  scale: ExportScale;
  /** frames a second: 60, or the console's 60000/1001 */
  fps: number;
  /** the TV the picture is shown on (off: the picture as it is) and its curve */
  tv?: { preset: CrtPreset; curve: number };
  /** where the picture of the row is after seek and next: the renderer's canvas (640 x 480) */
  source: HTMLCanvasElement | OffscreenCanvas;
  /** bring the picture of row `row` to the source; resolves when it is there */
  seek(row: number): Promise<void>;
  /** step the next row and bring its picture to the source; false when the row made no new picture (the one before is used again) */
  next(): boolean | Promise<boolean>;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
  /** bits a second (default: about BITS_PER_PIXEL a pixel at the frame rate, at most 200 Mbit/s) */
  bitrate?: number;
  /** (the checks) each encoded chunk before it goes into the file, in order */
  onChunk?(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  /** (the checks) the video frame's pixels before encoding: called with the composed canvas after each frame is drawn into it */
  onComposed?(canvas: OffscreenCanvas, frame: number): void;
  /** the sound: one block for each row, from the first, in order (pulled after the row's picture is taken) */
  audio?: AsyncIterator<PcmBlock>;
  /** (the checks) each encoded sound chunk, in order */
  onAudioChunk?(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void;
}

/** the video's sound track: 48 kHz stereo */
export const AUDIO_RATE = 48000;
/** frames a second of the console's own time (the game's sound is in it) */
export const CONSOLE_FPS = 60000 / 1001;
const AUDIO_CODECS: { codec: string; mux: "aac" | "opus"; bitrate: number }[] = [
  { codec: "mp4a.40.2", mux: "aac", bitrate: 192000 },
  { codec: "opus", mux: "opus", bitrate: 160000 },
];

/** whether this browser can encode the video's sound (WebCodecs' AudioEncoder) */
export const canExportSound = () => typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined";

async function audioEncoderConfig(): Promise<{ config: AudioEncoderConfig; mux: "aac" | "opus" } | null> {
  for (const a of AUDIO_CODECS) {
    const config: AudioEncoderConfig = { codec: a.codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: a.bitrate };
    try {
      const s = await AudioEncoder.isConfigSupported(config);
      if (s.supported) return { config: s.config ?? config, mux: a.mux };
    } catch { /* the next */ }
  }
  return null;
}

/** Interleaved 16-bit stereo at `from` Hz to two float channels at `to` Hz, a block at a time, continuing where the last left off:
 *  a 4-tap Catmull-Rom interpolation over the input's last samples, two input samples late (62.5 us at 32 kHz; ours: the game's
 *  sound is 32 kHz, a video's 48) */
export class Resampler {
  /** the last four input samples of each channel (the oldest first), and the next output sample's place among them */
  private hl = [0, 0, 0, 0];
  private hr = [0, 0, 0, 0];
  private t = 0;
  private started = false;
  constructor(private to: number) {}
  push(pcm: Int16Array, from: number): { l: Float32Array; r: Float32Array } {
    const n = pcm.length >> 1, step = from / this.to, l: number[] = [], r: number[] = [];
    for (let i = 0; i < n; i++) {
      const xl = pcm[2 * i] / 32768, xr = pcm[2 * i + 1] / 32768;
      if (!this.started) { this.hl = [xl, xl, xl, xl]; this.hr = [xr, xr, xr, xr]; this.started = true; this.t = 0; }
      this.hl.shift(); this.hl.push(xl);
      this.hr.shift(); this.hr.push(xr);
      // (output samples between the history's second and third samples: positions t in [0, 1))
      while (this.t < 1) {
        l.push(cubic(this.hl, this.t));
        r.push(cubic(this.hr, this.t));
        this.t += step;
      }
      this.t -= 1;
    }
    return { l: Float32Array.from(l), r: Float32Array.from(r) };
  }
}
function cubic(h: number[], t: number): number {
  const [p0, p1, p2, p3] = h;
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

export interface ExportResult {
  /** the MP4 (fragmented: a box of frames at a time, written as they come, so a long video never sits in one block of memory) */
  file: Blob;
  frames: number;
  /** rows that made no new picture (the picture before was used again) */
  repeated: number;
  width: number;
  height: number;
  codec: string;
  /** the encoder configured with hardware acceleration preferred */
  hardware: boolean;
  /** the bits a second asked of the encoder */
  bitrate: number;
  /** the sound track (null: none asked for) */
  audio: { codec: string; sampleRate: number; samples: number } | null;
  /** ms: reaching the first row, drawing and encoding the frames, the whole */
  ms: { seek: number; frames: number; total: number };
}

export class ExportCanceled extends Error {
  constructor() { super("the export was canceled"); this.name = "ExportCanceled"; }
}

/** the video track's timescale, ticks a second (mp4-muxer's frameRate, which must be a whole number): the frame rate when it is
 *  one (60: a frame is one tick), else the NTSC rate's numerator (the console's 60000/1001: 60000 ticks a second, each frame exactly
 *  1001 of them) */
export const timescaleOf = (fps: number) => (Number.isInteger(fps) ? fps : Math.round(fps * 1001));

/** whether this browser can make a video at all (WebCodecs' H.264 encoder) */
export const canExport = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

// H.264 profiles and levels to try, the best first: High at level 5.1 (2560 x 1920 at 60), then Main and Baseline
/** bits a pixel of the game's 640 x 480 at 60 frames a second; a scaled video gets this times the scale (its pixels are blocks of the
 *  game's: the encoder needs far fewer bits than its size alone would say) */
export const BITS_PER_PIXEL = 0.5;
/** at most this many bits a second: the graphics card's encoder made frames of a few dB when asked for 74 Mbit/s (1280 x 960) */
export const MAX_BITRATE = 50e6;
const CODECS = ["avc1.640033", "avc1.4d0033", "avc1.42e033", "avc1.640028", "avc1.4d0028", "avc1.42e028"];

async function encoderConfig(width: number, height: number, fps: number, scale: number, asked?: number): Promise<{ config: VideoEncoderConfig; hardware: boolean }> {
  // half a bit of the game's pixel at 60, times the scale, at most MAX_BITRATE: 9.2 Mbit/s at 640 x 480, 18 at 1280 x 960, 37 at 2560 x 1920
  // (measured on a public game: decoded back, 41 dB from the picture in luma at 1x, 41 at 2x with 18; a bit a pixel bought 3 dB for
  // twice the file)
  const bitrate = asked ?? Math.min(MAX_BITRATE, Math.round(640 * 480 * fps * BITS_PER_PIXEL * scale));
  for (const hw of ["prefer-hardware", "no-preference"] as const) {
    for (const codec of CODECS) {
      const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration: hw,
                                            latencyMode: "quality", avc: { format: "avc" } };
      try {
        const s = await VideoEncoder.isConfigSupported(config);
        if (s.supported) return { config: s.config ?? config, hardware: hw === "prefer-hardware" };
      } catch { /* the next */ }
    }
  }
  throw new Error(`this browser cannot encode H.264 video at ${width} x ${height}`);
}

/** the finished picture onto the video's canvas: scaled up pixel for pixel, or through the TV */
class Composer {
  readonly canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private crt: Crt | null = null;
  private tex: WebGLTexture | null = null;

  constructor(private w: number, private h: number, tv?: { preset: CrtPreset; curve: number }) {
    this.canvas = new OffscreenCanvas(w, h);
    if (tv && tv.preset !== "off") {
      const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
      if (!gl) throw new Error("this browser cannot draw the TV (WebGL 2)");
      this.gl = gl;
      this.crt = new Crt(gl, { ...CRT_LOOKS[tv.preset], curve: tv.curve });
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      this.ctx = this.canvas.getContext("2d", { alpha: false })!;
      this.ctx.imageSmoothingEnabled = false;
    }
  }

  draw(src: HTMLCanvasElement | OffscreenCanvas): void {
    if (this.ctx) { this.ctx.drawImage(src, 0, 0, 640, 480, 0, 0, this.w, this.h); return; }
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.crt!.draw(this.tex!, this.w, this.h);
  }

  dispose(): void {
    this.crt?.dispose();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function exportMp4(o: ExportOptions): Promise<ExportResult> {
  if (!canExport()) throw new Error("this browser cannot make videos (no WebCodecs)");
  if (!(o.to >= o.from)) throw new Error(`no frames from row ${o.from} to ${o.to}`);
  const t0 = performance.now();
  const width = 640 * o.scale, height = 480 * o.scale, total = o.to - o.from + 1;
  const { config, hardware } = await encoderConfig(width, height, o.fps, o.scale, o.bitrate);
  // (written in order, a fragment at a time: each piece kept as a Blob part, which the browser may keep on disk)
  const parts: Blob[] = [];
  let at = 0, outOfOrder = false;
  const target = new StreamTarget({
    onData: (data, position) => { if (position !== at) outOfOrder = true; at = position + data.length; parts.push(new Blob([data.slice() as unknown as BlobPart])); },
    chunked: true, chunkSize: 8 << 20,
  });
  // (the sound's encoder chosen first: the file says it has a sound track from its start)
  const ac = o.audio ? await audioEncoderConfig() : null;
  if (o.audio && !ac) throw new Error("this browser cannot encode the sound (no AAC or Opus encoder): make the video without it");
  const muxer = new Muxer({ target, video: { codec: "avc", width, height, frameRate: timescaleOf(o.fps) },
                            ...(ac ? { audio: { codec: ac.mux, numberOfChannels: 2, sampleRate: AUDIO_RATE } } : {}),
                            fastStart: "fragmented", minFragmentDuration: 1, firstTimestampBehavior: "offset" });
  let failed: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { o.onChunk?.(chunk, meta); muxer.addVideoChunk(chunk, meta); },
    error: (e) => { failed = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(config);
  let audioEncoder: AudioEncoder | null = null;
  if (ac) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => { o.onAudioChunk?.(chunk, meta); muxer.addAudioChunk(chunk, meta); },
      error: (e) => { failed = e instanceof Error ? e : new Error(String(e)); },
    });
    audioEncoder.configure(ac.config);
  }
  const resampler = new Resampler(AUDIO_RATE);
  let audioSamples = 0;
  /** the next row's sound, encoded */
  const sound = async () => {
    if (!o.audio || !audioEncoder) return;
    const r = await o.audio.next();
    if (r.done) throw new Error("the sound ended before the video");
    const b = r.value;
    if (b.channels !== 2) throw new Error(`the sound has ${b.channels} channels, not 2`);
    const { l, r: rr } = resampler.push(b.pcm, (b.sampleRate * o.fps) / CONSOLE_FPS);
    if (l.length === 0) return;
    const data = new Float32Array(l.length * 2);
    data.set(l, 0);
    data.set(rr, l.length);
    const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: l.length, numberOfChannels: 2,
                               timestamp: Math.round((audioSamples * 1e6) / AUDIO_RATE), data });
    audioSamples += l.length;
    audioEncoder.encode(ad);
    ad.close();
  };
  // (a TV the browser cannot draw: the encoder made above is closed, not left holding the graphics card's encoder)
  let composer: Composer;
  try { composer = new Composer(width, height, o.tv); } catch (e) { encoder.close(); audioEncoder?.close(); throw e; }
  const check = () => {
    if (failed) throw failed;
    if (o.signal?.aborted) throw new ExportCanceled();
  };
  try {
    await o.seek(o.from);
    check();
    const t1 = performance.now();
    let repeated = 0, lastYield = performance.now();
    // (a key frame every two seconds: a player can start the file anywhere near a point)
    const keyEvery = Math.round(o.fps * 2);
    for (let i = 0; i < total; i++) {
      if (i > 0 && !(await o.next())) repeated++;
      // (at 1x without a TV the picture is the frame as it is: taken from the source itself, nothing drawn between)
      const direct = o.scale === 1 && !o.tv && !o.onComposed;
      if (!direct) { composer.draw(o.source); o.onComposed?.(composer.canvas, i); }
      // one row, one frame: frame i at i / fps seconds
      const ts = Math.round((i * 1e6) / o.fps), next = Math.round(((i + 1) * 1e6) / o.fps);
      const frame = new VideoFrame(direct ? o.source : composer.canvas, { timestamp: ts, duration: next - ts });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      await sound();
      // (as fast as the encoder takes them, a few frames ahead at most; the page let in now and then)
      while (encoder.encodeQueueSize > 6) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
      if (performance.now() - lastYield > 50) {
        o.onProgress?.(i + 1, total);
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
      check();
    }
    await encoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    check();
    muxer.finalize();
    if (outOfOrder) throw new Error("the MP4 was not written in order");
    o.onProgress?.(total, total);
    const t2 = performance.now();
    return { file: new Blob(parts, { type: "video/mp4" }), frames: total, repeated, width, height, codec: config.codec, hardware, bitrate: config.bitrate ?? 0,
             audio: ac ? { codec: ac.config.codec, sampleRate: AUDIO_RATE, samples: audioSamples } : null,
             ms: { seek: t1 - t0, frames: t2 - t1, total: t2 - t0 } };
  } finally {
    if (encoder.state !== "closed") encoder.close();
    if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
    composer.dispose();
  }
}

/** save a file the browser downloads (to its own downloads folder; nothing is uploaded) */
export function saveFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** a file name from a replay's name and the stretch: "Game_1.mp4", "Game_1 frames 1200-1800.mp4" */
export function videoName(replay: string, from?: number, to?: number): string {
  const base = replay.replace(/\.slpz?$/i, "").replace(/[\\/:*?"<>|]+/g, "_") || "replay";
  return from === undefined ? `${base}.mp4` : `${base} frames ${from}-${to}.mp4`;
}
