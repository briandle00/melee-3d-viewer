/* 3D replay viewer: a stage, from your own stage file.
 *
 * A stage file (GrXx.dat) holds its models as numbered parts in map_head,
 * each with its animations, material animations and lights. The game's own
 * code decides which parts a match builds and where a few of them go; what
 * is here was learned by looking at the parts (which ones are the stage,
 * the platforms, the background) and is written in our own words. The
 * models, positions, colors and animations are all read from the file.
 */
import { AObj, Archive, DObj, Image, JObj, MatAnim, loadAnimJoint, loadJoint, loadLights, loadMatAnimJoint, parseArchive, ptr } from "./hsd";
import { DEFAULT_LIGHTS, LightSet, applyOverrides } from "./lightset";
import { type Fog, RENDER } from "./gx";
import { Mat, ident } from "./math";
import { Skeleton, type Drawable, type MatState } from "./skeleton";
import type { Lettering } from "./sistext";
import { Prop } from "./prop";
import type { StageCamera } from "./camera";
import { Overlay, type Tint } from "./fx/colanim";
import { keyEvents } from "./fx/bank";
import { type Collision, floorTestOf, Floors, partBindings, readCollision, readFloors, readFloorTest } from "./collision";
import type { FloorTest } from "./dynamics";

export interface StageInfo {
  file: string;
  name: string;
  /** the map_head parts a match shows */
  parts: number[];
  /** the map_head parts whose light list lights the stage and whose fog is
   *  the stage's (the parts the stage's code flags so: its StageCallbacks'
   *  first and second flags) */
  lightsPart: number;
  fogPart: number;
  /** part -> [joint, animation set]: a joint (and all under it) the stage's
   *  code starts on another of the part's animation sets than the first */
  animSets?: Record<number, [number, number][]>;
  /** part -> the layer the stage's code puts it on (2 is drawn first, then
   *  1, then everything else), and the render flags it sets on the materials
   *  of a joint and all under it (0x20000000: it hides nothing drawn after
   *  it; 0x08000000: it is drawn over whatever is there already). Only the
   *  parts whose materials the code changes: moving the others' see-through
   *  meshes ahead hid Final Destination's grid under its top */
  layers?: Record<number, { layer: number; flags?: number; joint?: number }>;
  /** parts whose setup starts no animation (their StageCallbacks' first
   *  function calls no grAnime_801C8138, and the ground's own setup starts
   *  none): they stand as the file has them until the code starts one */
  idle?: number[];
  /** parts the stage's code shows only later (Battlefield's other
   *  backgrounds and the wireframe between them): loaded, not drawn until
   *  something says they are up (setBattle) */
  later?: number[];
  /** part -> joints the stage's code hides as it builds the part (with all
   *  under them: HSD_JObjSetFlagsAll(JOBJ_HIDDEN)) */
  hide?: Record<number, number[]>;
  /** parts only a mirror image shows (Fountain's pond) */
  mirrorOnly?: number[];
  /** part -> the margin of the stage's shadow check (its
   *  on_check_shadow_render: a fighter's shadow is on a joint when the
   *  fighter's height plus this is above the joint's), for the parts whose
   *  code sets x10_flags.b5 (grDisplay_801C5B90 then asks it joint by joint);
   *  the other parts take every shadow. `forms`: the same for every part of a
   *  transformation */
  shadowCheck?: Record<number, number>;
  formShadowCheck?: number;
}

// Fighters' shadows: none, as in the game. The game draws a fighter's
// silhouette, seen from a stage light, onto only the stage joints a part
// lists as taking shadows (map_head's parts, +0x2C and +0x30) - and none of
// these six stages' parts list any, nor does any of their materials take
// them by itself. Dolphin's frames of the six agree: no shadow under a
// fighter standing or in the air.
//
// external stage id -> its file and the parts a match shows
export const STAGES: Record<number, StageInfo> = {
  // Fountain of Dreams: part 2 is scenery only the pond's mirror sees: the
  // code puts it on a layer (link 2) the mirror's camera draws and the
  // match's does not, its joints 2 and 3 hidden (grIzumi_801CCA64, 801CCEA0)
  // (the shadow checks: grIzumi_801CBE64 sets b5 on part 3, its check
  // grIzumi_801CD280 is "above the joint"; Stadium's grStadium_801D1570 on
  // part 5 and its forms' parts 3, 4, 6 and 9, its check
  // grStadium_OnCheckShadowRender "1 below the joint or above")
  2: { file: "GrIz", name: "Fountain of Dreams", parts: [0, 1, 2, 3], lightsPart: 3, fogPart: 3,
       hide: { 2: [2, 3] }, mirrorOnly: [2], shadowCheck: { 3: 0 } },
  3: { file: "GrPs", name: "Pokémon Stadium", parts: [0, 1, 2, 5], lightsPart: 2, fogPart: 2,
       shadowCheck: { 5: 1 }, formShadowCheck: 1 },
  // Yoshi's Story: the Shy Guys' part starts its joint 5 (a cardboard figure
  // on a stick, walking across the back) on its second animation set
  // (grStory's Shy Guy setup: grAnime(gobj, 5, 7, 1, ...)); on the first it
  // stood in the sky, stretched
  8: { file: "GrSt", name: "Yoshi's Story", parts: [0, 1, 2, 3], animSets: { 3: [[5, 1]] },
       lightsPart: 3, fogPart: 3,
       layers: { 1: { layer: 2, flags: 0x20000000, joint: 1 } },
       // (grStory_801E3234 sets b5 on part 3; grStory_801E36D8: 1 below the joint or above)
       shadowCheck: { 3: 1 } },
  // Dream Land: the sky and its rainbow (part 3) are a flat picture close
  // behind the tree, drawn first and hiding nothing (a star KO flies past it)
  28: { file: "GrOp", name: "Dream Land N64", parts: [0, 1, 3, 4, 5, 6, 7, 8],
        lightsPart: 5, fogPart: 5,
        // (the flowers' setup, grOldPupupu_80211C10, is empty: they bend first when Whispy blows,
        // grOldPupupu_80211C1C)
        idle: [6],
        layers: { 3: { layer: 2, flags: 0x28000000, joint: 0 } },
        // (grOldPupupu_80210B04 sets b5 on part 4; grOldPupupu_80211CA8: above the joint)
        shadowCheck: { 4: 0 } },
  // Battlefield: part 3 is the wireframe the background passes through when
  // it changes, hidden until then (grBattle_BG_Callback0); the match starts
  // on background 1. It changes 40 to 60 seconds in, to 2 or 4, as the
  // game's random numbers fall - which a replay does not give: without a
  // viewer track (track.ts, setBattle) 1 stays. The backgrounds and the
  // wireframe are on the background's layer (their callbacks' x11 b012 = 2:
  // grDisplay_801C5DB0 draws them with that camera), in the order the code
  // made them: the wireframe, then the background up, then the next one
  // (battleOrder) - the background's light added over the wireframe's black
  31: { file: "GrNBa", name: "Battlefield", parts: [0, 1, 2, 3, 4, 6], later: [2, 3, 4],
        lightsPart: 6, fogPart: 6,
        layers: { 1: { layer: 2 }, 2: { layer: 2 }, 3: { layer: 2 }, 4: { layer: 2 } } },
  // Final Destination: parts 4 to 8 are the background, 9 the one that
  // stands in for them part of the time: its code decides (gr/finaldest.ts)
  32: { file: "GrNLa", name: "Final Destination", parts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], later: [9],
        lightsPart: 3, fogPart: 4 },
};

/** a stage part's color overlay `t` frames after its script started (it is
 *  run once on its first frame, grMaterial_801C9604): its color blended over
 *  the part's by its alpha, as a fighter's (grmaterial.c), or null once off.
 *  The last one asked is kept and stepped on from there. */
