/* 3D replay viewer: what each stage's own code does, for one
 * replay.
 *
 * The stage's file has the models and their animations; its code decides
 * which parts are up, which animation each is on and from when, and makes
 * particles of its own. This puts together, for a stage and a replay, what
 * is known of that: the viewer track's record of the animations the code
 * started ("ganim") and of Battlefield's background ("bg"), and each
 * stage's own logic (Final Destination's background, Dream Land's Whispy
 * and birds, Fountain of Dreams' water, Pokemon Stadium's screen) - from the
 * track when it has what is needed, else worked out the game's way - and,
 * last, the joints as the game posed them, when the track has them ("sp").
 */
import type { ReplayData } from "~/common/types";
import type { Stage, StageLogic } from "../stage";
import type { StageFrame } from "../stage";
import type { ViewerTrack } from "../track";
import { TrackAnims } from "./anims";
import { TrackJoints } from "./joints";
import { FinalDestination, fixedSchedule, trackSchedule } from "./finaldest";
import { Emitter, StageParticles } from "./particles";
import { Fountain } from "./fountain";
import { StadiumForms, StadiumScreen } from "./stadium";
import { Birds, Whispy } from "./dreamland";
import { Randall } from "./story";
import { stageFrame } from "~/simulation-stage";

/** The generators the stage's code made itself, as the viewer track has
 *  them ("sgen": the stage object, bank, generator, where, and its random
 *  seed): these replace the stand-ins for the same generators. Bank 0 is the
 *  common effects' (Randall's puffs, made where his joint is), 30 the
 *  stage's own (placed at their point, at the stage's scale:
 *  grLib_801C96F8). Final Destination's burst keeps the player's own place
 *  (the track's comes out at its joint's local point). */
function withTrackGens(st: Stage, tr: ViewerTrack, ours: Emitter[]): Emitter[] {
  const fd = st.info.file === "GrNLa";
  const out: Emitter[] = [];
  const ids = new Set<number>();
  for (const e of tr.between("sgen", -1000, 1e9)) {
    const [, , , bank, gen, x, y, z] = e.map(Number);
    if (fd && gen === 30001) continue;
    ids.add(gen);
    const s = bank === 0 ? 1 : st.scale;
    out.push({ gen, bank: bank === 0 ? "common" : undefined, from: Number(e[0]) + 123, to: null,
               srt: { tx: x, ty: y, tz: z, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false } });
  }
  return [...ours.filter((e) => !ids.has(e.gen)), ...out];
}

/** the stage's code for one replay: its logic (set on the stage) and its particles */
export class StageScene implements StageLogic {
  readonly particles: StageParticles;
  private parts: StageLogic[] = [];
  private battle: [number, ...(number | string)[]][] | null = null;
  /** Pokemon Stadium's big screen, when this is that stage */
  screen: StadiumScreen | null = null;
  /** Pokemon Stadium's forms, when this is that stage */
  forms: StadiumForms | null = null;

  constructor(readonly st: Stage, readonly track: ViewerTrack | null, readonly data: ReplayData) {
    const emitters: Emitter[] = [];
    if (track?.has("ganim")) this.parts.push(new TrackAnims(track));
    if (st.info.file === "GrNBa") {
      this.battle = (track?.changes("bg", "") ?? []).map(([f, ...v]) => [Number(f) + 123, ...v]);
    }
    if (st.info.file === "GrNLa") {
      const last = data.frames.length - 123;
      const sched = track?.has("fd") ? trackSchedule(track)
        : data.fdFrozen ? { phases: [{ at: -123, phase: 1 }], fades: [] } : fixedSchedule(st, last);
      const fd = new FinalDestination(st, sched, track, last);
      this.parts.push(fd);
      emitters.push(...fd.emitters);
    }
    if (st.info.file === "GrIz") {
      // (the platforms' heights are in replays from Slippi 3.18 on, and the embedding page may send them for
      // older ones: stageFrame)
      // (and in a viewer track that has them, "fod": the game's own, whatever the replay's version)
      const tracked = track?.has("fod") ? track : null;
      const fod = new Fountain(st, (frame, side) => {
        const t = tracked?.valid(frame - 123) ? tracked.at("fod", "", frame - 123) : null;
        if (t) return Number(t[side]);
        const s = stageFrame(data, frame);
        return side === 0 ? s?.fodLeftPlatformHeight : s?.fodRightPlatformHeight;
      });
      this.parts.push(fod);
      emitters.push(...fod.emitters);
    }
    if (st.info.file === "GrSt") emitters.push(...new Randall(st, data).emitters);
    if (st.info.file === "GrOp") {
      // (Whispy from the track's starts when it has them; the birds from its flights)
      if (!track?.has("ganim")) this.parts.push(new Whispy(st, data));
      this.parts.push(new Birds(st, data, track));
    }
    // (Stadium's forms: after the track's animation starts, which it holds still on a form being replaced)
    if (st.info.file === "GrPs" && st.forms?.size) {
      this.parts.push((this.forms = new StadiumForms(st, data, track)));
      // (what the forms' code makes; a track that has the stage's own generators has the game's)
      if (!track?.has("sgen")) emitters.push(...this.forms.emitters);
    }
    if (st.info.file === "GrPs" && st.screen && typeof document !== "undefined") {
      this.screen = new StadiumScreen(st, data, track);
      this.parts.push(this.screen);
      emitters.push(...this.screen.emitters);
    }
    // (the joints as the game posed them, when the track has them: over all of the above)
    if (track?.has("sp")) this.parts.push(new TrackJoints(track));
    st.logic = this;
    this.particles = new StageParticles(st);
    this.particles.emitters = track?.has("sgen") ? withTrackGens(st, track, emitters) : emitters;
    if (this.forms && !track?.has("sgen")) this.particles.enders = this.forms.enders;
  }

  apply(st: Stage, frame: number) {
    st.resetFrame();
    if (this.battle) st.setBattle(this.battle, frame);
    for (const p of this.parts) p.apply(st, frame);
  }

  pose(st: Stage, frame: number, sf: StageFrame | undefined) {
    for (const p of this.parts) p.pose?.(st, frame, sf);
  }
}
