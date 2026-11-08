// Export Video (src/render3d/gxpath/export.ts) without a browser: WebCodecs and OffscreenCanvas are stand-ins that record
// what they are asked, mp4-muxer is the real one. One tape row is one video frame at i / fps seconds, the durations add up
// to the stretch exactly, a key frame every two seconds; 1x without a TV hands the renderer's canvas itself to the encoder,
// 2x and 4x draw it scaled pixel for pixel; the bitrate, the H.264 profile and the hardware choice; and every way it can
// fail says why and leaves no encoder open. (The real encoder's output is checked in a browser: exportcheck.ts.)
//
//   deno test -A --no-check --sloppy-imports tests/gxpath-export.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { AUDIO_RATE, BITS_PER_PIXEL, CONSOLE_FPS, ExportCanceled, MAX_BITRATE, Resampler, exportMp4, timescaleOf, videoName, type ExportOptions } from "../src/render3d/gxpath/export.ts";
import { SessionSound } from "../src/render3d/gxpath/exportsound.ts";
import { mp4Samples } from "../src/render3d/gxpath/exportcheck.ts";

type Config = { codec: string; width: number; height: number; bitrate: number; framerate: number; hardwareAcceleration: string };

/** what the stand-ins saw */
interface Seen {
  configs: Config[];
  frames: { source: unknown; timestamp: number; duration: number; keyFrame: boolean }[];
  encoders: FakeEncoder[];
  draws: unknown[][];
  canvases: { w: number; h: number; smoothing?: boolean }[];
}
let seen: Seen;
/** what the sound's stand-ins saw: the configuration, and each block of samples (frames, the timestamp, the left channel's first value) */
let heard: { configs: { codec: string; sampleRate: number; numberOfChannels: number }[]; data: { frames: number; timestamp: number; first: number }[]; closed: boolean };
/** the audio codecs the stand-in browser encodes */
let audioCodecs = ["mp4a.40.2", "opus"];

class FakeAudioData {
  closed = false;
  constructor(readonly o: { format: string; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array }) {}
  close() { this.closed = true; }
}
class FakeAudioEncoder {
  state = "unconfigured";
  private n = 0;
  constructor(private init: { output: (c: FakeChunk, meta?: unknown) => void; error: (e: unknown) => void }) {}
  static isConfigSupported(c: { codec: string }) { return Promise.resolve({ supported: audioCodecs.includes(c.codec), config: c }); }
  configure(c: { codec: string; sampleRate: number; numberOfChannels: number }) { this.state = "configured"; heard.configs.push(c); }
  encode(d: FakeAudioData) {
    if (d.closed) throw new Error("closed sound data was encoded");
    heard.data.push({ frames: d.o.numberOfFrames, timestamp: d.o.timestamp, first: d.o.data[0] });
    // (an AAC packet a block, its duration the block's)
    // (the decoder's description: AAC's AudioSpecificConfig, Opus's 19-byte OpusHead)
    const codec = heard.configs.at(-1)!.codec;
    const description = codec === "opus" ? new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]) : new Uint8Array([0x11, 0x90]);
    const meta = this.n++ === 0 ? { decoderConfig: { codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, description } } : undefined;
    this.init.output(new FakeChunk("key", d.o.timestamp, Math.round((d.o.numberOfFrames * 1e6) / AUDIO_RATE), new Uint8Array([9, 9])), meta);
  }
  flush() { return Promise.resolve(); }
  close() { this.state = "closed"; heard.closed = true; }
}
/** which configurations the stand-in browser takes (default: every one) */
let supports: (c: Config) => boolean = () => true;
/** the encoder fails on this frame (an error callback, as WebCodecs does) */
let failOn: number | null = null;

class FakeChunk {
  constructor(readonly type: "key" | "delta", readonly timestamp: number, readonly duration: number, private bytes: Uint8Array) {}
  get byteLength() { return this.bytes.length; }
  copyTo(to: Uint8Array) { to.set(this.bytes); }
}

