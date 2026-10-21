/* 3D replay viewer: the effect world's checkpoints, so that a jump gives exactly the particles of playing
 * straight through to the frame. The world is the same frame for frame from the same state (the track's events
 * and random states, the replay's poses), so it is kept as it stood every `every` frames (FxWorld.save); a jump
 * loads the nearest one at or before the frame and steps on from there (FxWorld.load, FxWorld.step).
 *
 * Memory is bounded: past `budget` bytes the spacing doubles and every checkpoint off the new spacing is let go
 * (the first, the world as made, is always kept), so a long replay keeps fewer, further apart, and a jump steps
 * a little further from the nearest one - never a different world. */

export interface Kept<S> { frame: number; snap: S; bytes: number }

export class Checkpoints<S> {
  /** the checkpoints, by frame; [0] is the world before any frame */
  readonly snaps: Kept<S>[] = [];
  bytes = 0;
  constructor(first: Kept<S>, public every = 240, public budget = 96 << 20) {
    this.snaps.push(first);
    this.bytes = first.bytes;
  }

  /** whether a world at this frame is one to keep */
  wants(frame: number): boolean {
    return frame > this.snaps[0].frame && frame % this.every === 0 && !this.snaps.some((x) => x.frame === frame);
  }

  /** keep a world as it stood after `frame` (made only when wanted: `make`), the spacing widened while they are
   *  over the budget */
  keep(frame: number, make: () => Kept<S>) {
    if (!this.wants(frame)) return;
    const k = { ...make(), frame };
    let i = this.snaps.length;
    while (i > 1 && this.snaps[i - 1].frame > frame) i--;
    this.snaps.splice(i, 0, k);
    this.bytes += k.bytes;
    while (this.bytes > this.budget && this.snaps.length > 2) this.thin();
  }

  /** the spacing doubled, the checkpoints between let go */
  private thin() {
    this.every *= 2;
    const kept = this.snaps.filter((x, i) => i === 0 || x.frame % this.every === 0);
    this.bytes = kept.reduce((n, x) => n + x.bytes, 0);
    this.snaps.length = 0;
    this.snaps.push(...kept);
  }

  /** the nearest checkpoint at or before a frame (the first when none is) */
  nearest(frame: number): Kept<S> {
    let best = this.snaps[0];
    for (const x of this.snaps) if (x.frame <= frame && x.frame >= best.frame) best = x;
    return best;
  }

  /** the furthest one kept */
  get last(): Kept<S> { return this.snaps[this.snaps.length - 1]; }
}

/** a world made as it is after frame `to`: loaded from the nearest checkpoint, stepped on frame by frame, the
 *  frames passed kept as checkpoints where wanted. Returns the frame it started from */
export function jumpTo<S>(store: Checkpoints<S>, to: number, load: (s: S) => void, step: (frame: number) => void,
                          save: () => Kept<S>): number {
  const from = store.nearest(to);
  load(from.snap);
  for (let g = from.frame + 1; g <= to; g++) {
    step(g);
    store.keep(g, save);
  }
  return from.frame;
}
