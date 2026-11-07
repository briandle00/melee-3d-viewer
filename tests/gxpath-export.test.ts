// Export Video (src/render3d/gxpath/export.ts) without a browser: WebCodecs and OffscreenCanvas are stand-ins that record
// what they are asked, mp4-muxer is the real one. One tape row is one video frame at i / fps seconds, the durations add up
// to the stretch exactly, a key frame every two seconds; 1x without a TV hands the renderer's canvas itself to the encoder,
// 2x and 4x draw it scaled pixel for pixel; the bitrate, the H.264 profile and the hardware choice; and every way it can
// fail says why and leaves no encoder open. (The real encoder's output is checked in a browser: exportcheck.ts.)
//
//   deno test -A --no-check --sloppy-imports tests/gxpath-export.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { BITS_PER_PIXEL, ExportCanceled, MAX_BITRATE, exportMp4, timescaleOf, videoName, type ExportOptions } from "../src/render3d/gxpath/export.ts";
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
    const canvas = this, c = { w: this.width, h: this.height } as Seen["canvases"][number];
    seen.canvases.push(c);
    return {
      set imageSmoothingEnabled(v: boolean) { c.smoothing = v; },
      drawImage: (...a: unknown[]) => { seen.draws.push([canvas, ...a]); },
    };
  }
}

const g = globalThis as Record<string, unknown>;
function withBrowser(on = true) {
  seen = { configs: [], frames: [], encoders: [], draws: [], canvases: [] };
  supports = () => true;
  failOn = null;
  for (const [k, v] of Object.entries({ VideoEncoder: FakeEncoder, VideoFrame: FakeFrame, EncodedVideoChunk: FakeChunk, OffscreenCanvas: FakeCanvas })) {
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