class FakeEncoder {
  state = "unconfigured";
  encodeQueueSize = 0;
  private n = 0;
  constructor(private init: { output: (c: FakeChunk, meta?: unknown) => void; error: (e: unknown) => void }) { seen.encoders.push(this); }
  static isConfigSupported(c: Config) { return Promise.resolve({ supported: supports(c), config: c }); }
  configure(c: Config) { this.state = "configured"; seen.configs.push(c); }
  encode(f: FakeFrame, o: { keyFrame: boolean }) {
    if (f.closed) throw new Error("a closed frame was encoded");
    seen.frames.push({ source: f.source, timestamp: f.timestamp, duration: f.duration, keyFrame: o.keyFrame });
    if (failOn === this.n++) { this.init.error(new Error("the encoder broke")); return; }
    // (WebCodecs hands the decoder's configuration with the first chunk)
    const meta = this.n === 1 ? { decoderConfig: { codec: seen.configs.at(-1)!.codec, description: new Uint8Array([1, 0x64, 0, 0x33, 0xff, 0xe0, 0]) } } : undefined;
    this.init.output(new FakeChunk(o.keyFrame ? "key" : "delta", f.timestamp, f.duration, new Uint8Array([1, 2, 3, 4])), meta);
  }
  flush() { return Promise.resolve(); }
  close() { this.state = "closed"; }
  addEventListener() {}
}

class FakeFrame {
  closed = false;
  readonly timestamp: number;
  readonly duration: number;
  constructor(readonly source: unknown, o: { timestamp: number; duration: number }) { this.timestamp = o.timestamp; this.duration = o.duration; }
  close() { this.closed = true; }
}

class FakeCanvas {
  constructor(readonly width: number, readonly height: number) {}
  getContext(kind: string) {
    if (kind !== "2d") return null; // (no WebGL 2 here)
    const c = { w: this.width, h: this.height } as Seen["canvases"][number];
    seen.canvases.push(c);
    return {
      set imageSmoothingEnabled(v: boolean) { c.smoothing = v; },
      drawImage: (...a: unknown[]) => { seen.draws.push([this, ...a]); },
    };
  }
}

const g = globalThis as Record<string, unknown>;
function withBrowser(on = true) {
  seen = { configs: [], frames: [], encoders: [], draws: [], canvases: [] };
  supports = () => true;
  failOn = null;
  heard = { configs: [], data: [], closed: false };
  audioCodecs = ["mp4a.40.2", "opus"];
  for (const [k, v] of Object.entries({ VideoEncoder: FakeEncoder, VideoFrame: FakeFrame, EncodedVideoChunk: FakeChunk, OffscreenCanvas: FakeCanvas,
                                         AudioEncoder: FakeAudioEncoder, AudioData: FakeAudioData, EncodedAudioChunk: FakeChunk })) {
    if (on) g[k] = v; else delete g[k];
  }
}

/** an export of rows from..to; `same` lists the rows whose picture did not change (next() says false) */
function options(o: Partial<ExportOptions> & { same?: number[] } = {}) {
  const calls = { seek: [] as number[], next: 0, progress: [] as [number, number][] };
  const source = { name: "the renderer's canvas" };
  let row = 0;
  const opts: ExportOptions = {
    from: 0, to: 9, scale: 1, fps: 60, source: source as unknown as OffscreenCanvas,
    seek: (r) => { calls.seek.push(r); row = r; return Promise.resolve(); },
    next: () => { calls.next++; row++; return !(o.same ?? []).includes(row); },
    onProgress: (d, t) => calls.progress.push([d, t]),
    ...o,
  };
  return { opts, calls, source };
}

test("a video file name from the replay's and the stretch's", () => {
  assert.equal(videoName("Game_20260101T120000.slp"), "Game_20260101T120000.mp4");
  assert.equal(videoName("game.SLPZ"), "game.mp4");
  assert.equal(videoName("a/b:c*d?.slp", 1200, 1800), "a_b_c_d_ frames 1200-1800.mp4");
  assert.equal(videoName(".slp"), "replay.mp4");
});

