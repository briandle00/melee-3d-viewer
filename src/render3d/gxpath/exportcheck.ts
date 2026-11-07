/* The checks of a video (export.ts), run in the page: not used to make one.
 *
 * The reference: the match played from its first row with every row drawn, as the player plays it, and each row's picture kept (its
 * hash; the pixels of every `sample`-th). The video: made the export's way (a fast-forward to the stretch, then each row drawn), each
 * composed frame's pixels hashed before encoding, and the encoded chunks decoded back with the browser's own decoder.
 *   exact    every composed frame is the reference picture of its row, pixel for pixel (at 2x and 4x: each block of s x s pixels is one
 *            of the picture's), the first frame row `from` and the last row `to`
 *   psnr     the decoded frames against the reference pictures (the encoding's loss), dB, min and mean over the sampled frames
 *   file     the MP4's own sample count and durations (its stsz and stts boxes)
 */
import type { ExportResult } from "./export";

export interface CheckHost {
  /** start the match again and draw every row up to `to`, calling `picture(row)` after each row drawn (the renderer's 640 x 480 picture) */
  reference(to: number, onRow: (row: number, rgba: Uint8Array) => void): Promise<void>;
  /** make the video (the page's own way) with hooks */
  make(hooks: { onChunk(c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata): void; onComposed(c: OffscreenCanvas, i: number): void }): Promise<ExportResult>;
}

// (the color channels: the video has no alpha)
const hash = (a: Uint8Array | Uint8ClampedArray) => { let h = 2166136261; for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) h = Math.imul(h ^ a[i], 16777619); return (h >>> 0).toString(16); };

/** the picture's top-left pixel of each s x s block (the 640 x 480 picture back from a scaled frame), and whether every block is one color */
function unscale(px: Uint8ClampedArray, s: number): { pic: Uint8Array; blocksFlat: boolean } {
  const W = 640 * s, pic = new Uint8Array(640 * 480 * 4);
  let flat = true;
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
    const k = ((y * s) * W + x * s) * 4, o = (y * 640 + x) * 4;
    for (let c = 0; c < 4; c++) pic[o + c] = px[k + c];
    if (flat && s > 1) for (let j = 0; j < s && flat; j++) for (let i = 0; i < s; i++) {
      const q = ((y * s + j) * W + x * s + i) * 4;
      if (px[q] !== px[k] || px[q + 1] !== px[k + 1] || px[q + 2] !== px[k + 2]) { flat = false; break; }
    }
  }
  return { pic, blocksFlat: flat };
}

/** PSNR of the color channels, dB (Infinity: equal) */
export function psnr(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d; n++; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / se);
}

/** PSNR of the luma (BT.601 Y), dB: the usual measure of a video's loss (the color is halved each way by the encoding, 4:2:0) */
export function psnrY(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = 0.299 * (a[i] - b[i]) + 0.587 * (a[i + 1] - b[i + 1]) + 0.114 * (a[i + 2] - b[i + 2]);
    se += d * d; n++;
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / se);
}

/** the MP4's boxes: a video track's samples and their durations, in its timescale (mdhd) - from the sample table (stsz, stts) of a
 *  file with its index at the front, or from the fragments (moof: tfhd's default duration, trun's samples) of a fragmented one */