const overlays = new WeakMap<Archive, Map<number, { t: number; o: Overlay }>>();
export function groundOverlay(a: Archive, script: number, t: number): Tint | null {
  let mine = overlays.get(a);
  if (!mine) overlays.set(a, (mine = new Map()));
  let run = mine.get(script);
  if (!run || run.t > t) {
    const o = new Overlay();
    o.startAt(script);
    o.step({ a }, null);
    mine.set(script, (run = { t: 0, o }));
  }
  while (run.t < t) { run.o.step({ a }, null); run.t++; }
  const o = run.o;
  if (!o.colorOn) return null;
  return { color: [o.color[0] / 255, o.color[1] / 255, o.color[2] / 255, Math.max(0, Math.min(255, o.color[3] | 0)) / 255],
           light: null };
}

/** what a replay frame tells the stage (Fountain of Dreams' platforms) */
export interface StageFrame {
  fodLeftPlatformHeight?: number;
  fodRightPlatformHeight?: number;
}

// Pokemon Stadium's forms: the replay's type -> its file (GrPs1-4.dat,
// read from your own game files). The game's own
// list (grpstadium.c's datfiles) is fire, grass, water, rock: water (9) is
// the third file and rock (6) the fourth. The normal form (5) is the main
// file's part 5.
export const STADIUM_FORMS: Record<number, string> = { 3: "GrPs1", 4: "GrPs2", 9: "GrPs3", 6: "GrPs4" };
export const STADIUM_NORMAL = 5;

/** one of Pokemon Stadium's forms as it stands on a frame: its type, the
 *  height it is flattened to (the scale along y of the joint the game has
 *  above its model; the stage's scale when whole), how far it is moved along
 *  y, the frame it was made on (the replay's index; -1: with the stage) and
 *  the frame its animations were stopped on, if they were */
export interface FormUp { form: number; scaleY: number; y: number; born: number; stopped: number | null }

/** a transformation's lengths in frames, from the stage file's
 *  yakumono_param: how long the screen shows what is coming (+0x10), how
 *  long a form takes to go flat or to come up (+0x14), and how long the flat
 *  one waits (+0x18) */
export interface StadiumTimes { wait: number; change: number; hold: number }
export const STADIUM_TIMES: StadiumTimes = { wait: 300, change: 120, hold: 60 };

const f32 = Math.fround;

/** The forms Stadium has up on a frame (one, or two while one comes up over
 *  the other), as the game's own code moves them (grStadium_801D4548). A
 *  replay's events are the code's steps as they change, each with the form
 *  that is coming: at 4 the form that is up starts to go flat - each frame
 *  0.95 / `change` less of its height, down to a twentieth, where it waits;
 *  at 5 its animations are stopped and the new form is made, a twentieth
 *  high and 10 down; over `change` frames the new one grows to its height
 *  (and comes up the 10 in the first half) while the old one goes down 10 in
 *  the second half; then (6) the old one is gone. Nothing else of the stage
 *  moves. */
export function stadiumForms(events: { frame: number; event: number; type: number }[] | undefined, frame: number,
                             t: StadiumTimes = STADIUM_TIMES, scale = 1): FormUp[] {
  let cur: FormUp = { form: STADIUM_NORMAL, scaleY: scale, y: 0, born: -1, stopped: null };
  let next: FormUp | null = null;
  let at4 = -1, at5 = -1;
  for (const e of events ?? []) {
    if (e.frame > frame) break;
    if (e.event === 4) { at4 = e.frame; at5 = -1; next = null; }
    else if (e.event === 5) {
      at5 = e.frame;
      cur = { ...cur, stopped: e.frame };
      next = { form: e.type, scaleY: scale, y: 0, born: e.frame, stopped: null };
    } else if (e.event === 6) {
      // (a replay that starts part way through has no 5 for it: the form is up all the same)
      cur = next ?? { form: e.type, scaleY: scale, y: 0, born: e.frame, stopped: null };
      next = null; at4 = at5 = -1;
    }
  }
  const change = Math.max(1, t.change), half = Math.trunc(change / 2), least = f32(0.05 * scale);
  if (next && at5 >= 0) {
    const n = frame - at5;
    // (the step after the rise's last frame is the one that says 6: past it without one, the rise is over)
    if (n > change) return [next];
    const grown = n === 0 ? least : f32(f32(f32(0.95 * n) / change + 0.05) * scale);
    const up = n === 0 ? -10 : n < half ? f32(-10 * scale * f32(1 - n / half)) : 0;
    const down = n > half ? f32(-10 * scale * f32(1 - (change - n) / (change - half))) : 0;
    return [{ ...cur, scaleY: f32(0.05), y: down }, { ...next, scaleY: grown, y: up }];
  }
  if (at4 >= 0) {
    // (each frame's step as the game takes it, in single precision)
    let sy = f32(scale);
    const step = f32(scale * f32(0.95 / change));
    for (let k = frame - at4; k > 0 && sy !== f32(0.05); k--) {
      const shrunk = f32(sy - step);
      sy = shrunk > least ? shrunk : f32(0.05);
    }
    return [{ ...cur, scaleY: sy }];
  }
  return [cur];
}

/** A replay's Stadium events worked out from a viewer track's screens, for a
 *  replay too old to have its own (before Slippi 3.18): the screen shows the
 *  coming form's picture (modes 2 to 6) on the frame the code goes to step
 *  3, and the steps after it follow by the file's lengths. Frames as the
 *  replay's index. */
export function stadiumEventsFromScreens(screens: { frame: number; mode: number }[], t: StadiumTimes = STADIUM_TIMES):
    { frame: number; event: number; type: number }[] {
  const TYPE: Record<number, number> = { 2: 5, 3: 3, 4: 4, 5: 9, 6: 6 };
  const out: { frame: number; event: number; type: number }[] = [];
  // (the frames a form takes to go flat: the game's own steps, counted)
  let flat = 0;
  for (let sy = f32(1), step = f32(f32(0.95 / Math.max(1, t.change))); flat < 100000; ) {
    flat++;
    sy = f32(sy - step);
    if (!(sy > f32(0.05))) break;
  }
  for (const s of screens) {
    const type = TYPE[s.mode];
    if (type === undefined) continue;
    // (the wait's count passes its length on its second frame over; the flat form waits the same way)
    const at4 = s.frame + t.wait + 2, at5 = at4 + flat + t.hold + 1, at6 = at5 + Math.max(1, t.change) + 1;
    out.push({ frame: s.frame, event: 3, type }, { frame: at4, event: 4, type }, { frame: at5, event: 5, type }, { frame: at6, event: 6, type });
  }
  return out;
}

export interface Part {
  index: number;
  skeleton: Skeleton;
  anim: (AObj | null)[] | null;
  matAnim: (MatAnim | null)[][] | null;
  joints: JObj[];
  /** true when nothing about it changes from frame to frame */
  still: boolean;
  /** where it sits: the stage's scale */
  place: Mat;
  /** its layer (StageInfo.layers): 0 for most */
  layer: number;
  /** its file and its map_head entry: its other animation sets are read from there when asked */
  archive: Archive;
  entry: number;
}

/** An animation the stage's code runs on a part: the part's animation set
 *  `anim`, on one joint or a joint and all under it (deep), at time
 *  (frame - from) * rate - frames as the replay's index, `from` the frame
 *  its time is 0. Played once and held at its end when the code cleared its
 *  loop (once), else looping as the file (or the code) says; held at `hold`
 *  when the code stopped it there. */
export interface Run {
  anim: number;
  joint: number;
  deep: boolean;
  from: number;
  rate: number;
  once?: boolean;
  /** looping whatever the file says */
  loop?: boolean;
  hold?: number;
}

/** a particle a part's animation starts (a key on a joint's track 0x28): its time in the animation, bank and generator */
export interface PtclKey { joint: number; time: number; bank: number; gen: number }

/** What a stage's own code does over a match, frame by frame (gr/*.ts):
 *  which parts are up, on which animations, in which color, and the
 *  color behind everything. Asked with the replay's frame index; what it
 *  says for a frame depends on that frame alone. */
export interface StageLogic {
  apply(st: Stage, frame: number): void;
  /** what the code moves itself, once the parts are on their animations
   *  (set on their skeletons' poses, before their matrices are made) */
  pose?(st: Stage, frame: number, sf: StageFrame | undefined): void;
}

