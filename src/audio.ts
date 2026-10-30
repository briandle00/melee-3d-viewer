// Sound for the replay, from a player the embedding page supplies.
//
// Nothing here makes sound by itself: no audio engine and no game sound
// assets are in this repository. A host page that has a sound-only replay
// player sets globalThis.__MELEE_AUDIO_CONFIG__ before the viewer loads (see
// README.md, "Optional browser audio"); without it this module does nothing,
// the sound controls are not shown, and the viewer plays on its own clock as
// before. Turning sound off destroys the host's player, which gives the viewer
// back its own clock.
//
// While sound is on, the picture follows the sound: each tick the viewer shows
// the game frame the audio device is playing (PCM playback time, the host
// player's audioFrame), not the next frame of its own clock. A seek goes to the
// host player, which starts its sound again at the frame shown; pause, play and
// speed changes go to it as they are, without a seek.

import { createSignal } from "solid-js";
import { clearSimulationStage, receiveSimulationStage } from "./simulation-stage";

import type { AudioConfig, AudioPlayer, AudioPlayerClass, PlaybackMode, PositionDetail } from "./audio-backend";
export type { AudioConfig, AudioPlayer, AudioPlayerClass, PlaybackMode } from "./audio-backend";

/** the game's first frame: viewer frame indexes start at 0, the host player's game frames at -123 */
const FIRST_FRAME = -123;

let config = (globalThis as { __MELEE_AUDIO_CONFIG__?: AudioConfig })
  .__MELEE_AUDIO_CONFIG__;

/** whether the host page configured sound at all (the sound controls show only then) */
export let soundConfigured = !!config;
/** the host's configuration has come (at load, or later by configureSound) */
export const [soundConfiguredNow, setSoundConfiguredNow] = createSignal(soundConfigured);
export const [soundState, setSoundState] = createSignal<
  "off" | "loading" | "on" | "error"
>("off");
/** the host's player module has loaded: sound can be turned on */
export const [soundAvailable, setSoundAvailable] = createSignal(false);
export const [musicEnabled, setMusicEnabled] = createSignal(true);

let Player: AudioPlayerClass | undefined;
// the host player while sound is on or starting, null while it is off
let player: AudioPlayer | null = null;
// the replay the host player opens
let blob: Blob | undefined;
// what the viewer asks for: playing or paused, the frame shown, the speed
let desired = false;
let index = 0;
let speed = 1;
let playbackMode: PlaybackMode = "slippi";
// counts every start and stop of sound: a start that finishes after sound
// was turned off (or on again) sees the count has moved and does nothing
let generation = 0;
// a seek was sent and the host player has not said it is done
let seeking = false;
// Viewer-owned sequence: promise completion never needs a backend private field.
let seekSequence = 0;

// the host's module is loaded ahead of the first click, so the click can
// start sound at once; loading it makes no worker or AudioContext
function loadModule(c: AudioConfig) {
  void import(/* @vite-ignore */ c.module)
    .then((m: { ReplayPlayer: AudioPlayerClass }) => {
      Player = m.ReplayPlayer;
      setSoundAvailable(true);
    })
    .catch((error) => {
      console.warn("Experimental audio controller failed", error);
      setSoundState("error");
    });
}
if (config) loadModule(config);

/** a host that learns its configuration after the viewer has loaded (from its server, say) gives it here, once; the same as
 *  __MELEE_AUDIO_CONFIG__ set before the viewer loads. Without either, nothing here does anything */
export function configureSound(c: AudioConfig): void {
  if (config || !c || typeof c.module !== "string") return;
  config = c;
  soundConfigured = true;
  setSoundConfiguredNow(true);
  loadModule(c);
}

/** sound off after the host player failed (if it is still the current one) */
function fail(p: AudioPlayer) {
  if (p !== player) return;
  void p.destroy();
  player = null;
  seeking = false;
  setSoundState("error");
}

/** start the host player's sound again at the frame shown, playing or paused */
function align() {
  if (!player?.ready) return;
  seeking = true;
  const p = player, sequence = ++seekSequence;
  try {
    const completion = p.seek(index + FIRST_FRAME, { resume: desired });
    if (completion) {
      void completion.then(() => {
        if (p === player && sequence === seekSequence) seeking = false;
      }, () => {
        if (p === player && sequence === seekSequence) fail(p);
      });
    } else if (typeof p._videoEpoch !== "number") {
      throw new Error("Audio backend seek must return a promise or provide legacy seek acknowledgments");
    }
  } catch { fail(p); }
}