export function mp4Samples(bytes: Uint8Array): { samples: number; durations: number[]; timescale: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { samples: 0, durations: [] as number[], timescale: 0 };
  let stsz = -1, defaultDuration = 0;
  const walk = (from: number, to: number) => {
    for (let p = from; p + 8 <= to;) {
      const size = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (size < 8) break;
      if (["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex"].includes(type)) walk(p + 8, p + size);
      else if (type === "stsz") stsz = dv.getUint32(p + 16);
      else if (type === "mdhd") out.timescale = dv.getUint8(p + 8) === 1 ? dv.getUint32(p + 28) : dv.getUint32(p + 20);
      else if (type === "stts") {
        const n = dv.getUint32(p + 12);
        for (let i = 0; i < n; i++) { const count = dv.getUint32(p + 16 + i * 8), d = dv.getUint32(p + 20 + i * 8); for (let k = 0; k < count; k++) out.durations.push(d); }
      } else if (type === "trex") defaultDuration = dv.getUint32(p + 20);
      else if (type === "tfhd") {
        const flags = dv.getUint32(p + 8) & 0xffffff;
        let q = p + 16;
        if (flags & 0x1) q += 8;
        if (flags & 0x2) q += 4;
        if (flags & 0x8) defaultDuration = dv.getUint32(q);
      } else if (type === "trun") {
        const flags = dv.getUint32(p + 8) & 0xffffff, n = dv.getUint32(p + 12);
        let q = p + 16;
        if (flags & 0x1) q += 4;
        if (flags & 0x4) q += 4;
        const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
        for (let i = 0; i < n; i++) out.durations.push(flags & 0x100 ? dv.getUint32(q + i * per) : defaultDuration);
        out.samples += n;
      }
      p += size;
    }
  };
  walk(0, bytes.length);
  if (stsz > 0) out.samples += stsz;
  return out;
}
export async function checkExport(host: CheckHost, o: { from: number; to: number; scale: number; fps: number; sample?: number }) {
  const sample = o.sample ?? 5, total = o.to - o.from + 1;
  const want = new Map<number, string>(), kept = new Map<number, Uint8Array>();
  const tr = performance.now();
  await host.reference(o.to, (row, rgba) => {
    if (row < o.from) return;
    want.set(row, hash(rgba));
    if ((row - o.from) % sample === 0) kept.set(row, rgba.slice());
  });
  const referenceMs = performance.now() - tr;
  const chunks: EncodedVideoChunk[] = [];
  let decoderConfig: VideoDecoderConfig | undefined;
  const composed: string[] = [];
  let blocksFlat = true;
  const result = await host.make({
    onChunk: (c, m) => { chunks.push(c); if (m?.decoderConfig) decoderConfig = m.decoderConfig; },
    onComposed: (c, i) => {
      const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      let px: Uint8ClampedArray;
      if (g) px = g.getImageData(0, 0, c.width, c.height).data;
      else {
        const gl = c.getContext("webgl2")!, buf = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        px = new Uint8ClampedArray(buf.buffer);
      }
      const u = o.scale === 1 ? { pic: new Uint8Array(px.buffer.slice(0)), blocksFlat: true } : unscale(px, o.scale);
      // (the canvas is opaque: alpha 255, as the renderer's picture)
      composed[i] = hash(u.pic);
      if (!u.blocksFlat) blocksFlat = false;
    },
  });
  // exact: composed frame i is row from + i
  let exact = 0, firstOff = -1;
  for (let i = 0; i < total; i++) { if (composed[i] === want.get(o.from + i)) exact++; else if (firstOff < 0) firstOff = i; }
  // decoded back
  const frames: { ts: number; px: Uint8ClampedArray | null }[] = [];
  const W = 640 * o.scale, H = 480 * o.scale;
  const cv = new OffscreenCanvas(W, H), g = cv.getContext("2d", { willReadFrequently: true })!;
  let decoded = 0, decodeError: string | null = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      const i = decoded++;
      let px: Uint8ClampedArray | null = null;
      if (i % sample === 0) { g.drawImage(f, 0, 0); px = g.getImageData(0, 0, W, H).data; }
      frames.push({ ts: f.timestamp, px });
      f.close();
    },
    error: (e) => { decodeError = String(e); },
  });
  decoder.configure(decoderConfig!);
  for (const c of chunks) decoder.decode(c);
  await decoder.flush();
  decoder.close();
  // (at 2x and 4x against the picture scaled up the same way, each pixel an s x s block)
  const up = (r: Uint8Array) => {
    if (o.scale === 1) return r;
    const s = o.scale, out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = ((y / s | 0) * 640 + (x / s | 0)) * 4, q = (y * W + x) * 4; out[q] = r[k]; out[q + 1] = r[k + 1]; out[q + 2] = r[k + 2]; out[q + 3] = 255; }
    return out;
  };
  const ps: number[] = [], py: number[] = [];
  for (let i = 0; i < frames.length; i += sample) { const r = kept.get(o.from + i), f = frames[i]; if (r && f?.px) { const u = up(r); ps.push(psnr(u, f.px)); py.push(psnrY(u, f.px)); } }
  const stamps = frames.every((f, i) => f.ts === Math.round((i * 1e6) / o.fps));
  const file = mp4Samples(new Uint8Array(await result.file.arrayBuffer()));
  const finite = ps.filter((v) => Number.isFinite(v));
  return {
    rows: [o.from, o.to], frames: result.frames, composedExact: exact, firstOff, blocksFlat, decoded, decodeError, stamps,
    psnr: ps.length ? { min: Math.min(...ps), mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : Infinity, n: ps.length } : null,
    psnrY: py.length ? { min: Math.min(...py), mean: py.filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, py.filter(Number.isFinite).length) } : null,
    file: { samples: file.samples, timescale: file.timescale, duration: file.durations.reduce((a, b) => a + b, 0), firstDurations: file.durations.slice(0, 3) },
    bytes: result.file.size, bitrate: result.bitrate, codec: result.codec, hardware: result.hardware, repeated: result.repeated, ms: result.ms, referenceMs,
  };
}
