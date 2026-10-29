/** Optional offline PCM contract. Independent of live playback and of the MP4 encoder.
 * Implementations own their simulation; this module supplies no game engine or assets. */
export interface PcmCapture {
  /** Signed 16-bit interleaved PCM, owned by the caller (not a mutable Wasm heap view). */
  pcm: Int16Array;
  gameFrame: number;
}
export interface OfflineAudioBackend {
  sampleRate: number;
  channels: number;
  /** Seek while paused to the frame BEFORE the first capture; clear old queued PCM. */
  prepare(gameFrame: number, signal?: AbortSignal): Promise<void>;
  /** Advance exactly one game frame and return all of its PCM. No speaker playback. */
  capture(gameFrame: number, signal?: AbortSignal): Promise<PcmCapture>;
  destroy(): void | Promise<void>;
}
export interface PcmBlock extends PcmCapture {
  sampleRate: number;
  channels: number;
  /** WebCodecs timestamps, in microseconds, relative to the clip's first sample. */
  timestamp: number;
  duration: number;
}

/** Pull one block at a time: the caller awaits encoding before requesting the next.
 * Owns and destroys a dedicated backend on success, failure, cancellation or iterator return.
 * The factory must clean up partial construction if it rejects. */
export async function* captureAudio(
  create: (signal?: AbortSignal) => Promise<OfflineAudioBackend>,
  from: number,
  to: number,
  signal?: AbortSignal,
): AsyncGenerator<PcmBlock> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from)
    throw new RangeError("Invalid audio capture range");
  signal?.throwIfAborted();
  const backend = await create(signal);
  try {
    signal?.throwIfAborted();
    const { sampleRate, channels } = backend;
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(channels) || channels <= 0)
      throw new RangeError("Invalid PCM format");
    await backend.prepare(from - 1, signal);
    let samples = 0;
    for (let gameFrame = from; gameFrame <= to; gameFrame++) {
      signal?.throwIfAborted();
      const block = await backend.capture(gameFrame, signal);
      signal?.throwIfAborted();
      if (block.gameFrame !== gameFrame || !(block.pcm instanceof Int16Array) || block.pcm.length % channels !== 0)
        throw new Error("Audio backend returned an invalid frame or PCM block");
      const timestamp = Math.round(samples * 1e6 / sampleRate);
      samples += block.pcm.length / channels;
      const duration = Math.round(samples * 1e6 / sampleRate) - timestamp;
      yield { ...block, sampleRate, channels, timestamp, duration };
    }
  } finally {
    await backend.destroy();
  }
}