export class Stage {
  parts: Part[] = [];
  info: StageInfo;
  scale: number;
  /** the fighters' shadows' gray (grGroundParam +0x04) */
  shadowIntensity: number;
  /** the lights the stage is lit by (the flagged part's list, as the stage
   *  file's overrides leave it) */
  lighting: LightSet;
  /** the lights the fighters, items and effects are lit by (map_plit) */
  playerLighting: LightSet;
  /** the stage's fog (the flagged part's), at the stage's scale, or null */
  fog: Fog | null = null;
  /** whether its materials take the renderer's mirror image (Fountain's pond) */
  mirror = false;
  private archive: Archive;
  /** Yoshi's Story: the Shy Guy's model (a stage item), and its scale */
  shyGuy: { prop: Prop; prop2: Prop | null; scale: number } | null = null;
  /** how far the camera goes (the game's camera range: general points 0x95
   *  and 0x96, at the stage's scale), or null without them */
  camBounds: { left: number; right: number; top: number; bottom: number } | null = null;
  /** what the game's match camera takes from the stage (camera.ts), or null */
  camera: StageCamera | null = null;
  /** Pokemon Stadium: the big screen's image (the game renders into it) and its part */
  screen: { image: Image; part: Part; states: MatState[] } | null = null;

  /** Pokemon Stadium's screen's color source as its code sets it with what
   *  it shows (grStadium_801D21E4): a copy of the match (modes 7, 8) in a
   *  constant color, the screen's green, instead of its vertex colors;
   *  the rest in its vertex colors. The materials whose mode changed (their
   *  TEV made again: HSD_MObjCompileTev) */
  setScreenConstant(on: boolean, color: [number, number, number]): MatState[] {
    const out: MatState[] = [];
    for (const s of this.screen?.states ?? []) {
      const m = s.mobj, was = m.renderMode;
      m.renderMode = on ? ((was & ~RENDER.VERTEX) | RENDER.CONSTANT) >>> 0 : ((was | RENDER.VERTEX) & ~RENDER.CONSTANT) >>> 0;
      if (on) {
        const c = color.map((v) => v / 255);
        m.diffuse = [c[0], c[1], c[2], m.diffuse[3]];
        s.diffuse.set(m.diffuse);
      }
      if (m.renderMode !== was) out.push(s);
    }
    return out;
  }
  /** its floors' slopes (its collision data: collision.ts), or null without them */
  floors: Floors | null = null;
  /** its floor lines for the fighters' swinging parts (dynamics.ts), or null */
  floorTest: FloorTest | null = null;
  /** its collision groups and floor lines (floorTestAt) */
  private collision: Collision | null = null;
  private floorAt: { frame: number; test: FloorTest } | null = null;

  /** The floor test the fighters' swinging parts make on a frame (the replay's index), as the game's lines stand
   *  then (mpLib): a group its code binds to a part's joint (the part's map_head list, +0x20) moved by that
   *  joint's matrix on the frame, and left out while its part is not up (a Stadium form not standing); the
   *  rest at the file's places times the stage's scale (mpLibLoad). The parts are posed for the frame and put
   *  back for the one drawn. */
  floorTestAt(frame: number): FloorTest | null {
    const c = this.collision;
    if (!c) return this.floorTest;
    if (this.floorAt?.frame === frame) return this.floorAt.test;
    const s = this.scale, drawn = this.frame;
    const owner = new Map<number, { part: Part; joint: number }>();
    const cands = [...this.parts, ...[...this.forms.values()].flat()];
    for (const p of cands) for (const b of partBindings(p.archive, p.entry)) if (!owner.has(b.group)) owner.set(b.group, { part: p, joint: b.joint });
    // (which parts are up on the frame: Stadium's forms by its logic for it)
    if (this.forms.size) this.logic?.apply(this, frame);
    const up = (p: Part) => (this.isForm(p) ? !!this.formUpOf(p) : this.up.has(p.index));
    const posed = new Set<Part>(), world = new Map<number, Float32Array | null>();
    for (const [g, o] of owner) {
      if (!up(o.part)) { world.set(g, null); continue; }
      if (!posed.has(o.part)) { this.poseAt(o.part, frame); posed.add(o.part); }
      const W = o.part.skeleton.world;
      world.set(g, o.joint >= 0 && (o.joint + 1) * 16 <= W.length ? W.slice(o.joint * 16, o.joint * 16 + 16) : null);
    }
    const segs: number[][] = [];
    const at = (v: number, W: Float32Array | null | undefined): [number, number] => {
      const x = c.verts[v * 2], y = c.verts[v * 2 + 1];
      return W ? [W[0] * x + W[4] * y + W[12], W[1] * x + W[5] * y + W[13]] : [x * s, y * s];
    };
    for (const l of c.floors) {
      const W = l.group >= 0 && owner.has(l.group) ? world.get(l.group) : undefined;
      if (W === null) continue;
      segs.push([...at(l.v0, W), ...at(l.v1, W)]);
    }
    // (the drawn frame as it was)
    for (const p of posed) this.poseAt(p, drawn);
    if (this.forms.size) this.logic?.apply(this, drawn);
    const test = floorTestOf(segs);
    this.floorAt = { frame, test };
    return test;
  }
  /** Fountain of Dreams: the main part, and where its side platforms start */
  private fod: { main: Part; start: [number, number]; mirror: Part | null } | null = null;

  constructor(buf: ArrayBuffer, public stageId: number) {
    const info = STAGES[stageId];
    if (!info) throw new Error(`no 3D model for stage ${stageId}`);
    this.info = info;
    const a = (this.archive = parseArchive(buf));
    // grGroundParam starts with the stage's scale (Battlefield 0.8, Yoshi's 0.7, ...)
    const gp = a.publics.get("grGroundParam");
    this.scale = gp === undefined ? 1 : a.data.getFloat32(gp);
    // (and its fighters' shadows' gray, an s16 at +0x04: Ground_801C0508, 128 without one)
    this.shadowIntensity = gp === undefined ? 128 : a.data.getInt16(gp + 4);
    const head = a.publics.get("map_head");
    if (head === undefined) throw new Error("not a stage file (no map_head)");
    // the materials that take the fighters' shadows: map_head +0x28 lists them
    // (+0x2C how many), and the game sets RENDER_SHADOW in each one's render
    // mode as the file is read (grDatFiles_801C6228) - here too, before the
    // parts are made from them
    {
      const list = ptr(a, head + 0x28), n = a.data.getUint32(head + 0x2c);
      for (let i = 0; list !== null && i < n && i < 4096; i++) {
        const m = ptr(a, list + i * 4);
        if (m !== null) a.data.setUint32(m + 4, (a.data.getUint32(m + 4) | RENDER.SHADOW) >>> 0);
      }
    }
    this.floors = readFloors(a);
    this.floorTest = readFloorTest(a);
    this.collision = readCollision(a);
    for (const i of info.parts) {
      const p = this.part(i);
      if (p) this.parts.push(p);
    }
    // the lights and the fog, as the game's ground code sets them up: the
    // file's list of lights and which of their parts are on (map_head +0x18),
    // and of the light animations that loop (+0x20)
    const d = a.data, arr = ptr(a, head + 0x08);
    const overrides = new Map<number, number>(), loops = new Set<number>();
    const ov = ptr(a, head + 0x18), nov = d.getUint32(head + 0x1c);
    for (let i = 0; ov !== null && i < nov && i < 256; i++) overrides.set(ptr(a, ov + i * 8) ?? -1, d.getUint8(ov + i * 8 + 4));
    const lp = ptr(a, head + 0x20), nlp = d.getUint32(head + 0x24);
    for (let i = 0; lp !== null && i < nlp && i < 256; i++) if (d.getUint8(lp + i * 8 + 4) & 0x80) loops.add(ptr(a, lp + i * 8) ?? -1);
    const part = (i: number, at: number) => (arr === null ? null : ptr(a, arr + i * 0x34 + at));
    // The two sets' clocks, as their light objects are made: the stage's
    // (Ground_801C466C) steps its animations once as it is made
    // (HSD_LObjAnimAll), so they stand one frame ahead of the stage's own; the
    // fighters' (ftCo_8009F4A4) starts at frame 0 (HSD_LObjReqAnimAll) and is
    // stepped once a frame by its own proc (ftCo_8009F480), so it stands at
    // the replay's frame (the game's recorded light colors show both, exact
    // on every frame recorded on Fountain). Fountain's code makes every
    // animation of the fighters' set loop (grIzumi_OnLoad)
    const list = part(info.lightsPart, 0x18);
    this.lighting = new LightSet(list === null ? DEFAULT_LIGHTS : applyOverrides(loadLights(a, list), overrides), this.scale, loops,
                                 { ahead: 1 });
    const plit = a.publics.get("map_plit");
    this.playerLighting = new LightSet(plit === undefined ? DEFAULT_LIGHTS : applyOverrides(loadLights(a, plit), overrides), this.scale,
                                       new Set(), { ahead: 0, loopAll: info.file === "GrIz" });
    const fog = part(info.fogPart, 0x1c);
    if (fog !== null) {
      this.fog = { type: d.getUint32(fog), start: d.getFloat32(fog + 8) * this.scale, end: d.getFloat32(fog + 12) * this.scale,
                   color: [d.getUint8(fog + 16) / 255, d.getUint8(fog + 17) / 255, d.getUint8(fog + 18) / 255] };
    }
    this.camBounds = camBoundsOf(a, this.scale);
    this.camera = cameraOf(a, this.scale);
    if (info.file === "GrIz") this.setupFountain();
    if (info.file === "GrSt") this.shyGuy = shyGuyOf(a, stageId);
    // Fountain's pond takes the renderer's mirror image; Pokemon Stadium's
    // big screen is drawn into by its code (gr/stadium.ts)
    const screen = info.file === "GrPs" ? /PStadiumBG_OVDummy/ : null;
    this.mirror = hideRenderTargets(a, this.parts, screen);
    if (screen) this.screen = screenOf(a, this.parts, screen);
    for (const p of this.parts) p.skeleton.update(p.place);
    this.drawOrder = [...this.parts].sort((p, q) => q.layer - p.layer);
    for (const p of this.parts) this.layer.set(p.skeleton, p.layer);
    for (const p of this.parts) if (!info.later?.includes(p.index)) this.up.add(p.index);
  }