test("one row, one frame: at i / fps seconds, durations adding up to the stretch, a key frame every two seconds", async () => {
  withBrowser();
  const fps = 60;
  const { opts, calls, source } = options({ from: 100, to: 399, fps, same: [150, 151] });
  const r = await exportMp4(opts);
  const n = 300;
  assert.equal(r.frames, n);
  assert.deepEqual(calls.seek, [100]);
  assert.equal(calls.next, n - 1);
  assert.equal(r.repeated, 2);
  assert.equal(seen.frames.length, n);
  let total = 0;
  seen.frames.forEach((f, i) => {
    assert.equal(f.timestamp, Math.round((i * 1e6) / fps), `frame ${i}'s time`);
    assert.equal(f.source, source, "1x without a TV: the renderer's canvas itself");
    assert.equal(f.keyFrame, i % 120 === 0, `frame ${i}'s key`);
    total += f.duration;
  });
  assert.equal(total, Math.round((n * 1e6) / fps));
  assert.deepEqual(calls.progress.at(-1), [n, n]);
  assert.equal(r.file.type, "video/mp4");
  assert.ok(r.file.size > n * 4, `${r.file.size} bytes`);
  const head = new Uint8Array(await r.file.slice(0, 8).arrayBuffer());
  assert.equal(new TextDecoder().decode(head.subarray(4, 8)), "ftyp");
  assert.deepEqual([r.width, r.height], [640, 480]);
  assert.equal(seen.encoders[0].state, "closed");
});

test("the console's 60000/1001 (Speed: Console): the file's clock is 60000 ticks a second and every frame is 1001 of them", async () => {
  assert.equal(timescaleOf(60), 60);
  assert.equal(timescaleOf(60000 / 1001), 60000);
  for (const [fps, ticks, each] of [[60000 / 1001, 60000, 1001], [60, 60, 1]] as const) {
    withBrowser();
    const r = await exportMp4(options({ from: 0, to: 299, fps }).opts);
    const m = mp4Samples(new Uint8Array(await r.file.arrayBuffer()));
    assert.equal(m.timescale, ticks, `${fps}: timescale`);
    assert.equal(m.samples, 300, `${fps}: samples`);
    assert.deepEqual([...new Set(m.durations)], [each], `${fps}: durations`);
    // (and the bitrate at that rate)
    assert.equal(r.bitrate, Math.round(640 * 480 * fps * BITS_PER_PIXEL));
  }
});

test("2x and 4x: the picture drawn scaled pixel for pixel (no smoothing) at 1280 x 960 and 2560 x 1920", async () => {
  for (const scale of [2, 4] as const) {
    withBrowser();
    const { opts, source } = options({ scale, to: 2 });
    const r = await exportMp4(opts);
    assert.deepEqual([r.width, r.height], [640 * scale, 480 * scale]);
    assert.deepEqual(seen.canvases, [{ w: 640 * scale, h: 480 * scale, smoothing: false }]);
    assert.equal(seen.draws.length, 3);
    for (const d of seen.draws) assert.deepEqual(d.slice(1), [source, 0, 0, 640, 480, 0, 0, 640 * scale, 480 * scale]);
    // (the frames are of the scaled canvas, not the renderer's)
    for (const f of seen.frames) assert.equal(f.source, seen.draws[0][0]);
  }
});

test("the bitrate: half a bit a game pixel a frame, times the scale, at most MAX_BITRATE; one asked for is used", async () => {
  for (const [scale, fps] of [[1, 60], [2, 60], [4, 60]] as const) {
    withBrowser();
    const r = await exportMp4(options({ scale, fps, to: 0 }).opts);
    assert.equal(r.bitrate, Math.min(MAX_BITRATE, Math.round(640 * 480 * fps * BITS_PER_PIXEL * scale)));
  }
  assert.equal(BITS_PER_PIXEL, 0.5);
  withBrowser();
  assert.equal((await exportMp4(options({ to: 0, bitrate: 1234567 }).opts)).bitrate, 1234567);
});

