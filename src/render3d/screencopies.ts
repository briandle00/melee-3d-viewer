/* 3D replay viewer: the copies of the picture a screen in the stage shows (Pokemon Stadium's big screen), kept as the
 * game keeps them.
 *
 * The game copies the match into buffers of its own (lb_800121FC): 640 x 406 for the match (grStadium_801D2FD0)
 * and 124 x 80 for a close-up (grStadium_801D3084). Each copy is made after the screen is drawn, so the screen shows,
 * on a frame, the last copy made into the buffer its mode binds before that frame - the one of the frame before while
 * the mode goes on, and an old one when the screen comes back to a buffer it left (the first frames after a switch
 * from a close-up to the match, or from the text page: the buffer still holds the copy made the last time that mode
 * ran). This is that bookkeeping, apart from the graphics: which copy each buffer holds, which one waits to be shown,
 * and what the screen shows on a frame. The renderer (renderer.ts) holds a texture per buffer and slot.
 *
 * A frame that does not follow the last one drawn (the first, a jump) knows no copy made before it: every buffer is
 * emptied. If the screen then shows a buffer, it is black for a first drawing and the frame is drawn again with the
 * copy that drawing made at its end (as the copy of the frame before, which a jump has not drawn).
 */

/** a buffer: the copy it holds (shown) and the copy made on the frame being drawn (shown from the next) */
export interface CopyBuffer<T> {
  w: number; h: number;
  cur: T | null; curFrame: number | null;
  next: T | null; nextFrame: number | null;
}

/** what the screen shows on a frame: its text page, a buffer's copy (made at copyFrame), or black (a buffer that holds
 *  no copy the player has made) */
export type Shown<T> = { kind: "text" } | { kind: "copy"; tex: T; copyFrame: number; w: number; h: number }
  | { kind: "black"; w: number; h: number };

export class ScreenCopies<T> {
  readonly bufs = new Map<string, CopyBuffer<T>>();
  /** the last frame advanced to */
  private last: number | null = null;
  /** a jump's frame whose first drawing is under way (its copy is shown at once), and whether its second is */
  private jumpedAt: number | null = null;
  private first = false;
  private second = false;
  shown: Shown<T> = { kind: "text" };

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
   *  -> true when the frame is to be drawn again (a jump onto a buffer: see above). */
  advance(frame: number, shows: boolean, w: number, h: number): boolean {
    if (this.second && this.jumpedAt === frame) { this.second = false; return false; }
    this.second = false;
    const redraw = this.last === frame;
    const follows = this.last !== null && frame === this.last + 1;
    if (!redraw && !follows) {
      for (const b of this.bufs.values()) { b.curFrame = null; b.nextFrame = null; }
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
    if (!shows) { this.shown = { kind: "text" }; return false; }
    if (redraw) return false;
    const b = this.buffer(w, h);
    if (b.cur !== null && b.curFrame !== null) {
      this.shown = { kind: "copy", tex: b.cur, copyFrame: b.curFrame, w, h };
      return false;
    }
    this.shown = { kind: "black", w, h };
    if (follows) return false;
    this.jumpedAt = frame;
    this.first = true;
    return true;
  }

  /** The texture the copy of frame `frame` into the w x h buffer goes to (shown from the next frame on). */
  copyInto(w: number, h: number, frame: number): T {
    const b = this.buffer(w, h);
    if (b.next === null) b.next = this.make(w, h);
    b.nextFrame = frame;
    return b.next;
  }

  /** After the copy of frame `frame` is made: on a jump's first drawing, the copy is shown at once (for the second). */
  copied(w: number, h: number, frame: number) {
    if (!this.first || this.jumpedAt !== frame) return;
    this.first = false;
    this.second = true;
    const b = this.buffer(w, h);
    if (b.nextFrame !== frame || b.next === null) return;
    [b.cur, b.next] = [b.next, b.cur];
    b.curFrame = frame;
    b.nextFrame = null;
    const s = this.shown;
    if (s.kind === "black" && s.w === w && s.h === h) this.shown = { kind: "copy", tex: b.cur!, copyFrame: frame, w, h };
  }
}