  /** the parts, layer 2 first, then 1, then the rest (a stable sort) */
  private drawOrder: Part[] = [];
  private layer = new Map<Skeleton, number>();
  /** the parts up now (StageInfo.later: the rest wait to be shown) */
  readonly up = new Set<number>();
  /** parts whose animation the stage's code started on a frame of its own, played once from there */
  private animFrom = new Map<number, number>();
  /** a part's color overlay this frame (the ground's ColorOverlay), by its skeleton */
  readonly tints = new Map<Skeleton, Tint>();
  /** the animations the stage's code has each part on this frame (a part
   *  not here plays its first set, looping, from the match's start) */
  readonly runs = new Map<number, Run[]>();
  /** what the stage's own code does (gr/*.ts), when this stage has it */
  logic: StageLogic | null = null;
  /** the color behind everything this frame, when the stage's code sets it */
  background: [number, number, number] | null = null;
  /** extra copies of parts the code makes more than one of (Fountain's
   *  water columns), drawn after the parts, each at its own place */
  readonly extras: Part[] = [];
  /** the copy a viewer track's stage object number stands for, when it is
   *  not the part of that index: the game's table keeps one object a number,
   *  the last made, and the track names another of the same number by the
   *  number plus 1000 for each made before it (Fountain's columns are both
   *  number 4: 1004 the left one, made first, 4 the right) */
  readonly named = new Map<number, Part>();

  /** back to what a frame has before the stage's code has its say: the
   *  parts a match starts with up, on their first animations, in their own
   *  colors */
  resetFrame() {
    this.runs.clear();
    this.extraRuns.clear();
    this.tints.clear();
    this.background = null;
    this.fodHeights = null;
    this.up.clear();
    for (const p of this.parts) if (!this.info.later?.includes(p.index)) this.up.add(p.index);
    if (this.forms.size) this.setForms(stadiumForms(undefined, 0, STADIUM_TIMES, this.scale));
  }

  /** the color behind everything: the game clears to its fog's color
   *  (Ground_801C1E94; black without fog), which the stage's code may change
   *  (it sets both together) */
  get clear(): [number, number, number] {
    return this.background ?? (this.fog ? this.fog.color : [0, 0, 0]);
  }

  /** the fog this frame, in the color the stage's code set, if it set one */
  get fogNow(): Fog | null {
    return this.fog && this.background ? { ...this.fog, color: this.background } : this.fog;
  }

  /** a part by its map_head index, if the match has it (Stadium's other
   *  forms' parts too: each has a number of its own, 3, 4, 6 and 7 to 9) */
  partOf(index: number): Part | undefined {
    const p = this.parts.find((q) => q.index === index);
    if (p || !this.forms.size) return p;
    for (const parts of this.forms.values()) for (const q of parts) if (q.index === index) return q;
    return undefined;
  }

  /** the file this stage is read from */
  get file(): Archive {
    return this.archive;
  }

  /** Battlefield, as a viewer track has it (its "bg" changes, frames as the
   *  replay's index): the background up, the wireframe it changes through
   *  (from the frame it started, its animation from there), and the two fades
   *  of a change - the old one to black, the new one out of it (the stage's
   *  yakumono_param scripts, run by the fighters' color animation engine) */
  setBattle(changes: [number, ...(number | string)[]][], frame: number) {
    if (this.info.file !== "GrNBa") return;
    let state = 0, curr = -1, prev = -1, since = 0, wire = -1;
    for (const [f, s, c, p] of changes) {
      if (f > frame) break;
      if (Number(s) === 1 && state !== 1) wire = f;
      state = Number(s); curr = Number(c); prev = Number(p); since = f;
    }
    this.up.clear();
    for (const p of this.parts) if (!this.info.later?.includes(p.index)) this.up.add(p.index);
    this.up.delete(1);
    this.up.add(curr > 0 ? curr : 1);
    // (drawn as the code made them: the wireframe at the start, each background as it came up)
    this.battleOrder = [3, ...(state === 2 && prev > 0 ? [prev] : []), curr > 0 ? curr : 1];
    this.tints.clear();
    if (state === 0) { this.animFrom.delete(3); return; }
    this.up.add(3);
    this.animFrom.set(3, wire >= 0 ? wire : since);
    if (state !== 2 || prev < 0) return;
    this.up.add(prev);
    const y = this.archive.publics.get("yakumono_param");
    if (y === undefined) return;
    const fade = (part: number, at: number) => {
      const sk = this.parts.find((p) => p.index === part)?.skeleton;
      const script = ptr(this.archive, y + at);
      if (!sk || script === null) return;
      const t = groundOverlay(this.archive, script, frame - since);
      if (t) this.tints.set(sk, t);
    };
    fade(curr, 0);
    fade(prev, 4);
  }

  /** Battlefield: the order its background layer's parts are drawn in (setBattle), or null: by number */
  private battleOrder: number[] | null = null;

  /** a part's color overlay this frame, or null */
  tintOf(sk: Skeleton): Tint | null {
    return this.tints.get(sk) ?? null;
  }

  /** Stadium: what its big screen writes with (sistext.ts), when its files have it */
  lettering: Lettering | null = null;

  /** Stadium: the forms loaded so far, by the replay's type (the normal one, 5, is the main file's part 5) */
  forms = new Map<number, Part[]>();
  /** Stadium: the forms up this frame, as the stage's code has them
   *  (gr/stadium.ts); with none said, the normal one, whole */
  formsUp: FormUp[] = [];
  /** Stadium: the form each of the other forms' parts is of */
  private formOf = new Map<Part, number>();