test("the encoder: High profile on the graphics card first, then the next the browser takes", async () => {
  withBrowser();
  let r = await exportMp4(options({ to: 0 }).opts);
  assert.deepEqual([r.codec, r.hardware], ["avc1.640033", true]);
  withBrowser();
  supports = (c) => c.hardwareAcceleration === "no-preference" && c.codec === "avc1.42e028";
  r = await exportMp4(options({ to: 0 }).opts);
  assert.deepEqual([r.codec, r.hardware], ["avc1.42e028", false]);
  assert.deepEqual(seen.configs.map((c) => [c.codec, c.width, c.height]), [["avc1.42e028", 640, 480]]);
});

test("a browser without WebCodecs is told so, and the replay is not touched", async () => {
  withBrowser(false);
  const { opts, calls } = options();
  await assert.rejects(exportMp4(opts), /cannot make videos/);
  assert.deepEqual(calls.seek, []);
});

test("no H.264 encoder at the size: says the size", async () => {
  withBrowser();
  supports = () => false;
  await assert.rejects(exportMp4(options({ scale: 4 }).opts), /cannot encode H\.264 video at 2560 x 1920/);
});

test("a stretch that ends before it starts is refused", async () => {
  withBrowser();
  await assert.rejects(exportMp4(options({ from: 10, to: 5 }).opts), /no frames from row 10 to 5/);
  assert.equal(seen.encoders.length, 0);
});

test("canceled: an ExportCanceled, and the encoder is closed", async () => {
  withBrowser();
  const stop = new AbortController();
  const { opts } = options({ to: 50, signal: stop.signal, next: () => { if (seen.frames.length === 5) stop.abort(); return true; } });
  await assert.rejects(exportMp4(opts), ExportCanceled);
  assert.ok(seen.frames.length <= 7, `${seen.frames.length} frames after the cancel`);
  assert.equal(seen.encoders[0].state, "closed");
});

test("the encoder's own error ends the export with it, the encoder closed", async () => {
  withBrowser();
  failOn = 3;
  await assert.rejects(exportMp4(options({ to: 20 }).opts), /the encoder broke/);
  assert.equal(seen.encoders[0].state, "closed");
});

test("a TV without WebGL 2 says the TV cannot be drawn, and the encoder is closed", async () => {
  withBrowser();
  const { opts, calls } = options({ tv: { preset: "trinitron", curve: 0 } });
  await assert.rejects(exportMp4(opts), /cannot draw the TV \(WebGL 2\)/);
  assert.deepEqual(calls.seek, []);
  assert.equal(seen.encoders[0].state, "closed");
});

// ---- the sound (export.ts audio: one block a row, audio-export.ts captureAudio over an OfflineAudioBackend - the page's is the
// player's own session's sound, exportsound.ts)

/** the game's sound of rows from..to as a session hands it: 533 or 534 stereo samples a row at 32 kHz (8008 / 15 on average), each
 *  row's samples the row's number */
function rowsSound(from: number, to: number, gameFrame = (row: number) => row - 123) {
  const snd = new SessionSound(gameFrame(from), gameFrame(to), gameFrame);
  for (let row = from - 3; row <= to + 3; row++) {
    const n = Math.floor(((row + 1) * 8008) / 15) - Math.floor((row * 8008) / 15);
    snd.take(new Int16Array(2 * n).fill(row), row);
  }
  return snd;
}