export const sound = {
  /** a new replay (or none): sound off, and the next start opens this one */
  load(data?: Blob): void {
    this.disable();
    clearSimulationStage();
    blob = data;
  },

  /** sound off: the host player is destroyed and the viewer's own clock is back */
  disable(): void {
    generation++;
    const old = player;
    player = null;
    seeking = false;
    if (old) void old.destroy();
    setSoundState("off");
  },

  /** sound on, from the sound button's click */
  async enable(): Promise<void> {
    if (!Player || !blob || !crossOriginIsolated) {
      setSoundState("error");
      return;
    }
    this.disable();
    const id = ++generation;
    const p = new Player({
      audioOnly: true,
      assetsUrl: config!.assetsUrl,
      music: musicEnabled(),
      playback: playbackMode,
    });
    player = p;
    setSoundState("loading");
    // (Fountain's platform heights for a replay that does not record them: src/simulation-stage.ts)
    p.addEventListener("stage-frames", (event) => {
      if (p !== player) return;
      receiveSimulationStage((event as CustomEvent<{ frames: number[][] }>).detail.frames);
    });
    p.addEventListener("error", () => fail(p));
    p.addEventListener("audiointerrupted", () => fail(p));
    p.addEventListener("position", (event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      // (a seek is done only when the host player says so for the latest
      // seek: an older seek finishing while the slider moves on is not it)
      if (p !== player || typeof p._videoEpoch !== "number" || detail.videoEpoch !== p._videoEpoch) return;
      if (!detail.seeking) seeking = false;
    });
    try {
      // enableAudio is called in the click itself, before the first await,
      // so the browser lets the host player start its AudioContext
      const unlock = p.enableAudio();
      await Promise.all([unlock, p.open(blob)]);
      // (sound was turned off, or the replay changed, while it started)
      if (id !== generation || player !== p) return;
      p.setSpeed(speed);
      setSoundState("on");
      align();
    } catch (error) {
      console.warn("Experimental audio startup failed", error);
      fail(p);
    }
  },

  /** the viewer's playing state, frame and speed (1 = the game's) */
  transport(playing: boolean, frame: number, rate: number): void {
    index = frame;
    const changed = desired !== playing || speed !== rate;
    desired = playing;
    speed = rate;
    if (changed && player?.ready) {
      if (player.speed !== rate) player.setSpeed(rate);
      // (a pause, a play or a new speed goes to the host player as it is: a seek would make a backend that
      // simulates the game rewind it, to start its sound again where it already is. A seek under way is
      // sent again, with the new playing state)
      const p = player;
      if (seeking) align();
      else if (desired) void p.play().catch(() => fail(p));
      else p.pause();
    }
  },

  /** the viewer jumped to this frame */
  seek(frame: number): void {
    index = frame;
    if (player?.ready) align();
  },

  /** the frame to show now: undefined while sound is off (the viewer's own
   *  clock), null while the sound is not there yet (the picture holds), or
   *  the frame the audio device is playing */
  frame(): number | null | undefined {
    if (!player) return undefined;
    if (!player.ready || seeking) return null;
    const frame = player.audioFrame;
    return frame == null ? null : Math.floor(frame - FIRST_FRAME);
  },

  /** the viewer's playback mode (README: setPlayback): told to the host player when it takes it, and its sound started again at the
   *  frame shown (`frame`, the viewer's index: playing moves it without telling this module); kept for the next start either way */
  playback(mode: PlaybackMode, frame?: number): void {
    if (mode === playbackMode) return;
    playbackMode = mode;
    if (frame !== undefined) index = frame;
    const p = player;
    if (p?.ready && p.setPlayback) {
      try { p.setPlayback(mode); } catch { fail(p); return; }
      align();
    }
  },

  /** the game's music on or off (the rest of the sound stays) */
  music(on: boolean): void {
    setMusicEnabled(on);
    player?.setMusic(on);
  },
};

window.addEventListener("pagehide", () => sound.disable());