  /** Stadium: a form's file. Its parts are the map_head entries the game's
   *  code makes for the form: the one of the form's own number, and with the
   *  water form (9) its two fountains (7 and 8: grStadium_801D1A38) - the
   *  only entries with a model in each file. */
  addForm(type: number, buf: ArrayBuffer) {
    const a = parseArchive(buf);
    const head = a.publics.get("map_head");
    if (head === undefined) return;
    const count = a.data.getUint32(head + 0x0c);
    const parts: Part[] = [];
    for (let i = 1; i < count; i++) {
      const p = this.part(i, `stage${this.stageId}:form${type}:${i}`, a);
      if (!p || !p.skeleton.drawables.length) continue;
      // (a form is never still: the code moves the joint above it)
      p.still = false;
      parts.push(p);
      this.formOf.set(p, type);
    }
    for (const p of parts) p.skeleton.update(p.place);
    this.forms.set(type, parts);
    const normal = this.parts.find((p) => p.index === STADIUM_NORMAL);
    if (normal) { normal.still = false; this.formOf.set(normal, STADIUM_NORMAL); }
    if (!this.formsUp.length) this.setForms(stadiumForms(undefined, 0, STADIUM_TIMES, this.scale));
  }

  /** Stadium: the forms up from now on (StageLogic.apply). Each one's parts
   *  stand on the joint the game has above them: flattened along y, moved
   *  along y. */
  setForms(up: FormUp[]) {
    this.formsUp = up;
    for (const f of up) for (const p of this.formParts(f.form)) {
      // (the water form's fountains are objects of their own: its code gives
      // them its height each frame, grStadium_801D1B48, and never moves them)
      p.place[5] = f.scaleY; p.place[13] = f.form === 9 && p.index !== 9 ? 0 : f.y;
      // HSD keeps a turned joint from being sheared by its parent's scale;
      // the water form's own code turns that off for the whole of its main
      // part, the joint above it too (grStadium_801D1A38:
      // HSD_JObjSetFlagsAll(jobj, 8))
      const plain = f.form === 9 && p.index === 9;
      p.skeleton.rootScale = plain || f.scaleY === this.scale ? null : [this.scale, f.scaleY, this.scale];
    }
  }

  /** Stadium: a form's parts (the normal form's is the main file's part 5) */
  formParts(form: number): Part[] {
    if (form === STADIUM_NORMAL) { const p = this.parts.find((q) => q.index === STADIUM_NORMAL); return p ? [p] : []; }
    return this.forms.get(form) ?? [];
  }

  /** Stadium: the form a part is of when that form is up, else undefined */
  formUpOf(p: Part): FormUp | undefined {
    const type = this.formOf.get(p);
    return type === undefined ? undefined : this.formsUp.find((f) => f.form === type);
  }

  /** Stadium: whether a part is of a form (up or not) */
  isForm(p: Part): boolean {
    return this.formOf.has(p);
  }

  private part(i: number, tag = `stage${this.stageId}:${i}`, archive?: Archive): Part | null {
    const a = archive ?? this.archive;
    const head = a.publics.get("map_head")!;
    const arr = ptr(a, head + 0x08);
    const count = a.data.getUint32(head + 0x0c);
    if (arr === null || i >= count) return null;
    const g = arr + i * 0x34;
    const j = ptr(a, g);
    if (j === null) return null;
    const { all, dobjs } = loadJoint(a, j);
    if (!archive) for (const h of this.info.hide?.[i] ?? []) {
      const under = (k: number): boolean => k === h || (k >= 0 && under(all[k].parent));
      all.forEach((jo, k) => { if (under(k)) jo.flags |= 0x10; });
    }
    const skeleton = new Skeleton(a, all, dobjs, tag);
    skeleton.shadowBias = (archive ? this.info.formShadowCheck : this.info.shadowCheck?.[i]) ?? null;
    const first = (at: number) => { const p = ptr(a, g + at); return p === null ? null : ptr(a, p); };
    const aj = first(0x04), mj = first(0x08);
    const place = ident(new Float32Array(16));
    place[0] = place[5] = place[10] = this.scale;
    let anim = aj === null ? null : loadAnimJoint(a, aj);
    for (const [joint, set] of this.info.animSets?.[i] ?? []) {
      const list = ptr(a, g + 0x04);
      const other = list === null ? null : ptr(a, list + set * 4);
      if (other === null || !anim) continue;
      const alt = loadAnimJoint(a, other);
      // the joint and everything under it
      const under = (k: number): boolean => k === joint || (k >= 0 && under(all[k].parent));
      anim = anim.map((ao, k) => (under(k) ? alt[k] ?? null : ao));
    }
    const matAnim = mj === null ? null : loadMatAnimJoint(a, mj);
    const lay = archive ? undefined : this.info.layers?.[i];
    if (lay?.flags) {
      const top = lay.joint ?? 0;
      const under = (k: number): boolean => k === top || (k >= 0 && under(all[k].parent));
      all.forEach((jo, k) => { if (under(k)) for (const d of jo.dobjs) if (d.mobj) d.mobj.renderMode |= lay.flags!; });
    }
    return {
      index: i, skeleton, anim, matAnim, joints: all,
      // a part with joints that face the camera turns as the camera does
      still: anim === null && matAnim === null && !all.some((jo) => jo.flags & 0xe00),
      place,
      layer: lay?.layer ?? 0,
      archive: a, entry: g,
    };
  }

  /** another copy of a part (its own skeleton), placed by the caller */
  copyOf(i: number, tag: string): Part | null {
    const p = this.part(i, tag);
    if (p) p.skeleton.update(p.place);
    return p;
  }

  // ---- a part's other animation sets, as the stage's code starts them

  private sets = new WeakMap<Part, { anim: Map<number, (AObj | null)[] | null>; mat: Map<number, (MatAnim | null)[][] | null>;
                                    keys: Map<number, PtclKey[]>; sparse: Map<string, Sparse> }>();
  private setsOf(p: Part) {
    let s = this.sets.get(p);
    if (!s) this.sets.set(p, (s = { anim: new Map(), mat: new Map(), keys: new Map(), sparse: new Map() }));
    return s;
  }

  /** the part's animation set `k` (its joints' AObjs), or null */
  animSet(p: Part, k: number): (AObj | null)[] | null {
    const s = this.setsOf(p);
    if (!s.anim.has(k)) {
      const list = ptr(p.archive, p.entry + 0x04), aj = list === null ? null : ptr(p.archive, list + k * 4);
      s.anim.set(k, aj === null ? null : loadAnimJoint(p.archive, aj));
    }
    return s.anim.get(k)!;
  }

  /** the part's material animation set `k`, or null */
  matSet(p: Part, k: number): (MatAnim | null)[][] | null {
    const s = this.setsOf(p);
    if (!s.mat.has(k)) {
      const list = ptr(p.archive, p.entry + 0x08), mj = list === null ? null : ptr(p.archive, list + k * 4);
      s.mat.set(k, mj === null ? null : loadMatAnimJoint(p.archive, mj));
    }
    return s.mat.get(k)!;
  }

  /** whether the stage's code makes set `k` loop, whatever its AObjs say
   *  (map_head's byte per set: the code sets their loop flag) */
  loops(p: Part, k: number): boolean {
    const fl = ptr(p.archive, p.entry + 0x28);
    return fl !== null && p.archive.data.getUint8(fl + k) !== 0;
  }