test("with the sound: the file has an AAC track at 48 kHz, as long as the video, a block a row in order from its first row", async () => {
  for (const fps of [60, CONSOLE_FPS]) {
    withBrowser();
    const snd = rowsSound(100, 399);
    const r = await exportMp4(options({ from: 100, to: 399, fps, audio: snd.blocks() }).opts);
    assert.deepEqual(r.audio, { codec: "mp4a.40.2", sampleRate: AUDIO_RATE, samples: r.audio!.samples });
    assert.deepEqual(heard.configs, [{ codec: "mp4a.40.2", sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192000 }]);
    // (300 rows at the video's rate: 5 s at 60 frames a second, 5.005 s at the console's - give or take a sample)
    const seconds = 300 / fps;
    assert.ok(Math.abs(r.audio!.samples - seconds * AUDIO_RATE) <= 2, `${r.audio!.samples} samples for ${seconds} s`);
    assert.equal(heard.data.length, 300, "a block a row");
    // (the timestamps follow the samples written: no gap, no overlap)
    let at = 0;
    for (const d of heard.data) { assert.equal(d.timestamp, Math.round((at * 1e6) / AUDIO_RATE)); at += d.frames; }
    // (row 100's sound first: the samples of row i are i / 32768)
    assert.ok(Math.abs(heard.data[0].first - 100 / 32768) < 1e-6, `${heard.data[0].first}`);
    assert.ok(heard.closed, "the sound's encoder closed");
    const head = new Uint8Array(await r.file.arrayBuffer());
    const text = new TextDecoder("latin1").decode(head);
    assert.ok(text.includes("mp4a") && text.includes("soun"), "an audio track in the file");
  }
});

test("Opus when the browser has no AAC; neither: the export says so before it starts", async () => {
  withBrowser();
  audioCodecs = ["opus"];
  let r = await exportMp4(options({ from: 0, to: 59, audio: rowsSound(0, 59).blocks() }).opts);
  assert.equal(r.audio!.codec, "opus");
  withBrowser();
  audioCodecs = [];
  const { opts, calls } = options({ from: 0, to: 59, audio: rowsSound(0, 59).blocks() });
  await assert.rejects(exportMp4(opts), /cannot encode the sound/);
  assert.deepEqual(calls.seek, [], "the replay is not touched");
  r = await exportMp4(options({ from: 0, to: 59 }).opts);
  assert.equal(r.audio, null, "without the sound asked for, no sound track");
});

test("the sound of a row not made ends the export with it, both encoders closed", async () => {
  withBrowser();
  const snd = new SessionSound(0, 59, (row) => row);
  const r = exportMp4(options({ from: 0, to: 59, audio: snd.blocks() }).opts);
  await assert.rejects(r, /sound of game frame 0 was not made/);
  assert.equal(seen.encoders[0].state, "closed");
  assert.ok(heard.closed);
});

test("the resampler: 32 kHz to 48 kHz keeps a steady tone's level and its timing, block after block", () => {
  const rs = new Resampler(48000);
  const out: number[] = [];
  // (1 kHz at 32 kHz, in rows of 533 or 534)
  let k = 0;
  for (let row = 0; row < 120; row++) {
    const n = Math.floor(((row + 1) * 8008) / 15) - Math.floor((row * 8008) / 15), pcm = new Int16Array(2 * n);
    for (let i = 0; i < n; i++, k++) { const v = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * k) / 32000)); pcm[2 * i] = v; pcm[2 * i + 1] = -v; }
    const { l, r } = rs.push(pcm, 32000);
    assert.equal(l.length, r.length);
    for (let i = 0; i < l.length; i++) { out.push(l[i]); assert.ok(Math.abs(l[i] + r[i]) < 1e-6); }
  }
  // (as many output samples as 48 / 32 of the input, give or take the filter's two)
  assert.ok(Math.abs(out.length - (k * 3) / 2) <= 3, `${out.length} of ${(k * 3) / 2}`);
  // (the level: the tone's peak within half a percent; its phase: sample j is the tone at j / 48000 s, two input samples late - the
  // filter's four taps around the place between its second and third)
  const peak = Math.max(...out.slice(1000));
  assert.ok(Math.abs(peak - 16000 / 32768) < 0.005 * 16000 / 32768, `peak ${peak}`);
  for (const j of [3000, 3001, 20000]) {
    const want = (16000 / 32768) * Math.sin((2 * Math.PI * 1000 * (j / 48000 - 2 / 32000)));
    assert.ok(Math.abs(out[j] - want) < 0.01, `sample ${j}: ${out[j]} against ${want}`);
  }
});
