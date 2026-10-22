/* 3D replay viewer: Fountain of Dreams' water columns.
 *
 * Each side platform stands on a column of water: a copy of part 4 the
 * stage's code makes at the main part's joint 4 (left) and 6 (right)
 * (grIzumi_801CCBDC), looping its short animation, whose keys send up the
 * spray at its foot and its top. As its platform rises and sinks the code
 * stretches the column's root joint to the platform's height (tall by the
 * height over the column's own, 45; wide by half that and a half), and when
 * the platform goes under the water (the column down to -1) the column is
 * hidden until it comes back up (grIzumi_801CC358). A viewer track says how high each platform is
 * ("fod"), whatever the replay's version, and so does the replay from Slippi
 * 3.18 on; else they stand where the file starts them. The platforms are the
 * main part's joints, which the stage poses from the heights apply leaves.
 */
import type { Part, Run, Stage, StageFrame, StageLogic } from "../stage";
import type { Emitter } from "./particles";

interface Column { part: Part; side: 0 | 1; tall: number }

/** a platform this low is under the water (the code sets it just under its column's foot) */
const SUNK = -1.5;
/** the height a column sinks to (grIzumi_801CC358's state 1: xD4 = -1) */
const SINK = -1;
const columns = new WeakMap<Stage, Column[]>();

export class Fountain implements StageLogic {
  private cols: Column[] = [];
  /** each side's column's animation: from the stage's building, or from the frame after it last came back up */
  private runs: [Run[], Run[]] = [[{ anim: 0, joint: 0, deep: true, from: 0, rate: 1 }],
                                  [{ anim: 0, joint: 0, deep: true, from: 0, rate: 1 }]];
  /** each side's frames its column came back up on, found up to `scanned` */
  private back: [number[], number[]] = [[], []];
  private scanned = [0, 0];
  /** the two the main part's code makes as the stage is built and keeps
   *  going (grIzumi_801CBE64: generators 0x7534 at the middle, 0x7536 by the
   *  fountain), each under the stage's scale */
  readonly emitters: Emitter[];

  constructor(st: Stage, private heightAt: (frame: number, side: 0 | 1) => number | undefined) {
    const s = st.scale;
    const at = (x: number, y: number, z: number, gen: number): Emitter =>
      ({ gen, from: 0, to: null, srt: { tx: x * s, ty: y * s, tz: z * s, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false } });
    this.emitters = [at(0, 0, 0, 0x7534), at(0, 1, -27, 0x7536)];
    // (made once per stage: another replay on it uses the same two)
    const made = columns.get(st);
    if (made) { this.cols = made; return; }
    columns.set(st, this.cols);
    const main = st.partOf(3);
    if (!main) return;
    main.skeleton.resetPose();
    main.skeleton.update(main.place);
    ([[4, 0], [6, 1]] as const).forEach(([joint, side]) => {
      const at = main.skeleton.position(joint);
      const e = st.copyOf(4, `stage${st.stageId}:column${side}`);
      if (!e) return;
      const m = e.place;
      m[12] = at[0]; m[13] = at[1]; m[14] = at[2];
      e.skeleton.update(m);
      // the column's own height: its joint 2 over its foot
      const tall = e.joints.length > 2 ? (e.skeleton.position(2)[1] - at[1]) / (st.scale || 1) : 45;
      st.extras.push(e);
      // (as a viewer track names them: the game makes the left one first, and its table keeps the second)
      st.named.set(side === 0 ? 1004 : 4, e);
      this.cols.push({ part: e, side, tall: tall || 45 });
    });
  }

  private height(st: Stage, frame: number, side: 0 | 1): number {
    return this.heightAt(frame, side) ?? st.fountainStart?.[side] ?? 20;
  }

  /** whether a column is under the water this frame: its platform below SUNK, or the column's height at the
   *  sink's -1 (grIzumi_801CC358 sends it there, xD4 = -1) and on the frames either side too. It is shown on the
   *  frame it gets there (the code hides it the frame after, in its state 3) and on the frame it comes back up
   *  (state 4 shows it, its height still -1, and raises it from the next) */
  private under(st: Stage, frame: number, side: 0 | 1): boolean {
    if (this.height(st, frame, side) < SUNK) return true;
    return this.heightAt(frame, side) === SINK && this.heightAt(frame - 1, side) === SINK && this.heightAt(frame + 1, side) === SINK;
  }

  /** the last frame up to `frame` a sunk column came back up on, or -1. Sunk, the code takes its animation
   *  away (grIzumi_801CC358's state 3: HSD_JObjRemoveAnimAll); coming back up (state 4) it starts it again
   *  from 0 (grAnime_801C7FF8 at frame 0.0) in its callback, after that frame's HSD_JObjAnimAll
   *  (Ground_801C1CD0): the animation's frame 0 is the next frame's */
  private cameBack(st: Stage, frame: number, side: 0 | 1): number {
    const list = this.back[side];
    for (let f = this.scanned[side] + 1; f <= frame; f++) {
      if (this.under(st, f - 1, side) && !this.under(st, f, side)) list.push(f);
      this.scanned[side] = f;
    }
    for (let k = list.length - 1; k >= 0; k--) if (list[k] <= frame) return list[k];
    return -1;
  }

  apply(st: Stage, frame: number) {
    st.fodHeights = [this.heightAt(frame, 0), this.heightAt(frame, 1)];
    for (const c of this.cols) {
      if (this.under(st, frame, c.side)) continue;
      const run = this.runs[c.side], back = this.cameBack(st, frame, c.side);
      run[0].from = back < 0 ? 0 : back + 1;
      st.extraRuns.set(c.part, run);
    }
  }

  pose(st: Stage, frame: number, sf: StageFrame | undefined) {
    for (const c of this.cols) {
      if (!st.extraRuns.has(c.part)) continue;
      // (the track's or the replay's for this frame; the frame handed in when neither says)
      const h = this.heightAt(frame, c.side) ?? (c.side === 0 ? sf?.fodLeftPlatformHeight : sf?.fodRightPlatformHeight) ??
        this.height(st, frame, c.side);
      const f = Math.max(0.01, h / c.tall);
      const sk = c.part.skeleton;
      if (sk.n < 2) continue;
      // (the joint under the object's own root - HSD_JObjGetChild of it: the file's root joint, the part's
      // joint 0 here. The game puts a joint of its own above a stage object's file root, and its
      // Ground_801C3FA4 counts from the file's root: that function's 2 is this part's joint 2, the height)
      sk.scale[0] = 0.5 * f + 0.5;
      sk.scale[1] = f;
    }
  }
}
