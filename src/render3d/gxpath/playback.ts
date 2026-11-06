/* Playback controls over a GxSession: play, pause, speed, pace, frame step, seek. The game runs at 60 frames a second ("60") or at the
 * console's 60000/1001 ("console"); a tick (one display frame of the page) steps and draws every row the time asks for and shows the
 * last. A seek behind the match rewinds it (session.ts rewindFor) and plays forward, a slice of a tick at a time so the page stays
 * alive; a seek ahead plays forward the same way.
 */
import type { GxSession } from "./session";

export interface PlaybackHooks {
  /** a new picture is ready (rgba: the renderer's buffer, copy to keep) and the row it is */
  onPicture(rgba: Uint8Array, row: number): void;
  /** the state changed: playing, speed, row, seeking, the end */
  onState(): void;
  onError(e: unknown): void;
  /** a frame has been drawn and is the one to show (when the renderer shows its own canvas, present() goes here) */
  onShown?(): void;
  /** the game parted from the replay and the other settings are being tried (text), or that is over (null) */
  onRetry?(text: string | null): void;
}

/** the speeds offered (1 is the game's) */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];

/** the frame rate the game is paced at: "60" (60 a second, one game frame per refresh of a 60 Hz display) or "console" (one game frame
 *  per NTSC field, 60000/1001 a second, as a GameCube plays it) */
export type Pace = "60" | "console";
export const PACES: Pace[] = ["60", "console"];
export const isPace = (v: unknown): v is Pace => v === "60" || v === "console";
export const paceFps = (p: Pace) => (p === "console" ? 60000 / 1001 : 60);

/** the display refreshes at 60 Hz when its frames come 16.0 to 17.4 ms apart (the median of the last few) */
const isSixtyHz = (ms: number) => ms > 16.0 && ms < 17.4;

export class GxPlayback {
  playing = false;
  speed = 1;
  pace: Pace = "60";
  /** the display's refresh interval, ms (median of the last ticks; 0 until measured) */
  refreshMs = 0;
  private gaps: number[] = [];
  ended = false;
  /** the row a seek is going to (null: not seeking) */
  seeking: number | null = null;
  /** while set and answering a row, playing shows that row instead of the clock's: the row being heard (src/audio.ts sound.frame: the
   *  host's audioFrame). undefined: the clock's own; null: hold the picture (the sound is catching up). Every row up to it is drawn,
   *  none past it: the picture never runs ahead of the sound, and a sound behind the picture holds it */
  follow: (() => number | null | undefined) | null = null;
  private acc = 0;
  private last = 0;
  private busy = false;
  private raf = 0;
  private restarting = false;

  constructor(readonly session: GxSession, private hooks: PlaybackHooks, private clock = () => performance.now()) {
    session.onPicture = (rgba, row) => hooks.onPicture(rgba, row);
  }

  get row(): number { return this.session.shown; }

  play(): void { if (this.ended) { void this.seek(0).then(() => this.play()); return; } this.playing = true; this.acc = 0; this.last = this.clock(); this.hooks.onState(); this.kick(); }
  pause(): void { this.playing = false; this.hooks.onState(); }
  toggle(): void { this.playing ? this.pause() : this.play(); }
  setSpeed(s: number): void { this.speed = s; this.hooks.onState(); }
  setPace(p: Pace): void { this.pace = p; this.acc = 0; this.last = this.clock(); this.hooks.onState(); }

  /** one row forward (paused) */
  stepForward(): void {
    this.pause();
    this.session.step(true);
    this.hooks.onShown?.();
    this.hooks.onState();
  }

  /** one row back: the match starts again and plays to the row before */
  stepBack(): Promise<void> { this.pause(); return this.seek(Math.max(0, this.session.shown - 1)); }

  /** show row `row` (0 = the first), by playing forward; resolves when it is shown */
  seek(row: number): Promise<void> {
    this.seeking = Math.max(0, Math.min(row, this.session.frameCount - 1));
    this.ended = false;
    this.hooks.onState();
    return new Promise((resolve) => { this.seekDone.push(resolve); this.kick(); });
  }
  private seekDone: (() => void)[] = [];

