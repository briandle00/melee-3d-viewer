/* The game's sound for Export Video, through the offline sound contract (src/audio-export.ts): an OfflineAudioBackend over the player's
 * own session. The video's rows are stepped by the export (its seek, then one row a frame): each row's sound the session hands out
 * (GxSession.onSound) is kept here for that row's game frame, and capture() gives it back in order - the same sound the player plays,
 * byte for byte (the session's sound is the simulator's sound core's: its state follows every rewind and seek exactly). Nothing is
 * simulated twice; prepare() has nothing to do (the export's own seek brings the session there).
 */
import { captureAudio, type OfflineAudioBackend, type PcmBlock, type PcmCapture } from "../../audio-export";
import { SOUND_CHANNELS, SOUND_RATE } from "./core";

export class SessionSound implements OfflineAudioBackend {
  readonly sampleRate = SOUND_RATE;
  readonly channels = SOUND_CHANNELS;
  private kept = new Map<number, Int16Array>();

  /** the video's game frames, from..to; `gameFrame` gives a row's */
  constructor(private from: number, private to: number, private gameFrame: (row: number) => number) {}

  /** a row's sound as the session steps it (the page's onSound, while the video is made) */
  take(pcm: Int16Array, row: number): void {
    const f = this.gameFrame(row);
    if (f >= this.from && f <= this.to) this.kept.set(f, pcm);
  }

  async prepare(_gameFrame: number): Promise<void> {}

  async capture(gameFrame: number): Promise<PcmCapture> {
    const pcm = this.kept.get(gameFrame);
    if (!pcm) throw new Error(`the sound of game frame ${gameFrame} was not made`);
    this.kept.delete(gameFrame);
    return { pcm, gameFrame };
  }

  destroy(): void { this.kept.clear(); }

  /** the blocks of game frames from..to, one a row, for exportMp4's audio */
  blocks(signal?: AbortSignal): AsyncGenerator<PcmBlock> {
    return captureAudio(async () => this, this.from, this.to, signal);
  }
}