  /** the particles set `k` of a part starts: its joints' tracks 0x28 */
  keysOf(p: Part, k: number): PtclKey[] {
    const s = this.setsOf(p);
    let out = s.keys.get(k);
    if (out) return out;
    out = [];
    const a = p.archive, d = a.data;
    const list = ptr(a, p.entry + 0x04), aj = list === null ? null : ptr(a, list + k * 4);
    let joint = 0;
    const walk = (o: number | null) => {
      for (; o !== null; o = ptr(a, o + 0x04)) {
        const j = joint++;
        const ao = ptr(a, o + 0x08);
        for (let f = ao === null ? null : ptr(a, ao + 0x08); f !== null; f = ptr(a, f)) {
          if (d.getUint8(f + 0x0c) !== 0x28) continue;
          const len = d.getUint32(f + 0x04), start = d.getFloat32(f + 0x08), fv = d.getUint8(f + 0x0d);
          const dat = d.getUint32(f + 0x10);
          // (the track's start frame is where its clock stands when the
          // animation starts: a key waits until the clock passes 0)
          for (const e of keyEvents(a.u8.subarray(dat, dat + len), fv, -start)) {
            out!.push({ joint: j, time: e.time, bank: e.value & 0x3f, gen: (e.value >>> 6) & 0xffffff });
          }
        }
        walk(ptr(a, o));
      }
    };
    try { walk(aj); } catch { out.length = 0; }
    s.keys.set(k, out);
    return out;
  }

  /** a run's AObjs and material animations, only on its joints, each
   *  looping or not as the run has it */
  private sparse(p: Part, r: Run): Sparse {
    const s = this.setsOf(p);
    const key = `${r.anim}:${r.joint}:${r.deep ? 1 : 0}:${r.once ? 1 : 0}:${r.loop ? 1 : 0}`;
    let out = s.sparse.get(key);
    if (out) return out;
    const n = p.joints.length;
    const inRun = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      if (j === r.joint) inRun[j] = 1;
      else if (r.deep) for (let q = p.joints[j].parent; q >= 0; q = p.joints[q].parent) if (q === r.joint) { inRun[j] = 1; break; }
    }
    const loop = r.loop || this.loops(p, r.anim);
    const fix = (ao: AObj | null): AObj | null =>
      ao === null ? null : r.once ? { ...ao, loop: false } : loop && !ao.loop ? { ...ao, loop: true } : ao;
    const anim = this.animSet(p, r.anim)?.map((ao, j) => (j < n && inRun[j] ? fix(ao) : null)) ?? null;
    let mat = this.matSet(p, r.anim)?.map((list, j) => (j < n && inRun[j]
      ? list.map((m) => m && { aobj: fix(m.aobj), tex: m.tex.map((t) => ({ ...t, aobj: fix(t.aobj) })) })
      : [])) ?? null;
    // (none at all on the run's joints: no material animation)
    if (mat && !mat.some((list) => list.some((m) => m))) mat = null;
    s.sparse.set(key, (out = { anim, mat }));
    return out;
  }

  /** what a part plays this frame as the stage's code left it: each run's
   *  set, joint, start and rate, or a held time (the parity harness's) */
  playing(index: number): (number | null)[][] {
    const runs = this.runs.get(index);
    if (runs) return runs.map((r) => [r.anim, r.joint, r.hold === undefined ? r.from : null, r.rate, r.hold ?? null]);
    // (none: nothing for a part its setup leaves still; else its first set, from where the code started it or
    // from the stage's building)
    if (this.info.idle?.includes(index)) return [];
    return [[0, 0, this.animFrom.get(index) ?? -1, 1, null]];
  }

  /** pose a part on its runs at this frame (the replay's index) */
  private poseRuns(p: Part, runs: Run[], frame: number) {
    const sk = p.skeleton;
    sk.resetPose();
    // (the materials put back only when an animation sets them, or set them last time)
    let mats = false;
    for (const r of runs) if (this.sparse(p, r).mat) mats = true;
    if (mats || this.matsSet.has(p)) sk.resetMaterials();
    if (mats) this.matsSet.add(p); else this.matsSet.delete(p);
    for (const r of runs) {
      const t = r.hold ?? (frame - r.from) * r.rate;
      if (t < 0) continue;
      const s = this.sparse(p, r);
      if (s.anim) sk.applyAObjs(s.anim, t, false);
      if (s.mat) sk.applyMatAnims(s.mat, this.dobjsOf(p), t, false);
    }
  }
  /** the parts whose materials an animation set when last posed */
  private matsSet = new Set<Part>();
  private dobjsFn = new WeakMap<Part, (j: number) => DObj[]>();
  private dobjsOf(p: Part): (j: number) => DObj[] {
    let f = this.dobjsFn.get(p);
    if (!f) this.dobjsFn.set(p, (f = (j) => p.joints[j]?.dobjs ?? NO_DOBJS));
    return f;
  }

  /** a part posed at another frame than the one drawn (a particle made
   *  then: where its joint was); the frame drawn is posed again after */
  poseAt(p: Part, frame: number) {
    this.logic?.apply(this, frame);
    this.posePart(p, frame, undefined);
    this.logic?.pose?.(this, frame, undefined);
    p.skeleton.update(p.place);
  }

  /** what a part plays this frame: the runs the code (or a track) has it
   *  on, or undefined for its first set from the stage's building.
   *  Stadium: a form made during the match plays its first set from the
   *  frame it was made on, looping or not as the file says (grAnime_801C8138
   *  in each form's setup), unless a track said what it plays; a form being
   *  replaced stands as it was on the frame its animations were stopped
   *  (grAnime_801C7A04 at rate 0, as the new form is made) */
  runsOf(p: Part): Run[] | undefined {
    let runs = this.runs.get(p.index);
    const up = this.formUpOf(p);
    if (up && (up.born >= 0 || up.stopped !== null)) {
      const base: Run[] = runs ?? [{ anim: 0, joint: 0, deep: true, from: up.born, rate: 1 }];
      // (the water form's fountains are objects of their own: the code stops only the form's, and they play on
      // until its teardown removes them, grStadium_801D1D84)
      const stopped = up.form === 9 && p.index !== 9 ? null : up.stopped;
      runs = stopped === null ? base : base.map((r) => (r.hold !== undefined ? r : { ...r, hold: (stopped - r.from) * r.rate }));
    }
    return runs;
  }

  private posePart(p: Part, frame: number, st: StageFrame | undefined) {
    const sk = p.skeleton;
    const runs = this.runsOf(p);
    if (runs) this.poseRuns(p, runs, frame);
    else if (this.info.idle?.includes(p.index)) {
      // (a part its setup starts nothing on: as the file has it)
      sk.resetPose();
      if (p.matAnim) sk.resetMaterials();
    } else if (!p.still) {
      // (a part the code started on a frame of its own plays once from
      // there; the rest were started as the stage was built, and have been
      // stepped once more than the frame's number by the time it is drawn)
      const from = this.animFrom.get(p.index);
      const t = from === undefined ? frame + 1 : frame - from, loop = from === undefined;
      sk.resetPose();
      if (p.anim) sk.applyAObjs(p.anim, t, loop);
      if (p.matAnim) {
        sk.resetMaterials();
        sk.applyMatAnims(p.matAnim, (j) => p.joints[j]?.dobjs ?? NO_DOBJS, t, loop);
      }
    }
    if (this.fod && p === this.fod.main) {
      sk.trans[1 * 3 + 1] = this.fodHeight(0, st);
      sk.trans[2 * 3 + 1] = this.fodHeight(1, st);
    }
    // the mirror's copies of the side platforms (part 2's joints 2 and 3)
    // stand where the platforms are, shown while they are out of the water
    // (grIzumi_801CC0D4)
    if (this.fod && p === this.fod.mirror && sk.n > 3) {
      const m = this.fod.main.skeleton;
      const h = [this.fodHeight(0, st), this.fodHeight(1, st)];
      for (let side = 0; side < 2; side++) {
        const from = (side + 1) * 3, to = (side + 2) * 3;
        sk.trans[to] = m.trans[from]; sk.trans[to + 1] = h[side]; sk.trans[to + 2] = m.trans[from + 2];
        sk.setBranchShown(side + 2, h[side] >= 0);
      }
    }
  }

  /** Fountain of Dreams: the side platforms are joints 1 and 2 of the main
   * part, resting in the floor until the game's code lifts them; a viewer
   * track says how high each one is, and so does a replay from Slippi 3.18 on
   * (fodHeight). Before any word they stand where the file's own
   * yakumono_param starts them. */
  private setupFountain() {
    const main = this.parts.find((p) => p.index === 3);
    if (!main || main.joints.length < 3) return;
    const a = this.archive;
    const y = a.publics.get("yakumono_param");
    const start: [number, number] = y === undefined ? [20, 28] : [a.data.getFloat32(y), a.data.getFloat32(y + 8)];
    main.still = false;
    const mirror = this.parts.find((p) => this.info.mirrorOnly?.includes(p.index)) ?? null;
    if (mirror) mirror.still = false;
    this.fod = { main, start, mirror };
    // the stars all round it: a model of its own that the code adds as the
    // stage starts, its points drawn 18 sixths of a pixel across
    // (grIzumi_801CCB18, 801CCB90: HSD_StateSetPointSize)
    const so = a.publics.get("GrdIzumiStar_TopN_joint");
    if (so !== undefined) {
      const { all, dobjs } = loadJoint(a, so);
      const sk = new Skeleton(a, all, dobjs, `stage${this.stageId}:stars`);
      sk.pointSize = 18 / 6;
      const place = ident(new Float32Array(16));
      place[0] = place[5] = place[10] = this.scale;
      sk.update(place);
      this.stars = sk;
      // (on the background's layer: grIzumi_801CCB18 sets its x11 b012 to 2, so fn_800301D0 draws it whole
      // with that camera, before the rest of the stage)
      this.layer.set(sk, 2);
    }
  }
  /** Fountain of Dreams' stars (setupFountain), or null */
  private stars: Skeleton | null = null;

  /** Fountain of Dreams: where its side platforms stand before the replay says (left, right) */
  get fountainStart(): [number, number] | null {
    return this.fod?.start ?? null;
  }

  /** Fountain of Dreams: the side platforms' heights this frame as its logic
   *  has them (a viewer track's "fod" whatever the replay's version, else the
   *  replay's from Slippi 3.18 on), left by its apply; null before */
  fodHeights: [number | undefined, number | undefined] | null = null;

  /** Fountain of Dreams: a side platform's height (0 left, 1 right): the
   *  logic's, else the frame's, else where the file starts it */
  private fodHeight(side: 0 | 1, st: StageFrame | undefined): number {
    return this.fodHeights?.[side] ?? (side === 0 ? st?.fodLeftPlatformHeight : st?.fodRightPlatformHeight) ??
      this.fod!.start[side];
  }

  /** the frame last posed (the replay's index) */
  frame = 0;

  /** everything that moves, at this frame (the replay's index) */
  update(frame: number, st: StageFrame | undefined) {
    this.frame = frame;
    this.logic?.apply(this, frame);
    for (const p of this.parts) if (this.up.has(p.index)) this.posePart(p, frame, st);
    for (const [e, runs] of this.extraRuns) this.poseRuns(e, runs, frame);
    // (Stadium's other forms, the ones up)
    for (const f of this.formsUp) if (f.form !== STADIUM_NORMAL) for (const p of this.formParts(f.form)) this.posePart(p, frame, st);
    // (what the code moves itself, over its animations)
    this.logic?.pose?.(this, frame, st);
    for (const p of this.parts) {
      if (!this.up.has(p.index) || (p.still && !this.runs.has(p.index))) continue;
      p.skeleton.update(p.place);
    }
    for (const f of this.formsUp) if (f.form !== STADIUM_NORMAL) for (const p of this.formParts(f.form)) p.skeleton.update(p.place);
    for (const e of this.extras) if (this.extraRuns.has(e)) e.skeleton.update(e.place);
  }

  /** the copies up this frame, each on its animations (StageLogic.apply sets them) */
  readonly extraRuns = new Map<Part, Run[]>();

  /** a copy posed on its runs at a frame (its particles' joints) */
  poseExtra(e: Part, frame: number) {
    this.logic?.apply(this, frame);
    const runs = this.extraRuns.get(e);
    if (runs) this.poseRuns(e, runs, frame);
    this.logic?.pose?.(this, frame, undefined);
    e.skeleton.update(e.place);
  }

  /** every part's skeleton, up or not (to have their textures ready) */
  get allSkeletons(): Skeleton[] {
    return [...[...this.parts, ...this.extras].map((p) => p.skeleton), ...(this.stars ? [this.stars] : [])];
  }

  /** the surfaces drawn with the mirror image (Fountain's pond), with their skeletons */
  get mirrorSurfaces(): { sk: Skeleton; d: Drawable }[] {
    const out: { sk: Skeleton; d: Drawable }[] = [];
    for (const sk of this.skeletons) for (const d of sk.drawables) if (d.state.mirror) out.push({ sk, d });
    return out;
  }

  /** the parts only a mirror image shows (StageInfo.mirrorOnly) */
  get mirrorSkeletons(): Skeleton[] {
    const mo = this.info.mirrorOnly;
    return mo ? this.parts.filter((p) => mo.includes(p.index) && this.up.has(p.index)).map((p) => p.skeleton) : [];
  }

  get skeletons(): Skeleton[] {
    if (!this.forms.size) {
      const mo = this.info.mirrorOnly;
      let parts = this.drawOrder.filter((p) => this.up.has(p.index) && !mo?.includes(p.index));
      const bo = this.battleOrder;
      if (bo) {
        const rank = (p: Part) => (bo.includes(p.index) ? bo.indexOf(p.index) : -1);
        parts = parts.map((p, k) => ({ p, k })).sort((x, y) => y.p.layer - x.p.layer || rank(x.p) - rank(y.p) || x.k - y.k).map((x) => x.p);
      }
      const out = parts.map((p) => p.skeleton);
      if (this.stars) out.unshift(this.stars);
      for (const e of this.extras) if (this.extraRuns.has(e)) out.push(e.skeleton);
      return out;
    }
    // Stadium: the arena, its screen and everything round it (parts 0 to 2),
    // which no transformation touches, and the form up - or the two, while
    // one comes up over the other
    const out = this.drawOrder.filter((p) => this.up.has(p.index) && p.index !== STADIUM_NORMAL).map((p) => p.skeleton);
    for (const f of this.formsUp) for (const p of this.formParts(f.form)) out.push(p.skeleton);
    return out;
  }

  /** a part's layer: above 0, the game draws all of it (see-through parts
   *  too) before the rest of the stage and the fighters */
  layerOf(sk: Skeleton): number {
    return this.layer.get(sk) ?? 0;
  }

}