  /** a tick of the page's clock; call from requestAnimationFrame (or `run()` below) */
  tick(): void {
    if (this.busy || this.restarting) return;
    this.busy = true;
    try {
      if (this.seeking !== null) {
        const s = this.session;
        if (s.needsRestart(this.seeking)) {
          this.restarting = true;
          void s.rewindFor(this.seeking).then(() => { this.restarting = false; this.kick(); }, (e) => { this.restarting = false; this.hooks.onError(e); });
          return;
        }
        // (a seek has the tick to itself: most of it)
        if (s.seekStep(this.seeking, 14)) {
          this.seeking = null;
          this.hooks.onShown?.();
          const done = this.seekDone; this.seekDone = [];
          this.hooks.onState();
          done.forEach((f) => f());
        }
        return;
      }
      if (!this.playing) return;
      const heard = this.follow?.();
      if (heard !== undefined) {
        // (the clock's own count starts again from here when the sound goes)
        this.last = this.clock();
        this.acc = 0;
        if (heard === null) return;
        const s = this.session, target = Math.min(heard, s.frameCount - 1), t0 = this.clock();
        let stepped = false;
        while (s.index <= target) {
          s.step(true);
          stepped = true;
          if (this.clock() - t0 > 14) break;
        }
        if (s.index >= s.frameCount) { this.ended = true; this.playing = false; }
        if (stepped || this.ended) { this.hooks.onShown?.(); this.hooks.onState(); }
        if (s.wantsRetry) this.retry();
        return;
      }
      const now = this.clock(), gap = now - this.last;
      this.last = now;
      if (gap > 0 && gap < 100) {
        this.gaps.push(gap);
        if (this.gaps.length > 15) this.gaps.shift();
        this.refreshMs = [...this.gaps].sort((a, b) => a - b)[this.gaps.length >> 1];
      }
      // "60" on a 60 Hz display: one game frame each refresh, so every picture stays on screen for exactly one refresh. Otherwise
      // (another refresh rate, the console's rate, other speeds) the clock decides how many game frames are due.
      if (this.pace === "60" && this.speed === 1 && isSixtyHz(this.refreshMs)) this.acc = Math.min(this.acc, 0) + 1;
      else this.acc += Math.min(100, gap) * (paceFps(this.pace) / 1000) * this.speed;
      let n = Math.floor(this.acc);
      if (n < 1) return;
      this.acc -= n;
      // (every game frame is drawn, none skipped: when the page cannot keep up, the replay slows down rather than dropping frames;
      // at most two frames' worth of lateness is carried over)
      const s = this.session, t0 = now;
      while (n > 0) {
        if (s.index >= s.frameCount) { this.ended = true; this.playing = false; this.hooks.onState(); break; }
        s.step(true);
        n--;
        if (n > 0 && this.clock() - t0 > 14) { this.acc = Math.min(2, this.acc + n); break; }
      }
      this.acc = Math.min(this.acc, 2);
      this.hooks.onShown?.();
      this.hooks.onState();
      if (s.wantsRetry) this.retry();
    } catch (e) {
      this.playing = false;
      this.hooks.onError(e);
    } finally {
      this.busy = false;
    }
  }

  /** the game parted from the replay: the other drive choices are tried in the background while the match on screen goes on; when one
   *  holds longer, the match starts again on it and comes back to the frame shown */
  private retry(): void {
    const s = this.session;
    void s.bestDrive((text) => this.hooks.onRetry?.(text)).then(async (best) => {
      this.hooks.onRetry?.(null);
      if (best === null) return;
      const row = Math.max(0, s.shown), wasPlaying = this.playing;
      this.playing = false;
      this.restarting = true;
      this.hooks.onState();
      await s.switchDrive(best);
      this.restarting = false;
      this.seeking = row;
      this.playing = wasPlaying;
      this.last = this.clock();
      this.hooks.onState();
      this.kick();
    }).catch((e) => { this.restarting = false; this.hooks.onRetry?.(null); this.hooks.onError(e); });
  }

  private kick(): void { if (!this.raf && typeof requestAnimationFrame === "function") this.loop(); }
  private loop = (): void => {
    this.tick();
    this.raf = this.playing || this.seeking !== null || this.restarting ? requestAnimationFrame(this.loop) : 0;
  };
  /** start the page's loop (call once; it keeps going while something is playing or seeking) */
  run(): void { this.kick(); }
  /** the loop must run again after play/pause/seek set something */
  poke(): void { this.kick(); }
}
