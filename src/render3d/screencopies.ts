/* 3D replay viewer: the copies of the picture a screen in the stage shows (Pokemon Stadium's big screen), kept as the
 * game keeps them.
 *
 * The game copies the match into buffers of its own (lb_800121FC): 640 x 406 for the match (grStadium_801D2FD0)
 * and 124 x 80 for a close-up (grStadium_801D3084). Each copy is made after the screen is drawn, so the screen shows,
 * on a frame, the last copy made into the buffer its mode binds before that frame - the one of the frame before while
 * the mode goes on, and an old one when the screen comes back to a buffer it left (the first frames after a switch
 * from a close-up to the match, or from the text page: the buffer still holds the copy made the last time that mode
 * ran, however long ago). This is that bookkeeping, apart from the graphics: which copy each buffer holds, which one
 * waits to be shown, and what the screen shows on a frame. The renderer (renderer.ts) holds a texture per buffer.
 *
 * A frame that does not follow the last one drawn (the first, a seek) knows no copy made before it. The caller says
 * which copies the buffers would hold there (`history`: for each buffer, the last frame before that copied into it)
 * and they are "primes": the caller draws each of those frames and copies it into its buffer (primeInto), then draws
 * the frame again - with what the game has in its buffers on the screen.
 */

/** a buffer: the copy it holds (shown) and the copy made on the frame being drawn (shown from the next) */
export interface CopyBuffer<T> {
  w: number; h: number;
  cur: T | null; curFrame: number | null;
  next: T | null; nextFrame: number | null;
}

/** a copy a buffer holds that a seek has to make again: the frame copied into the w x h buffer */
export interface Prime { w: number; h: number; frame: number }

/** what the screen shows on a frame: its text page, a buffer's copy (made at copyFrame), or black (a buffer that holds
 *  no copy - the game's own start, before any copy) */
export type Shown<T> = { kind: "text" } | { kind: "copy"; tex: T; copyFrame: number; w: number; h: number }
  | { kind: "black"; w: number; h: number };

export class ScreenCopies<T> {
  readonly bufs = new Map<string, CopyBuffer<T>>();
  /** the last frame advanced to */
  private last: number | null = null;
  /** the copies a seek left to make again (primes), and the one being made */
  primes: Prime[] = [];
  priming: Prime | null = null;
  shown: Shown<T> = { kind: "text" };
  private mode: { shows: boolean; w: number; h: number } = { shows: false, w: 0, h: 0 };

  /** make: a texture w x h for a buffer's slot */
  constructor(private make: (w: number, h: number) => T) {}

  private key(w: number, h: number) { return `${w}x${h}`; }

  buffer(w: number, h: number): CopyBuffer<T> {
    const k = this.key(w, h);
    let b = this.bufs.get(k);
    if (!b) this.bufs.set(k, (b = { w, h, cur: null, curFrame: null, next: null, nextFrame: null }));
    return b;
  }

  /** Before drawing frame `frame`: whether the screen shows a copy (its mode binds a buffer: w x h) or its text page.
   *  `history(frame)`: on a seek, the copies the buffers hold at that frame (see above). -> true when copies are to
   *  be made again first (primes). */
  advance(frame: number, shows: boolean, w: number, h: number, history: ((frame: number) => Prime[]) | null = null): boolean {
    const redraw = this.last === frame;
    const follows = this.last !== null && frame === this.last + 1;
    if (!redraw && !follows) {
      for (const b of this.bufs.values()) { b.curFrame = null; b.nextFrame = null; }
      this.primes = history ? history(frame).filter((p) => p.frame < frame) : [];
    }
    if (!redraw) {
      // (the copies made before this frame are what the buffers hold now)
      for (const b of this.bufs.values()) {
        if (b.nextFrame !== null && b.nextFrame < frame) {
          [b.cur, b.next] = [b.next, b.cur];
          b.curFrame = b.nextFrame;
          b.nextFrame = null;
        }
      }
      this.last = frame;
    }
    this.mode = { shows, w, h };
    this.show();
    return this.primes.length > 0;
  }

  /** what the screen shows, from what its buffers hold now */
  private show() {
    const { shows, w, h } = this.mode;
    if (!shows) { this.shown = { kind: "text" }; return; }
    const b = this.buffer(w, h);
    this.shown = b.cur !== null && b.curFrame !== null ? { kind: "copy", tex: b.cur, copyFrame: b.curFrame, w, h }
      : { kind: "black", w, h };
  }

  /** The texture the copy of frame `frame` into the w x h buffer goes to: while a prime is made, the buffer's held
   *  copy itself (it is a copy from before the frame being drawn); else its next one, shown from the next frame on. */
  copyInto(w: number, h: number, frame: number): T {
    const b = this.buffer(w, h);
    const p = this.priming;
    if (p && p.w === w && p.h === h && p.frame === frame) {
      if (b.cur === null) b.cur = this.make(w, h);
      b.curFrame = frame;
      return b.cur;
    }
    if (b.next === null) b.next = this.make(w, h);
    b.nextFrame = frame;
    return b.next;
  }

  /** a prime made (or given up): off the list, and the screen shows what the buffers hold now */
  primed(p: Prime) {
    this.primes = this.primes.filter((x) => x !== p);
    this.priming = null;
    this.show();
  }
}