const NO_DOBJS: DObj[] = [];

/** the image a render target's texture shows, and its part */
function screenOf(a: Archive, parts: Part[], name: RegExp): { image: Image; part: Part; states: MatState[] } | null {
  let off = -1;
  for (const [n, o] of a.publics) if (name.test(n)) off = o;
  for (const p of parts)
    for (const d of p.skeleton.drawables)
      for (const t of d.state.tex) {
        if (t.tobj.image.offset !== off) continue;
        // (every material that shows it: the code changes their color source with what it shows)
        const states = [...new Set(p.skeleton.drawables.filter((e) => e.state.tex.some((u) => u.tobj.image.offset === off))
          .map((e) => e.state))];
        return { image: t.tobj.image, part: p, states };
      }
  return null;
}

/** a run's animations, only on its joints */
interface Sparse { anim: (AObj | null)[] | null; mat: (MatAnim | null)[][] | null }

/** The stage's general points (map_head's first list: a joint tree, and pairs
 *  of joint index and point type) of the types asked for, where they are. */
function pointsOf(a: Archive, scale: number, types: number[]): Map<number, [number, number]> {
  const d = a.data;
  const out = new Map<number, [number, number]>();
  const head = a.publics.get("map_head");
  if (head === undefined) return out;
  const list = ptr(a, head), n = d.getUint32(head + 4);
  if (list === null || n > 64) return out;
  for (let e = 0; e < n; e++) {
    const E = list + e * 12;
    const j = ptr(a, E), pairs = ptr(a, E + 4), cnt = d.getUint32(E + 8);
    if (j === null || pairs === null || cnt > 512) continue;
    let want = false;
    for (let k = 0; k < cnt; k++) if (types.includes(d.getInt16(pairs + k * 4 + 2))) want = true;
    if (!want) continue;
    const { all, dobjs } = loadJoint(a, j);
    const sk = new Skeleton(a, all, dobjs, "campoints");
    sk.update();
    for (let k = 0; k < cnt; k++) {
      const ji = d.getInt16(pairs + k * 4), t = d.getInt16(pairs + k * 4 + 2);
      if (types.includes(t) && ji >= 0 && ji < sk.n) {
        const p = sk.position(ji);
        out.set(t, [p[0] * scale, p[1] * scale]);
      }
    }
  }
  return out;
}

