// Public host-backend contract. No game engine or assets are included.

/** what the host page sets before the viewer loads */
export interface AudioConfig {
  /** URL of an ES module that exports ReplayPlayer */
  module: string;
  /** passed through to the host player */
  assetsUrl: string;
}

/** the host player's position event: which seek it is for, and whether that seek is done */
export interface PositionDetail {
  videoEpoch: number;
  seeking: boolean;
}

/** the host's sound-only replay player (the contract in README.md) */
export interface AudioPlayer extends EventTarget {
  /** the replay is open and seeks may be sent */
  readonly ready: boolean;
  readonly speed: number;
  /** the fractional game frame (from -123) at the audio device's playback time, null until known */
  readonly audioFrame: number | null | undefined;
  /** Legacy position-event acknowledgement only. New backends omit this and
   * return a promise from seek instead. */
  readonly _videoEpoch?: number;
  enableAudio(): Promise<unknown>;
  open(replay: Blob): Promise<unknown>;
  /** Resolve after this seek is ready. Clear queued sound immediately and cancel older seeks.
   * Legacy backends may return void and acknowledge through position/_videoEpoch. */
  seek(gameFrame: number, options: { resume: boolean }): Promise<void> | void;
  /** play on from where the sound is (no seek) */
  play(): Promise<unknown>;
  /** stop the sound where it is */
  pause(): void;
  setSpeed(rate: number): void;
  setMusic(on: boolean): void;
  /** (optional) how the viewer plays the replay back from now on: "slippi" (as Slippi's replay playback shows it) or "original" (as the
   *  console recorded it). The two can play some replays differently (the C-stick of a replay from before Slippi 3.17); a backend that
   *  simulates the game plays it the same way, or its sound drifts from the picture. A backend may ignore it */
  setPlayback?(mode: PlaybackMode): void;
  destroy(): unknown;
}

/** how the viewer plays the replay back (the GX player's Playback setting) */
export type PlaybackMode = "slippi" | "original";

export type AudioPlayerClass = new (options: {
  audioOnly: true;
  assetsUrl: string;
  music: boolean;
  /** (optional for the backend) the playback mode the replay is played back in, as setPlayback */
  playback: PlaybackMode;
}) => AudioPlayer;
