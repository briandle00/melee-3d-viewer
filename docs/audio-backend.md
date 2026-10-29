# Supplying an audio backend

Both the 3D entry and `gx.html` already accept an optional host audio module.
The viewer supplies transport controls and follows the backend's audio clock.
It does not synthesize Melee's sound itself. This guide and the example contain
no game assets, extracted sounds, game data, service endpoints or credentials.

## Check the connection without a game sound engine

Before the entry script in your local `gx.html` or `embed.html`, add:

```html
<script>
  globalThis.__MELEE_AUDIO_CONFIG__ = {
    module: "/audio-example/tone-player.mjs",
    assetsUrl: "", // the diagnostic module does not fetch assets
  };
</script>
```

Run the normal Vite dev server, open the viewer with your own game data and
assets, then click Sound. The example plays a quiet synthetic tone. Pause,
resume, seek, speed and music controls exercise the connection; seeking changes
pitch. It does not reproduce game sound or validate simulation agreement. The
module uses an AudioContext clock for demonstration, not a production PCM queue
with output-latency compensation. Adjust the module URL if hosting in a subfolder.
The existing adapter requires cross-origin isolation; Vite configures it locally.

You can also instantiate the example on a blank page: call `enableAudio()` from
a button click, `open(new Blob())`, then `seek(-123, { resume: true })`. That
smoke test needs no game data or assets at all. Always call `destroy()` afterward.

## Replace the example with a real engine

Export a class called `ReplayPlayer` matching [`src/audio-backend.ts`](../src/audio-backend.ts).
The name is retained for compatibility with existing hosts. Keep worker, Wasm
and AudioWorklet URLs relative to the backend module (`new URL(..., import.meta.url)`)
so the backend can be hosted independently. Supply your own asset loader through
`assetsUrl`; the viewer does not prescribe its manifest format or distribution.

1. Construct in audio-only mode, without rendering or renderer workers.
2. Call AudioContext resume synchronously in `enableAudio()`, before awaiting
   anything. `open(blob)` may run concurrently; resolve it only when the engine
   is ready to accept seeks.
3. Implement `seek(gameFrame, { resume })` as a promise. Clear queued old sound
   synchronously, cancel older work, seek the simulation, and resolve when the
   requested position is ready. Only the latest seek may change the backend's
   state. The viewer ignores stale completions and stale failures, but cannot
   cancel incorrectly implemented backend work for you.
4. Expose `audioFrame` from PCM actually consumed by the output device, accounting
   for queued audio and playback speed. Return null while unknown or buffering.
   Do not use a wall clock or the producer's newest simulated frame.
5. Implement play/pause/speed without seeking again. Stop or resume the current
   sound queue. `destroy()` must be safe during startup and stop pending work,
   workers and audio resources. Report failures with `error` or
   `audiointerrupted` events.

Game frame -123 is viewer row 0. Keep that conversion at the adapter boundary;
never add the offset a second time inside a backend. The existing `_videoEpoch`
plus `position` event protocol still works, but new backends should use seek
promises and omit that private field entirely.

Match the GX playback mode when the backend simulates game state. Two independent
engines can agree on a frame number while disagreeing on what happened in that
frame. Validate representative game data, backward seeks and end-of-game audio.
An audio-only second engine is a practical first integration but costs additional
CPU and memory. Producing PCM from the GX simulation itself is a longer-term
option that avoids that duplicated state.

While audio is enabled it owns pacing. The current GX integration passes a
console/60 rate adjustment through `setSpeed`; a backend must honor the effective
rate it receives, without applying that adjustment again.

Shared-memory backends require COOP/COEP on the top-level and embedded documents,
plus compatible CORS/CORP headers on their resources. Serve modules, workers,
worklets and Wasm with appropriate MIME types. Do not point another site's viewer
at authenticated asset URLs from your own application.

## Offline audio for MP4 export

The existing GX MP4 exporter remains video-only in this change. Live speaker
recording at accelerated playback speed is not an offline export implementation.

[`src/audio-export.ts`](../src/audio-export.ts) provides a separate, optional
`OfflineAudioBackend` contract and `captureAudio()` generator:

- Create a dedicated, paused engine for each export, not the live player.
- `prepare(from - 1)` positions it immediately before the first desired game frame.
- `capture(frame)` advances one frame and returns all of that frame's signed
  16-bit interleaved PCM in an owned buffer. Copy a Wasm heap view before returning.
- Pull one block at a time; await encoder backpressure before requesting another.
- Timestamps derive from cumulative samples per channel, not elapsed wall time
  or a rounded, fixed number of samples per game frame.
- Backend destruction runs in a `finally` block, including early iterator exit,
  errors and aborts. The backend must honor the abort signal for pending work;
  the factory must release partially constructed resources if creation fails.

Integration outline (the encoder calls here are intentionally pseudocode):

```ts
for await (const block of captureAudio(createDedicatedBackend, from, to, signal)) {
  // Render the corresponding GX row: block.gameFrame + 123.
  // Encode video at (block.gameFrame - from) * 1_000_000 / fps.
  // Convert block.pcm to the format accepted by AudioData/your AAC encoder.
  // Use block.timestamp; skip zero-length PCM blocks.
  // Await both encoders' capacity before continuing.
}
// Flush audio/video encoders, then finalize a muxer configured with both tracks.
```

AAC/WebCodecs support must be probed in the target browser. Configure the MP4
muxer's audio track before writing samples and pass encoder metadata through.
Close AudioData and VideoFrame objects even on errors. Capture should use neutral
volume and full game speed; apply desired output gain explicitly during encoding.

Choose a timing policy before supporting console-rate exports: 60 fps and
60000/1001 fps are different durations. The backend must generate or resample
PCM for the selected output rate. The helper deliberately does not guess or
resample. Validate decoded video frame counts, audio sample counts and total
track durations for both policies, including clips starting in the middle of a
game. Rendering can then take more or less wall time without changing duration.

## Checks

With dependencies installed, use the repository's Deno test workflow:

```sh
deno test --no-check --sloppy-imports tests/audio.test.mjs tests/gx-audio.test.mjs \
  tests/audio-promise.test.mjs tests/audio-tone.test.mjs tests/audio-export.test.ts \
  tests/gxpath-playback.test.ts
npm run build
```

These checks use fake backends and synthetic PCM. They verify the contract,
seek races, teardown, timing and fallback, not actual game sound accuracy or a
finished audio/video encoder. No game assets are needed for these checks.