/** The stage's camera range, as the game reads it (Ground_801C39C0): the
 *  general points of types 0x95 and 0x96, two corners. */
function camBoundsOf(a: Archive, scale: number): Stage["camBounds"] {
  const pts = pointsOf(a, scale, [0x95, 0x96]);
  const p = pts.get(0x95), q = pts.get(0x96);
  if (!p || !q) return null;
  return { left: Math.min(p[0], q[0]), right: Math.max(p[0], q[0]), top: Math.max(p[1], q[1]), bottom: Math.min(p[1], q[1]) };
}

/** Everything the game's match camera takes from the stage (camera.ts): the
 *  camera range and its center (points 0x95, 0x96, 0x94), the blast zone's
 *  top (0x97, 0x98), and grGroundParam's camera numbers - the tilt factor
 *  (+0x18) and turn factor (+0x1C), the pan (+0x14, degrees), the nearest
 *  and farthest distance (+0x0C, +0x10), the track ratio, fixed zoom and
 *  smoothing (+0x20, +0x24, +0x28). */
function cameraOf(a: Archive, scale: number): StageCamera | null {
  const pts = pointsOf(a, scale, [0x94, 0x95, 0x96, 0x97, 0x98]);
  const g = a.publics.get("grGroundParam");
  if (g === undefined) return null;
  // a stage without all three points (Pokemon Stadium has no center, 0x94)
  // gets the game's stand-in range: 170 either side of the origin, 120 up,
  // 60 down ("use dummy CamRange", Ground_801C39C0's default)
  const range = cameraRange(pts.get(0x95), pts.get(0x96), pts.get(0x94));
  const b0 = pts.get(0x97), b1 = pts.get(0x98);
  const d = a.data, f = (o: number) => d.getFloat32(g + o), i = (o: number) => d.getInt32(g + o);
  return {
    ...range,
    blast: b0 && b1
      ? { left: Math.min(b0[0], b1[0]), right: Math.max(b0[0], b1[0]), top: Math.max(b0[1], b1[1]), bottom: Math.min(b0[1], b1[1]) }
      : { left: -250, right: 250, top: 200, bottom: -100 },
    pitchK: f(0x18), yawK: f(0x1c), pan: i(0x14), near: i(0x0c), far: i(0x10),
    trackRatio: f(0x20), fixedZoom: f(0x24), smooth: f(0x28), fov: d.getInt16(g + 0x08),
    quakes: quakesOf(a),
  };
}

/** The camera range and its center from general points 0x95, 0x96 (two
 *  corners) and 0x94 (the center), absolute; without all three, the game's
 *  stand-in (Ground_801C39C0 for the stages without their own) */
export function cameraRange(p: [number, number] | undefined, q: [number, number] | undefined, c: [number, number] | undefined):
    { left: number; right: number; top: number; bottom: number; cx: number; cy: number } {
  if (!p || !q || !c) return { left: -170, right: 170, top: 120, bottom: -60, cx: 0, cy: 0 };
  return { left: Math.min(p[0], q[0]), right: Math.max(p[0], q[0]), top: Math.max(p[1], q[1]), bottom: Math.min(p[1], q[1]),
           cx: c[0], cy: c[1] };
}

/** The stage's camera quakes (quake_model_set): a joint whose animation -
 *  one each for the looping, small, medium and large quake - moves it, and
 *  whose place the camera shakes by. The root's x and y tracks of each. */
function quakesOf(a: Archive): StageCamera["quakes"] {
  const at = a.publics.get("quake_model_set");
  const anims = at === undefined ? null : ptr(a, at + 4);
  const out: StageCamera["quakes"] = [];
  for (let k = 0; k < 4; k++) {
    const aj = anims === null ? null : ptr(a, anims + k * 4);
    const ao = aj === null ? null : loadAnimJoint(a, aj)[0];
    out.push(ao ? { x: ao.tracks.find((t) => t.type === 5)?.keys ?? null, y: ao.tracks.find((t) => t.type === 6)?.keys ?? null, end: ao.end }
                : null);
  }
  return out;
}

/** Yoshi's Story's Shy Guy: the stage file's own item (itemdata lists the
 *  stage's items as {kind, article}; the Shy Guy is kind 0xD2). Its model is a
 *  card whose texture animation is the Shy Guy flying; its scale is the
 *  item's own (the article's attributes, +0x60). */
function shyGuyOf(a: Archive, stageId: number): { prop: Prop; prop2: Prop | null; scale: number } | null {
  const list = a.publics.get("itemdata");
  if (list === undefined) return null;
  for (let i = 0; i < 16; i++) {
    const e = ptr(a, list + i * 4);
    if (e === null) break;
    if (a.data.getInt32(e) !== 0xd2) continue;
    const art = ptr(a, e + 4);
    if (art === null) return null;
    const attr = ptr(a, art), states = ptr(a, art + 0x0c), model = ptr(a, art + 0x10);
    const joint = model === null ? null : ptr(a, model);
    if (joint === null) return null;
    // Its flying state plays the first state's material animation (the
    // card's three frames: the propeller turning). The joint animation and
    // the root's own offset are left out: the replay says where the Shy Guy
    // is, frame by frame, and it is drawn there.
    const mj = states === null ? null : ptr(a, states + 4);
    // (its state 4 plays animation 2's instead: itheiho.c's it_803F83F0)
    const mj2 = states === null ? null : ptr(a, states + 2 * 0x10 + 4);
    try {
      return { prop: new Prop(a, joint, null, mj, `stage${stageId}:shyguy`, true),
               prop2: mj2 === null || mj2 === mj ? null : new Prop(a, joint, null, mj2, `stage${stageId}:shyguy`, true),
               scale: attr === null ? 1 : a.data.getFloat32(attr + 0x60) || 1 };
    } catch {
      return null;
    }
  }
  return null;
}

/** Some textures in a stage file are placeholders the game renders into at
 * runtime (Fountain's pond reflection, Stadium's big screen): an image with
 * a public name ending in Dummy..._image_desc. Fountain's pond is drawn from
 * the renderer's mirror image, as the game's code draws it (grizumi.c); the
 * ones the stage's code draws are kept (`keep`); the others, drawn as they
 * are, would be a flat white: those texture stages are skipped, and a
 * surface that has nothing but such a texture is not drawn. Returns whether
 * the stage has a mirror. */
const MIRRORS = new Set(["GrdIzumi_cd_wt_GrdIzumiDummy1_1_image_desc"]);
function hideRenderTargets(a: Archive, parts: Part[], keep: RegExp | null = null): boolean {
  const dummies = new Set<number>(), mirrors = new Set<number>();
  for (const [name, off] of a.publics) {
    if (MIRRORS.has(name)) mirrors.add(off);
    else if (/Dummy.*_image_desc$/.test(name) && !keep?.test(name)) dummies.add(off);
  }
  let mirrored = false;
  for (const p of parts)
    for (const d of p.skeleton.drawables) {
      const tex = d.state.tex;
      const m = tex.filter((t) => mirrors.has(t.tobj.image.offset));
      if (m.length) { d.state.mirror = new Set(m.map((t) => t.tobj)); mirrored = true; }
      if (!dummies.size) continue;
      const keep = tex.filter((t) => !dummies.has(t.tobj.image.offset));
      if (keep.length === tex.length) continue;
      if (!keep.length) p.skeleton.hidden.add(d.dobj.index);
      else d.state.skip = new Set(tex.filter((t) => dummies.has(t.tobj.image.offset)).map((t) => t.tobj));
    }
  return mirrored;
}
