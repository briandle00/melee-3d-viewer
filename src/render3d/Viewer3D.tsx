/* 3D replay viewer: the replay drawn with the game's own models.
 *
 * A drop-in for Slippi Lab's SVG <Viewer/>: it reads the same replayStore
 * (frame, replay, range, ghosts, zoom), so the embed page's postMessage API,
 * the controls and the ghost overlay work unchanged. The models come from
 * your own extracted game files (files.ts);
 * nothing from the game is bundled. Whenever something cannot be loaded or
 * drawn, onFail says why and the page draws Slippi Lab's line art instead.
 */
import { EffectBank } from "./fx/bank";
import { animTime } from "./animtime";
import { diagWarmed } from "~/diag";
import { createEffect, createMemo, createSignal, Index, JSX, on as follow, onCleanup, onMount, Show, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import { Controls } from "~/components/viewer/Controls";
import { GameFrame } from "~/components/viewer/GameFrame";
import { Item } from "~/components/viewer/Item";
import { getPlayerColor, holdPlay, replayStore } from "~/state/replayStore";
import { hudSlotsNow } from "~/state/hudSlotsStore";
import { PagePlayer } from "./pagePlayers";
import { actionMapByInternalId } from "~/viewer/characters";
import type { PlayerInputs, PlayerState, ReplayData } from "~/common/types";
import { type FallLean, Fighter, type GameAnim, isScreenKO, isStarKO, koPlace, missingAnimations, type Place, type PoseInput } from "./fighter";
import * as files from "./files";
import { Hud3D } from "./Hud3D";
import { CRT_LOOKS, type CrtPreset, isCrtPreset, tubeOutline, unbend } from "./crt";
import { invert, lookAt, mat, perspective, translation, mul } from "./math";
import { CAM_ASPECT, CAM_STRIDE, cameraPlanes, CamActor, CameraRun, cameraRun, gameProjection, gameView, playerScales } from "./camera";
import { chargeShakeAt, floorHeights, HIT_FEEL, hitShakeAt, quakeOf, shakeKindOf } from "./hitlag";
import { setBillboardView } from "./skeleton";
import { DEFAULT_LIGHTING, Renderer } from "./renderer";
import type { Lighting } from "./lightset";
import { Stall, idle } from "./idle";
import { Stage } from "./stage";
import { StageScene } from "./gr";
import { Face, faceAt, TrackFaces } from "./face";
import { HELD_MAKER, heldIn, holdOf, type Hold } from "./itemhold";
import { EffectKit } from "./effects3d";
import { Prop } from "./prop";
import type { FigaTree } from "./hsd";
import { partSkips, partToModelJoint, worldByPart } from "./parts";
import { Dynamics, animDriven, eulerToQuat, from44, mtxEuler, quatMtx, type DynPose } from "./dynamics";
import { GuardFrame, guardTilt } from "./guard";
import { ENTRY, ENTRY_END, ENTRY_START, entryPose, standScale } from "./entry";
import { copiesFromReplay, HAT_JOINT, KIRBY, KIRBY_ITEMS, KirbyCopy, KirbyHat, poseSkin, yoshiHatAnim } from "./kirby";
import { onAngelPlatform, runNumber, shineAt, SHY_GUY } from "~/common/effects";
import { ActorFrame, FxWorld, type FxSnapshot, type LearnedFx, type LearnedPiece, NO_WORLD, stepThrough } from "./fx/world";
import { Checkpoints, jumpTo, type Kept } from "./fx/checkpoints";
import { buildParticles } from "./fx/draw";
import { srtApply } from "./fx/particles";
import { Before, hitSparks, powershielded } from "./fx/contact";
import { ChargeAttrs, storedAnim, storedCharges, storedFromTrack } from "./fx/charges";
import { invincibilityAsked, timedInvincible } from "./fx/invincible";
import { launchSmokes } from "./fx/launchsmoke";
import { WAIT, waitSubactions } from "./waitanim";
import { fetchTrack, replayPath, TrackData, ViewerTrack, type TrackPose } from "./track";
import { SHIELD_MODEL } from "./fx/dispatch";
import { pageCache } from "../state/pageCache";
import { SHIELD_FX, trackFilesOf, trackShapes, type TrackShapes } from "./fx/drawn";
import { type EggRoll, eggRollAt, YOSHI } from "./yoshiroll";
import { kirbyStoneAt } from "./kirbystone";
import { ROLLOUT_ATTRS, ROLLOUT_FIRST, rolloutAngle, rolloutAttrs } from "./rollout";
import { Hud, HudActor, HudKit } from "./hud";
import { drawLogCommand } from "./drawlog";
import type { Tint as ColTint } from "./fx/colanim";
import { itemAnimation, itemAnimationIndex } from "./item-animation";
import { samusBombClocks, samusBombRotation } from "./item-facing";
import { itemSource } from "./item-source";
import { isShadowBall, shadowBallScale } from "./shadow-ball";
import { shadowCamera } from "./shadow";
import { stageFrame, stageRevision } from "~/simulation-stage";
import { mark, timed } from "./startup";

const FOVY = (30 * Math.PI) / 180;
// the SVG viewer frames the players in 640 x 480 of its 730 x 600 box
const FRAME_W = 640 / 730, FRAME_H = 480 / 600;
const PAD = 25, MIN_RANGE = 100;
// how far above its target the camera sits, as a share of its distance: the
// game's camera looks a little down on the stage
const LIFT = 0.1;

interface Actor { st: PlayerState; inputs?: PlayerInputs; costume: number; player: number; nana: boolean;
                 hip?: [number, number, number]; scale?: number; platform?: number; ko?: Place | null;
                 /** its eyes, mouth and hands this frame (face.ts) */
                 face?: Face;
                 /** Yoshi's egg roll this frame: part 0's variant and part 3's spin (yoshiroll.ts) */
                 roll?: EggRoll | null;
                 /** Rollout's spin this frame: YRotN's turn about x (rollout.ts) */
                 rollout?: number | null;
                 /** Kirby's Stone this frame: parts 0 and 1 (kirbystone.ts) */
                 stone?: { part0?: number; part1?: number } | null;
                 /** held or thrown: who holds it, and where its XRotN is moved to */
                 captor?: Actor | null; hold?: { joint: number; d: [number, number, number] } | null;
                 /** in Kirby's inhale: its root's size this frame, or the turn it keeps as his star (kirbyHeld) */
                 kirbyHeld?: { shrink?: number; turn?: number } | null }

// ?mini=1: a small preview: the picture fills the frame
// and there are no controls; ?zoom= starts it closer
const MINI = new URLSearchParams(location.search).get("mini") === "1";
// ?snap=1: once the stage and every fighter of the frame are drawn, hand the
// page that embeds this a still of it ({type: "snap", url}), once (a card
// showing a moment on its stage, say). Only the picture goes back.
const SNAP = new URLSearchParams(location.search).get("snap") === "1";
// ?debug=nohud: the picture without the game's HUD (to time what it costs)
const NO_HUD = new URLSearchParams(location.search).get("debug") === "nohud";
// A pixel comparison's layers (__viewer3d.setLayers): groups of what is drawn left
// out of the next draws, so a picture drawn with and without one says where that group is on the canvas.
// Nothing sets them but such a tool; empty, every draw is the player's own.
type Layer = "back" | "stage" | "fighters" | "items" | "effects" | "hud";
let layersOff: Partial<Record<Layer, boolean>> = {};

// A fighter the game does not draw: dead, or waiting to come back (action
// states 0-11: the Dead* states and Sleep), or in the middle of a move that
// makes them vanish - Sheik's Vanish and Zelda's Farore's Wind (the travel
// states the line-art tables mark invisible) and Mewtwo's Teleport (its
// SpecialHiLost states). Internal character ids.
const INVISIBLE: Record<number, Set<number>> = {
  7: new Set([356, 359]),    // Sheik
  19: new Set([350, 353]),   // Zelda
  16: new Set([354, 357]),   // Mewtwo
};
const gone = (st: PlayerState) => st.isDead || st.actionStateId <= 11;

// Kirby's copy on each frame from the replay alone (kirby.ts), per player,
// worked out once per replay
const replayCopies = new WeakMap<ReplayData, Map<number, Int8Array>>();
function copiesOf(data: ReplayData, player: number): Int8Array {
  let byPlayer = replayCopies.get(data);
  if (!byPlayer) replayCopies.set(data, (byPlayer = new Map()));
  let out = byPlayer.get(player);
  if (!out) {
    const frames = data.frames.map((f) => {
      const st = f.players[player]?.state;
      return { state: st?.actionStateId ?? -1, dead: !st || gone(st) };
    });
    // (whoever he is drinking in: the one in CaptureKirby, 288)
    const victim = (i: number) => {
      for (const p of data.frames[i]?.players ?? []) {
        if (p && p.playerIndex !== player && p.state.actionStateId === 288) return p.state.internalCharacterId;
      }
      for (const p of data.frames[i - 1]?.players ?? []) {
        if (p && p.playerIndex !== player && p.state.actionStateId === 288) return p.state.internalCharacterId;
      }
      return -1;
    };
    out = copiesFromReplay(frames, victim);
    byPlayer.set(player, out);
  }
  return out;
}

/** where a KO'd fighter the game still draws is (fighter.ts koPlace: a star
 *  KO flying into the background, a screen KO on the screen), by how many
 *  frames it has been in its state, counted back through the replay (the
 *  replay's own counter is the animation's, which starts over); null for
 *  one not drawn */
function koAt(data: ReplayData, f: number, player: number, nana: boolean, st: PlayerState,
              camInv: Float32Array | null): Place | null {
  const s = st.actionStateId;
  if (!isStarKO(s) && !isScreenKO(s)) return null;
  const same = isStarKO(s) ? isStarKO : (q: number) => q === s;
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  let g = f;
  while (g > 0 && f - g < 400 && same(at(g - 1)?.actionStateId ?? -1)) g--;
  return koPlace(s, f - g, st.xPosition, st.yPosition, st.internalCharacterId === GAME_AND_WATCH, camInv);
}
const GAME_AND_WATCH = 24;

/** where a frame's drawing time goes: milliseconds by section, summed since
 *  the checks last read them (window.__viewer3d.sections()) */
const prof = {
  last: 0,
  sums: new Map<string, number>(),
  frames: 0,
  start() { this.last = performance.now(); this.frames++; },
  mark(name: string) {
    const t = performance.now();
    this.sums.set(name, (this.sums.get(name) ?? 0) + t - this.last);
    this.last = t;
  },
  read() {
    const out: Record<string, number> = {};
    for (const [k, v] of this.sums) out[k] = +(v / Math.max(1, this.frames)).toFixed(3);
    this.sums.clear();
    this.frames = 0;
    return out;
  },
};

/** what the item in a fighter's hand on a replay frame does to the hand (itemhold.ts): the item it owns in one of
 *  its held states, by its article's hold kind; null with none, or one whose article is not this fighter's own */
function holdAt(data: ReplayData, fi: Fighter, player: number, nana: boolean, g: number): Hold | null {
  const items = nana ? undefined : data.frames[g]?.items;
  if (!items?.length) return null;
  for (const it of items) {
    if (it.owner !== player || HELD_MAKER[it.typeId] !== fi.internalId) continue;
    const h = heldIn(it.typeId, it.state);
    const index = h ? trackArticles.get(data)?.get(it.typeId) ?? ARTICLES[it.typeId]?.art : undefined;
    const art = index === undefined ? null : fi.article(index, it.state);
    if (h && art) return holdOf(fi.internalId, art.hold ?? 0, !!art.heavy, h.now);
  }
  return null;
}

/** a fighter's eyes, mouth and hands on a frame (face.ts), from its history in the replay */
function faceOf(data: ReplayData, fi: Fighter, player: number, nana: boolean, f: number, tr: ViewerTrack | null): Face {
  const face = faceAt(fi.internalId, {
    at: (g) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; },
    // (a wait plays the script of the wait animation it picked)
    script: (s) => fi.scriptFor(s, s === WAIT ? waitSubOf(data, fi, player, nana, f) : undefined),
    // (its hand around an item it holds: itemhold.ts)
    hold: (g) => holdAt(data, fi, player, nana, g),
    itemVis: (s) => fi.itemVisFor(s, s === WAIT ? waitSubOf(data, fi, player, nana, f) : undefined),
  }, f);
  // (the textures as the game switched them, when the viewer track has them)
  const tex = tr?.valid(f - 123) ? trackFacesOf(tr)?.texAt(player, nana ? 1 : 0, f - 123) : undefined;
  if (tex) face.tex = tex;
  return face;
}
/** the wait animation a fighter standing still plays on a frame (waitanim.ts),
 *  or undefined for its state's own; worked out once per replay and fighter */
const waitSubs = new WeakMap<ReplayData, Map<string, Int16Array>>();
function waitSubOf(data: ReplayData, fi: Fighter, player: number, nana: boolean, f: number): number | undefined {
  const p = data.frames[f]?.players[player];
  if ((nana ? p?.nanaState : p?.state)?.actionStateId !== WAIT) return undefined;
  let m = waitSubs.get(data);
  if (!m) waitSubs.set(data, m = new Map());
  const key = `${player}:${nana ? 1 : 0}:${fi.internalId}`;
  let subs = m.get(key);
  if (!subs) {
    subs = waitSubactions((g) => { const q = data.frames[g]?.players[player]; return nana ? q?.nanaState ?? undefined : q?.state; },
                          data.frames.length, fi.waitAnims(), fi.subactionFor(WAIT) ?? 2, player * 7 + (nana ? 3 : 0));
    m.set(key, subs);
  }
  return subs[f] >= 0 ? subs[f] : undefined;
}

/** Yoshi's egg roll on a frame (yoshiroll.ts), from his history in the replay */
function rollOf(data: ReplayData, fi: Fighter, player: number, nana: boolean, f: number) {
  if (fi.internalId !== YOSHI) return null;
  return eggRollAt({
    at: (g) => {
      const p = data.frames[g]?.players[player];
      const s = nana ? p?.nanaState : p?.state;
      return s ? { actionStateId: s.actionStateId, actionStateFrameCounter: s.actionStateFrameCounter,
                   groundSpeed: s.selfInducedGroundXSpeed ?? 0, airSpeed: s.selfInducedAirXSpeed ?? 0 } : undefined;
    },
    script: (s) => fi.scriptFor(s),
  }, f);
}
// Kirby's inhale on the one drawn in (ftCo_CaptureKirby.c) and spat out or let out of a copy as his star
// (ftCo_ThrownKirby.c): CaptureKirby, ThrownKirbyStar, ThrownCopyStar
const CAPTURE_KIRBY = 288, KIRBY_STARS = new Set([290, 291]), THROWN_KIRBY = 292;
/** One in Kirby's inhale, from the replay and Kirby's attributes: drawn in, its root shrinks with its distance d
 *  from his mouth (his place, +0x38 the way he faces and +0x3C up) as it was before this frame's pull - while d
 *  is under his +0x40, its size times (1 - k) + d / +0x40 x k, k his +0x44 (ftCo_800BD39C); as his star it is
 *  hidden and keeps the turn it began with, away from him (inlineB2: its facing set before the state, then
 *  turned by its star's speed every frame, which turns no model). Kirby: the nearest one */
function kirbyHeld(data: ReplayData, f: number, a: Actor, actors: Actor[], fs: Map<string, Fighter>): { shrink?: number; turn?: number } | null {
  const s = a.st.actionStateId;
  if (s !== CAPTURE_KIRBY && s !== THROWN_KIRBY && !KIRBY_STARS.has(s)) return null;
  const kbs = actors.filter((o) => o !== a && o.st.internalCharacterId === KIRBY);
  if (!kbs.length) return null;
  const far = (o: Actor) => Math.hypot(o.st.xPosition - a.st.xPosition, o.st.yPosition - a.st.yPosition);
  const kb = kbs.reduce((b, o) => (far(o) < far(b) ? o : b));
  const kfi = fs.get(`${KIRBY}:${kb.costume}`);
  if (!kfi) return null;
  const at = (g: number, who: Actor) => { const p = data.frames[g]?.players[who.player]; return who.nana ? p?.nanaState : p?.state; };
  if (s === CAPTURE_KIRBY) {
    const vp = at(f - 1, a), kp = at(f - 1, kb);
    // (the frame it is caught on: not yet)
    if (!vp || !kp || vp.actionStateId !== CAPTURE_KIRBY) return { shrink: 1 };
    const f32 = Math.fround;
    const mx = f32(kp.xPosition + f32(kfi.specialAttr(0x38) * kp.facingDirection)), my = f32(kp.yPosition + kfi.specialAttr(0x3c));
    const d = f32(Math.hypot(vp.xPosition - mx, vp.yPosition - my)), r = kfi.specialAttr(0x40), k = kfi.specialAttr(0x44);
    return { shrink: r > 0 && d < r ? f32(f32(1 - k) + f32(f32(d / r) * k)) : 1 };
  }
  let g = f;
  while (g > 0 && f - g < 600 && at(g - 1, a)?.actionStateId === s) g--;
  if (s === THROWN_KIRBY) {
    // (out of the star, growing back: from 1 - k of its size, k his +0x44, by k x his +0x64 / +0x70 a frame as its
    // timer runs down from +0x70 - ftCo_800BE6AC; the frame it comes out its timer is whole)
    const f32 = Math.fround, k = kfi.specialAttr(0x44), span = kfi.specialAttr(0x70), step = kfi.specialAttr(0x64);
    const left = span > 0 ? Math.max(0, f32(span - (f - g) * step)) : 0;
    return { shrink: span > 0 ? f32(f32(1 - k) + f32(f32(f32(span - left) / span) * k)) : 1 };
  }
  const kf = (at(g, kb)?.facingDirection ?? 1) < 0 ? -1 : 1;
  return { turn: -kf * Math.PI / 2 };
}

/** Rollout's spin on a frame (rollout.ts): Jigglypuff's, and Kirby's copy of it */
function rolloutOf(data: ReplayData, fi: Fighter, player: number, nana: boolean, f: number) {
  const first = ROLLOUT_FIRST[fi.internalId];
  if (first === undefined) return null;
  const now = (nana ? data.frames[f]?.players[player]?.nanaState : data.frames[f]?.players[player]?.state)?.actionStateId;
  if (now === undefined || now < first || now > first + 16) return null;
  return rolloutAngle((g) => {
    const p = data.frames[g]?.players[player];
    const s = nana ? p?.nanaState : p?.state;
    return s ? { actionStateId: s.actionStateId, facingDirection: s.facingDirection,
                 speed: s.isGrounded ? s.selfInducedGroundXSpeed ?? 0 : s.selfInducedAirXSpeed ?? 0 } : undefined;
  }, f, first, rolloutAttrs((o) => fi.specialAttr(o), ROLLOUT_ATTRS[fi.internalId]));
}
/** Kirby's Stone on a frame (kirbystone.ts): which of his stones is the
 *  game's random pick, so a stand-in seeded by the frame it began picks one */
function stoneOf(data: ReplayData, fi: Fighter, player: number, nana: boolean, f: number) {
  if (fi.internalId !== KIRBY) return null;
  return kirbyStoneAt({
    at: (g) => {
      const p = data.frames[g]?.players[player];
      const s = nana ? p?.nanaState : p?.state;
      return s ? { actionStateId: s.actionStateId, actionStateFrameCounter: s.actionStateFrameCounter } : undefined;
    },
    script: (s) => fi.scriptFor(s),
  }, f, (g) => (Math.imul(g + 1, 2654435761) >>> 0) % 5 + 1);
}
const trackFaces = new WeakMap<ViewerTrack, TrackFaces | null>();
function trackFacesOf(tr: ViewerTrack): TrackFaces | null {
  let t = trackFaces.get(tr);
  if (t === undefined) trackFaces.set(tr, (t = tr.has("tex") ? new TrackFaces(tr.between("tex", -1e9, 1e9)) : null));
  return t;
}
// a fighter coming back down on the angel platform
const REBIRTH = 12;
// the reflector's effect file (EfFxData, Fox's and Falco's both: efalt 0x488-0x48A)
const REFLECTOR_FILE: Record<number, number> = { 1: 3, 22: 3 };
// (and one swallowed: in Yoshi's egg, in Kirby's mouth, spat out as his star -
// the game hides it: ftCo_YoshiEgg.c, ftCo_CaptureWaitKirby.c, ftCo_ThrownKirby.c)
const SWALLOWED = new Set([277, 289, 290, 291, 332]);
// (and one waiting to enter the match: Entry, ft_0C31.c)
const vanished = (st: PlayerState) => !!INVISIBLE[st.internalCharacterId]?.has(st.actionStateId) || SWALLOWED.has(st.actionStateId) ||
  st.actionStateId === ENTRY;
const hidden = (st: PlayerState) => gone(st) || vanished(st);
/** a stage's own particle bank (its file's map_ptcl), read once; null when it has none */
const stageBanks = new WeakMap<Stage, EffectBank | null>();
function stageBankOf(st: Stage | null | undefined): EffectBank | null {
  if (!st) return null;
  let b = stageBanks.get(st);
  if (b === undefined) {
    try { b = new EffectBank(st.file, "map_ptcl", 1000 + st.stageId); } catch { b = null; }
    stageBanks.set(st, b);
  }
  return b;
}
/** whether a track's stage generator events name their joints (a version 2 track of a newer simulator): the
 *  effect world then makes the stage's generators itself, in the game's order with everything else's */
const stageInWorldOf = new WeakMap<ViewerTrack, boolean>();
function stageInWorld(tr: ViewerTrack | null): boolean {
  if (!tr) return false;
  let v = stageInWorldOf.get(tr);
  if (v === undefined) {
    v = tr.betweenOf(["gen", "sgen"], -1e9, 1e9).some((e) => e.length >= (e[1] === "gen" ? 10 : 11));
    stageInWorldOf.set(tr, v);
  }
  return v;
}

// a shield's tilt toward the stick (guard.ts), from the frame it came up
const guarding = (st: PlayerState) => st.actionStateId >= 178 && st.actionStateId <= 182 && st.actionStateId !== 180;
/** how many frames a shield has been coming up (GuardOn, and on through a
 *  powershield's GuardReflect), 0 on the first: the replay's own counter
 *  stays at -1 the whole way */
function risingAge(data: ReplayData, fno: number, player: number, nana: boolean): number {
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  let g = fno;
  while (g > 0 && fno - g < 600 && (at(g - 1)?.actionStateId === 178 || at(g - 1)?.actionStateId === 182)) g--;
  return fno - g;
}
function tiltOf(data: ReplayData, fno: number, player: number, nana: boolean, ek: EffectKit | undefined) {
  if (!ek?.guardEase) return null;
  const run: GuardFrame[] = [];
  for (let g = fno; g >= 0 && fno - g < 1200; g--) {
    const p = data.frames[g]?.players[player];
    const st = nana ? p?.nanaState : p?.state, inp = nana ? p?.nanaInputs : p?.inputs;
    if (!st || !guarding(st)) break;
    run.push({ state: st.actionStateId, facing: st.facingDirection, x: inp?.processed.joystickX ?? 0, y: inp?.processed.joystickY ?? 0 });
    if (st.actionStateId === 178 && data.frames[g - 1]?.players[player]?.state.actionStateId !== 178 && !nana) break;
  }
  return guardTilt(run.reverse(), ek.guardEase);
}
/** what a fighter is posed from: its state, and a shield's tilt */
/** whether the viewer track's animations are used (the pose check turns them off to compare) */
let gameAnims = true;
/** a fighter's swinging joints' turns at a replay frame's end, written over a pose's, when the player's swinging
 *  chains were stepped through that frame (set by the player: its chains are its own) */
let swungAt: ((player: number, nana: boolean, frame: number, rot: Float32Array) => void) | null = null;
/** a fighter's animations as the game played them, when the viewer track has
 *  them (fighter.ts gamePose), for replay frame `fno` */
const gameAnimOf = (tr: ViewerTrack | null, player: number, nana: boolean, fno: number,
                    from?: { data: ReplayData; ek: EffectKit | undefined; fi: Fighter }): GameAnim | null =>
  gameAnims && tr?.has("anim") ? {
    at: (g) => tr.animAt(player, nana ? 1 : 0, g), frame: fno - 123,
    swung: (g, rot) => swungAt?.(player, nana, g + 123, rot),
    // (the same fighter on an earlier frame: what a blend starts from, what a state with no animation keeps)
    input: from ? (g) => {
      const f = g + 123, p = from.data.frames[f]?.players[player], st = nana ? p?.nanaState : p?.state;
      if (!st || st.internalCharacterId !== from.fi.internalId) return null;
      return { ...posing(from.data, f, st, player, nana, from.ek), subaction: waitSubOf(from.data, from.fi, player, nana, f),
               ...modelTurn(from.data, f, st, player, nana, from.fi),
               root2: root2Of(from.ek, st.internalCharacterId), transN: transNOf(from.ek, st.internalCharacterId),
               game: gameAnimOf(tr, player, nana, f, from), fallLean: fallLeanOf(from.data, f, st, player, nana, from.ek, from.fi) };
    } : undefined,
  } : null;

// A fall's lean (ftCo_Fall_Anim_Inner): each frame of Fall, FallAerial and
// FallSpecial the game works out how hard the fighter drifts - its own air
// speed over its top drift speed (attributes +0x6C), past a dead zone
// (ftCommonData +0x444) the fall's forward animation when it drifts the way
// it faces and the backward one when not - eases an amount toward that
// (+0x448 of the way a frame, from 0 as the fall starts), and moves the joints
// that amount of the way to the animation it leans into, which it takes up
// at the fall's own frame and plays on from there. The speed is the one the
// frame before ended with (the animation comes before the physics).
const FALLS = new Set([29, 32, 35]);
function fallLeanOf(data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, ek: EffectKit | undefined,
                    fi: Fighter): FallLean | null {
  const k = ek?.fallLean;
  if (!FALLS.has(st.actionStateId) || !k) return null;
  const top = fi.commonAttr(0x6c);
  if (!(top > 0)) return null;
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  let from = fno;
  while (from > 0 && fno - from < 240 && at(from - 1)?.actionStateId === st.actionStateId) from--;
  let amount = 0, which: 0 | 1 | 2 = 0, taken = -1, takenAt = 0;
  for (let g = from + 1; g <= fno; g++) {
    const was = at(g - 1), now = at(g);
    if (!was || !now || !Number.isFinite(was.selfInducedAirXSpeed)) return null;
    const drift = Math.max(-1, Math.min(1, was.selfInducedAirXSpeed / top)), hard = Math.abs(drift);
    const to = hard > k.dead ? (drift * was.facingDirection > 0 ? 1 : 2) : 0;
    amount += k.ease * ((hard > k.dead ? (hard - k.dead) / (1 - k.dead) : 0) - amount);
    if (amount !== 0 && to !== which) { which = to; taken = g; takenAt = now.actionStateFrameCounter; }
  }
  if (taken < 0 || !(amount > 0)) return null;
  return { sub: which, amount: Math.min(1, amount), frame: takenAt + (fno - taken) + 1, first: taken === fno ? takenAt : undefined };
}

/** how far off the stage's plane a fighter stands, from the viewer track
 *  (track.ts depthAt): not while it is KO'd (its own flight: koPlace) */
const fighterDepth = (tr: ViewerTrack | null, player: number, nana: boolean, fno: number, st: PlayerState): number =>
  gameAnims && tr && st.actionStateId > 11 ? tr.depthAt(player, nana ? 1 : 0, fno - 123, st.xPosition, st.yPosition) : 0;

const posing = (data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, ek: EffectKit | undefined,
                borrow: { anim: FigaTree; nodeJoint: number[]; facing: number } | null = null) =>
  guarding(st) ? { ...st, guard: tiltOf(data, fno, player, nana, ek), guardAge: risingAge(data, fno, player, nana) }
  // (thrown: facing the way the game turned it - its thrower's way for a
  // throw, ftCo_800DE3FC, and the other way in Captain Falcon's and
  // Ganondorf's up-B, ftCo_8009CA0C - which the replay has as its own facing)
  : borrow ? { ...st, borrow, facingDirection: borrow.facing } : st;

/** a sum of a skeleton's joints' turns under TopN: the same for a pose that stands still (the checks') */
const poseSum = (rot: Float32Array) => { let v = 0; for (let i = 3; i < rot.length; i++) v += rot[i] * ((i % 7) + 1); return Math.round(v * 1000) / 1000; };

/** what a fighter was posed from on the last frame before its state began, for a state with no animation of its
 *  own and no viewer track to say what the game kept (PoseInput.kept): back past any state that has none either
 *  (buried, then waiting buried), to the last frame of a move with one */
function keptOf(data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, ek: EffectKit | undefined,
                fi: Fighter): () => PoseInput | null {
  return () => {
    const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
    let g = fno, state = st.actionStateId;
    for (let hops = 0; hops < 24; hops++) {
      while (g > 0 && fno - g < 1800 && at(g - 1)?.actionStateId === state) g--;
      const was = g > 0 ? at(g - 1) : undefined;
      if (!was || was.internalCharacterId !== st.internalCharacterId || gone(was)) return null;
      if (fi.animFor(was.actionStateId)) {
        const c = was.internalCharacterId;
        return { ...posing(data, g - 1, was, player, nana, ek), subaction: waitSubOf(data, fi, player, nana, g - 1),
                 root2: root2Of(ek, c), transN: transNOf(ek, c), airborne: was.isGrounded === true, clock: g - 1 };
      }
      state = was.actionStateId;
      g--;
    }
    return null;
  };
}

// The way the model is turned. The game turns TopN to the fighter's facing
// as a state starts (Fighter_ChangeMotionState) and not again. A move whose
// animation carries the fighter round (a turn, a roll forward, a back throw:
// its flags name the part it turns by, Fighter.turnsByAnimation) changes the
// facing partway while the model stays as it was set, and the model is put to
// the new facing when the next state starts: its turn is the facing the
// state's first frame had. Any other move that changes the facing does so by
// starting its state again in place, which a replay does not show: there the
// turn is the frame's facing.
function modelFacing(data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, fi: Fighter): number {
  if (!fi.turnsByAnimation(st.actionStateId)) return st.facingDirection;
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  let g = fno, now = st;
  while (g > 0 && fno - g < 600) {
    const was = at(g - 1);
    if (!was || was.actionStateId !== st.actionStateId || was.actionStateFrameCounter > now.actionStateFrameCounter) break;
    now = was;
    g--;
  }
  return now.facingDirection;
}

// A jump that turns the fighter round: Yoshi's second jump and Kirby's and Jigglypuff's jumps in the air, begun
// with the stick held back, turn TopN a share of a half turn each frame for their own attributes' +0 frames, and
// the facing changes at the middle of it (ft_800CB6EC: once as the jump begins, then each frame of its animation
// callback - ftYs_JumpAerial_Enter and ftYs_JumpAerial_Anim_Cb, ftCo_800D74A4 and ftCo_JumpAerialF1_Anim). The
// replay shows the facing change, not the stick's test: a jump whose facing changes is one turning, and the frame
// it changes on is the step the count came to half. One cut short before the middle is not seen.
const TURN_JUMP: Record<number, (s: number) => boolean> = {
  14: (s) => s === 27, 4: (s) => s >= 341 && s <= 345, 15: (s) => s >= 341 && s <= 345,
};
function jumpTurn(data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, fi: Fighter): number | undefined {
  if (!TURN_JUMP[st.internalCharacterId]?.(st.actionStateId)) return undefined;
  const n = fi.ownAttrInt(0);
  if (!(n > 0 && n < 120)) return undefined;
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  const same = (a: PlayerState | undefined, b: PlayerState | undefined) =>
    !!a && !!b && a.actionStateId === st.actionStateId && b.actionStateId === st.actionStateId && a.actionStateFrameCounter <= b.actionStateFrameCounter;
  let e = fno;
  while (e > 0 && fno - e < 600 && same(at(e - 1), at(e))) e--;
  const first = at(e)!.facingDirection;
  let flip = -1;
  for (let g = e + 1; g <= e + n + 2 && same(at(g - 1), at(g)); g++) if (at(g)!.facingDirection !== first) { flip = g; break; }
  if (flip < 0) return undefined;
  // (the facing changes on the step that leaves half the count: steps done then, and one more each frame)
  const steps = Math.max(0, Math.min(n, n - Math.floor(n / 2) + (fno - flip)));
  return (Math.PI / 2) * first - steps * Math.PI / n;
}
/** the way the model is turned on a frame: the facing it was turned to (modelFacing), and for a jump that turns
 *  it round TopN's own turn (jumpTurn) */
function modelTurn(data: ReplayData, fno: number, st: PlayerState, player: number, nana: boolean, fi: Fighter):
    { facingDirection: number; turn?: number } {
  const turn = jumpTurn(data, fno, st, player, nana, fi);
  return turn === undefined ? { facingDirection: modelFacing(data, fno, st, player, nana, fi) }
    : { facingDirection: modelFacing(data, fno, st, player, nana, fi), turn };
}

/** the model joint of a fighter's second root, its named part 53 (fighter.ts applyAnim); -1 without one */
const ROOT2 = 53;
/** the model joint that is a fighter's TransN (its named part 1): joint 2 for Mewtwo and Mr. Game & Watch */
const transNOf = (ek: EffectKit | undefined, char: number): number | undefined => {
  const part = ek ? ek.partToJoint(char, 1) : -1;
  return part > 0 ? partToModelJoint(char, part) : undefined;
};
const root2Of = (ek: EffectKit | undefined, char: number): number => {
  const part = ek ? ek.partToJoint(char, ROOT2) : -1;
  return part > 0 ? partToModelJoint(char, part) : -1;
};

// Held and thrown (ftCo_CapturePulled.c, ftCo_Thrown.c): the one held has its
// XRotN held where its holder's TransN2 is (a position constraint the game
// adds as the grab takes it, ftCo_800DB368), and, thrown, plays its
// thrower's animation of it (the thrower's subaction for the thrown state:
// the generic skeleton's PlyTaro_Share_ACTION_T<fighter>Throw..., its nodes
// the named parts)
// (the grabs and throws every fighter has; and the special ones: Captain Falcon's
// and Ganondorf's up-B, Yoshi's neutral-B, Bowser's side-B, Kirby's inhale,
// Mewtwo's throws - ftCo_Capture*.c, ftCo_Thrown*.c. A thrown state plays the
// thrower's animation when the thrower has one for it: Fighter.thrownAnim)
const CAPTURED = new Set([223, 224, 225, 226, 227, 228, 275, 276, 278, 279, 280, 283, 284, 285, 289, 301, 302, 331]);
// (Kirby's star, ThrownKirbyStar and ThrownCopyStar, 290 and 291: thrown too - inlineB2 enters them with
// Fighter_ChangeMotionState given the thrower, so the one hidden in it plays Kirby's animation of it, and the
// star, held to its YRotN by place and turn (lb_8000C2F8), is turned as that animation turns it)
const THROWN = new Set([239, 240, 241, 242, 243, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 279, 281, 282, 284, 286, 287,
                        290, 291, 301, 302, 303, 304]);
const XROTN = 2, TRANSN2 = 52, TARO_PARTS = 52, TRANSN = 1, THROWN_PART = 51;
/** Yoshi (internal id), and the state of one laid in his egg */
const YOSHI_ID = 14, YOSHI_EGG = 277;
/** one laid in an egg by Kirby with Yoshi's copy (ftCo_MS_KirbyYoshiEgg; 331, CaptureKirbyYoshi, is his tongue pulling it in) */
const KIRBY_YOSHI_EGG = 332;
/** what Kirby holds through a copy's move: the copy, its states, its data's joint slot, the part it is held to */
const KB_HELD: { kind: number; states: [number, number]; slot: number; part: number; sized: boolean }[] = [
  { kind: 10, states: [453, 454], slot: 1, part: 31, sized: false }, // Ice Shot: the hammer on his LThumbNb
  { kind: 18, states: [492, 499], slot: 0, part: 49, sized: true },  // Shield Breaker (Marth's): the sword on his RThumbNb
  { kind: 26, states: [530, 537], slot: 0, part: 49, sized: true },  // and Roy's
];
/** who holds a fighter held or thrown: the nearest of the others */
function captorOf(a: Actor, actors: Actor[]): Actor | null {
  const s = a.st.actionStateId;
  if (!CAPTURED.has(s) && !THROWN.has(s)) return null;
  let best: Actor | null = null, dist = Infinity;
  for (const o of actors) {
    if (o.player === a.player || gone(o.st)) continue;
    // (a star's thrower is a Kirby: the nearest, as kirbyHeld takes him)
    if (KIRBY_STARS.has(s) && o.st.internalCharacterId !== KIRBY) continue;
    const d = Math.hypot(o.st.xPosition - a.st.xPosition, o.st.yPosition - a.st.yPosition);
    if (d < dist) { dist = d; best = o; }
  }
  return best;
}
const nodeJoints = new Map<number, number[]>();
/** a fighter's joint for each named part (a borrowed animation's nodes) */
function nodeJointsOf(ek: EffectKit, c: number): number[] {
  let out = nodeJoints.get(c);
  if (!out) {
    out = Array.from({ length: TARO_PARTS }, (_, k) => partToModelJoint(c, ek.partToJoint(c, k)));
    nodeJoints.set(c, out);
  }
  return out;
}

// Fire Fox and Fire Bird: while flying, the game's code leans the fighter's
// XRotN (named part 2) along the way it flies - the move's angle, which the
// replay's speeds give (on the ground, state 355, the floor's: level)
const FIRE_FOX = new Set([355, 356]);
// A tumble that rolls (DamageFlyRoll): the game turns XRotN to the way the
// fighter flies, facing x atan2 of its speed across over its speed up, the
// fighter's own and the knockback's together - as the state begins and each
// physics step after (ftCo_Damage.c inlineA1, doFlyRoll); the replay has both
// speeds, as they stand after the frame's physics
const FLY_ROLL = 91;
function lean(ek: EffectKit | undefined, st: PlayerState): { joint: number; angle: number } | undefined {
  const c = st.internalCharacterId;
  if (st.actionStateId === FLY_ROLL && ek) {
    const vx = (st.selfInducedAirXSpeed ?? 0) + (st.attackBasedXSpeed ?? 0);
    const vy = (st.selfInducedAirYSpeed ?? 0) + (st.attackBasedYSpeed ?? 0);
    return { joint: partToModelJoint(c, ek.partToJoint(c, 2)), angle: (st.facingDirection < 0 ? -1 : 1) * Math.atan2(vx, vy) };
  }
  if ((c !== 1 && c !== 22) || !FIRE_FOX.has(st.actionStateId) || !ek) return undefined;
  const f = st.facingDirection < 0 ? -1 : 1;
  const vx = st.selfInducedAirXSpeed, vy = st.selfInducedAirYSpeed;
  const travel = st.actionStateId === 355 || (vx === 0 && vy === 0) ? 0 : Math.atan2(vy, vx * f);
  return { joint: partToModelJoint(c, ek.partToJoint(c, 2)), angle: 2 * Math.PI - travel };
}

// The main picture draws what the game draws: its effects run from the
// fighters' own move scripts and the hits (fx/world.ts, fx/contact.ts), its
// reflector, shield, angel platform and Yoshi's Story's Shy Guys, all with
// the game's own art (effects3d.ts). simulated runs, the see-through ghosts,
// keep the reading aids instead: a plain shield bubble and the line art's
// projectile hitboxes.
// Where a fighter's middle is above its feet (a run's number goes over
// twice that; a hit no hitbox explains sparks there)
const middle = (char: number) => actionMapByInternalId[char]?.shieldOffset[1] ?? 8;

export interface Stats {
  fps: number; // frames drawn in the last second
  drawMs: number; // mean time to draw one, on the CPU side
  hudMs: number; // the HUD's share of it (hud.ts)
  mirrorMs: number; // the stage mirror's share (Fountain's pond)
  worstMs: number;
  draws: number; // draw calls in the last frame
  culled: number; // meshes the camera could not see, not sent
  mirrorDraws: number; // the stage mirror's share of them
  frames: number; // frames drawn since the page opened
  fighters: number; // posed this frame (ghosts included)
  ghosts: number;
  look480: boolean; // the 480p look is on
  lookGpuMs: number | null; // its copy and stretch on the graphics card (null: off, or the browser cannot say)
  crt: string; // the TV the Console view is shown on (crt.ts): off, trinitron or pvm
  curve: number; // and its curve (0: flat)
  /** the player: seen, warmed up, drawing every frame, free to load, playing */
  player: { seen: boolean; warm: boolean; every: boolean; mayLoad: boolean; running: boolean; waiting: string };
}

/** every (character, costume) a replay needs, Zelda/Sheik and Nana included */
function wanted(data: ReplayData, into: Set<string>) {
  const costumes = data.settings.playerSettings.map((p) => p?.costumeIndex ?? 0);
  for (const f of data.frames) {
    for (const p of f.players) {
      if (!p) continue;
      into.add(`${p.state.internalCharacterId}:${costumes[p.playerIndex] ?? 0}`);
      if (p.nanaState) into.add(`${p.nanaState.internalCharacterId}:${costumes[p.playerIndex] ?? 0}`);
    }
  }
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.replace("#", "").slice(0, 6), 16);
  if (!/^#?[0-9a-f]{6}/i.test(c) || isNaN(n)) return [0.49, 0.23, 0.93];
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** the viewer track's camera ("cam": eye, interest, field of view, and the
 *  quake's offset, as the game has them), frame by frame as camera.ts's own:
 *  the offset moves the eye and the interest alike */
function camFromTrack(tr: ViewerTrack, n: number): Float32Array {
  const out = new Float32Array(n * CAM_STRIDE);
  const changes = tr.changes("cam", "");
  let k = 0, cur = changes[0];
  for (let f = 0; f < n; f++) {
    while (k + 1 < changes.length && changes[k + 1][0] <= f - 123) cur = changes[++k];
    const [, ex, ey, ez, ix, iy, iz, fov, tx, ty] = cur.map(Number);
    out.set([ex + tx, ey + ty, ez, ix + tx, iy + ty, iz, fov], f * CAM_STRIDE);
  }
  return out;
}

// The 480p look (look480.ts): the picture as the console's video output makes
// it. Off by default; the page's setting (embed.tsx) or ?look=480 turns it on,
// and every 3D player on the page follows the page.
export const [look480, setLook480] = createSignal(new URLSearchParams(location.search).get("look") === "480");
// The TV the Console view is shown on (crt.ts), the same way: the page's
// setting (embed.tsx) or ?crt= in the URL
const crtInUrl = new URLSearchParams(location.search).get("crt");
export const [crtPreset, setCrtPreset] = createSignal<CrtPreset>(isCrtPreset(crtInUrl) ? crtInUrl : "off");
// and how much its tube curves (the page's Curve slider for that TV; 0: flat)
export const [crtCurve, setCrtCurve] = createSignal(0);
// (each player's own name for the edge its line art is cut at)
let tubes = 0;

/** the page holding the player told how its viewer track stands (a page may
 *  wait for "ready" or "none" before it shows a clip) */
function tellTrack(state: "ready" | "pending" | "none") {
  if (window.parent !== window) window.parent.postMessage({ type: "track", state }, "*");
}

/** how many stalls and lost contexts a page tells the diagnostics of (a
 *  player starts over each time: one that keeps at it says so a few times) */
let reportsLeft = 4;
function tellDiag(name: string, message: string) {
  if (reportsLeft <= 0) return;
  reportsLeft--;
  const e = new Error(message);
  e.name = name;
  try { reportError(e); } catch { /* an old browser */ }
}

/** The 3D player. `onFail`: it cannot draw (the page draws the line art and
 *  tries 3D again); `onStall`: loading stopped getting anywhere, `onLost`: the
 *  graphics card dropped its picture - the page starts it over (without them,
 *  both are failures); `onReady`: warmed up, it plays. `quiet`: a try made
 *  behind the line art - it holds nothing up while it loads. `retrying`: its
 *  cover says 3D is catching up rather than loading */
export function Viewer3D(props: { onFail: (reason: string) => void; onStall?: (reason: string) => void;
                                  onLost?: (reason: string) => void; onReady?: () => void; quiet?: boolean;
                                  retrying?: boolean; source?: string | null; corner?: JSX.Element }) {
  let canvas!: HTMLCanvasElement;
  let renderer: Renderer | undefined;
  // what the replay does not record, from the simulator, when a track was given
  // it for this replay (track.ts); asked for again while it is being made
  const [viewerTrack, setViewerTrack] = createSignal<ViewerTrack | null>(null);
  let trackWhy = "";
  // whether the track's answer is in: the track, or why there is none (not
  // while it is being made - the warm-up waits a while for it)
  const [trackSettled, setTrackSettled] = createSignal(false);
  // (while it is being made the player says so in its corner, and the page
  // holding it is told how it stands - tellTrack)
  const [trackPending, setTrackPending] = createSignal(false);
  createEffect(() => {
    const path = props.source ? replayPath(props.source) : null;
    setViewerTrack(null);
    trackWhy = path ? "being made" : "no viewer track given";
    setTrackSettled(!path);
    setTrackPending(!!path);
    tellTrack(path ? "pending" : "none");
    if (!path) return;
    onCleanup(fetchTrack(path, (t) => { trackWhy = ""; setViewerTrack(t); setTrackSettled(true); setTrackPending(false); tellTrack("ready"); },
                         (why) => {
                           trackWhy = why;
                           if (why !== "being made") { setTrackSettled(true); setTrackPending(false); tellTrack("none"); }
                         }));
  });
  const [stage, setStage] = createSignal<Stage>();
  // whether the renderer's programs are linked (Renderer.ready)
  const [linked, setLinked] = createSignal(false);
  // the page's other players (pagePlayers.ts): whether this one can be seen,
  // whether it may load now, and whether it draws every frame
  const peers = new PagePlayer();
  onCleanup(() => peers.remove());
  const [inSight, setInSight] = createSignal(true);
  const [mayLoad, setMayLoad] = createSignal(true);
  let seenArea = 0, drawEvery = true, drawTick = 0;
  const [ready, setReady] = createSignal<Map<string, Fighter>>(new Map());
  const [size, setSize] = createSignal<[number, number]>([730, 600]);
  const [itemMatrix, setItemMatrix] = createSignal([1, 0, 0, -1, 0, 0], { equals: (a, b) => a.every((v, i) => v === b[i]) });
  const [kit, setKit] = createSignal<EffectKit>();
  const [kitDone, setKitDone] = createSignal(false);
  // the loads still out that the warm-up waits for (each fighter's effects, Kirby's copies)
  const [loadsOut, setLoadsOut] = createSignal(0);
  const out = <T,>(p: Promise<T>): Promise<T> => {
    setLoadsOut((n) => n + 1);
    p.finally(() => setLoadsOut((n) => n - 1)).catch(() => { /* its own handler says */ });
    return p;
  };
  // Kirby's hats, as they load (kind:costume -> the hat, or null: none)
  const [kbHats, setKbHats] = createSignal<Map<string, KirbyHat | null>>(new Map());
  const kbAsked = new Set<string>();
  // Kirby's copies' files as they load (their projectiles: kirbyCopies)
  const [kbCopyCount, setKbCopyCount] = createSignal(0);
  const kbHat = (kind: number, costume: number): KirbyHat | null => {
    const key = `${kind}:${costume}`;
    const got = kbHats().get(key);
    if (got !== undefined) return got;
    if (!kbAsked.has(key)) {
      kbAsked.add(key);
      out(files.kirbyHat(kind, costume)).then((h) => {
        if (h?.prop) renderer?.warm(h.prop.skeleton);
        if (h?.skin) renderer?.warm(h.skin);
        setKbHats((m) => new Map(m).set(key, h));
      }).catch(() => setKbHats((m) => new Map(m).set(key, null)));
    }
    return null;
  };
  // each numbered run's tag over its head, in game units (the overlay's)
  const [runTags, setRunTags] = createSignal<{ n: number; x: number; y: number; color: string }[]>([]);
  let fxw: FxWorld | null = null;
  let fxData: ReplayData | null = null;
  let fxTrack: ViewerTrack | null = null;
  const fxPercent = new Map<string, Before>();
  let failed = false;
  // whether this player holds the replay's playing up while it warms up
  // (replayStore.holdPlay): let go as it is ready, fails or goes
  let holding = false;
  const hold = (on: boolean) => {
    if (on === holding) return;
    holding = on;
    holdPlay(on);
  };
  const fail = (why: unknown) => {
    if (failed) return;
    failed = true;
    hold(false);
    props.onFail(String((why as Error)?.message ?? why));
  };

  const cam = { x: 0, y: 20, dist: 0 };
  const box = { w: 730, h: 600, dw: 0, dh: 0 };
  // the replay's own objects, not the store's proxies of them (every read
  // through a proxy costs, and a frame reads thousands): once per replay
  const rawData = createMemo(() => unwrap(replayStore.replayData));
  // (the articles the track says each kind of item is made with: articleOf)
  createEffect(() => { const d = rawData(); if (d) useTrackArticles(d, viewerTrack()); });
  const rawGhosts = createMemo(() => unwrap(replayStore.ghosts));
  // the heights the replay's fighters stand at (a hit's shake runs along the
  // floor one is hit on: hitlag.ts)
  const floors = createMemo(() => {
    const data = rawData();
    if (!data) return undefined;
    const all: PlayerState[] = [];
    for (const fr of data.frames) for (const p of fr.players) if (p) { all.push(p.state); if (p.nanaState) all.push(p.nanaState); }
    return floorHeights(all);
  });
  /** a fighter's shake this frame (hitlag.ts): a hit's, and a smash attack's
   *  charge; the viewer track's first offset of a hit says its table and
   *  floor. Null when it stands still */
  const shakeOf = (data: ReplayData, f: number, a: Actor, hf: typeof HIT_FEEL, fi: Fighter,
                   tr: ViewerTrack | null): [number, number] | null => {
    const stAt = (g: number) => {
      const p = data.frames[g]?.players[a.player];
      return p ? (a.nana ? p.nanaState ?? undefined : p.state) : undefined;
    };
    const key = `${a.player}:${a.nana ? 1 : 0}`;
    const hit = hitShakeAt(stAt, f, {
      hf, floorAt: floors(), by: (g, port) => data.frames[g]?.players[port]?.state,
      // (the floor it stands on, from the stage's collision data: its slope)
      floorNormal: (s) => stage()?.floors?.normal(s.lastGroundId) ?? null,
      said: tr?.has("shake") ? (g) => {
        const v = tr.at("shake", key, g - 123), s = stAt(g);
        return v && s ? shakeKindOf([Number(v[0]), Number(v[1])], s.facingDirection, hf) : null;
      } : undefined,
    });
    const charge = chargeShakeAt(stAt, f, (s) => fi.scriptFor(s).find((e) => e.kind === "smashCharge")?.frame ?? null, hf);
    if (!hit && !charge) return null;
    return [(hit?.[0] ?? 0) + (charge?.[0] ?? 0), (hit?.[1] ?? 0) + (charge?.[1] ?? 0)];
  };
  const viewProj = mat(), view = mat(), proj = mat();
  // (the game camera's projection as GX is loaded with it: the draw log's)
  const gxProj = new Float32Array(16);
  let gxProjOn = false;
  // (and its near and far planes: the stage's, when its code sets them)
  let camPlanes = cameraPlanes(null);
  // every (character, costume) the replay and its runs need, and whether all are in
  const wantedKeys = createMemo(() => {
    const data = rawData(), want = new Set<string>();
    if (!data) return want;
    wanted(data, want);
    for (const g of rawGhosts()) wanted(g.replayData, want);
    return want;
  });
  const allIn = createMemo(() => {
    const fs = ready();
    for (const k of wantedKeys()) if (!fs.has(k)) return false;
    return wantedKeys().size > 0;
  });
  // the game's match camera for this replay, run once from its first frame
  // (camera.ts); simulated runs, where they go elsewhere, are kept in the
  // picture as fighters of their own
  const camTrack = createMemo(() => {
    const data = rawData(), ghosts = rawGhosts();
    // the game's own camera, when the viewer track has it: exact (a simulated run's
    // runs, which go elsewhere, are not in it, so it is used without them)
    const tr = viewerTrack();
    const fromTrack = data && tr?.has("cam") && !ghosts.length ? camFromTrack(tr, data.frames.length) : null;
    if (fromTrack && !tr!.diverges) return fromTrack;
    // (else run once every fighter is in - it takes their camera boxes - not
    // again as each one comes; a track that parts from the replay has the
    // game's camera up to there, this one after)
    const st = stage(), fs = allIn() ? ready() : null;
    if (!data || !st?.camera || !fs) return fromTrack;
    const costumes = data.settings.playerSettings.map((p) => p?.costumeIndex ?? 0);
    // (a camera box is at the player's scale, not the character's: camera.ts)
    const playerScale = playerScales(data.settings.playerSettings);
    // (the quakes the fighters' hits and bounces start: hitlag.ts)
    const hf = kit()?.hitFeel ?? HIT_FEEL;
    // (each frame's fighters as the run asks for them, not all of the replay's up front)
    const actorsAt = (i: number): CamActor[] => {
      const fr = data.frames[i];
      const out: CamActor[] = [];
      const add = (key: string, s: PlayerState, costume: number, at?: [number, number], before?: PlayerState) => {
        const f = fs.get(`${s.internalCharacterId}:${costume}`);
        out.push({ key, x: at?.[0] ?? s.xPosition, y: at?.[1] ?? s.yPosition, facing: s.facingDirection,
                   state: s.actionStateId, box: f?.cameraBox ?? null, scale: playerScale[s.playerIndex] ?? 1,
                   quake: quakeOf(before, s, hf, f ? (state) => f.scriptQuakes(state) : undefined) });
      };
      // coming back on the angel platform (Rebirth), the game frames where
      // the platform will stop, not where it is (ftCo_Rebirth_Cam): where the
      // fighter is once the state ends
      const rebirthAt = (player: number, nana: boolean): [number, number] | undefined => {
        for (let g = i + 1; g < data.frames.length && g < i + 300; g++) {
          const p = data.frames[g]?.players[player];
          const s = nana ? p?.nanaState : p?.state;
          if (!s) return undefined;
          if (s.actionStateId !== REBIRTH) return [s.xPosition, s.yPosition];
        }
        return undefined;
      };
      for (const p of fr.players) {
        if (!p) continue;
        const c = costumes[p.playerIndex] ?? 0;
        const was = data.frames[i - 1]?.players[p.playerIndex];
        add(`${p.playerIndex}`, p.state, c, p.state.actionStateId === REBIRTH ? rebirthAt(p.playerIndex, false) : undefined,
            was?.state);
        if (p.nanaState) add(`${p.playerIndex}n`, p.nanaState, c,
                             p.nanaState.actionStateId === REBIRTH ? rebirthAt(p.playerIndex, true) : undefined,
                             was?.nanaState ?? undefined);
      }
      ghosts.forEach((g, gi) => {
        for (const p of g.replayData.frames[i]?.players ?? []) {
          const real = fr.players[p?.playerIndex ?? -1]?.state;
          if (!p || (real && Math.abs(real.xPosition - p.state.xPosition) < 0.01 && Math.abs(real.yPosition - p.state.yPosition) < 0.01)) continue;
          add(`g${gi}:${p.playerIndex}`, p.state, g.replayData.settings.playerSettings[p.playerIndex]?.costumeIndex ?? 0);
        }
      });
      return out;
    };
    const run = cameraRun(st.camera, actorsAt, data.frames.length,
                          fromTrack ? { track: fromTrack, frames: Math.max(0, Math.min(data.frames.length, tr!.until + 123)) } : undefined);
    camRun = run;
    return run.out;
  });
  // (the run goes on as far as the picture needs: camTrackTo; the rest in the page's idle time once the player is up)
  let camRun: CameraRun | null = null;
  const camTrackTo = (f: number): Float32Array | null => {
    const t = camTrack();
    if (t && camRun && camRun.out === t) camRun.advance(f + 1);
    return t;
  };
  const camFill = () => {
    const run = camRun;
    if (!run || run.done >= run.total) return;
    idle((left) => {
      if (camRun !== run) return;
      while (run.done < run.total && left() > 1) run.advance(run.done + 250);
      camFill();
    });
  };
  // the game camera's inverse view at a frame (a screen KO is placed by
  // it: the game's own, not the page's closer look), or null without it
  const camInvScratch = mat(), camViewScratch = mat();
  const camInvAt = (f: number): Float32Array | null => {
    const track = camTrackTo(f);
    if (!track || (f + 1) * CAM_STRIDE > track.length) return null;
    const t = f * CAM_STRIDE;
    gameView(camViewScratch, [track[t], track[t + 1], track[t + 2]], [track[t + 3], track[t + 4], track[t + 5]]);
    return invert(camInvScratch, camViewScratch);
  };

  // stats: when each frame was drawn, and how long it took
  const drawnAt: number[] = [];
  const frameLog: number[] = [];
  const drawTimes: number[] = [];
  const hudTimes: number[] = []; // the HUD's share of each
  let lastCulled = 0;
  const mirrorTimes: number[] = []; // the stage mirror's share of each
  let frames = 0, lastDraws = 0, lastFighters = 0, lastMirrorDraws = 0;
  // what each fighter was posed with on the last frame drawn (the checks read it)
  let lastPoses: { char: number; state: number; t: number; animFrames: number | null; at: number | null;
                   /** which fighter, how its joints were got (Fighter.posedBy), who holds it, where it is, a sum of
                    *  its joints' turns (poseSum) */
                   key: string; by: string; heldBy: string | null; x: number; y: number; sum: number;
                   ko?: { x: number; y: number; z: number; replayX: number; replayY: number }; face?: Face }[] = [];

  onMount(() => {
    try {
      mark("rendererStart");
      renderer = new Renderer(canvas);
      mark("rendererCreated");
    } catch (e) {
      fail(e);
      return;
    }
    // the graphics card dropping the picture (its memory wanted elsewhere, a
    // driver reset): said in the diagnostics, and the page starts the player
    // over on a new canvas - never left blank
    canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      if (failed) return;
      const why = "the graphics card dropped the 3D view";
      tellDiag("ContextLost", why);
      if (props.onLost) { failed = true; hold(false); props.onLost(why); } else fail(why);
    });
    // (its programs are linked while the rest loads: the first draw waits for them)
    renderer.ready.then(() => { mark("programsLinked"); setLinked(true); schedule(); }).catch(fail);
    // the canvas's size as the observer reports it: asking the canvas itself
    // while drawing would make the browser lay the page out first, every frame
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1], r = e?.contentRect;
      box.w = r?.width || 730; box.h = r?.height || 600;
      // (the screen pixels it covers, where the browser says: the CRT's grille is laid on them)
      const d = e?.devicePixelContentBoxSize?.[0];
      box.dw = d?.inlineSize ?? 0; box.dh = d?.blockSize ?? 0;
      setSize([box.w, box.h]);
      schedule();
    });
    ro.observe(canvas);
    // whether it can be seen: on the screen (the page's, through every frame
    // it is in), its part of the page shown, the tab in front
    let onScreen = true;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      onScreen = !!e?.isIntersecting;
      seenArea = e ? e.intersectionRect.width * e.intersectionRect.height : 0;
      beat();
    });
    io.observe(canvas);
    const beat = () => {
      const now = onScreen && document.visibilityState === "visible";
      peers.set(now, seenArea, replayStore.running);
      drawEvery = peers.first();
      setMayLoad(peers.mayLoad());
      if (now !== inSight()) { setInSight(now); if (now) schedule(); }
    };
    document.addEventListener("visibilitychange", beat);
    const beats = setInterval(beat, 500);
    onCleanup(() => { io.disconnect(); clearInterval(beats); document.removeEventListener("visibilitychange", beat); });
    onCleanup(() => { ro.disconnect(); renderer?.dispose(); });
    createEffect(() => {
      try {
        renderer?.setLook480(look480());
        renderer?.setCrt(crtPreset(), crtCurve());
      } catch (e) {
        fail(e);
        return;
      }
      schedule();
    });
    // (HUD Slots changed: the HUD is drawn again where it now sits, paused too)
    createEffect(follow(hudSlotsNow, () => schedule(), { defer: true }));
  });

  // load the stage and every fighter the replay and its ghosts will need
  createEffect(() => {
    const data = replayStore.replayData;
    if (!data || !mayLoad()) return;
    files.stage(data.settings.stageId).then((s) => {
      if (renderer) for (const sk of s.allSkeletons) renderer.warm(sk);
      if (renderer && s.shyGuy) renderer.warm(s.shyGuy.prop.skeleton);
      // Stadium's forms, ahead of the first transformation
      if (renderer) for (const parts of s.forms.values()) for (const p of parts) renderer.warm(p.skeleton);
      setStage(s);
    }).catch(fail);
  });
  // the game's HUD: its art once per page, then one display per replay (hud.ts)
  const [hudKit, setHudKit] = createSignal<HudKit>();
  const [hudDone, setHudDone] = createSignal(false);
  const [magColors, setMagColors] = createSignal<[number, number, number][] | null>(null);
  createEffect(() => {
    if (!replayStore.replayData || hudKit() || !mayLoad()) return;
    files.hud().then(setHudKit).catch((e) => console.warn("3D replay viewer: no HUD art:", e)).finally(() => setHudDone(true));
  });
  createEffect(() => {
    const data = replayStore.replayData;
    setMagColors(null);
    if (data) files.magnifierColors(data.settings.stageId).then(setMagColors);
  });
  // (where the HUD's draws start: after the frame's particles and the HUD's own generators, as the game runs its
  // procs - trials against Dolphin's pictures of the others: the percent area 0.886 against 0.862 to 0.864)
  let hudRng: "track" | "trackprev" | "ps" | "off" = "ps";
  // (the plates' and nametags' words as the page last gave them: a HUD made again - the stage's colors for its
  // magnifier coming in after it - takes them at once, as Hud3D gives them only when they change)
  let hudWords: { data: unknown; w: Map<string, string> } | null = null;
  const hudOf = createMemo(() => {
    const k = hudKit(), data = rawData(), st = stage();
    if (!k || !data) return null;
    try {
      const h = new Hud(k, data, magColors(), st?.camBounds ?? null);
      if (hudWords && hudWords.data === data) h.setWords(hudWords.w);
      // (the percent's shake and scatter from the game's own random numbers, when a viewer track has them:
      // the effect world's state at the end of the frame's particles - hud.ts shakeDraws)
      h.rngAt = (i) => {
        if (hudRng === "off") return null;
        if (hudRng === "ps") return fxw?.rngAfter.get(i) ?? null;
        return viewerTrack()?.rngAt(i - 123 - (hudRng === "trackprev" ? 1 : 0)) ?? null;
      };
      if (renderer) h.warm(renderer);
      return h;
    } catch (e) {
      console.warn("3D replay viewer: the HUD could not be made:", e);
      return null;
    }
  });
  createEffect(() => {
    if (!replayStore.replayData || kit() || !mayLoad()) return;
    files.effects().then((k) => {
      if (renderer) {
        for (const pr of [k.platform, k.reflector?.loop, k.reflector?.start, k.reflector?.hit]) if (pr) renderer.warm(pr.skeleton);
      }
      setKit(k);
    }).catch(() => { /* no effect art: the plain stand-ins */ }).finally(() => setKitDone(true));
  });
  // each fighter's own effect file (its special moves' effects), once the
  // common ones are in: the effects are run again with it
  createEffect(() => {
    const data = replayStore.replayData, k = kit();
    if (!data || !k || !mayLoad()) return;
    const chars = new Set<number>();
    for (const f of data.frames) for (const p of f.players) {
      if (p) { chars.add(p.state.internalCharacterId); if (p.nanaState) chars.add(p.nanaState.internalCharacterId); }
    }
    for (const c of chars) {
      out(files.fighterEffects(k, c)).then((got) => {
        if (!got.length) return;
        // (the reflector's models come in with Fox's or Falco's file: their textures sent ahead too)
        if (renderer) for (const pr of [k.reflector?.loop, k.reflector?.start, k.reflector?.hit]) if (pr) renderer.warm(pr.skeleton);
        fxw = null;
        schedule();
      });
    }
  });
  // the common items' file, when the replay has one of them (a Bob-omb or
  // Mr. Saturn pulled from the ground)
  createEffect(() => {
    const data = replayStore.replayData;
    if (!data || !mayLoad() || commonItemArts) return;
    if (!data.frames.some((f) => (f.items ?? []).some((it) => it.typeId <= COMMON_ITEM_LAST))) return;
    out(files.commonItems()).then((c) => { commonItemArts = c; setKbCopyCount((n) => n + 1); schedule(); });
  });
  // every effect file the viewer track's pieces name (the game's own: an
  // item's, a copy's, one no fighter of the replay's own lists): loaded
  // like a fighter's, and the effects run again with it. trackFiles: those
  // still being read (0 when all are in, or there is nothing to read)
  const [trackFiles, setTrackFiles] = createSignal(0);
  createEffect(() => {
    const k = kit(), tr = viewerTrack();
    if (!k || !tr || !mayLoad()) { setTrackFiles(0); return; }
    const want = [...trackFilesOf(tr)].filter((n) => n !== 30 && !k.banks.has(n));
    setTrackFiles(want.length);
    for (const n of want) {
      out(files.effectFile(k, n)).then(() => {
        setTrackFiles((c) => Math.max(0, c - 1));
        fxw = null;
        schedule();
      });
    }
  });
  // Kirby's copies' projectiles: each copy's file, for the ones the replay has
  createEffect(() => {
    const data = replayStore.replayData;
    if (!data || !mayLoad()) return;
    const kinds = new Set<number>();
    for (const f of data.frames) for (const it of f.items ?? []) {
      const k = KIRBY_ITEMS[it.typeId];
      if (k) kinds.add(k.kind);
    }
    // (and the copies whose data holds what he wears or lays with no item of
    // its own: the swords and the hammer in his hand, Yoshi's egg)
    const own = new Set([...KB_HELD.map((h) => h.kind), YOSHI_ID]);
    data.frames[0]?.players.forEach((p) => {
      if (!p || p.state.internalCharacterId !== KIRBY) return;
      for (const k of copiesOf(data, p.playerIndex)) if (own.has(k)) kinds.add(k);
    });
    for (const kind of kinds) {
      if (kirbyCopies.has(kind)) continue;
      out(files.kirbyCopy(kind)).then((c) => {
        kirbyCopies.set(kind, c);
        setKbCopyCount((n) => n + 1);
        schedule();
      }).catch(() => { /* its projectiles stay line art */ });
    }
  });
  createEffect(() => {
    if (!mayLoad()) return;
    const want = wantedKeys();
    for (const k of want) {
      if (ready().has(k)) continue;
      const [id, c] = k.split(":").map(Number);
      files.fighter(id, c).then((f) => {
        renderer?.warm(f.skeleton);
        setReady((m) => new Map(m).set(k, f));
      }).catch(fail);
    }
  });

  // ---- the warm-up. A replay does not start playing until everything it
  // needs is in and made: the renderer's programs linked, the stage, every
  // fighter and effect file, the HUD's art and the viewer track (waited for
  // a while when it is still being made), every texture decoded and sent,
  // each fighter's animations for the moves it makes read, and a frame drawn
  // under the cover. Until then the player says it is loading; asked to
  // play meanwhile, it plays once it is ready (replayStore.holdPlay). The
  // longer steps go a few milliseconds at a time, so the page - and another
  // player on it - keeps moving.
  const TRACK_WAIT = 8000;
  /** the longest loading may go without getting anywhere before the player
   *  starts over (ms): counted only while it may load and can be seen. A
   *  step waiting on a busy graphics card still moves within it (a
   *  simulation's round is 13-16 s); ?stallms= sets it for the checks */
  const WARM_LIMIT = Number(new URLSearchParams(location.search).get("stallms")) || 20000;
  /** the warm-up's steps done so far (the watch's: still moving) */
  let warmSteps = 0;
  const [warm, setWarm] = createSignal(false);
  createEffect(() => { if (warm()) { camTrack(); untrack(camFill); } });
  // (each new start of the warm-up: the effect below starts it again even
  // when the warm-up under way was not done - runs put over the replay while
  // it loads used to stop it for good)
  const [warmKick, setWarmKick] = createSignal(0);
  let warmStartedAt = 0;
  // how far the warm-up is (0-100), for the cover
  const [progress, setProgress] = createSignal(0);
  const [trackWaited, setTrackWaited] = createSignal(false);
  let warmFor: ReplayData | null = null;
  let waitingFor = "";
  createEffect(() => {
    const data = rawData();
    // (runs put over it are made ready too)
    void rawGhosts();
    setWarm(false);
    setTrackWaited(false);
    setProgress(0);
    warmFor = null;
    warmStartedAt = performance.now();
    setWarmKick((k) => k + 1);
    if (!data) return;
    mark("replayData");
    if (!untrack(() => props.quiet)) hold(true);
    const t = setTimeout(() => setTrackWaited(true), TRACK_WAIT);
    // (a warm-up that stops getting anywhere - a file that never comes, a
    // program that never links, a step that never finishes - must not leave
    // the player saying it is loading: it says so in the diagnostics by what
    // it was waiting for, and the page starts it over. A slow one that is
    // still moving - on a page busy playing another replay - is let finish;
    // time it may not load, or cannot be seen, does not count)
    const stall = new Stall(WARM_LIMIT);
    const stuck = setInterval(() => {
      if (warm() || failed || rawData() !== data) { clearInterval(stuck); return; }
      const at = `${waitingFor}|${warmSteps}|${renderer?.warmDone ?? 0}`;
      if (!stall.check(performance.now(), at, mayLoad() && inSight())) return;
      clearInterval(stuck);
      const what = (waitingFor || "warming").split(/[ ,(]/)[0];
      const why = `3D player stuck loading (waiting for ${waitingFor || "warming"})`;
      tellDiag("WarmupStuck" + what.charAt(0).toUpperCase() + what.slice(1).replace(/[^A-Za-z0-9]/g, ""), why);
      if (props.onStall) { failed = true; hold(false); props.onStall(why); } else fail(why);
    }, 1000);
    // (while it warms up where it can be seen, the host page is told every
    // 2 s (a {type: "warming"} message), in case it wants to hold other work)
    const tellWarming = () => {
      if (warm() || failed || rawData() !== data || !inSight() || !mayLoad()) return;
      files.tellWarming();
    };
    untrack(tellWarming);
    const beatWarm = setInterval(tellWarming, 2000);
    onCleanup(() => { clearTimeout(t); clearInterval(stuck); clearInterval(beatWarm); });
  });
  onCleanup(() => hold(false));
  createEffect(() => {
    void warmKick();
    const data = rawData(), st = stage(), fs = ready(), r = renderer;
    // (what it waits for, the checks' to read: stats().player.waiting)
    const waits = [!data && "replay", !r && "renderer", !mayLoad() && "its turn", !linked() && "programs", !st && "stage",
                   !kitDone() && "effects", !hudDone() && "HUD", loadsOut() > 0 && `files (${loadsOut()})`,
                   !trackSettled() && !trackWaited() && "track", !allIn() && "fighters"].filter((x) => x) as string[];
    waitingFor = warm() ? "" : warmFor === data && data ? "warming" : waits.join(", ");
    if (!data || !r || warm() || warmFor === data || !mayLoad()) return;
    if (!linked() || !st || !kitDone() || !hudDone() || loadsOut() > 0) return;
    if (!trackSettled() && !trackWaited()) return;
    if (!allIn()) return;
    warmFor = data;
    void warmUp(data, fs, r).then(() => {
      if (warmFor !== data || failed) return;
      setWarm(true);
      diagWarmed(warmStartedAt);
      mark("ready");
      hold(false);
      props.onReady?.();
      schedule();
    }).catch(fail);
  });
  /** each fighter's animations for the moves the replay has it make, read a
   *  few milliseconds at a time; the textures sent; then a frame drawn */
  const warmUp = async (data: ReplayData, fs: Map<string, Fighter>, r: Renderer) => {
    const costumes = data.settings.playerSettings.map((p) => p?.costumeIndex ?? 0);
    const moves = new Map<string, Set<number>>();
    const note = (s: PlayerState | null | undefined, c: number) => {
      if (!s) return;
      const k = `${s.internalCharacterId}:${c}`;
      let m = moves.get(k);
      if (!m) moves.set(k, (m = new Set()));
      m.add(s.actionStateId);
    };
    for (const f of data.frames) for (const p of f.players) if (p) { note(p.state, costumes[p.playerIndex] ?? 0); note(p.nanaState, costumes[p.playerIndex] ?? 0); }
    // (and the runs over it: their fighters' moves too)
    for (const g of rawGhosts()) {
      const gc = g.replayData.settings.playerSettings.map((p) => p?.costumeIndex ?? 0);
      for (const f of g.replayData.frames) for (const p of f.players) if (p) { note(p.state, gc[p.playerIndex] ?? 0); note(p.nanaState, gc[p.playerIndex] ?? 0); }
    }
    // (a slice at a time, in the page's idle time)
    let left = () => 6;
    let total = 0, done = 0;
    for (const [, states] of moves) total += states.size;
    const breathe = async () => {
      warmSteps++;
      done++;
      if (done % 16 === 0 && total > 0) setProgress(Math.min(99, Math.round((100 * done) / total)));
      // (the checks' stand-in for a step that never finishes)
      while ((globalThis as { __v3dHoldWarm?: boolean }).__v3dHoldWarm) await new Promise((r) => setTimeout(r, 100));
      if (left() > 1) return;
      await new Promise<void>((res) => idle((l) => { left = l; res(); }));
    };
    // (a still - ?snap=1 - is one frame: its fighters' moves are read as it draws)
    for (const [k, states] of SNAP ? [] : moves) {
      const fi = fs.get(k);
      if (!fi) continue;
      for (const s of states) {
        if (warmFor !== data) return;
        timed("anim", k, () => fi.animFor(s));
        await breathe();
      }
    }
    // the items' models, each kind in each state it takes (made as they first
    // show, else: a projectile's first frame would read its file then)
    if (!SNAP) {
      const seenItems = new Set<string>();
      for (let f = 0; f < data.frames.length; f++) {
        for (const it of data.frames[f].items ?? []) {
          const k = `${it.typeId}:${it.owner}:${it.state}`;
          if (seenItems.has(k)) continue;
          seenItems.add(k);
          if (warmFor !== data) return;
          try {
            const art = articleOf(data, fs, it, f);
            if (art) r.warm(art.prop.skeleton);
          } catch { /* drawn as it can be when it shows */ }
          await breathe();
        }
      }
    }
    mark("animsRead");
    await r.warmed();
    mark("texturesWarmed");
    // (a frame drawn, under the cover: what is made on a first draw is made now)
    if (warmFor === data) {
      draw();
      mark("firstDraw");
      requestAnimationFrame(() => mark("firstFramePresented"));
    }
  };

  // Kirby's hats for every copy he takes in the replay, before it plays (a
  // hat read as he first takes it is a stall, and he is bare meanwhile)
  createEffect(() => {
    const data = rawData();
    if (!data || !mayLoad()) return;
    const tr = viewerTrack();
    for (const ps of data.settings.playerSettings) {
      if (!ps) continue;
      const kinds = new Set<number>();
      const key = `${ps.playerIndex}:0:kb.kind`;
      if (tr?.hasKey("charge", key)) {
        for (const [, v] of tr.changes("charge", key)) kinds.add(Number(v));
      }
      // (and the replay's, for the frames after a track parts from it)
      if (!tr?.hasKey("charge", key) || tr.diverges) {
        let kirby = false;
        for (const f of data.frames) if (f.players[ps.playerIndex]?.state.internalCharacterId === KIRBY) { kirby = true; break; }
        if (kirby) for (const k of copiesOf(data, ps.playerIndex)) kinds.add(k);
      }
      for (const k of kinds) if (k >= 0 && k !== KIRBY) untrack(() => kbHat(k, ps.costumeIndex ?? 0));
    }
  });

  // one draw per change, however many signals moved together
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; draw(); });
  };
  createEffect(() => {
    void replayStore.frame; void replayStore.ghosts; void replayStore.zoom; void replayStore.replayData;
    void stage(); void ready(); void kit(); void hudOf();
    // (Fountain's platform heights sent by the embedding page: src/simulation-stage.ts)
    void stageRevision();
    schedule();
  });

  // (Stadium's screen, when the frame has no copy of the frame before to show: drawn a second time, with its own copy on the screen)
  let screenAgain = false;
  let lastDrawAt = 0;
  const draw = () => {
    screenAgain = false;
    lastDrawAt = performance.now();
    drawPass();
    if (screenAgain) { screenAgain = false; drawPass(); }
  };
  const drawPass = () => {
    const data = rawData();
    const fno = benchFrame ?? replayStore.frame;
    const ghosts = rawGhosts();
    const r = renderer;
    // (not while warming up, but for the one frame its end draws, under the cover)
    if (!r || !data || failed || r.lost || !r.isReady || (!warm() && warmFor !== data)) return;
    // (nothing drawn that cannot be seen - drawn once it can - and, playing
    // while another player the page shows bigger plays, every other frame)
    if (!inSight() && !SNAP && benchFrame === null) return;
    if (!drawEvery && replayStore.running && (drawTick++ & 1)) return;
    const frame = data.frames[fno];
    if (!frame) return;
    const t0 = performance.now();
    prof.start();
    let mirrorMs = 0;
    lastMirrorDraws = 0;
    const actors: Actor[] = [];
    for (const p of frame.players) {
      if (!p) continue;
      const s = data.settings.playerSettings[p.playerIndex];
      actors.push({ st: p.state, inputs: p.inputs, costume: s?.costumeIndex ?? 0, player: p.playerIndex, nana: false });
      if (p.nanaState) actors.push({ st: p.nanaState, inputs: p.nanaInputs ?? undefined, costume: s?.costumeIndex ?? 0, player: p.playerIndex, nana: true });
    }
    if (!actors.length) return;
    mark("drawStarted");

    // the camera follows the fighters, as the game's and the SVG viewer's do:
    // the ones on screen (not one waiting to come back off the top), and
    // simulated ghosts, so a run that goes somewhere else stays in the picture
    const w = box.w, h = box.h;
    const aspect = w / Math.max(1, h);
    const seen = actors.filter((a) => !a.st.isDead && a.st.actionStateId > 11);
    const framed = (seen.length ? seen : actors).map((a) => a.st);
    for (const g of ghosts) {
      const gf = g.replayData.frames[fno];
      for (const p of gf ? gf.players : []) if (p && !p.state.isDead && p.state.actionStateId > 11) framed.push(p.state);
    }
    // as the game's camera does, it goes no further than the stage's camera
    // range: a fighter beyond it is framed at its edge
    const cb = stage()?.camBounds;
    const xs = framed.map((s) => cb ? Math.min(cb.right, Math.max(cb.left, s.xPosition)) : s.xPosition);
    const ys = framed.map((s) => cb ? Math.min(cb.top, Math.max(cb.bottom, s.yPosition)) : s.yPosition);
    const x0 = Math.min(...xs) - PAD, x1 = Math.max(...xs) + PAD;
    const y0 = Math.min(...ys) - PAD, y1 = Math.max(...ys) + PAD + 10;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const halfH = Math.max(Math.max(x1 - x0, MIN_RANGE) / FRAME_W / aspect, Math.max(y1 - y0, MIN_RANGE) / FRAME_H) / 2;
    const dist = halfH / Math.tan(FOVY / 2) / Math.max(0.05, replayStore.zoom);
    const k = cam.dist === 0 || !replayStore.running ? 1 : 0.08;
    cam.x += (cx - cam.x) * k; cam.y += (cy - cam.y) * k; cam.dist += (dist - cam.dist) * k;
    const track = camTrackTo(fno);
    if (track && (fno + 1) * CAM_STRIDE <= track.length) {
      // the game's own camera (camera.ts), run for this replay; a closer
      // look (the page's zoom) brings the eye toward what it looks at
      const t = fno * CAM_STRIDE, z = Math.max(0.05, replayStore.zoom);
      const at = [track[t + 3], track[t + 4], track[t + 5]];
      const eye = [0, 1, 2].map((i) => at[i] + (track[t + i] - at[i]) / z);
      // (its matrices as the game makes them: camera.ts gameView, gameProjection - its near and far, and its
      // aspect when the picture is the game's shape)
      gameView(view, eye, at);
      const d = Math.hypot(eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]);
      camPlanes = cameraPlanes(rawData()?.settings.stageId);
      gameProjection(proj, gxProj, track[t + 6], Math.abs(aspect - CAM_ASPECT) < 0.01 ? CAM_ASPECT : aspect, ...camPlanes);
      gxProjOn = true;
      cam.dist = d; cam.x = at[0]; cam.y = at[1];
    } else {
      gxProjOn = false;
      const lift = cam.dist * LIFT;
      translation(view, -cam.x, -(cam.y + lift), -cam.dist);
      const f = 1 / Math.tan(FOVY / 2);
      // move the image, not the camera's aim: the target stays mid-screen
      perspective(proj, FOVY, aspect, Math.max(1, cam.dist * 0.05), cam.dist * 40, 0, -f * lift / cam.dist);
    }
    mul(viewProj, proj, view);
    setBillboardView(view);

    prof.mark("camera");
    const st = stage();
    // the stage's own code (gr/): what it does for this replay, its
    // particles run to this frame (which poses the stage at other frames),
    // then the stage posed for this one
    if (st) {
      const tr = viewerTrack();
      const scene = sceneFor(st, tr, data);
      // (some of a stage's particles are the common effects': Randall's puffs)
      if (!scene.particles.common && kit()?.bank) { scene.particles.common = kit()!.bank; scene.particles.reset(); }
      const ts = performance.now();
      // (with a track that names the stage's generators' joints they are the effect world's)
      if (stageInWorld(tr)) { if (scene.particles.ps.gens.length || scene.particles.ps.particles.length) scene.particles.ps.clear(); }
      else scene.particles.step(fno);
      stageMs = performance.now() - ts;
      // Fountain's platform heights are in replays from Slippi 3.18 on; before
      // that the parser's stand-ins are not the file's, so the stage keeps its own
      prof.mark("stageParticles");
      st.update(fno, stageFrame(data, fno));
      // Stadium's big screen: what it shows now
      if (scene.screen && st.screen) {
        scene.screen.draw(fno);
        r.liveImage(st.screen.image, scene.screen.canvas, scene.screen.version);
        // (the match's copy is the frame before's, whatever the number of draws of this frame)
        if (r.liveAdvance(st.screen.image, fno, scene.screen.mode === 7 || scene.screen.mode === 8, scene.screen.size[0], scene.screen.size[1])) screenAgain = true;
        // (a copy of the match is shown in the screen's constant green, the rest in its vertex colors)
        const m = scene.screen.mode;
        for (const s of st.setScreenConstant(m === 7 || m === 8, scene.screen.tint)) r.forgetMaterial(s);
      }
    }
    // the game clears to its stage's fog color (black without fog); the
    // stage is lit by its own lights, everything else by its player lights,
    // and all but the effects are in its fog
    prof.mark("stageLogic");
    r.begin(proj, view, st ? st.clear : [0.02, 0.02, 0.05], w, h, [box.dw, box.dh], gxProjOn ? gxProj : null,
            gxProjOn ? camPlanes : null);
    // (Stadium's screen: the game's lettering, a quad a glyph drawn into its picture, first of the frame's draws)
    if (st?.screen && scene?.screen) scene.screen.drawLetters(r, st.screen.image);
    const stageLit = st ? st.lighting.at(fno) : DEFAULT_LIGHTING;
    const lighting = st ? st.playerLighting.at(fno) : DEFAULT_LIGHTING;
    r.setFog(st?.fogNow ?? null);
    const fs = ready();
    const ek = kit();
    const posed: { f: Fighter; a: Actor }[] = [];
    drawnKirbyHats = [];

    // stage and fighters, opaque parts first, then the see-through ones; the
    // stage once the fighters are posed and their shadows made (below), as
    // the game makes them before it draws the stage (lbShadow_8000F38C)
    const drawStage = () => {
      if (st) {
        // (the back layers whole, first: the game draws them before the rest)
        r.setLighting(stageLit);
        for (const sk of st.skeletons) {
          if (layersOff[st.layerOf(sk) > 0 ? "back" : "stage"]) continue;
          r.setTint(st.tintOf(sk));
          r.drawSkeleton(sk, "opa");
          if (st.layerOf(sk) > 0) r.drawSkeleton(sk, "xlu");
        }
        r.setTint(null);
      }
      r.setLighting(lighting);
      prof.mark("stageDraw");
    };
    const skins: Fighter[] = [];
    const poses: typeof lastPoses = [];
    const frameActors: ActorFrame[] = [];
    // (one held or thrown: posed with its thrower's animation, then its XRotN
    // moved to where its holder's TransN2 is - worked out below, once all are posed)
    for (const a of actors) a.captor = captorOf(a, actors), a.hold = null;
    // (one the viewer track says its move script hid: set_fighter_vis - Yoshi's
    // tongue pulling someone in, a fighter before it enters. The track's bits:
    // 1 fp->invisible, 2 x221E_b5, 4 x2226_b5; ftDrawCommon_800805C8 leaves
    // the fighter out for either of the first two, the mirror's draw
    // (ftDrawCommon_80080C28) for any of the three)
    const trackAt = viewerTrack();
    const hideBits = (a: Actor) => Number(trackAt?.at("hide", `${a.player}:${a.nana ? 1 : 0}`, fno - 123)?.[0] ?? 0);
    const trackHidden = (a: Actor) => (hideBits(a) & 3) !== 0;
    const borrowOf = (a: Actor) => {
      if (!a.captor || !ek || !THROWN.has(a.st.actionStateId)) return null;
      const cf = fs.get(`${a.captor.st.internalCharacterId}:${a.captor.costume}`);
      const anim = cf?.thrownAnim(a.st.actionStateId);
      return anim ? { anim, nodeJoint: nodeJointsOf(ek, a.st.internalCharacterId), facing: a.st.facingDirection } : null;
    };
    const poseActor = (fi: Fighter, a: Actor) => {
      const sub = waitSubOf(data, fi, a.player, a.nana, fno);
      const input = { ...posing(data, fno, a.st, a.player, a.nana, ek, borrowOf(a)), subaction: sub,
                      game: gameAnimOf(trackAt, a.player, a.nana, fno, { data, ek, fi }),
                      root2: root2Of(ek, a.st.internalCharacterId), transN: transNOf(ek, a.st.internalCharacterId),
                      ...(borrowOf(a) ? {} : { ...modelTurn(data, fno, a.st, a.player, a.nana, fi) }),
                      fallLean: fallLeanOf(data, fno, a.st, a.player, a.nana, ek, fi),
                      kept: keptOf(data, fno, a.st, a.player, a.nana, ek, fi), clock: fno, airborne: a.st.isGrounded === true,
                      depth: fighterDepth(trackAt, a.player, a.nana, fno, a.st) };
      // (entering: growing up, and the entry's animation held after it)
      const en = ek ? entryPose(a.st.actionStateId, stateAge(data, fno, a.player, a.nana), ek.entry, fi.modelScale) : null;
      fi.pose(en ? { ...input, yScale: en.yScale, holdAnimOf: en.holdAnimOf } : input, rollSpin(a) ?? lean(ek, a.st), a.ko, a.face);
      afterPose(fi, a);
      if (a.hold) { fi.skeleton.shift = a.hold; fi.skeleton.update(); }
      // (its swinging chains, as stepped to this frame)
      const dy = dyns.get(actorKey(a.player, a.nana));
      if (dy && dy.fi === fi && dy.d.frame === fno) {
        dy.d.apply(fi.skeleton.rot, fi.skeleton.trans, fi.skeleton.scale);
        fi.skeleton.update();
      }
      // (and the ones the simulator runs - the chains a hurtbox sits on - as the game swung them, when the
      // track has them: "fp")
      const swungBy = trackAt?.pose("fp", `${a.player}:${a.nana ? 1 : 0}:${a.st.internalCharacterId}`, fno - 123);
      if (swungBy && layTrackSwing(fi, a.st.internalCharacterId, swungBy.joints, true)) fi.skeleton.update();
    };
    for (const a of actors) {
      const fi = fs.get(`${a.st.internalCharacterId}:${a.costume}`);
      if (!fi) continue;
      // one KO'd or asleep is not drawn, but the effects hear of it (a KO's
      // blast); a star or screen KO is, somewhere of its own
      const ko = gone(a.st) ? koAt(data, fno, a.player, a.nana, a.st, camInvAt(fno)) : null;
      if (gone(a.st) && !ko) {
        frameActors.push({ key: actorKey(a.player, a.nana), st: a.st, fighter: fi, world: NO_WORLD });
        continue;
      }
      a.ko = ko;
      a.face = faceOf(data, fi, a.player, a.nana, fno, viewerTrack());
      a.roll = rollOf(data, fi, a.player, a.nana, fno);
      a.stone = stoneOf(data, fi, a.player, a.nana, fno);
      a.rollout = rolloutOf(data, fi, a.player, a.nana, fno);
      a.kirbyHeld = kirbyHeld(data, fno, a, actors, fs);
      poseActor(fi, a);
      // a fighter its move makes vanish is not drawn, but its effects go on
      // (Sheik's Vanish bursts where she was)
      if (vanished(a.st) || trackHidden(a)) {
        frameActors.push({ key: actorKey(a.player, a.nana), st: a.st, fighter: fi, world: worldByPart(a.st.internalCharacterId, fi.skeleton.world) });
        continue;
      }
      const an = fi.animFor(a.st.actionStateId);
      poses.push({ char: a.st.internalCharacterId, state: a.st.actionStateId, face: a.face,
                   t: a.st.actionStateFrameCounter, animFrames: an?.frames ?? null,
                   at: an ? animTime(a.st.actionStateFrameCounter, an.frames) : null,
                   key: actorKey(a.player, a.nana), by: fi.posedBy, heldBy: null, x: a.st.xPosition, y: a.st.yPosition,
                   sum: poseSum(fi.skeleton.rot),
                   ...(ko ? { ko: { x: ko.x, y: ko.y, z: ko.z, replayX: a.st.xPosition, replayY: a.st.yPosition } } : {}) });
      frameActors.push({ key: actorKey(a.player, a.nana), st: a.st, fighter: fi, world: worldByPart(a.st.internalCharacterId, fi.skeleton.world) });
      const hip = partToModelJoint(a.st.internalCharacterId, ek?.hipOf(a.st.internalCharacterId) ?? -1);
      a.hip = hip >= 0 && hip < fi.skeleton.n ? fi.skeleton.position(hip) : undefined;
      a.scale = fi.modelScale;
      a.platform = fi.modelScale * fi.platformScale;
      skins.push(fi);
      posed.push({ f: fi, a });
    }
    for (const { f: fi, a } of posed) {
      const c = a.captor ? posed.find((q) => q.a === a.captor) : undefined;
      if (!c || !ek) continue;
      const cc = c.a.st.internalCharacterId, vc = a.st.internalCharacterId;
      const tj = partToModelJoint(cc, ek.partToJoint(cc, TRANSN2)), vj = partToModelJoint(vc, ek.partToJoint(vc, XROTN));
      if (tj < 0 || vj < 0) continue;
      poseActor(c.f, c.a);
      const at = c.f.skeleton.position(tj);
      a.hold = null;
      poseActor(fi, a);
      const from = fi.skeleton.position(vj);
      a.hold = { joint: vj, d: [at[0] - from[0], at[1] - from[1], at[2] - from[2]] };
      poseActor(fi, a);
      const fa = frameActors.find((x) => x.key === actorKey(a.player, a.nana));
      if (fa) fa.world = worldByPart(vc, fi.skeleton.world);
      const po = poses.find((x) => x.key === actorKey(a.player, a.nana));
      if (po) { po.by = fi.posedBy; po.heldBy = actorKey(c.a.player, c.a.nana); po.sum = poseSum(fi.skeleton.rot); }
    }
    // the game's effects, stepped to this frame (their colors on the
    // fighters are this frame's; the effects themselves are drawn later)
    prof.mark("pose");
    if (ek?.bank) {
      // (made again when a viewer track comes in: what it says replaces the guesses)
      const tr = viewerTrack();
      if (!fxw || fxData !== data || fxTrack !== tr) {
        fxw = makeWorld(ek, data, fs, tr);
        fxData = data;
        fxTrack = tr;
      }
      if (!fxw.ko && st?.camera) fxw.ko = koLook(ek, st);
      // (the color animations' tables come with the shared fighter file,
      // which may load after the world is made)
      if (!fxw.colTables && ek.colAnims) fxw.colTables = ek.colAnims;
      // (a skip or a jump steps the frames between, posing the fighters
      // for each: posed again for this one, to be drawn)
      // (checkpoints ahead first, in a little of the frame's time - not while the frame is timed - the stage and the
      // fighters posed for this frame again after)
      const filled = benchFrame === null && fillChecks(fxw, data, fs, FILL_MS);
      if (filled && st && stageInWorld(tr)) st.update(fno, stageFrame(data, fno));
      if (advance(fxw, data, fs, fno, frameActors) || filled) for (const { f: fi, a } of posed) poseActor(fi, a);
      // (the swinging chains are stepped to this frame now: those with them posed again)
      for (const { f: fi, a } of posed) {
        const key = actorKey(a.player, a.nana);
        if (!dyns.has(key)) continue;
        poseActor(fi, a);
        const fa = frameActors.find((x) => x.key === key);
        if (fa) fa.world = worldByPart(a.st.internalCharacterId, fi.skeleton.world);
      }
    }
    // the fighters, each in its color animation's tint (fx/colanim.ts); a
    // fighter drawn twice in one frame (a ditto in the same costume) was
    // posed for its last user: pose each again. With a viewer track, the
    // color the game drew is the track's (a hit by a thrown item, a charge
    // stored before the replay starts), and the scripts here only start the
    // effects theirs start
    lastTints = [];
    const tr = viewerTrack();
    // (what each fighter looks like this frame - its parts, its color, a
    // copy's hat - found once, for all its passes)
    const looks = new Map<string, { parts: number[]; tint: ColTint | null; kh: KirbyHat | null }>();
    // (a fighter drawn for two actors - a ditto in one costume - is posed for each)
    const shared = new Set(skins.filter((s, i) => skins.indexOf(s) !== i));
    // a fighter hit shakes in place, one charging a smash attack trembles:
    // its model and what it holds, drawn moved (hitlag.ts)
    const shakes = new Map<string, [number, number]>();
    for (const { f: fi, a } of posed) {
      const sh = shakeOf(data, fno, a, ek?.hitFeel ?? HIT_FEEL, fi, tr);
      if (sh) shakes.set(actorKey(a.player, a.nana), sh);
    }
    lastShakes = shakes;
    // what a fighter looks like this frame, found once for all its passes (its shadow's too)
    const lookOf = (fi: Fighter, a: Actor, akey: string) => {
      let look = looks.get(akey);
      if (!look) {
        // its model parts as the game switched them: the track's switches when
        // it has them, else the states known to switch one (Yoshi's egg)
        const parts: number[] = [];
        for (let part = 0; part < fi.partCount; part++) {
          let v = fi.defaultPart(part);
          if (tr?.hasAt("part", fno - 123)) {
            const c = tr.at("part", `${a.player}:${a.nana ? 1 : 0}:${part}`, fno - 123);
            if (c) v = Number(c[0]);
          } else v = ownPart(fi, a, part, frame.items ?? []);
          parts.push(v);
          fi.setPart(part, v);
        }
        // (a part shown now that was hidden when the pose was made: its
        // meshes posed too - else the first frame of a switch drew them
        // where they last stood: Kirby's Stone blinking out)
        fi.skeleton.update();
        const fromTrack = tr?.tint(a.player, a.nana ? 1 : 0, fno - 123, a.st.facingDirection);
        const tint = fromTrack !== undefined ? fromTrack : fxw?.tintOf(akey, a.st.facingDirection) ?? null;
        // Kirby's copy's hat: the viewer track's copy (kb.kind, 4 for none),
        // else the replay's (kirby.ts). A hat in his colors covers his body:
        // its meshes instead of his body's lookup 0, unless his face is in
        // one of its special looks (part 0's variants 2 to 6), when it goes
        // (ftKb_UnkIntBoolFunc0)
        let kh: KirbyHat | null = null;
        if (a.st.internalCharacterId === KIRBY) {
          const key = `${a.player}:${a.nana ? 1 : 0}:kb.kind`;
          const said = tr?.hasKey("charge", key) ? tr.at("charge", key, fno - 123) : null;
          const kind = said ? Number(said[0]) : copiesOf(data, a.player)[fno] ?? -1;
          kh = kind >= 0 && kind !== KIRBY ? kbHat(kind, a.costume) : null;
          if (kh?.skin) {
            const face = fi.partNow(0);
            if (face >= 2 && face <= 6) kh = null;
          }
          drawnKirbyHats.push({ player: a.player, kind, loaded: !!kh });
        }
        look = { parts, tint, kh };
        looks.set(akey, look);
        lastTints.push({ key: akey, tint, anims: fxw?.colAnimsOf(akey) ?? null });
      } else {
        for (let part = 0; part < look.parts.length; part++) fi.setPart(part, look.parts[part]);
      }
      return look;
    };
    prof.mark("fxStep");
    // one Kirby spat out, or let out of his mouth as he copies it: hidden, his star in its place - his own article
    // 4 (ftKb_SpecialN_800F5898), its size the one in it's common attributes' +0xDC, held to that one's YRotN
    // where it is and as it turns (ftCommon_SetAccessory, lb_8000C2F8: ftCo_ThrownKirby.c inlineB2); posed
    // once a frame, for its shadow and its draw
    const kirbyStars = new Map<Actor, { fi: Fighter; star: Prop } | null>();
    const kirbyStarOf = (a: Actor) => {
      if (kirbyStars.has(a)) return kirbyStars.get(a)!;
      let out: { fi: Fighter; star: Prop } | null = null;
      if (KIRBY_STARS.has(a.st.actionStateId) && ek) {
        const kb = actors.find((o) => o !== a && o.st.internalCharacterId === KIRBY);
        const star = kb ? fs.get(`${KIRBY}:${kb.costume}`)?.accessory(4) ?? null : null;
        const fi = fs.get(`${a.st.internalCharacterId}:${a.costume}`);
        const fa = frameActors.find((x) => x.key === actorKey(a.player, a.nana));
        const j = ek.partToJoint(a.st.internalCharacterId, 3);
        const on = fi && star && fa && j >= 0 && (j + 1) * 16 <= fa.world.length ? fa.world.subarray(j * 16, j * 16 + 16) : null;
        if (star && fi && on) {
          star.poseUnder(stateAge(data, fno, a.player, a.nana), on, fi.commonAttr(0xdc) || 1, true, 0);
          out = { fi, star };
        }
      }
      kirbyStars.set(a, out);
      return out;
    };
    // the fighters' shadows (shadow.ts): each drawn flat into its own picture
    // through its shadow camera, before the stage, which takes them
    const shadowMaps: { tex: WebGLTexture; mtx: Float32Array; y: number; laid: boolean }[] = [];
    const sl = st && !layersOff.fighters ? st.playerLighting.shadowLight(fno) : null;
    if (st && sl) {
      const scales = playerScales(data.settings.playerSettings);
      // (the shadow's camera on the fighter's camera bone, ftLib_800866DC: attributes +0x16C name it by its
      // place in the fighter's bone list, fp->parts, not by a common part's name)
      const cameraOf = (fi: Fighter, a: Actor) => {
        const joint = partToModelJoint(a.st.internalCharacterId, fi.cameraPart);
        if (joint < 0 || joint >= fi.skeleton.n) return null;
        const W = fi.skeleton.world, o = fi.cameraOffset, k = joint * 16;
        const bone = [0, 1, 2].map((i) => W[k + i] * o[0] + W[k + 4 + i] * o[1] + W[k + 8 + i] * o[2] + W[k + 12 + i]);
        return shadowCamera(sl.pos, sl.interest, bone, (fi.cameraBox?.v[2] ?? 0) * (scales[a.player] ?? 1));
      };
      for (const a of actors) {
        const p = posed.find((q) => q.a === a);
        // (one hidden in Kirby's star: its draw, which its shadow is made with, leaves its model out and
        // draws its accessory, the star, all the same - ftDrawCommon_800805C8 - so its shadow is the star's)
        const star = p ? null : kirbyStarOf(a);
        if (!p && !star) continue;
        const fi = p?.f ?? star!.fi;
        if (p && shared.has(fi)) poseActor(fi, a);
        const cam = cameraOf(fi, a);
        if (!cam) continue;
        const t = r.shadowTarget(shadowMaps.length);
        r.beginShadow(t, cam.proj, cam.view, st.shadowIntensity);
        if (p) {
          const look = lookOf(fi, a, actorKey(a.player, a.nana));
          // (its low-detail model, as in a mirror: ftDrawCommon_80081200 switches every fighter to it first)
          const low = look.kh?.skin ? null : fi.mirrorPassHidden();
          if (low) { fi.skeleton.posePass(low); fi.skeleton.passHidden = low; }
          else if (look.kh?.skin) fi.skeleton.passHidden = fi.hiddenUnderHat();
          r.drawSkeleton(fi.skeleton, "opa");
          fi.skeleton.passHidden = null;
        } else r.drawSkeleton(star!.star.skeleton, "opa");
        r.endShadow();
        // (made for every fighter, laid by none of Nana's materials: ftLib_800872BC keeps a sub fighter's inactive)
        shadowMaps.push({ tex: t.tex, mtx: cam.tex, y: a.st.yPosition, laid: !a.nana });
      }
    }
    r.setShadows(shadowMaps.reverse());
    prof.mark("shadows");
    drawStage();
    // (a fighter's hats are posed on it once a frame, or for each pass when it is shared)
    const hatsPosed = new Set<string>();
    // (`under`: the lights current while they are drawn, when not their own -
    // the pond's first draw, under the stage's)
    const drawFighters = (pass: "opa" | "xlu", mirror = false, under: Lighting | null = null) => {
      if (layersOff.fighters) return;
      for (const { f: fi, a } of posed) {
        if (mirror && hideBits(a) & 4) continue;
        const again = shared.has(fi);
        if (again) poseActor(fi, a);
        const akey = actorKey(a.player, a.nana);
        const poseHats = !hatsPosed.has(akey) || again;
        hatsPosed.add(akey);
        const look = lookOf(fi, a, akey);
        const kh = look.kh;
        r.setTint(look.tint);
        // (a color animation's light sets the fighter's lights whatever is
        // current: ftCo_8009F5AC makes the fighters' own set current (light
        // enable) or their set's ambient light (lobj1), then adds its own -
        // so in the pond's first draw too, under the stage's lights - and
        // ftCo_8009F7F8 leaves the fighters' own set current after it, so the
        // fighters drawn after it in that pass are lit by their own set too)
        if (under !== null && look.tint?.light) { r.setLighting(lighting); under = null; }
        // (its shake moves its model, its hats and outline with it, not its trail)
        const sh = shakes.get(akey);
        if (sh) r.shiftDraws(sh[0], sh[1]);
        if (kh?.skin) fi.skeleton.passHidden = fi.hiddenUnderHat();
        // (in a stage's mirror, its low-detail model: ftDrawCommon_80080C28)
        const low = mirror && !kh?.skin ? fi.mirrorPassHidden() : null;
        if (low) { fi.skeleton.posePass(low); fi.skeleton.passHidden = low; }
        // Mr. Game & Watch's outline first, in its color, writing no depth
        // (ftDrawCommon_80080E18), then his body over it
        if (fi.outlineColor && pass === "opa" && !mirror) {
          fi.skeleton.passHidden = fi.outlinePassHidden();
          // (the outline pass takes neither color animation: ftMaterial_800BF6BC
          // lays the outline's color in place of the overlay's, and
          // ftMaterial_800BF534 adds no light overlay while x2223_b2 is set)
          r.setTint(null);
          r.setOutline(fi.outlineColor);
          r.setNoDepthWrite(true);
          r.drawSkeleton(fi.skeleton, "opa");
          r.setNoDepthWrite(false);
          r.setOutline(null);
          r.setTint(look.tint);
          fi.skeleton.passHidden = null;
        }
        // its face's textures on their frames (face.ts)
        fi.faceTex?.apply(a.face?.tex ?? null);
        r.drawSkeleton(fi.skeleton, pass);
        fi.skeleton.passHidden = null;
        // then the outline's shells again, in depth only (ftDrawCommon_80080E18's second draw: x2223_b3,
        // whose pixel engine ftMaterial_800BF2B8 sets to compare and update depth and write no color)
        if (fi.outlineColor && pass === "opa" && !mirror) {
          fi.skeleton.passHidden = fi.outlinePassHidden();
          r.setTint(null);
          r.setDepthOnly(true);
          r.drawSkeleton(fi.skeleton, "opa");
          r.setDepthOnly(false);
          r.setTint(look.tint);
          fi.skeleton.passHidden = null;
        }
        // its sword's swing strip, drawn with its see-through parts
        // (ftafterimage.c; not in a mirror, whose draw leaves it out)
        if (pass === "xlu" && fxw && !mirror && !layersOff.effects) {
          const strip = fxw.swords.strip(actorKey(a.player, a.nana), fxw.swordOf(fi));
          if (strip) {
            if (sh) r.shiftDraws(0, 0);
            r.drawTrail(strip);
            if (sh) r.shiftDraws(sh[0], sh[1]);
          }
        }
        if (kh?.prop && (HAT_JOINT + 1) * 16 <= fi.skeleton.world.length) {
          // (Yoshi's copy: the hat as its tongue's animations have it through his neutral-B)
          const ya = kh.anims ? yoshiHatAnim((k) => {
            const p = data.frames[fno - k]?.players[a.player];
            return (a.nana ? p?.nanaState : p?.state)?.actionStateId;
          }) : null;
          const hp = (ya ? kh.anims![ya.slot] : null) ?? kh.prop;
          if (poseHats) hp.poseMatrix(fi.skeleton.world.subarray(HAT_JOINT * 16, HAT_JOINT * 16 + 16), ya?.frame);
          r.drawSkeleton(hp.skeleton, pass);
        } else if (kh?.skin) {
          if (poseHats) poseSkin(kh, fi.skeleton);
          kh.face?.apply(a.face?.tex ?? null);
          // (Mr. Game & Watch's copy: its outline first, as his is drawn)
          if (kh.outline && pass === "opa") {
            kh.skin.passHidden = kh.outline.hidden;
            r.setTint(null);
            r.setOutline(kh.outline.color);
            r.setNoDepthWrite(true);
            r.drawSkeleton(kh.skin, "opa");
            r.setNoDepthWrite(false);
            r.setOutline(null);
            r.setTint(look.tint);
            kh.skin.passHidden = null;
          }
          r.drawSkeleton(kh.skin, pass);
          if (kh.outline && pass === "opa") {
            kh.skin.passHidden = kh.outline.hidden;
            r.setTint(null);
            r.setDepthOnly(true);
            r.drawSkeleton(kh.skin, "opa");
            r.setDepthOnly(false);
            r.setTint(look.tint);
            kh.skin.passHidden = null;
          }
        }
        // a costume's hat, on its joint as posed now, in the fighter's tint
        const hat = fi.hat, hj = hat?.joint ?? -1;
        if (hat && (hj + 1) * 16 <= fi.skeleton.world.length) {
          if (poseHats) hat.prop.poseMatrix(fi.skeleton.world.subarray(hj * 16, hj * 16 + 16));
          r.drawSkeleton(hat.prop.skeleton, pass);
        }
        if (sh) r.shiftDraws(0, 0);
      }
      r.setTint(null);
    };
    prof.mark("fx");
    drawFighters("opa");
    prof.mark("fightersOpa");
    // (an owner's joint as posed this frame, for the items the game ties to one)
    const jointOf = (owner: number, j: number): Float32Array | null => {
      const fa = frameActors.find((x) => x.key === actorKey(owner, false));
      return fa && j >= 0 && (j + 1) * 16 <= fa.world.length ? fa.world.subarray(j * 16, j * 16 + 16) : null;
    };
    const heldShake = (owner: number) => shakes.get(actorKey(owner, false));
    drawnArticles = [];
    drawnShields = [];
    const partJoint = (owner: number, part: number): number => {
      const c = frame.players[owner]?.state.internalCharacterId;
      return c === undefined || !ek ? -1 : ek.partToJoint(c, part);
    };
    const trNow = viewerTrack();
    const turnOf = (spawnId: number): number[] | null => {
      const v = trNow?.at("irot", String(spawnId), fno - 123);
      return v && v.length >= 3 ? v.map(Number) : null;
    };
    // (an item's joints as the game posed them, and the chains whose links the track has: drawn from them)
    const itemPose = (spawnId: number) => trNow?.pose("jp", String(spawnId), fno - 123)?.joints ?? null;
    const trackChains = new Set<number>();
    if (trNow?.has("lm")) for (const it of frame.items ?? []) if (trNow.pose("lm", String(it.spawnId), fno - 123)) trackChains.add(it.spawnId);
    // The chains whose links the track has ("lm": hookshots, Sheik's chain, the yo-yo, the belay, the grapple
    // beam), each link at the matrix the item's code gave it, and the grapple's glow. Each link (the end too)
    // and the beam itself are drawn by HSD_GObj_JObjCallback (it_802A24A0 asks only whether the link is up),
    // which does not look at which of the main camera's two passes it is in: so the game draws their opaque
    // parts twice, in Camera_800311EC's first pass under the stage's lights and in its second under the
    // fighters', and their see-through parts once (Camera_80031328); the items' own it_8026EECC draws in one of
    // the two only. `note`: the glow's place for the checks, once a frame
    const drawChains = (pass: "opa" | "xlu", note = false) => {
      for (const it of frame.items ?? []) {
        if (!trackChains.has(it.spawnId)) continue;
        const links = trNow!.pose("lm", String(it.spawnId), fno - 123);
        const f = articleFighter(data, fs, it, fno);
        if (links && f) drawTrackChain(r, f, it, links, trackArticles.get(data)?.get(it.typeId), itemLife(data, fno, it), pass);
      }
      for (const a of actors) {
        const c = CHAINS[a.st.internalCharacterId];
        const costume = data.settings.playerSettings[a.player]?.costumeIndex ?? 0;
        const f = c ? fs.get(`${a.st.internalCharacterId}:${costume}`) : undefined;
        if (!c || !f || c.glowAnim === undefined) continue;
        // (the chain's own item, for its glow: its animations run from when it is made)
        const own = c.itemType === undefined ? undefined
          : (frame.items ?? []).find((it) => it.owner === a.player && c.itemType === it.typeId);
        if (!own) continue;
        const item = { state: own.state, age: itemLife(data, fno, own) };
        // its glow, held at the arm the whole time, fired or not (Item_8026AB54
        // with ThrowN's number, which ftLib_80086630 takes as the fighter's own
        // part slot, not through the named-part table: Samus's joint 51, her cannon)
        const on = jointOf(a.player, THROWN_PART);
        const glow = f.articleAnimated(c.art, null, c.glowAnim), art = f.article(c.art, 0);
        if (on && glow) {
          glow.poseUnder(item.age, on, (art?.scale ?? 1) * f.modelScale, false, 0);
          const w = glow.skeleton.world;
          if (note) {
            drawnArticles.push({ type: own.typeId, state: item.state, x: w[12], y: w[13], z: w[14], scale: Math.hypot(w[0], w[1], w[2]),
                                 shown: Array.from(glow.skeleton.shown), age: item.age });
          }
          r.drawSkeletonTrsp(glow.skeleton, TRSP[pass]);
          r.endPass();
        }
      }
    };
    // (their first opaque copy, under the stage's lights, then the second, under the fighters')
    if (st) r.setLighting(stageLit);
    drawChains("opa");
    r.setLighting(lighting);
    drawChains("opa");
    // Fountain of Dreams' pond: what the game draws after the stage - the
    // fighters, the items, the effects - seen from below the floor into the
    // stage's mirror image, before the pond is drawn with it (grizumi.c)
    // (not drawn while no part of the pond is in view: nothing would show it)
    let mirrorDrawn = false;
    if (st?.mirror && st.mirrorSurfaces.some(({ sk, d }) => sk.isVisible(d) && r.inView(d))) {
      const m0 = performance.now(), d0 = r.draws;
      mirrorDrawn = true;
      const axesM = r.beginMirror();
      // (grIzumi_801CCEA0: the mirror's camera draws links 0, 2 and 5 - the
      // scenery under the stage's lights, and the fighters - in their opaque
      // and cut-out passes, then links 4, 5 and 6 in all three passes: the
      // fighters' own lights (link 4, ftCo_8009F4A4), the fighters again over
      // their first draw, see-through parts too, and the items; then the
      // effects. So the fighters in the pond are lit as they are above it -
      // the second draw covers the first at the same depth - but both are
      // drawn, as the game draws them)
      r.setLighting(stageLit);
      // (a pass takes a joint by its own flags - OPA, TEXEDGE, XLU - not by its
      // materials': the mirror-only scenery's backdrop, joint 4, is a cut-out
      // joint whose material is see-through, so it is in the mirror's passes)
      if (!layersOff.stage) for (const sk of st.mirrorSkeletons) { r.drawSkeleton(sk, "opa"); r.drawSkeleton(sk, "xlu"); }
      r.endPass();
      drawFighters("opa", true, stageLit);
      r.endPass();
      r.setLighting(lighting);
      drawFighters("opa", true);
      drawFighters("xlu", true);
      if (!layersOff.items) for (const it of frame.items ?? []) drawArticleTracked(r, data, fs, it, fno, jointOf, partJoint, turnOf, heldShake, itemPose);
      // (and the chains: grIzumi_801CCEA0's links 4 to 6 in all three passes, once)
      drawChains("opa");
      drawChains("xlu");
      drawnArticles = [];
      r.setFog(null);
      if (ek?.bank && fxw && !layersOff.effects) {
        drawFxModels(r, fxw);
        const mine = fxw.particlesOf(false);
        if (mine.length) {
          const built = buildParticles(mine, axesM);
          r.drawParticles(built.data, built.batches);
        }
      }
      r.setFog(st.fogNow);
      r.endMirror();
      mirrorMs = performance.now() - m0;
      lastMirrorDraws = r.draws - d0;
    }
    if (st) {
      r.setLighting(stageLit);
      for (const sk of st.skeletons) {
        if (st.layerOf(sk) || layersOff.stage) continue;
        r.setTint(st.tintOf(sk));
        r.drawSkeleton(sk, "xlu");
      }
      r.setTint(null);
    }
    r.setLighting(lighting);
    prof.mark("stageXlu");
    drawFighters("xlu");
    prof.mark("fightersXlu");
    r.endPass();
    // the angel platform under a fighter coming back, Yoshi's Story's Shy
    // Guys, then the effects over everything
    for (const a of actors) if (onAngelPlatform(a.st)) drawPlatform(r, ek, a, fno);
    // the stands the fighters enter the match on (the leader's only: ftCo_800C6408)
    for (const a of actors) {
      const s = a.st.actionStateId;
      if (a.nana || (s !== ENTRY_START && s !== ENTRY_END) || !ek?.entryStand) continue;
      const fi = fs.get(`${a.st.internalCharacterId}:${a.costume}`);
      const en = fi ? entryPose(s, stateAge(data, fno, a.player, false), ek.entry, fi.modelScale) : null;
      if (!fi || !en || en.stand <= 0) continue;
      // (the stand and its set-back go by the player's scale, x34_scale - 1 in a
      // versus match - not the character's model scaling: ftCo_800C6408, ftCommon_800804EC)
      const ps = playerScales(data.settings.playerSettings)[a.player] ?? 1;
      drawStand(r, ek.entryStand, a.st, standScale(ps, fi.trophyScale), en.stand, fi.entryGap * ps);
    }
    if (st?.shyGuy) drawShyGuys(r, st.shyGuy, data, frame.items ?? [], fno);
    prof.mark("fighters2");
    let projectiles = 0;
    // (a chain's item is drawn as its own model too - the hookshot in Link's hand - its links from "lm" below)
    for (const it of layersOff.items ? [] : frame.items ?? []) {
      if (drawArticleTracked(r, data, fs, it, fno, jointOf, partJoint, turnOf, heldShake, itemPose)) projectiles++;
    }
    // one Yoshi laid in an egg: hidden, the egg (his articles' slot 3) worn
    // in its place - its child on the victim's TransN, the egg the victim's
    // size and growing to it over his attributes' +0x20 frames from +0x1C
    // short of it (ftCo_800BBED4, ftCo_800BBCC0). Laid by Kirby with Yoshi's
    // copy: the egg is his copy file's (Yoshi's copy, its list's slot 0), and
    // the growing his own attributes' +0x3BC frames from +0x3B8 short
    // (ftKb_SpecialNYs_8010AC78, fn_8010AA64)
    const yoshi = [...fs.entries()].find(([k]) => k.startsWith(`${YOSHI_ID}:`))?.[1];
    const kirby = [...fs.entries()].find(([k]) => k.startsWith(`${KIRBY}:`))?.[1];
    for (const a of actors) {
      const s = a.st.actionStateId;
      if ((s !== YOSHI_EGG && s !== KIRBY_YOSHI_EGG) || !ek) continue;
      const layer = s === YOSHI_EGG ? yoshi : kirby;
      const fi = fs.get(`${a.st.internalCharacterId}:${a.costume}`);
      const egg = s === YOSHI_EGG ? yoshi?.accessory(3) ?? null : kirbyCopies.get(YOSHI_ID)?.joint(0) ?? null;
      const on = fi && egg ? jointOf(a.player, ek.partToJoint(a.st.internalCharacterId, TRANSN)) : null;
      if (!layer || !fi || !egg || !on) continue;
      const [spanAt, shortAt] = s === YOSHI_EGG ? [0x20, 0x1c] : [0x3bc, 0x3b8];
      // (its own timer, a frame each frame from the egg's start - the replay's
      // counter is the egg's looping animation's: ftCo_800BBCC0)
      const span = layer.ownAttr(spanAt), short = layer.ownAttr(shortAt), t = stateAge(data, fno, a.player, a.nana) + 1;
      const grow = span > 0 && t < span ? 1 - short + short * Math.max(0, t) / span : 1;
      egg.poseUnder(0, on, fi.size * grow, false, Math.min(1, egg.skeleton.n - 1));
      r.drawSkeleton(egg.skeleton, "opa");
      r.drawSkeleton(egg.skeleton, "xlu");
      r.endPass();
    }
    // what Kirby holds through a copy's move: the Ice Climbers' hammer, Marth's
    // and Roy's sword - his copy data's joint, made his accessory as the move
    // begins (ftCommon_SetAccessory) and held to his thumb where it is and as
    // it turns (lb_8000C2F8), gone with the move (ftkirbyspecialiceclimber.c,
    // ftkirbyspecialmars.c: the sword at his size)
    for (const a of actors) {
      const s = a.st.actionStateId;
      if (a.st.internalCharacterId !== KIRBY || !ek) continue;
      const held = KB_HELD.find((h) => s >= h.states[0] && s <= h.states[1]);
      const prop = held ? kirbyCopies.get(held.kind)?.joint(held.slot) ?? null : null;
      const on = held && prop ? jointOf(a.player, ek.partToJoint(KIRBY, held.part)) : null;
      const fi = fs.get(`${KIRBY}:${a.costume}`);
      if (!held || !prop || !on) continue;
      prop.poseUnder(0, on, held.sized && fi ? fi.modelScale : 1, false, 0);
      r.drawSkeleton(prop.skeleton, "opa");
      r.drawSkeleton(prop.skeleton, "xlu");
      r.endPass();
    }
    // the stars of the ones in Kirby's (kirbyStarOf)
    for (const a of actors) {
      const star = kirbyStarOf(a)?.star;
      if (!star) continue;
      r.drawSkeleton(star.skeleton, "opa");
      r.drawSkeleton(star.skeleton, "xlu");
      r.endPass();
    }
    // the chains' see-through parts: once, in the see-through pass, under the fighters' lights (drawChains)
    drawChains("xlu", true);
    let shines = 0;
    // (the game's effects are drawn without fog: HSD_FogSet(NULL))
    r.setFog(null);
    // (the shield's bubble and the reflector: from the track's pieces while it
    // holds and has them, else from the replay's states)
    const shapes = shapesAt(viewerTrack(), fno);
    for (const a of layersOff.effects ? [] : actors) {
      if (hidden(a.st)) continue;
      const key = actorKey(a.player, a.nana);
      const fa = frameActors.find((x) => x.key === key);
      drawShield(r, ek, a, data, fa, fno, shapes?.shieldAt(key, fno - 123) ?? undefined);
      const sh = shapes ? shapes.shineAt(key, fno - 123, heldOf(data, a.player, a.nana)) : shineAt(data, fno, a.player, a.nana);
      if (sh) { drawReflector(r, ek, a, sh); shines++; }
    }
    // the game's effects: stepped to this frame, then drawn
    prof.mark("articles");
    let models = 0, particles = 0;
    // (square to the camera: its right and up, in world directions)
    const axes = { right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], viewProj, view };
    // the stage's own particles, behind everything else's
    const stagePs = st && scene?.st === st && !layersOff.stage ? scene.particles.particles : [];
    if (stagePs.length) {
      const built = buildParticles(stagePs, axes);
      r.drawParticles(built.data, built.batches);
    }
    if (ek?.bank && fxw && !layersOff.effects) {
      models = drawFxModels(r, fxw, !mirrorDrawn);
      // (every list but the HUD's: that one is drawn in the HUD's pass, in its space)
      const mine = fxw.particlesOf(false);
      particles = mine.length;
      if (particles) {
        const built = buildParticles(mine, axes);
        r.drawParticles(built.data, built.batches);
      }
    }
    lastFx = { models, particles, generators: fxw?.ps.gens.length ?? 0, shines, projectiles, stageParticles: stagePs.length,
               platforms: actors.filter((a) => onAngelPlatform(a.st)).length,
               shyGuys: st?.shyGuy ? (frame.items ?? []).filter((it) => it.typeId === SHY_GUY).length : 0,
               art: { particles: !!ek?.bank, reflector: !!ek?.reflector, platform: !!ek?.platform, shyGuy: !!st?.shyGuy } };

    // simulated branches: the same fighters, see-through, in the ghost's color
    prof.mark("particles");
    let nGhost = 0;
    // the outline, 2 pixels wide in game units at this distance
    const px = (2 * cam.dist * Math.tan(FOVY / 2)) / Math.max(1, h);
    const tags: { n: number; x: number; y: number; color: string }[] = [];
    lastGhostPoses = [];
    ghosts.forEach((g, gi) => {
      const gd = g.replayData, gf = gd.frames[fno];
      // (a run cut to its moment has nothing before it: parser.ts's held)
      if (!gf || fno < (gd.held ?? 0)) return;
      const run = runNumber(g.label) ?? (ghosts.length > 1 ? gi + 1 : null);
      // (posed as the game's own fighters are, from the run's own frames: its state's animation, a wait's, a
      // fall's lean, a shield's tilt, and one held or thrown by its thrower's animation on its holder's joint -
      // framePoser. A run has no viewer track: a state with no animation keeps the move before's pose)
      const { held, poseOne, holdOf } = framePoser(gd, fs, fno, null, false);
      for (const h of held) {
        const s = h.a.st, fi = h.fi, p = gf.players[h.a.player];
        if (hidden(s) || !p) continue;
        // where the run is still the game itself (every run shares the game
        // up to the moment) the real fighter reads on top: no outline or tag
        const real = frame.players[h.a.player];
        const rs = real ? (h.a.nana ? real.nanaState : real.state) : undefined;
        const same = !!rs && rs.actionStateId === s.actionStateId && Math.abs(rs.xPosition - s.xPosition) < 0.01 &&
                     Math.abs(rs.yPosition - s.yPosition) < 0.01;
        nGhost++;
        // exactly where the real fighter is, the real one covers it: the
        // ghost would draw nothing, so it is not drawn at all
        if (same) continue;
        const by = holdOf(h);
        poseOne(h);
        lastGhostPoses.push({ run: gi, player: h.a.player, nana: h.a.nana, char: s.internalCharacterId, state: s.actionStateId,
                              t: s.actionStateFrameCounter, by: fi.posedBy, heldBy: by ? by.key : null, own: !!fi.animFor(s.actionStateId),
                              at: fi.skeleton.position(by ? by.joint : 0), sum: poseSum(fi.skeleton.rot) });
        const color = hex(g.color);
        r.drawGhost(fi.skeleton, { color, alpha: 0.9 }, 2 * px);
        ghostShield(r, s, h.a.nana ? p.nanaInputs ?? undefined : p.inputs, color);
        if (run !== null && !h.a.nana) {
          tags.push({ n: run, x: s.xPosition, y: s.yPosition + middle(s.internalCharacterId) * 2 + 5, color: g.color });
        }
      }
    });
    r.endPass();
    // (Stadium's screen showing the match: a copy of the picture just drawn,
    // before the HUD goes over it, for the next frame)
    if (st?.screen && scene?.screen) {
      const sc = scene.screen, img = st.screen.image;
      const rect = sc.captureRect((player) => {
        const p = frame.players[player]?.state;
        if (!p) return null;
        const X = p.xPosition, Y = p.yPosition + middle(p.internalCharacterId), m = viewProj;
        const cw = m[3] * X + m[7] * Y + m[15];
        return [((m[0] * X + m[4] * Y + m[12]) / cw + 1) / 2, (1 - (m[1] * X + m[5] * Y + m[13]) / cw) / 2];
      });
      // (as it is: the screen's material lays its green on it, setScreenConstant)
      if (rect) r.captureLive(img, sc.size[0], sc.size[1], rect, [255, 255, 255], fno);
    }
    prof.mark("ghosts");
    // the game's HUD over it all (hud.ts)
    let hudMs = 0;
    const hud = NO_HUD || layersOff.hud ? null : hudOf();
    if (hud) {
      const hudActors: HudActor[] = [];
      for (const a of actors) {
        if (a.nana) continue;
        const fi = fs.get(`${a.st.internalCharacterId}:${a.costume}`);
        if (!fi) continue;
        const drawn = posed.some((p) => p.a === a);
        // (the magnifier goes by ftLib_80086ED0, which leaves out fp->invisible but not x221E_b5 or x2226_b5:
        // a fighter those two hide still gets its bubble, its picture empty; it was posed all the same)
        const magnify = drawn || (trackHidden(a) && !(hideBits(a) & 1) && !hidden(a.st));
        // (the camera bone: its place in the fighter's bone list, ftLib_800866DC; the model's joint past its
        // part list's gaps, parts.ts)
        const joint = partToModelJoint(a.st.internalCharacterId, fi.cameraPart);
        let bone: [number, number, number] | null = null;
        if (magnify && joint >= 0 && joint < fi.skeleton.n) {
          const W = fi.skeleton.world, o = fi.cameraOffset, k = joint * 16;
          bone = [0, 1, 2].map((i) => W[k + i] * o[0] + W[k + 4 + i] * o[1] + W[k + 8 + i] * o[2] + W[k + 12 + i]) as [number, number, number];
        } else if (magnify) bone = [a.st.xPosition, a.st.yPosition + (fi.cameraBox?.lift ?? 8) * fi.modelScale, 0];
        hudActors.push({
          player: a.player, st: a.st, drawn, magnify, at: a.ko ? [a.ko.x, a.ko.y, a.ko.z] : undefined,
          // (the magnifier's size: the camera box's target_ext.v.z, ftData +0x3C's last float times fp->x34_scale.y
          // - the player's scale, not the model's (ftCamera_80076064, ftLib_80086B80) - over 8)
          nameTagHeight: fi.nameTagHeight, bone,
          zoom: ((fi.cameraBox?.v[2] ?? 8) * (playerScales(data.settings.playerSettings)[a.player] ?? 1)) / 8,
          // (ifMagnify_802FBBDC draws it through ftDrawCommon_80080C28, as the pond's mirror does: its
          // low-detail model, and nothing while any of the three hide bits is set)
          draw: () => {
            if (hideBits(a) & 7) return;
            if (skins.filter((s) => s === fi).length > 1) poseActor(fi, a);
            fi.faceTex?.apply(a.face?.tex ?? null);
            r.setLighting(lighting);
            r.setTint((lastTints.find((t) => t.key === actorKey(a.player, false))?.tint ?? null) as ColTint | null);
            const low = fi.mirrorPassHidden();
            if (low) { fi.skeleton.posePass(low); fi.skeleton.passHidden = low; }
            r.drawSkeleton(fi.skeleton, "opa");
            r.drawSkeleton(fi.skeleton, "xlu");
            fi.skeleton.passHidden = null;
            r.setTint(null);
          },
        });
      }
      const h0 = performance.now();
      // (with a track that has the HUD's own generators, the bursts are the effect world's)
      const bursts = fxw && fxw.trackHud && fno < fxw.trackUntil
        ? { particles: fxw.particlesOf(true), places: fxw.hudPlaces } : null;
      hud.draw(r, fno, viewProj, hudActors, ek?.bank ?? null, w / Math.max(1, h), bursts);
      hudMs = performance.now() - h0;
    }
    const had = runTags();
    if (tags.length !== had.length || tags.some((t, i) => t.n !== had[i].n || t.x !== had[i].x || t.y !== had[i].y || t.color !== had[i].color)) {
      setRunTags(tags);
    }

    // the line-art overlay (items) maps game units straight onto the canvas
    // (the camera turns a little, so this is the picture's own map of the
    // stage's plane, taken where the camera looks: close enough for items)
    const onScreen = (x: number, y: number) => {
      const m = viewProj, cw = m[3] * x + m[7] * y + m[15];
      return [((m[0] * x + m[4] * y + m[12]) / cw + 1) * w / 2, (1 - (m[1] * x + m[5] * y + m[13]) / cw) * h / 2];
    };
    const ax = cam.x, ay = cam.y;
    const o0 = onScreen(ax, ay), ox = onScreen(ax + 1, ay), oy = onScreen(ax, ay + 1);
    const a = ox[0] - o0[0], b = ox[1] - o0[1], c = oy[0] - o0[0], d = oy[1] - o0[1];
    // (only while it has something to place: setting it redraws the page's
    // overlay, every frame the camera moves)
    if (frame.items?.length || ghosts.length || tags.length) {
      setItemMatrix([a, b, c, d, o0[0] - a * ax - c * ay, o0[1] - b * ax - d * ay]);
    }

    r.finish();
    prof.mark("rest");
    const t1 = performance.now();
    mark("frameDrawn");
    frames++;
    lastDraws = r.draws;
    lastCulled = r.culled;
    lastFighters = posed.length + nGhost;
    lastPoses = poses;
    // (for the depth checks: the view, and the fighters as posed - read out only when asked)
    lastDepth = { view: view.slice(), actors: frameActors };
    drawnAt.push(t1);
    drawTimes.push(t1 - t0);
    // (every frame's start and length, for the checks' hitch counts: frameLog)
    if (frameLog.length < 12000) frameLog.push(t0, t1 - t0, fno);
    hudTimes.push(hudMs);
    mirrorTimes.push(mirrorMs);
    while (drawnAt.length && drawnAt[0] < t1 - 1000) { drawnAt.shift(); drawTimes.shift(); hudTimes.shift(); mirrorTimes.shift(); }
    lastGhosts = nGhost;
    if (SNAP && !snapped && st && posed.length >= actors.filter((a) => !hidden(a.st)).length) {
      snapped = true;
      try {
        // straight after drawing, while the picture is still in the buffer
        window.parent.postMessage({ type: "snap", url: canvas.toDataURL("image/jpeg", 0.72) }, "*");
      } catch { /* no picture: the card keeps its plain background */ }
    }
  };
  const actorKey = (player: number, nana: boolean) => `${player}:${nana ? 1 : 0}`;
  // the stage's own code for this replay (gr/index.ts): made again for another stage, replay or track
  let scene: StageScene | null = null;
  /** the scene for this stage, track and replay, made if it is another's: the drawing asks, and so does the
   *  harness (which steps the stage itself and may run before anything was drawn with a new track: without
   *  this it posed the stage by whatever scene the last drawn frame left, or none) */
  const sceneFor = (st: Stage, tr: ViewerTrack | null, data: ReplayData) => {
    if (scene && scene.st === st && scene.track === tr && scene.data === data) return scene;
    scene = new StageScene(st, tr, data);
    // (the copies of parts its code makes)
    if (renderer) for (const sk of st.allSkeletons) renderer.warm(sk);
    return scene;
  };
  /** how long the stage's particles took on the last frame drawn (a jump runs them again from further back) */
  let stageMs = 0;
  // the charges each fighter keeps stored (fx/charges.ts): the track's when it
  // has them, else counted from the replay's states
  const chargesOf = (data: ReplayData, fs: Map<string, Fighter>, tr: ViewerTrack | null) => {
    const attrs = (c: number): ChargeAttrs | null => {
      const fi = [...fs.values()].find((x) => x.internalId === c);
      return fi ? { int: (o) => fi.specialInt(o), float: (o) => fi.specialAttr(o) } : null;
    };
    const said = tr ? storedFromTrack(data, tr, attrs) : null;
    // (Kirby's copy on each frame, from the same history as his hat's: his copies' charges)
    const copyAt = (port: number, frame: number) => copiesOf(data, port)[frame];
    if (!said) return storedCharges(data, attrs, copyAt);
    if (!tr!.diverges) return said;
    // (a track that parts from the replay: its charges up to there, the replay's after)
    const own = storedCharges(data, attrs, copyAt), n = data.frames.length, cut = Math.min(n, Math.max(0, tr!.until + 123));
    for (const key of new Set([...own.keys(), ...said.keys()])) {
      const arr = own.get(key) ?? new Uint8Array(n);
      arr.fill(0, 0, cut);
      const t = said.get(key);
      if (t) arr.set(t.subarray(0, cut));
      own.set(key, arr);
    }
    return own;
  };

  // the effects learned from public replays' tracks (effect-table.json, optional),
  // once a page; the effects run again with it as it comes in
  const [learnedTable, setLearnedTable] = createSignal<Learned | null>(null);
  let useLearned = true;
  createEffect(() => {
    if (!mayLoad()) return;
    loadLearned().then((t) => { if (t) { setLearnedTable(t); fxw = null; schedule(); } });
  });

  // the parity harness's own effect world, and where its last ask ended
  let harnessRun: { w: FxWorld; data: ReplayData; track: ViewerTrack | null; next: number } | null = null;

  // the effect world for this replay: how it finds where a move started, and
  // where hits landed
  const makeWorld = (ek: EffectKit, data: ReplayData, fs: Map<string, Fighter>, tr: ViewerTrack | null): FxWorld => {
    const w = new FxWorld(ek.bank!, (c, part) => ek.partToJoint(c, part), ek.banks);
    fxPercent.clear();
    // (where no track holds: the effects learned from public replays' tracks)
    const table = learnedTable();
    if (table && useLearned) w.learned = (key) => table.at.get(key);
    // (a move script's own effect of a fighter's file: its pieces as the game makes them most often)
    if (table) w.learnedGfx = (gfx) => table.byGfx.get(gfx);
    // the effects the game made, from the track's pieces (game frames: the
    // index less 123), up to where it parts from the replay; a track from
    // before the simulator wrote pieces is not used for them
    if (tr?.has("fxp")) {
      w.trackFx = (f) => tr.betweenOf(["fx", "fxend"], f - 124, f - 123);
      w.trackPieces = (f) => tr.between("fxp", f - 124, f - 123);
      // (the stage's own generators too, when the track names their joints: they are in the one list)
      const kinds = stageInWorld(tr) ? ["fxp", "fxend", "gen", "sgen", "send"] : ["fxp", "fxend"];
      w.trackOrdered = (f) => tr.betweenOf(kinds, f - 124, f - 123);
      // (the track counts a stage object's joints from the joint the game puts above the file's root: the
      // file's root, the part's joint 0 here, is its 1. Seen on every stage by the place check,
      // particle checks)
      w.stageJoint = (map, joint) => {
        // (a copy the stage's code makes, when the number stands for one: Fountain's columns)
        const part = stage()?.named.get(map) ?? stage()?.partOf(map);
        const W = part?.skeleton.world, j = joint - 1;
        return W && j >= 0 && (j + 1) * 16 <= W.length ? W.subarray(j * 16, j * 16 + 16) : null;
      };
      w.stageScale = stage()?.scale ?? 1;
      w.trackStageBefore = (f) => tr.betweenOf(["gen", "sgen", "send"], -1e9, f - 124);
      if (tr.has("rng")) w.trackRng = (f) => tr.rngAt(f - 123);
      // (an item's joint a generator is on: its turn and place frame by frame)
      if (tr.has("ij")) w.trackItemJoint = (item, joint, f) => tr.at("ij", `${item}:${joint}`, f - 123);
      // (the HUD's own generators, made after a frame's particles have run)
      if (tr.has("hgen")) w.trackHud = (f) => tr.between("hgen", f - 124, f - 123);
      w.trackUntil = tr.until + 123;
    }
    const stOf = (key: string, f: number) => {
      const [pl, nn] = key.split(":").map(Number);
      const p = data.frames[f]?.players[pl];
      return p ? (nn ? p.nanaState : p.state) : undefined;
    };
    // (each fighter's state on any frame: Final Cutter's effects worked out from where its move began)
    w.stateAt = stOf;
    w.entryCounterOf = (key, f) => {
      const s = stOf(key, f);
      if (!s) return undefined;
      let e = f;
      while (e > 0 && f - e < 900) {
        const q = stOf(key, e - 1);
        if (!q || q.actionStateId !== s.actionStateId) break;
        e--;
      }
      return { entry: e, counter: stOf(key, e)?.actionStateFrameCounter ?? 0 };
    };
    // color animations: the scripts, when a fighter's timed invincibility
    // runs (fx/invincible.ts: after the platform, the ledge, a throw, a wall
    // tech or jump, a bounce), and the charges it keeps stored (fx/charges.ts)
    w.colTables = ek.colAnims;
    // (a floor's material's effects: on Fountain of Dreams' and Pokemon
    // Stadium's material 10 the stage's own - mpLib_803BD7A0, 803BD850 - and
    // the moves' own everywhere else a ranked stage has)
    w.floorFx = (a, which) => {
      if (a.st.isGrounded === true) return null;
      const mat = stage()?.floors?.material(a.st.lastGroundId) ?? -1;
      const table = FLOOR_FX[data.settings.stageId]?.[mat];
      const id = table ? table[which] : -1;
      return id >= 0 ? id : null;
    };
    // (the stage's own file's bank: the drawn scene's when there is one, else read from the stage)
    w.stageBank = () => scene?.particles.bank ?? stageBankOf(stage());
    w.invincible = (key, f) => timedInvincible((g) => stOf(key, g), f, ek.invTimes);
    // a launched fighter's trail of smoke, worked out once a fighter from its history
    const smokes = new Map<string, Float32Array>();
    w.launchSmoke = (key, f) => {
      let s = smokes.get(key);
      if (!s) smokes.set(key, s = launchSmokes((g) => stOf(key, g), data.frames.length, ek.smokeTimes));
      return s[f] ?? NaN;
    };
    w.invincibleAsked = (key, f) => invincibilityAsked(stOf(key, f - 1), stOf(key, f), ek.invTimes) > 0;
    let charges: Map<string, Uint8Array> | null = null, chargesFor = -1, chargesTrack: ViewerTrack | null = null;
    w.stored = (key, f) => {
      // (the fighters loaded so far: counted again as more come, or when the track does)
      const now = ready(), tr = viewerTrack();
      if (!charges || chargesFor !== now.size || chargesTrack !== tr) {
        chargesFor = now.size;
        chargesTrack = tr;
        charges = chargesOf(data, now, tr);
      }
      return charges.get(key)?.[f] ?? 0;
    };
    w.items = (f) => (data.frames[f]?.items ?? []).map((it) => ({
      spawnId: it.spawnId, typeId: it.typeId, owner: it.owner, x: it.xPosition, y: it.yPosition, missile: it.samusMissileType,
      launched: it.isChargeShotLaunched, facing: it.facingDirection < 0 ? -1 : 1, vx: it.xVelocity, vy: it.yVelocity, state: it.state,
    }));
    // (an item's model's particles: its article's animation's keys, by how far into it the item is)
    w.itemPtcl = (it, f) => {
      const q = data.frames[f]?.items?.find((x) => x.spawnId === it.spawnId);
      // (none from one not drawn in this state, from one held in a pose (its state has no animation), or on a
      // frame its animation stood still: its keys would be made again)
      if (q && articleEntry(q.typeId)?.gone?.includes(q.state)) return null;
      if (q && itemAnimation(data, f, q).frozen) return null;
      const before = q ? data.frames[f - 1]?.items?.find((x) => x.spawnId === q.spawnId) : undefined;
      if (q && before && before.state === q.state && itemAnimAge(data, f - 1, before) === itemAnimAge(data, f, q)) return null;
      const art = q ? articleOf(data, fs, q, f) : null;
      return q && art?.ptcl?.length ? { keys: art.ptcl, age: itemAnimAge(data, f, q) } : null;
    };
    w.extra = (f, actors, world) => {
      hitSparks(f, actors.filter((x) => x.world.length > 0), world, fxPercent, {
        prevWorld: (k) => world.prevWorld(k),
        scriptTime: (k) => world.scriptTime(k),
        // (the frame before's as well: a projectile that hits is often gone on the hit's frame)
        items: (port) => {
          const now = (data.frames[f]?.items ?? []).filter((it) => it.owner === port);
          const was = (data.frames[f - 1]?.items ?? []).filter((it) => it.owner === port && !now.some((n) => n.spawnId === it.spawnId));
          return [...now, ...was].map((it) => ({ pos: [it.xPosition, it.yPosition, 0] as [number, number, number],
                                                 element: itemElement(data, fs, it, f) }));
        },
        middle,
        partToJoint: (c, part) => ek.partToJoint(c, part),
        // (L or R's button newly pressed: the replay's inputs)
        powershield: (key) => powershielded((g) => stOf(key, g), (g) => lrPressed(key, g) && !lrPressed(key, g - 1), f,
                                            ek.powershieldWindow),
      });
      for (const a of actors) fxPercent.set(a.key, { percent: a.st.percent, state: a.st.actionStateId, hitlag: a.st.hitlagRemaining ?? 0 });
      // the reflector's start and reflect: the sparkles their models' own
      // animations start at the hip (a viewer track has the models, not these)
      const shapes = shapesAt(viewerTrack(), f);
      for (const a of actors) {
        const [pl, nn] = a.key.split(":").map(Number);
        const sh = shapes ? shapes.shineAt(a.key, f - 123, heldOf(data, pl, nn === 1)) : shineAt(data, f, pl, nn === 1);
        if (!sh || (sh.start < 0 && sh.hit < 0)) continue;
        const hip = ek.hipOf(a.st.internalCharacterId), W = a.world;
        if (hip < 0 || (hip + 1) * 16 > W.length) continue;
        const at: [number, number, number] = [W[hip * 16 + 12], W[hip * 16 + 13], W[hip * 16 + 14]];
        const file = REFLECTOR_FILE[a.st.internalCharacterId];
        if (file === undefined) continue;
        if (sh.start >= 0) world.rootParticles(file, 1, sh.start, at, a.fighter.modelScale, a.key);
        if (sh.hit >= 0) world.rootParticles(file, 2, sh.hit, at, a.fighter.modelScale, a.key);
      }
    };
    const lrPressed = (key: string, g: number) => {
      const [pl, nn] = key.split(":").map(Number);
      const p = data.frames[g]?.players[pl];
      const i = (nn ? p?.nanaInputs : p?.inputs)?.processed;
      return !!i && (i.lTriggerDigital || i.rTriggerDigital);
    };
    return w;
  };

  // the KO's column of light (the game passes table 18's color, then 19's,
  // but its compiler reads the two arguments last first: 19's is the konst
  // color, the pale middle of the column, and 18's the tev0, its edges - as
  // the playback Dolphin's frames show)
  const koLook = (ek: EffectKit, st: Stage) =>
    ({ blast: st.camera!.blast, scale: ek.koScale, konst: ek.koColors, tev0: ek.shieldColors });

  // the fighters of an earlier frame, posed only for their joints
  /** a fighter of a frame, and when it is held or thrown: who holds it (its key), the holder's model joint it
   *  is held on and its own joint that is held there (the pose check lays the same hold on the game's joints) */
  type HeldFrame = ActorFrame & { heldBy?: { key: string; on: number; joint: number } };
  type PosedActor = { a: Actor; fi: Fighter };
  /** The fighters of one frame of a replay - the game's, or a simulated run's (a run is a replay of its own with no
   *  viewer track: `tr` null) - to be posed as draw() poses the game's: `held` the ones to pose, `out` the ones not
   *  drawn (KO'd), `poseOne` poses one on its fighter's skeleton (the last word: a fighter shared by two actors is
   *  posed for each in turn), `holdOf` works out where one held or thrown is held - its holder's joint, from the
   *  holder posed for the same frame - and keeps it for poseOne */
  /** Yoshi's roll's spin about his part 3, for the pose's lean (yoshiroll.ts) */
  const rollSpin = (a: Actor) => {
    const ek = kit();
    return a.roll?.spin !== undefined && ek ? { joint: partToModelJoint(YOSHI, ek.partToJoint(YOSHI, 3)), angle: a.roll.spin } : undefined;
  };
  /** what a fighter's own code turns after its animation's pose, on every path that poses one (drawn, a run's,
   *  the checks'): Yoshi's roll - part 2 leaned about z, the root turned about y, squashed as it lands
   *  (yoshiroll.ts) - and Rollout's spin - TopN to face right, YRotN about x (rollout.ts) */
  const afterPose = (fi: Fighter, a: Actor) => {
    const ek = kit(), r = a.roll;
    if (r && ek && (r.lean !== undefined || r.turn !== undefined || r.squash)) {
      const sk = fi.skeleton;
      if (r.lean !== undefined) sk.rot[partToModelJoint(YOSHI, ek.partToJoint(YOSHI, 2)) * 3 + 2] = r.lean;
      if (r.turn !== undefined) sk.rot[1] = r.turn;
      if (r.squash) { sk.scale[1] *= r.squash[0]; sk.scale[2] *= r.squash[1]; }
      sk.update();
    }
    if (a.rollout != null && ek) {
      const sk = fi.skeleton, y = partToModelJoint(a.st.internalCharacterId, ek.partToJoint(a.st.internalCharacterId, 3));
      sk.rot[1] = Math.PI / 2;
      if (y > 0 && y < sk.n) sk.rot[y * 3] = a.rollout;
      sk.update();
    }
    // (in Kirby's inhale: drawn in, shrinking; his star, turned as it began)
    const kh = a.kirbyHeld;
    if (kh && (kh.shrink !== undefined || kh.turn !== undefined)) {
      const sk = fi.skeleton;
      if (kh.shrink !== undefined) sk.scale[0] = sk.scale[1] = sk.scale[2] = Math.fround(fi.modelScale * kh.shrink);
      if (kh.turn !== undefined) sk.rot[1] = kh.turn;
      sk.update();
    }
  };

  const framePoser = (data: ReplayData, fs: Map<string, Fighter>, f: number, tr: ViewerTrack | null, faces: boolean) => {
    const out: HeldFrame[] = [];
    const fr = data.frames[f];
    const held: PosedActor[] = [];
    for (const p of fr ? fr.players : []) {
      if (!p) continue;
      const costume = data.settings.playerSettings[p.playerIndex]?.costumeIndex ?? 0;
      for (const [s, nana] of [[p.state, false], [p.nanaState, true]] as const) {
        if (!s) continue;
        const fi = fs.get(`${s.internalCharacterId}:${costume}`);
        if (!fi) continue;
        const ko = gone(s) ? koAt(data, f, p.playerIndex, nana, s, camInvAt(f)) : null;
        if (gone(s) && !ko) { out.push({ key: actorKey(p.playerIndex, nana), st: s, fighter: fi, world: NO_WORLD }); continue; }
        held.push({ a: { st: s, costume, player: p.playerIndex, nana, ko, roll: rollOf(data, fi, p.playerIndex, nana, f),
                         rollout: rolloutOf(data, fi, p.playerIndex, nana, f) }, fi });
      }
    }
    // (posed as draw() poses them: one held or thrown on its holder's joint)
    const ek = kit();
    const actorsNow = held.map((h) => h.a);
    for (const h of held) h.a.captor = captorOf(h.a, actorsNow);
    for (const h of held) h.a.kirbyHeld = kirbyHeld(data, f, h.a, actorsNow, fs);
    const poseOne = (h: PosedActor) => {
      const c = h.a.captor, s = h.a.st;
      const cf = c ? fs.get(`${c.st.internalCharacterId}:${c.costume}`) : undefined;
      const anim = c && ek && THROWN.has(s.actionStateId) ? cf?.thrownAnim(s.actionStateId) : null;
      const borrow = anim && c && ek ? { anim, nodeJoint: nodeJointsOf(ek, s.internalCharacterId), facing: s.facingDirection } : null;
      // (entering: growing up, as the drawn pose has it - without it every joint was under a TopN at its full size)
      const en = ek ? entryPose(s.actionStateId, stateAge(data, f, h.a.player, h.a.nana), ek.entry, h.fi.modelScale) : null;
      h.fi.pose({ ...posing(data, f, s, h.a.player, h.a.nana, ek, borrow), subaction: waitSubOf(data, h.fi, h.a.player, h.a.nana, f),
                  ...(en ? { yScale: en.yScale, holdAnimOf: en.holdAnimOf } : {}),
                  game: gameAnimOf(tr, h.a.player, h.a.nana, f, { data, ek, fi: h.fi }),
                  root2: root2Of(ek, s.internalCharacterId), transN: transNOf(ek, s.internalCharacterId),
                  ...(borrow ? {} : { ...modelTurn(data, f, s, h.a.player, h.a.nana, h.fi) }),
                  fallLean: fallLeanOf(data, f, s, h.a.player, h.a.nana, ek, h.fi),
                  kept: keptOf(data, f, s, h.a.player, h.a.nana, ek, h.fi), clock: f, airborne: s.isGrounded === true,
                  depth: fighterDepth(tr, h.a.player, h.a.nana, f, h.a.st) },
                // (its part poses too - a hand's around an item it holds turns the joint the item hangs on)
                rollSpin(h.a) ?? lean(ek, s), h.a.ko, faces ? h.a.face ??= faceOf(data, h.fi, h.a.player, h.a.nana, f, null) : undefined);
      afterPose(h.fi, h.a);
      if (h.a.hold) { h.fi.skeleton.shift = h.a.hold; h.fi.skeleton.update(); }
    };
    const holdOf = (h: PosedActor): { key: string; on: number; joint: number } | undefined => {
      const c = h.a.captor ? held.find((q) => q.a === h.a.captor) : undefined;
      if (!c || !ek) return undefined;
      const cc = c.a.st.internalCharacterId, vc = h.a.st.internalCharacterId;
      const tj = partToModelJoint(cc, ek.partToJoint(cc, TRANSN2)), vj = partToModelJoint(vc, ek.partToJoint(vc, XROTN));
      if (tj < 0 || vj < 0) return undefined;
      poseOne(c);
      const at = c.fi.skeleton.position(tj);
      h.a.hold = null;
      poseOne(h);
      const from = h.fi.skeleton.position(vj);
      h.a.hold = { joint: vj, d: [at[0] - from[0], at[1] - from[1], at[2] - from[2]] };
      return { key: actorKey(c.a.player, c.a.nana), on: tj, joint: vj };
    };
    return { out, held, poseOne, holdOf };
  };
  const actorsAt = (data: ReplayData, fs: Map<string, Fighter>, f: number): HeldFrame[] => {
    const { out, held, poseOne, holdOf } = framePoser(data, fs, f, viewerTrack(), true);
    const heldBy = new Map<Actor, { key: string; on: number; joint: number }>();
    const worlds = new Map<Actor, Float32Array>();
    for (const h of held) { poseOne(h); worlds.set(h.a, worldByPart(h.a.st.internalCharacterId, h.fi.skeleton.world)); }
    for (const h of held) {
      const by = holdOf(h);
      if (!by) continue;
      heldBy.set(h.a, by);
      poseOne(h);
      worlds.set(h.a, worldByPart(h.a.st.internalCharacterId, h.fi.skeleton.world));
    }
    for (const h of held) out.push({ key: actorKey(h.a.player, h.a.nana), st: h.a.st, fighter: h.fi, world: worlds.get(h.a)!, heldBy: heldBy.get(h.a) });
    return out;
  };

  // Step the effect world to this frame: one step while playing, a few after a small skip; after a jump it is
  // made exactly as playing to the frame makes it, from the nearest checkpoint (fx/checkpoints.ts) at or before
  // the frame, stepped on. Checkpoints are kept as playing passes them and, in the time a frame leaves, ahead to
  // the replay's end. Only while none is within CATCH_UP frames (a far jump soon after opening) is it warmed up
  // from a little before as before, and made exact on the first frame drawn after one is. True when it posed the
  // fighters for frames before this one (they share their models with this frame's: posed again before they are
  // drawn)
  const CATCH_UP = 1200, FILL_MS = 2, IDLE_FILL_MS = 12;
  // (with each the hit sparks' record of the fighters' percents, which the world's steps read and keep: fxPercent)
  type Snap = { snap: FxSnapshot; percent: [string, Before][] };
  type Checks = { store: Checkpoints<Snap>; key: unknown[]; exact: boolean; ahead?: Kept<Snap> };
  const saveCheck = (w: FxWorld): Kept<Snap> => {
    const snap = w.save();
    return { frame: snap.frame, snap: { snap, percent: [...fxPercent].map(([k, v]) => [k, { ...v }]) }, bytes: snap.bytes };
  };
  const loadCheck = (w: FxWorld, c: Snap) => {
    w.load(c.snap);
    fxPercent.clear();
    for (const [k, v] of c.percent) fxPercent.set(k, { ...v });
  };
  const checksOf = new WeakMap<FxWorld, Checks>();
  /** the world's checkpoints, made again when what its steps read changes (files and tables that came late) */
  const checks = (w: FxWorld): Checks => {
    const key = [w.colTables, w.ko, w.banks.size];
    let c = checksOf.get(w);
    if (!c || c.key.some((k, i) => k !== key[i])) {
      // (the first: the world as made, before any frame)
      const now = saveCheck(w);
      w.reset(0);
      fxPercent.clear();
      const first = saveCheck(w);
      loadCheck(w, now.snap);
      checksOf.set(w, (c = { store: new Checkpoints(first), key, exact: false }));
    }
    return c;
  };
  /** one frame of the world, the stage and the fighters as they were on it (the dynamics too, unless ahead) */
  const fxStepper = (w: FxWorld, data: ReplayData, fs: Map<string, Fighter>, f: number, now: ActorFrame[] | null, dyn: boolean) => {
    // (the stage as it was on each frame stepped, when its generators are the effect world's: they go
    // along its joints. The frame drawn is posed last, as the draw left it)
    const st = stageInWorld(viewerTrack()) ? stage() : null;
    let posedOther = false;
    const pose = (g: number) => {
      if (!st || (g === f && now && !posedOther)) return;
      st.update(g, stageFrame(data, g));
      posedOther = g !== f || !now;
    };
    const one = (g: number) => {
      const actors = g === f && now ? now : actorsAt(data, fs, g);
      w.step(g, actors);
      if (dyn) dynStep(g, actors, data);
    };
    return { st, pose, one };
  };
  const advance = (w: FxWorld, data: ReplayData, fs: Map<string, Fighter>, f: number, now: ActorFrame[]): boolean => {
    const c = checks(w);
    const small = f - w.frame > 0 && f - w.frame <= 8;
    const near = c.store.nearest(f);
    const reach = f - Math.max(near.frame, 0) <= CATCH_UP;
    if (f === w.frame && (c.exact || !reach)) return false;
    if (!small || f === w.frame) fxPercent.clear();
    const { st, pose, one } = fxStepper(w, data, fs, f, now, true);
    if ((!small || !c.exact) && reach) {
      // (exactly: from the nearest checkpoint, stepped on)
      const from = jumpTo(c.store, f, (s) => loadCheck(w, s), (g) => { pose(g); one(g); }, () => saveCheck(w));
      c.exact = true;
      return from + 1 < f;
    }
    if (!small) {
      c.exact = false;
      return stepThrough(w, f, one, pose, st ? { frames: (g) => w.stageFrames(g), start: (g) => w.stageStart(g), step: (g) => w.stepStage(g) } : undefined);
    }
    const stepped = stepThrough(w, f, one, pose);
    if (c.exact) c.store.keep(w.frame, () => saveCheck(w));
    return stepped;
  };
  // (while nothing is drawn - paused, or between seeks - checkpoints are made ahead in longer turns)
  const idleFill = setInterval(() => {
    const data = replayStore.replayData;
    if (!fxw || !data || benchFrame !== null || performance.now() - lastDrawAt < 50) return;
    fillChecks(fxw, data, ready(), IDLE_FILL_MS);
  }, 60);
  onCleanup(() => clearInterval(idleFill));
  /** checkpoints ahead of the ones playing has made, in `ms` of a frame's spare time: the world as it stands is
   *  kept, the furthest checkpoint loaded and stepped on (the dynamics left alone), and the world put back */
  const fillChecks = (w: FxWorld, data: ReplayData, fs: Map<string, Fighter>, ms: number): boolean => {
    const c = checks(w);
    const end = data.frames.length - 1;
    // (where the stepping ahead stopped last time: carried on from, until it reaches the end)
    const last = c.store.last;
    const from = c.ahead && c.ahead.frame >= last.frame ? c.ahead : last;
    if (Math.max(from.frame, 0) >= end) return false;
    const keep = saveCheck(w);
    loadCheck(w, from.snap);
    const { pose, one } = fxStepper(w, data, fs, Number.NaN, null, false);
    const t0 = performance.now();
    for (let g = Math.max(from.frame + 1, 0); g <= end && performance.now() - t0 < ms; g++) {
      pose(g); one(g); c.store.keep(g, () => saveCheck(w));
    }
    c.ahead = saveCheck(w);
    loadCheck(w, keep.snap);
    return true;
  };

  // the fighters' swinging chains (dynamics.ts): stepped with the effects, a
  // frame at a time from the animation's pose, laid on the model after it
  type DynHeld = { d: Dynamics; fi: Fighter; sub: number | null; was: { frame: number; turns: Float32Array }[] };
  const dyns = new Map<string, DynHeld>();
  /** the chains a pose looks its swinging joints' earlier turns up in: the drawn ones, or the pose check's own */
  let dynLook: Map<string, DynHeld> = dyns;
  /** how many frames back a swinging joint's turns are kept (a blend's start is looked up through its length) */
  const DYN_KEPT = 64;
  swungAt = (player, nana, frame, rot) => {
    const e = dynLook.get(actorKey(player, nana));
    const h = e?.was.find((x) => x.frame === frame);
    if (h) {
      for (let i = 0; i + 3 < h.turns.length; i += 4) {
        const j = h.turns[i] * 3;
        if (j + 2 < rot.length) { rot[j] = h.turns[i + 1]; rot[j + 1] = h.turns[i + 2]; rot[j + 2] = h.turns[i + 3]; }
      }
    }
    // (the swinging joints the simulator runs, as the game left them on that frame: "fp")
    const fi = e?.fi;
    const by = fi && gameAnims ? viewerTrack()?.pose("fp", `${player}:${nana ? 1 : 0}:${fi.internalId}`, frame - 123) : null;
    if (fi && by) {
      for (const [part, v] of by.joints) {
        const j = partToModelJoint(fi.internalId, part);
        if (j < 0 || j * 3 + 2 >= rot.length) continue;
        for (let k = 0; k < 3; k++) if (!Number.isNaN(v[k])) rot[j * 3 + k] = v[k];
      }
    }
  };
  onCleanup(() => { swungAt = null; });
  const dynKeep = (e: DynHeld, g: number) => {
    e.was.push({ frame: g, turns: e.d.swung() });
    if (e.was.length > DYN_KEPT) e.was.shift();
  };
  /** the pose check's own swinging chains (poseCompare), for one replay and one way of posing */
  let cmpDyns: { game: boolean; data: ReplayData | null; held: Map<string, DynHeld> } = { game: true, data: null, held: new Map() };
  const dynPoseOf = (fa: ActorFrame): DynPose => {
    const fi = fa.fighter, sk = fi.skeleton, c = fa.st.internalCharacterId, n = sk.n;
    const skips = partSkips(c);
    const partOf = (j: number) => {
      if (!skips.length) return j;
      let p = j;
      for (const k of skips) if (k <= p) p++;
      return p;
    };
    const world = (j: number) => fa.world.subarray(partOf(j) * 16, partOf(j) * 16 + 16);
    return {
      world,
      rot: (j) => {
        const w = world(j), pj = sk.parent[j];
        if (pj < 0) return [0, 0, 0];
        const inv = invert(new Float32Array(16), world(pj) as Float32Array);
        const l = mul(new Float32Array(16), inv, w as Float32Array);
        const m = from44(l);
        for (let col = 0; col < 3; col++) {
          const k = Math.hypot(m[col], m[4 + col], m[8 + col]) || 1;
          m[col] /= k; m[4 + col] /= k; m[8 + col] /= k;
        }
        const len2 = Math.sqrt(m[0] * m[0] + m[4] * m[4]);
        return len2 > 1e-5 ? [Math.atan2(m[9], m[10]), Math.atan2(-m[8], len2), Math.atan2(m[4], m[0])]
          : [Math.atan2(-m[6], m[5]), Math.atan2(-m[8], len2), 0];
      },
      jointOf: (part) => partToModelJoint(c, part),
      parent: (j) => sk.parent[j],
      restT: (j) => sk.restOf(j, "trans"),
      restS: (j) => sk.restOf(j, "scale"),
      child: (j) => { for (let k = j + 1; k < n; k++) if (sk.parent[k] === j) return k; return -1; },
      ts: (j) => {
        const w = world(j), pj = sk.parent[j];
        const l = pj < 0 ? (w as Float32Array) : mul(new Float32Array(16), invert(new Float32Array(16), world(pj) as Float32Array), w as Float32Array);
        return { t: [l[12], l[13], l[14]], s: [Math.hypot(l[0], l[1], l[2]), Math.hypot(l[4], l[5], l[6]), Math.hypot(l[8], l[9], l[10])] };
      },
    };
  };
  const dynStep = (g: number, actors: ActorFrame[], rd: ReplayData) => {
    for (const fa of actors) {
      try { dynOne(g, fa, rd); } catch (e) {
        // (a fighter whose chains fail is drawn as its animation has it)
        dyns.delete(fa.key);
        dynBroken.add(fa.fighter);
        try { reportError(e); } catch { /* */ }
      }
    }
  };
  const dynBroken = new WeakSet<Fighter>();
  const dynOne = (g: number, fa: ActorFrame, rd: ReplayData, held = dyns) => {
    {
      if (dynBroken.has(fa.fighter)) return;
      const data = fa.fighter.dynamics();
      if (!data || fa.world.length < 16) return;
      let e = held.get(fa.key);
      const pose = dynPoseOf(fa);
      if (!e || e.fi !== fa.fighter || e.d.frame !== g - 1) {
        e = { d: new Dynamics(data), fi: fa.fighter, sub: null, was: [] };
        e.d.init(pose, fa.fighter.modelScale);
        held.set(fa.key, e);
      }
      // (an animation's say over the chains, as it starts: ftCo_8009E7B4, with the flags of the animation the
      // game set - Fighter_ChangeMotionState's for the state, ftwaitanim.c's for the wait it picked. The track
      // names it (a wait with an item in hand is another animation with other flags: Fox's swings his tail
      // where his plain wait drives it); without the track the state's own, and for a wait the one picked here)
      let sub = fa.fighter.subactionFor(fa.st.actionStateId);
      const [dpl, dnn] = fa.key.split(":").map(Number);
      const said = gameAnims && viewerTrack()?.has("anim") ? viewerTrack()!.animAt(dpl, dnn, g - 123) : null;
      if (said && said.anim >= 0 && (said.kind === fa.fighter.internalId || (fa.fighter.internalId === 11 && said.kind === 10))) sub = said.anim;   // (Nana plays Popo's)
      else if (!said && fa.st.actionStateId === WAIT) sub = waitSubOf(rd, fa.fighter, dpl, dnn === 1, g) ?? sub;
      if (sub !== null && sub !== e.sub) {
        const af = fa.fighter.animFlags(sub);
        e.d.setDriven(animDriven(data, af.flags, af.slot));
        e.sub = sub;
      }
      e.d.follow(pose);
      // (an animation the game set on this frame with no blend: the model's own tree is laid on the joints
      // first, so a swinging joint the guard pose had moved is back at its own place - without it a
      // Jigglypuff grabbed out of her shield kept the guard pose's place on her body's joint, 1.4 units off
      // for the rest of the game. The track says when)
      const trk = gameAnims ? viewerTrack() : null;
      if (trk?.has("anim")) {
        const [pl, nn] = fa.key.split(":").map(Number);
        const now = trk.animAt(pl, nn, g - 123), was = trk.animAt(pl, nn, g - 124);
        if (now && now.anim >= 0 && now.blendFrames === 0 &&
            (!was || was.anim !== now.anim || was.kind !== now.kind || now.frame < was.frame)) e.d.restPlaces();
      }
      // (held in the guard pose with the stick at rest, the pose's tree
      // reaches the swinging joints' places and sizes: ftCo_80091E78)
      if (fa.st.actionStateId === 179 && fa.fighter.internalId !== YOSHI_ID) {
        const [pl, nn] = fa.key.split(":").map(Number);
        if (!tiltOf(rd, g, pl, nn === 1, kit())?.amount) e.d.holdPlaces(pose);
      }
      e.d.frame = g;
      // (not in hitlag: Fighter_procDynamics)
      if ((fa.st.hitlagRemaining ?? 0) > 0) { dynKeep(e, g); return; }
      const fi = fa.fighter, c = fa.st.internalCharacterId;
      // (the floor only on the ground, and not for Bowser: ftCo_8009DD94 - at
      // the player's size 1, which a replay's fighters keep; not the model's)
      // (and for Mewtwo held by a grab - the capture states, 223 to 232 - whether on the ground or not)
      const s0 = fa.st.actionStateId;
      const ground = (c === 16 && s0 >= 223 && s0 <= 232) || (fa.st.isGrounded !== true && c !== KOOPA && c !== GIGA_KOOPA)
        ? stage()?.floorTestAt(g) ?? null : null;
      const colliders = data.colliders.map((col) => {
        const j = partToModelJoint(c, col.part);
        const w = j >= 0 ? pose.world(j) : null;
        const pos: [number, number, number] = w
          ? [w[0] * col.off[0] + w[4] * col.off[1] + w[8] * col.off[2] + w[12], w[1] * col.off[0] + w[5] * col.off[1] + w[9] * col.off[2] + w[13],
             w[2] * col.off[0] + w[6] * col.off[1] + w[10] * col.off[2] + w[14]] : [0, 0, 0];
        return { pos, radius: col.radius };
      });
      // (the checks' --peek: the floor tests of the character peeked at)
      const dp = (globalThis as { __dynPeek?: { char: number; rows: number[][] } }).__dynPeek;
      e.d.debug = dp && dp.char === c && dp.rows.length < 20000 ? (r) => dp.rows.push([g - 123, fa.st.actionStateId, ...r.map((x) => +x.toFixed(3))]) : null;
      e.d.step(pose, ground, colliders);
      dynKeep(e, g);
    }
  };

  let snapped = false;
  /** the frame the timing check draws, when it is drawing (bench) */
  let benchFrame: number | null = null;
  let lastGhosts = 0;
  /** each run's fighter drawn on the last frame: how it was posed (Fighter.posedBy), who holds it, where it (or
   *  its held joint) is, whether its state has an animation in its own file, and a sum of its joints' turns (a pose that stands still has the same sum) */
  let lastGhostPoses: { run: number; player: number; nana: boolean; char: number; state: number; t: number; by: string;
                        heldBy: string | null; own: boolean; at: [number, number, number]; sum: number }[] = [];
  let lastFx: Record<string, unknown> = {};
  let lastTints: { key: string; tint: unknown; anims: unknown }[] = [];
  let lastShakes = new Map<string, [number, number]>();

  const stats = (): Stats => ({
    fps: drawnAt.filter((t) => t > performance.now() - 1000).length,
    drawMs: drawTimes.length ? drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length : 0,
    hudMs: hudTimes.length ? hudTimes.reduce((a, b) => a + b, 0) / hudTimes.length : 0,
    mirrorMs: mirrorTimes.length ? mirrorTimes.reduce((a, b) => a + b, 0) / mirrorTimes.length : 0,
    worstMs: drawTimes.length ? Math.max(...drawTimes) : 0,
    draws: lastDraws,
    culled: lastCulled,
    mirrorDraws: lastMirrorDraws,
    /** the player's own state: seen, warm, drawing every frame, free to load, playing */
    player: { seen: inSight(), warm: warm(), every: drawEvery, mayLoad: mayLoad(), running: replayStore.running, waiting: waitingFor },
    frames,
    fighters: lastFighters,
    ghosts: lastGhosts,
    look480: look480(),
    lookGpuMs: renderer?.lookGpuMs ?? null,
    crt: crtPreset(),
    curve: crtCurve(),
  });

  // the checks (tests) and the fps overlay read this
  const handle = {
    stats,
    /** the runs' fighters as drawn on the last frame, and every state a fighter had no animation for */
    ghostPoses: () => lastGhostPoses,
    missingAnimations,
    /** what is in: the stage, the fighters, and whether the warm-up is done (it draws, and plays when asked) */
    loaded: () => ({ stage: !!stage(), fighters: ready().size, warm: warm(),
                     // (and every effect file the track's pieces name, the stage's own among them)
                     effects: trackFiles() === 0 && !(viewerTrack() && trackFilesOf(viewerTrack()!).has(30) && !scene?.particles.bank) }),
    /** each fighter on the last frame drawn: its action state, the frame of
     *  it, and the animation found for it (null: none, the model's rest pose) */
    poses: () => lastPoses,
    /** the replay's fighters on each of these replay frames, posed as a simulated run's are (framePoser with no
     *  viewer track: the code a ghost is posed by), nothing drawn: per fighter its state, how its joints were got
     *  (Fighter.posedBy), who holds it, whether its own file has an animation for the state, and the fighters of
     *  the frame whose files are not in yet (`unread`). For sweeping whole public games through a run's path */
    runPoses: (frames: number[], withTrack = false) => {
      const data = rawData(), fs = ready();
      if (!data) return null;
      return frames.map((f) => {
        const fr = data.frames[f];
        const there = fr ? fr.players.filter((p) => p).reduce((n, p) => n + (p!.nanaState ? 2 : 1), 0) : 0;
        // (`withTrack`: as the game's own fighters are posed, with the replay's viewer track when it holds)
        const { out, held, poseOne, holdOf } = framePoser(data, fs, f, withTrack ? viewerTrack() : null, false);
        const rows = [];
        for (const h of held) {
          const s = h.a.st;
          if (hidden(s)) continue;
          const by = holdOf(h);
          poseOne(h);
          rows.push({ key: actorKey(h.a.player, h.a.nana), char: s.internalCharacterId, state: s.actionStateId, by: h.fi.posedBy,
                      heldBy: by ? by.key : null, own: !!h.fi.animFor(s.actionStateId), captor: h.a.captor ? h.a.captor.st.internalCharacterId : null });
        }
        return { f, unread: there - out.length - held.length, rows };
      });
    },
    /** the effects on the last frame drawn, by kind, and which of the game's
     *  own art they were drawn with */
    effects: () => lastFx,
    /** the effect models up on the last frame drawn: which file and model,
     *  where, how old */
    fxModels: () => (fxw?.models ?? []).map((m) => {
      const [x, y, z] = fxw!.modelPlace(m);
      return { file: m.bank.id, model: m.index, x, y, z, age: m.age, rotY: m.rotY, rotZ: m.rotZ, scale: m.scale };
    }),
    /** where each fighter of the frame drawn is on the canvas: 0..1 from the
     *  top left, at its middle */
    where: () => {
      const fr = replayStore.replayData?.frames[replayStore.frame];
      const out: { player: number; x: number; y: number }[] = [];
      for (const p of fr?.players ?? []) {
        if (!p) continue;
        const X = p.state.xPosition, Y = p.state.yPosition + middle(p.state.internalCharacterId);
        const m = viewProj;
        const cw = m[3] * X + m[7] * Y + m[15];
        out.push({ player: p.playerIndex, x: ((m[0] * X + m[4] * Y + m[12]) / cw + 1) / 2,
                   y: (1 - (m[1] * X + m[5] * Y + m[13]) / cw) / 2 });
      }
      return out;
    },
    /** the stretches of frames each fighter holds a full charge stored (fx/charges.ts):
     *  its key, the color animation, first and last frame */
    storedRuns: () => {
      const data = rawData(), fs = ready();
      if (!data) return [];
      const runs = chargesOf(data, fs, viewerTrack());
      // (as the game numbers its frames, from -123, as the page's seek takes them)
      const num = (i: number) => i - 123;
      const out: { key: string; anim: number; from: number; to: number }[] = [];
      for (const [key, arr] of runs) {
        const at = (f: number) => storedAnim(arr[f] ?? 0);
        for (let f = 0; f < arr.length; f++) {
          if (!at(f) || at(f - 1) === at(f)) continue;
          let g = f;
          while (g + 1 < arr.length && at(g + 1) === at(f)) g++;
          out.push({ key, anim: at(f), from: num(f), to: num(g) });
        }
      }
      return out;
    },
    /** each fighter's color animations and tint on the last frame drawn */
    tints: () => lastTints,
    /** each fighter's shake on the last frame drawn (hitlag.ts): its model's offset */
    shakes: () => Object.fromEntries(lastShakes),
    /** the HUD on the last frame drawn: each percent (and whether it is off in
     *  a KO), the timer as it reads, the tags and magnifiers up, the stock icons */
    hud: () => hudOf()?.last ?? null,
    // each fighter's sword trail: how many samples the game would have, and the strip's vertices
    swords: () => fxw?.swords.debug() ?? null,
    /** the match camera at a replay index (the track's when there is one): eye, interest, field of view */
    camera: (f: number) => {
      const t = camTrackTo(f);
      if (!t || (f + 1) * CAM_STRIDE > t.length) return null;
      return Array.from(t.subarray(f * CAM_STRIDE, (f + 1) * CAM_STRIDE)).map((v) => Math.round(v * 100) / 100);
    },
    /** the articles hung on a fighter's joint on the last frame drawn: where, how big */
    articles: () => drawnArticles,
    kirbyHats: () => drawnKirbyHats,
    /** the shields drawn on the last frame: whose, its state, how far into its model, where, how big */
    shields: () => drawnShields,
    /** the swinging chains as stepped (dynamics.ts): each fighter's, by chain, each joint's turn, place, swing and length */
    dynamics: () => [...dyns].map(([key, e]) => ({ key, frame: e.d.frame, sub: e.sub,
      chains: e.d.chains.map((c) => ({ first: c.first, nodes: c.nodes.map((n) => ({ joint: n.joint, swing: n.swing, rot: n.rot, pos: n.pos,
        vel: n.vel, axis: n.axis, len: n.len, dom: n.dom })) })) })),
    /** the view matrix and each fighter's parts' world places on the last frame drawn (depth checks) */
    depth: () => lastDepth && {
      view: Array.from(lastDepth.view),
      fighters: lastDepth.actors.map((fa) => ({ key: fa.key, char: fa.st.internalCharacterId,
        parts: Array.from({ length: Math.floor(fa.world.length / 16) }, (_, k) => [fa.world[k * 16 + 12], fa.world[k * 16 + 13], fa.world[k * 16 + 14]]) })),
    },
    /** a fighter's joint's world matrix on the frame stepped ("player:nana", joint) */
    joint: (key: string, j: number) => Array.from(fxw?.jointWorld(key, j) ?? []),
    /** the checks: fail as a real failure does */
    fail: (why: string) => fail(why),
    /** the stage on the last frame drawn: the parts up, the animations its code has them on, the color behind */
    stage: () => {
      const st = stage();
      if (!st) return null;
      return { up: [...st.up].sort((a, b) => a - b), clear: st.clear.map((v) => Math.round(v * 255)),
               runs: Object.fromEntries([...st.runs].map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
               tinted: st.parts.filter((p) => st.tintOf(p.skeleton)).map((p) => p.index),
               extras: [...st.extraRuns.keys()].map((e) => ({ part: e.index, shown: [...e.skeleton.shown].map((v, j) => (v ? j : -1)).filter((j) => j >= 0),
                 at: [...e.skeleton.shown].map((v, j) => (v ? e.skeleton.position(j).map((q) => Math.round(q)) : null)).filter((x) => x) })),
               particles: scene?.particles.particles.length ?? 0, generators: scene?.particles.ps.gens.length ?? 0,
               particleMs: +stageMs.toFixed(2),
               // (Pokemon Stadium: the forms up, each with its height and how far it is moved)
               forms: st.formsUp.map((f) => ({ ...f, scaleY: +f.scaleY.toFixed(4), y: +f.y.toFixed(3) })),
               drawn: st.skeletons.length };
    },
    /** the checks: Pokemon Stadium's big screen's picture on the frame last drawn (a PNG data URL), its mode
     *  and whether it is written with the game's own text; null on another stage */
    screenPicture: (gameText = true) => {
      const sc = scene?.screen, st = stage();
      if (!sc || !st) return null;
      // (gameText false: the same frame drawn the way the player drew it before the game's own text, then back)
      const keep = st.lettering;
      if (!gameText) { st.lettering = null; (sc as unknown as { drawn: string }).drawn = ""; sc.draw(st.frame); }
      const png = sc.canvas.toDataURL("image/png");
      if (!gameText) { st.lettering = keep; (sc as unknown as { drawn: string }).drawn = ""; sc.draw(st.frame); }
      return { mode: sc.mode, player: sc.player, gameText: !!st.lettering && gameText, png };
    },
    /** the checks: the stage's own particles as a game with no track has them (gr/particles.ts), run
     *  from `from` to `to` (the replay's index): each frame's generators of the stage's bank, in the
     *  list's order, as [command, x, y, z] (a transform's place where it has one) */
    stageGensRun: (from: number, to: number) => {
      const sp = scene?.particles;
      if (!sp) return null;
      const out: [number, number[][]][] = [];
      for (let f = from; f <= to; f++) {
        sp.step(f);
        out.push([f, sp.ps.gens.filter((g) => !g.dead && g.bank === sp.bank).map((g) =>
          [g.cmdId, ...(g.srt && !(g.px || g.py || g.pz) ? [g.srt.tx, g.srt.ty, g.srt.tz] : [g.px, g.py, g.pz]).map((v) => +v.toFixed(2))])]);
      }
      // (one frame asked for: its particles too, by their generator's command, [command, x, y, z])
      const parts = from === to ? sp.ps.particles.filter((p) => p.bank === sp.bank).map((p) =>
        [p.gen?.cmdId ?? -1, +p.px.toFixed(2), +p.py.toFixed(2), +p.pz.toFixed(2)]) : null;
      draw();
      return parts ? [...out, [-1, parts]] : out;
    },
    /** the checks: Pokemon Stadium's transformation steps set by hand (frames as the replay's index;
     *  null: the replay's own again), to see a form on a replay that has none */
    setStadium: (events: { frame: number; event: number; type: number }[] | null) => {
      const f = scene?.forms, data = replayStore.replayData;
      if (!f || !data) return false;
      f.events = events ?? data.stadium ?? [];
      draw();
      return true;
    },
    /** where a joint of a stage part is at a frame (the replay's index): the part posed for it */
    stageJoint: (part: number, joint: number, frame: number) => {
      const st = stage(), p = st?.partOf(part);
      if (!st || !p) return null;
      st.poseAt(p, frame);
      const out = p.skeleton.position(joint).map((v) => +v.toFixed(2));
      draw();
      return out;
    },
    /** the stage audit: each of the stage's meshes on the frame shown - its
     *  part, joint, material and textures (by the file's names for them),
     *  whether it is shown and can reach the picture, and how many pixels of
     *  the picture change when it alone is left out. One that is shown and in
     *  view and changes none puts nothing in the picture (it may be behind
     *  something: the audit is read with a view pulled back). `noise` is how
     *  many pixels differ between two draws with nothing changed. */
    stageDrawn: () => {
      const st = stage(), r = renderer;
      if (!st || !r) return null;
      const gl = r.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const read = () => { draw(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      const differ = (a: Uint8Array, b: Uint8Array) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) n++;
        return n;
      };
      const base = read(), noise = differ(base, read());
      const names = new Map<number, string>();
      for (const [n, o] of st.file.publics) if (/_image$/.test(n)) names.set(o, n.replace(/^Grd|_image$/g, ""));
      const meshes: Record<string, unknown>[] = [];
      const drawn = new Set(st.skeletons);
      const sets = [...st.parts.filter((p) => drawn.has(p.skeleton)).map((p) => ({ part: p.index, copy: false, sk: p.skeleton })),
                    ...st.formsUp.filter((f) => f.form !== 5).flatMap((f) => st.formParts(f.form)).map((p) => ({ part: p.index, copy: false, sk: p.skeleton })),
                    ...st.extras.filter((e) => st.extraRuns.has(e)).map((e) => ({ part: e.index, copy: true, sk: e.skeleton }))];
      for (const { part, copy, sk } of sets) {
        const by = new Map<number, typeof sk.drawables>();
        for (const d of sk.drawables) by.set(d.dobj.index, [...(by.get(d.dobj.index) ?? []), d]);
        for (const [i, ds] of by) {
          const shown = ds.some((d) => sk.isVisible(d)), inView = ds.some((d) => r.inView(d));
          let changed = -1;
          if (shown && !sk.hidden.has(i)) {
            sk.hidden.add(i);
            changed = differ(base, read());
            sk.hidden.delete(i);
          }
          const mo = ds[0].state.mobj;
          meshes.push({ part, copy, joint: ds[0].jobj.index, dobj: i, shown, inView, changed, seeThrough: ds[0].translucent,
                        mode: (mo.renderMode >>> 0).toString(16), alpha: +ds[0].state.alpha.toFixed(3),
                        tex: ds[0].state.tex.map((t) => names.get(t.image.dataOff) ?? `image@${t.image.dataOff.toString(16)}`) });
        }
      }
      draw();
      return { w, h, noise, meshes };
    },
    /** the Console view's CRT pass alone at w x h pixels, ms a frame (null: not on) */
    benchCrt: (w: number, h: number, n?: number) => renderer?.benchCrt(w, h, n) ?? null,
    /** the CRT pass on a made-up picture of its own at w x h, with a TV and
     *  a curve: the SHA-256 of its pixels (crt.ts crtPixels) */
    crtHash: async (preset: "trinitron" | "pvm", curve: number, w: number, h: number) => {
      const px = renderer?.crtPixels(preset, curve, w, h);
      if (!px) return null;
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", px));
      return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    /** draw now and read a block of the canvas: x, y, w, h in its pixels
     *  from the top left; RGBA, top row first */
    region: (x: number, y: number, w: number, h: number) => {
      draw();
      const gl = renderer?.gl;
      if (!gl) return null;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(x, canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out: number[] = [];
      for (let r = h - 1; r >= 0; r--) for (let i = 0; i < w * 4; i++) out.push(px[r * w * 4 + i]);
      return out;
    },
    /** where the drawing time went since the last ask: milliseconds a frame, by section */
    sections: () => prof.read(),
    /** checkpoints made ahead to a frame now, at once (the checks', before a jump they measure) */
    fxFill: (to: number) => {
      const data = replayStore.replayData;
      if (!fxw || !data) return null;
      const c = checks(fxw);
      for (let i = 0; i < 100000 && (c.ahead?.frame ?? c.store.last.frame) < Math.min(to, data.frames.length - 1); i++) {
        if (!fillChecks(fxw, data, ready(), 50)) break;
      }
      draw();
      return true;
    },
    /** the effect world's checkpoints: how many, to which frame, their spacing and bytes (roughly), and whether
     *  the world drawn is the exact one */
    fxChecks: () => {
      const c = fxw ? checksOf.get(fxw) : undefined;
      return c ? { count: c.store.snaps.length, last: c.store.last.frame, every: c.store.every, bytes: c.store.bytes, exact: c.exact }
        : null;
    },
    /** each frame drawn since the last ask: [when it started (ms), how long it took, the frame] */
    frameLog: () => { const out: number[][] = []; for (let i = 0; i + 2 < frameLog.length; i += 3) out.push([frameLog[i], frameLog[i + 1], frameLog[i + 2]]); frameLog.length = 0; return out; },
    /** the drawing alone, timed: frames from..from+n-1 drawn one after another,
     *  as playing draws them, with nothing else between (the checks' steady
     *  measure); milliseconds each, and where they went */
    bench: (from: number, n: number, hash = false) => {
      const ts: number[] = [], hashes: number[] = [], mats: string[] = [];
      prof.read();
      for (let i = 0; i < n; i++) {
        benchFrame = from + i;
        // (the card's work on the last one done first, untimed: a frame's
        // time is its own, not a wait on the ones before)
        renderer?.gl.finish();
        const t = performance.now();
        draw();
        ts.push(performance.now() - t);
        // (a hash of the picture just drawn: two ways of drawing the same frames compared)
        if (hash && renderer) hashes.push(pictureHash(renderer.gl));
        // (and of the drawn meshes' matrices: the stage's and the fighters')
        if (hash) {
          let x = 0, nan = 0;
          const sks = [...(stage()?.skeletons ?? []), ...[...ready().values()].map((f) => f.skeleton)];
          sks.forEach((sk) => sk.drawables.forEach((d, k) => { if (sk.isVisible(d)) for (let q = 0; q < d.mats.length; q++) { const v = d.mats[q]; if (v === v) x += v * ((k * 7 + q) % 97 + 1); else nan++; } }));
          mats.push(`${x.toPrecision(12)}|${nan}`);
        }
      }
      benchFrame = null;
      const sections = prof.read();
      draw();
      ts.sort((a, b) => a - b);
      return { mean: +(ts.reduce((a, b) => a + b, 0) / n).toFixed(3), median: +ts[n >> 1].toFixed(3), p90: +ts[Math.floor(n * 0.9)].toFixed(3),
               sections, ...(hash ? { hashes, mats } : {}) };
    },
    /** the stage's own particles on the last frame drawn: where (through their transform), size, color */
    stageParticles: () => (scene?.particles.particles ?? []).map((p) => {
      const [x, y, z] = p.srt ? srtApply(p.srt, p.px, p.py, p.pz) : [p.px, p.py, p.pz];
      return { x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1), size: +(p.size * (p.srt ? Math.abs(p.srt.sx) : 1)).toFixed(2),
               life: p.life, tex: p.texGroup, pose: p.pose, kind: p.kind.toString(16), v: [p.vx, p.vy, p.vz].map((v) => +v.toFixed(2)),
               gen: p.gen ? [p.gen.px, p.gen.py, p.gen.pz, ...(p.gen.rot ?? [])].map((v) => +v.toFixed(2)) : null,
               prim: [p.prim.r, p.prim.g, p.prim.b, p.prim.a].map(Math.round), env: [p.env.r, p.env.g, p.env.b, p.env.a].map(Math.round) };
    }),
    /** whether the last frame drawn used a viewer track (its effects world was made with one), and for which replay */
    drewWith: () => ({ track: !!fxTrack && fxTrack === viewerTrack(), source: props.source ?? null, frame: replayStore.frame }),
    /** the viewer track: whether there is one, the seconds the simulator took, or why not */
    track: () => { const t = viewerTrack(); return t ? { ready: true, seconds: t.seconds } : { ready: false, why: trackWhy }; },
    /** use the learned table where no track holds (the default), or the
     *  move scripts' effects alone (the parity harness compares the two) */
    setLearned: (on: boolean) => { useLearned = on; fxw = null; harnessRun = null; return !!learnedTable(); },
    /** an article of a fighter on show (internal character id): its model, its states (the harness's) */
    article: (char: number, index: number) => [...ready().values()].find((f) => f.internalId === char)?.articleInfo(index) ?? null,
    /** use this track (the tests: a made-up one), or none */
    /** each stage part's joints' places as posed now (the part's number, its
     *  joint count, each joint's parent and place): for matching the track's
     *  stage joints to the player's */
    stageJoints: () => (stage()?.parts ?? []).map((p) => ({
      part: p.index, up: !!stage()?.up.has(p.index),
      joints: p.joints.map((j, i) => [j.parent, +p.skeleton.world[i * 16 + 12].toFixed(1), +p.skeleton.world[i * 16 + 13].toFixed(1),
                                     +p.skeleton.world[i * 16 + 14].toFixed(1)]),
    })),
    setTrack: (data: TrackData | null) => setViewerTrack(data ? new ViewerTrack(data) : null),
    /** the generators running on the last frame drawn: bank, type, where, their transform */
    generators: () => (fxw?.ps.gens ?? []).map((g) => ({ file: g.bank.id, type: g.type, kind: g.kind, x: g.px, y: g.py, z: g.pz,
      srt: g.srt, age: g.age, genLife: g.genLife, follows: !!g.follow })),
    /** the effects the effect world started lately: frame, id, whose */
    spawns: () => fxw?.spawnLog ?? [],
    /** each fighter's character (internal id) by its key, from the replay (pose checks) */
    charsByKey: () => {
      const out: Record<string, number> = {};
      for (const fr of rawData()?.frames.slice(0, 400) ?? []) {
        for (const p of fr.players) {
          if (p?.state) out[actorKey(p.playerIndex, false)] = p.state.internalCharacterId;
          if (p?.nanaState) out[actorKey(p.playerIndex, true)] = p.nanaState.internalCharacterId;
        }
      }
      return out;
    },
    /** each fighter's own pose on these replay frames, for the parts asked
     *  (pose checks): by fighter key, per part its model
     *  joint's turn x, y, z, scale x, y, z and place x, y, z in its parent's
     *  frame, as the effects world poses it */
    poseLocal: (frames: number[], parts: number[]) => {
      const data = rawData(), fs = ready();
      if (!data || !allIn()) return null;
      return frames.map((f) => Object.fromEntries(actorsAt(data, fs, f).filter((a) => a.world.length).map((a) => {
        const sk = a.fighter.skeleton, char = a.st.internalCharacterId;
        return [a.key, parts.map((p) => {
          const j = partToModelJoint(char, p);
          if (j < 0 || j >= sk.n) return null;
          return [...sk.rot.slice(j * 3, j * 3 + 3), ...sk.scale.slice(j * 3, j * 3 + 3), ...sk.trans.slice(j * 3, j * 3 + 3)]
            .map((v) => +v.toFixed(4));
        })];
      })));
    },
    /** the player's poses against the game's on these replay frames
     *  (pose checks): each fighter posed as the effects world poses
     *  it, then the game's joints for it (`refs`: per frame, by fighter key,
     *  base64 of per part a uint32 of flags and its turn x, y, z, w, scale and
     *  place, in its parent's frame - melee-sim-light's MSL_POSE_WORLD probe)
     *  laid on the same model; per frame and fighter, how far each part's
     *  world place is from the game's, as base64 float32s. A part the
     *  simulator leaves unposed (its JOBJ_MSL_GAMEPLAY_COLD flag: gameplay
     *  never reads it) keeps the player's own pose and says NaN. With `game`
     *  false the track's animations are left out (the replay's own way).
     *  With `detail` (the check's sweep) each fighter's answer is instead
     *  {d: those distances, l: per part how far its own joint is from the
     *  game's in its parent's frame - its turn (radians), place and scale -
     *  so a part that is off only because its parent is says 0, s: its
     *  action state, the state's frame counter, the state before, its hitlag
     *  left and whether it is on the ground} */
    poseCompare: (frames: number[], game: boolean, refs: Record<string, string>[], detail = false) => {
      const data = rawData(), fs = ready();
      if (!data || !allIn()) return null;
      gameAnims = game;
      // (the swinging chains stepped every frame up to each one asked, as
      // drawing steps them: their own, apart from the drawn ones)
      const held = (cmpDyns.game === game && cmpDyns.data === data) ? cmpDyns.held : new Map<string, DynHeld>();
      cmpDyns = { game, data, held };
      dynLook = held;
      const stepTo = (f: number) => {
        let from = Math.max(0, f - 120);
        for (const e of held.values()) if (e.d.frame < f && e.d.frame >= f - 120) from = Math.max(from, e.d.frame + 1);
        for (let g = from; g < f; g++) for (const fa of actorsAt(data, fs, g)) { try { dynOne(g, fa, data, held); } catch { /* left as posed */ } }
        const now = actorsAt(data, fs, f);
        for (const fa of now) {
          try { dynOne(f, fa, data, held); } catch { continue; }
          const e = held.get(fa.key), sk = fa.fighter.skeleton;
          if (!e || e.d.frame !== f || e.fi !== fa.fighter) continue;
          e.d.apply(sk.rot, sk.trans, sk.scale);
          sk.update();
          fa.world = worldByPart(fa.st.internalCharacterId, sk.world);
        }
        return now;
      };
      const b64 = (a: Float32Array) => {
        let bin = "";
        const u8 = new Uint8Array(a.buffer);
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa(bin);
      };
      try {
        // (a fighter falling past the screen - DeadUpFall, DeadUpFallHitCamera - is left out: the player puts it
        // where the camera is looking from, the simulator's game has no such camera: no reference for its place)
        return frames.map((f, k) => {
          const actorsNow = stepTo(f), theirsOf = new Map<string, Float32Array>();
          // (a held fighter after its holder: its reference takes the holder's)
          return Object.fromEntries(actorsNow.filter((a) => a.world.length && refs[k]?.[a.key] &&
                                                            a.st.actionStateId !== 6 && a.st.actionStateId !== 7)
          .sort((x, y) => (x.heldBy ? 1 : 0) - (y.heldBy ? 1 : 0))
          .map((a) => {
            const mine = a.world, bin = atob(refs[k][a.key]), u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const dv = new DataView(u8.buffer), parts = u8.length / 44, char = a.st.internalCharacterId;
            const sk = a.fighter.skeleton, cold = new Set<number>();
            // (a held fighter's shift is the player's own way of putting it on
            // its holder: the game's joints are laid on the model without it)
            sk.shift = null;
            const local =detail ? new Float32Array(parts * 3) : null;
            for (let p = 0; p < parts; p++) {
              const j = partToModelJoint(char, p);
              if (j < 0 || j >= sk.n) continue;
              const o = p * 44, v = (i: number) => dv.getFloat32(o + 4 + i * 4, true), flags = dv.getUint32(o, true);
              if (flags & 0x80000000) { cold.add(p); continue; }
              const quat: [number, number, number, number] | null = flags & (1 << 17) ? [v(0), v(1), v(2), v(3)] : null;
              const r = quat ? mtxEuler(quatMtx(quat)) : [v(0), v(1), v(2)];
              if (local) {
                const qm = eulerToQuat(sk.rot.subarray(j * 3, j * 3 + 3)), qg = quat ?? eulerToQuat(r);
                const dot = Math.abs(qm[0] * qg[0] + qm[1] * qg[1] + qm[2] * qg[2] + qm[3] * qg[3]) / (Math.hypot(...qg) || 1);
                local[p * 3] = 2 * Math.acos(Math.min(1, dot));
                local[p * 3 + 1] = Math.hypot(sk.trans[j * 3] - v(7), sk.trans[j * 3 + 1] - v(8), sk.trans[j * 3 + 2] - v(9));
                local[p * 3 + 2] = Math.hypot(sk.scale[j * 3] - v(4), sk.scale[j * 3 + 1] - v(5), sk.scale[j * 3 + 2] - v(6));
              }
              // (the check's --peek: one part's own joint, the player's then the game's - turn, size, place)
              const peek = (globalThis as { __posePeek?: { char: number; part: number; rows: number[][] } }).__posePeek;
              if (peek && detail && peek.char === char && peek.part === p && peek.rows.length < 6000) {
                peek.rows.push([f - 123, a.st.actionStateId, ...sk.rot.subarray(j * 3, j * 3 + 3), ...sk.scale.subarray(j * 3, j * 3 + 3),
                                ...sk.trans.subarray(j * 3, j * 3 + 3), ...r, v(4), v(5), v(6), v(7), v(8), v(9), flags].map((x) => +(+x).toFixed(4)));
              }
              for (let c = 0; c < 3; c++) { sk.rot[j * 3 + c] = r[c]; sk.scale[j * 3 + c] = v(4 + c); sk.trans[j * 3 + c] = v(7 + c); }
            }
            // (and a swinging chain the simulator does not run - it keeps only
            // the chains a hurtbox sits on, Fox's tail and Jigglypuff's body:
            // ftCo_HeadlessPruneDynamics - is no reference either: hair, a
            // cape, a dress stay as the animation has them there. Its joints
            // and what hangs from them are left out like the unposed ones)
            const chains = held.get(a.key)?.d.chains ?? [];
            const hurt = new Set(a.fighter.hurtboxes.map((h) => partToModelJoint(char, h.joint)));
            const off = new Set<number>();
            for (const c of chains) if (!c.nodes.some((nd) => hurt.has(nd.joint))) for (const nd of c.nodes) off.add(nd.joint);
            if (off.size) {
              for (let p = 0; p < parts; p++) {
                let j = partToModelJoint(char, p);
                for (; j >= 0 && j < sk.n; j = sk.parent[j]) if (off.has(j)) { cold.add(p); break; }
              }
            }
            sk.update();
            const theirs = worldByPart(char, sk.world), n = Math.min(mine.length, theirs.length) / 16, d = new Float32Array(n);
            // (held or thrown: the game holds its XRotN on its holder's TransN2 with a constraint added as the
            // grab takes it - ftCo_800DB368, lb_8000C1C0 - which is in no joint's own values; the same hold is
            // laid on the game's joints, from the game's joints for the holder: the held joint and what hangs
            // from it moved to where the holder's joint is. Without it the reference was a fighter standing
            // where the replay says it is, as far from the game's as the hold moves it)
            theirsOf.set(a.key, theirs);
            const by = a.heldBy, holder = by ? theirsOf.get(by.key) : undefined;
            if (by && holder) {
              const hc = actorsNow.find((q) => q.key === by.key)?.st.internalCharacterId ?? -1;
              const partOf = (c: number, joint: number, count: number) => { for (let p = 0; p < count; p++) if (partToModelJoint(c, p) === joint) return p; return -1; };
              const hp = partOf(hc, by.on, holder.length / 16), vp = partOf(char, by.joint, theirs.length / 16);
              if (hp >= 0 && vp >= 0) {
                const dx = holder[hp * 16 + 12] - theirs[vp * 16 + 12], dy = holder[hp * 16 + 13] - theirs[vp * 16 + 13],
                  dz = holder[hp * 16 + 14] - theirs[vp * 16 + 14];
                for (let p = 0; p < theirs.length / 16; p++) {
                  let j = partToModelJoint(char, p);
                  for (; j >= 0 && j < sk.n; j = sk.parent[j]) if (j === by.joint) { theirs[p * 16 + 12] += dx; theirs[p * 16 + 13] += dy; theirs[p * 16 + 14] += dz; break; }
                }
              }
            }
            for (let i = 0; i < n; i++) {
              d[i] = cold.has(i) ? NaN : Math.hypot(mine[i * 16 + 12] - theirs[i * 16 + 12], mine[i * 16 + 13] - theirs[i * 16 + 13],
                                                   mine[i * 16 + 14] - theirs[i * 16 + 14]);
            }
            if (!local) return [a.key, b64(d)];
            for (const p of cold) if (p * 3 + 2 < local.length) local[p * 3] = local[p * 3 + 1] = local[p * 3 + 2] = NaN;
            const [pl, nn] = a.key.split(":").map(Number);
            let before = -1;
            for (let g = f - 1; g >= 0 && f - g < 600; g--) {
              const q = data.frames[g]?.players[pl], s = nn === 1 ? q?.nanaState : q?.state;
              if (!s) break;
              if (s.actionStateId !== a.st.actionStateId) { before = s.actionStateId; break; }
            }
            return [a.key, { d: b64(d), l: b64(local), s: [a.st.actionStateId, a.st.actionStateFrameCounter, before,
                                                           a.st.hitlagRemaining ?? 0, a.st.isGrounded === false ? 0 : 1] }];
          }));
        });
      } finally {
        gameAnims = true; dynLook = dyns;
      }
    },
    /** the parity harness (effect checks): an effect world of its
     *  own stepped over the replay's frames from..to (indexes) as playing
     *  steps it, nothing drawn - every effect start that draws something
     *  ([frame, id, whose, from where]: FxWorld.started), and per item kind
     *  the frames it is out and those it has no model here (the line art
     *  draws it), and each item's kind by its spawn id. Asked again from where the last ask ended, it goes on;
     *  from anywhere else it starts over. Null until the stage, every
     *  fighter and the effects are in. */
    harness: (from: number, to: number, against?: TrackData, generators = false, draws = false, sync?: Record<number, number[]>) => {
      const data = rawData(), fs = ready(), ek = kit(), st = stage();
      if (!data || !ek?.bank || !ek.colAnims || !st || !allIn()) return null;
      // (and every file still being read: a fighter's own effect file comes after its model, and a world
      // stepped without it makes none of that file's models - one run in three of a full set lacked the two
      // generators of one such model for its 8 frames, the file having come a moment after the first ask)
      if (loadsOut() > 0 || trackFiles() > 0) return null;
      const tr = viewerTrack();
      const last = Math.min(to, data.frames.length - 1);
      if (!harnessRun || harnessRun.data !== data || harnessRun.track !== tr || harnessRun.next !== from) {
        const w = makeWorld(ek, data, fs, tr);
        if (st.camera) w.ko = koLook(ek, st);
        w.reset(from);
        harnessRun = { w, data, track: tr, next: from };
        // (the drawn world is made again for the next frame drawn: this one cleared what they share)
        fxw = null;
      }
      const run = harnessRun, starts: [number, number, string | null, string][] = [];
      run.w.started = (f, id, by, via) => starts.push([f, id, by, via]);
      // (where each piece on a joint went, against the game's: frame, effect, whose, distance, and
      // the distance had it gone where its joint was the frame before)
      const placed: [number, number, string | null, number, number][] = [];
      const unplaced: [number, number, string | null, string][] = [];
      run.w.unplaced = (f, gfx, by, why) => unplaced.push([f, gfx, by, why]);
      const far = (p: number[], q: number[]) => +Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]).toFixed(2);
      // (a place of exactly 0, 0, 0 is one the simulator had no matrix for: -1, not known)
      run.w.placed = (f, gfx, by, _i, ours, game, before) =>
        placed.push(game.every((x) => x === 0) ? [f, gfx, by, -1, -1] : [f, gfx, by, far(ours, game), far(before, game)]);
      const items: Record<number, { frames: number; none: number }> = {}, kinds: Record<number, number> = {};
      // (with `against`, a track the player is not using: what it draws without
      // one - the color animations, the eyes and hands, the model parts' own
      // rules, the camera - against what the track says, frame by frame)
      const ag = against ? new ViewerTrack(against) : null;
      const vs = { tint: { frames: 0, same: 0 }, tex: { frames: 0, same: 0 }, cam: { frames: 0, eye: [] as number[], aim: [] as number[] },
                   // (model parts: every part's every frame, and the frames either has one switched)
                   part: { frames: 0, same: 0, switched: 0, switchedSame: 0, by: {} as Record<string, [number, number, Record<string, number>]> } };
      const own = ag ? camTrackTo(data.frames.length) : null, theirs = ag?.has("cam") ? camFromTrack(ag, data.frames.length) : null;
      const tfaces = ag ? trackFacesOf(ag) : null;
      // (the stage's code, with the track and without it: each frame the
      // parts it has up, the animation each is on and from when, and the
      // color behind everything; and the generators it made)
      const stageVs = { frames: 0, same: 0, runsSame: 0, gens: { track: 0, own: 0, matched: 0 }, differ: {} as Record<string, number>,
                        gensBy: {} as Record<number, [number[], number[]]> };
      if (ag) {
        const was = st.logic;
        const withIt = new StageScene(st, ag, data), without = new StageScene(st, null, data);
        st.logic = was;
        const runsOf = () => JSON.stringify(st.parts.map((p) => st.playing(p.index)));
        const restOf = () => JSON.stringify([[...st.up].sort((x, y) => x - y), st.background, st.tints.size]);
        for (let g = from; g <= last; g++) {
          if (!ag.valid(g - 123)) continue;
          withIt.apply(st, g);
          const r1 = runsOf(), o1 = restOf();
          without.apply(st, g);
          stageVs.frames++;
          if (runsOf() === r1 && restOf() === o1) stageVs.same++;
          const r2 = runsOf();
          if (r2 === r1) stageVs.runsSame++;
          else {
            // (only the parts that differ)
            const a1 = JSON.parse(r1) as unknown[], a2 = JSON.parse(r2) as unknown[];
            const k = st.parts.map((p, i) => JSON.stringify(a1[i]) === JSON.stringify(a2[i]) ? "" : `${p.index}: ${JSON.stringify(a1[i])} / ${JSON.stringify(a2[i])}`)
              .filter((x) => x).join("; ").slice(0, 200);
            stageVs.differ[k] = (stageVs.differ[k] ?? 0) + 1;
          }
        }
        st.resetFrame();
        // (each generator the track says the stage's code made against the
        // player's own list: the same one made within a frame of it)
        const theirs = ag.between("sgen", from - 124, last - 123).map((e) => [Number(e[4]), Number(e[0]) + 123]);
        const ids = new Set(theirs.map(([gen]) => gen));
        const mine = without.particles.emitters.filter((e) => ids.has(e.gen) && e.from >= from && e.from <= last);
        stageVs.gens.track = theirs.length;
        stageVs.gens.own = mine.length;
        const used = new Set<number>();
        for (const [gen, at] of theirs) {
          const k = mine.findIndex((e, i) => !used.has(i) && e.gen === gen && Math.abs(e.from - at) <= 1);
          if (k >= 0) { used.add(k); stageVs.gens.matched++; }
        }
        // (by generator: the track's first frames and the player's)
        for (const gen of ids) {
          stageVs.gensBy[gen] = [theirs.filter(([x]) => x === gen).slice(0, 6).map(([, at]) => at),
                                 mine.filter((e) => e.gen === gen).slice(0, 6).map((e) => e.from)];
        }
      }
      const sameTint = (x: ColTint | null, y: ColTint | null) => {
        if (!x || !y) return !x && !y;
        const c = (a: ColTint["color"], b: ColTint["color"]) => (!a && !b) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 0.02));
        return c(x.color, y.color) && (!x.light) === (!y.light);
      };
      // (with `generators`: the effect world's generator list after each frame it has any - each one's
      // effect file, command, count, life left and particles - for the check against the game's own list,
      // particle checks)
      const gens: [number, number[][]][] = [];
      // (and each one as it is first seen: which it is, its command, how it was made, whose it is - and every
      // frame's list as their numbers - for the sweep, particle checks)
      const born: [number, number, number, string, string, number, number][] = [], ids: [number, number[]][] = [];
      // (and on every 60th game frame each particle, in the lists' order: its list, its generator, its place
      // and motion, and its transform's place when it is under one - the place check's second half)
      const parts: [number, number[][]][] = [];
      // (with `draws`: every random draw of each frame in order - phase, kind, command, the state left -
      // and the state the frame's update starts from, for particle checks)
      const drawn: [number, number[]][] = [];
      const seenGens = ((run as { seenGens?: Set<number> }).seenGens ??= new Set<number>());
      // (the stage as it was on each frame, when its generators are the effect world's: they go along its joints)
      const stw = generators && stageInWorld(tr) ? st : null;
      if (stw) sceneFor(st, tr, data);
      for (let g = from; g <= last; g++) {
        const now = actorsAt(data, fs, g);
        if (stw) {
          stw.update(g, stageFrame(data, g));
        }
        if (draws) run.w.ps.rng.trace = [];
        run.w.step(g, now);
        if (draws) { const t = run.w.ps.rng.trace ?? []; run.w.ps.rng.trace = null; if (t.length) drawn.push([g, t]); }
        // (with `sync`, the game's list after each frame as command, count, ...: once the frame is recorded, a
        // list of the same commands in the same order takes the game's counts. A generator's count is carried
        // from frame to frame, so one slip would otherwise stay in a never-ending generator for the rest of the
        // game; with this each slip is seen where it happens, and the frames after it only if they slip again)
        const syncNow = () => {
          const want = sync?.[g], have = run.w.ps.gens;
          if (!want || want.length !== have.length * 2) return;
          for (let i = 0; i < have.length; i++) if (have[i].cmdId !== want[i * 2]) return;
          for (let i = 0; i < have.length; i++) have[i].count = Math.fround(want[i * 2 + 1]);
        };
        if (!(generators && run.w.ps.gens.length)) syncNow();
        if (generators && run.w.ps.gens.length) {
          // (on every 60th game frame each one's place too: its own, and its transform's)
          const places = (g - 123) % 60 === 0;
          gens.push([g, run.w.ps.gens.map((x) => {
            const row = [x.bank.id, x.cmdId, +x.count.toFixed(5), x.genLife, x.numChild];
            return places ? [...row, x.px, x.py, x.pz, x.srt ? 1 : 0, x.srt?.tx ?? 0, x.srt?.ty ?? 0, x.srt?.tz ?? 0] : row;
          })]);
          ids.push([g, run.w.ps.gens.map((x) => x.uid)]);
          if (places) {
            parts.push([g, run.w.ps.particles.map((p) => [p.linkNo, p.gen?.uid ?? -1, p.px, p.py, p.pz, p.vx, p.vy, p.vz,
                                                         p.srt ? 1 : 0, p.srt?.tx ?? 0, p.srt?.ty ?? 0, p.srt?.tz ?? 0,
                                                         p.srt?.rx ?? 0, p.srt?.ry ?? 0, p.srt?.rz ?? 0,
                                                         p.srt?.sx ?? 1, p.srt?.sy ?? 1, p.srt?.sz ?? 1])]);
          }
          for (const x of run.w.ps.gens) {
            if (seenGens.has(x.uid)) continue;
            seenGens.add(x.uid);
            // (and the effect model whose joint it is on, file * 1000 + model, with the model's age: -1, none)
            const xm = x.model as { bank: { id: number }; index: number; age: number } | null | undefined;
            born.push([g, x.uid, x.cmdId, x.made, x.tag ?? "", xm ? xm.bank.id * 1000 + xm.index : -1, xm ? xm.age : -1]);
          }
          syncNow();
        }
        if (ag?.valid(g - 123)) {
          for (const a of now) {
            const [pl, nn] = a.key.split(":").map(Number);
            const facing = a.st.facingDirection;
            const said = ag.tint(pl, nn, g - 123, facing);
            if (said !== undefined) {
              vs.tint.frames++;
              if (sameTint(run.w.tintOf(a.key, facing), said)) vs.tint.same++;
            }
            const tex = tfaces?.texAt(pl, nn, g - 123);
            const face = a.fighter ? faceOf(data, a.fighter, pl, nn === 1, g, null) : null;
            if (tex && face) {
              vs.tex.frames++;
              if (tex.every((v, i) => v === undefined || face.tex[i] === v)) vs.tex.same++;
            }
            if (a.fighter && face && ag.has("part")) {
              const fi = a.fighter;
              const me = { st: a.st, player: pl, nana: nn === 1, face, roll: rollOf(data, fi, pl, nn === 1, g),
                           stone: stoneOf(data, fi, pl, nn === 1, g) };
              for (let part = 0; part < fi.partCount; part++) {
                const c = ag.at("part", `${pl}:${nn}:${part}`, g - 123);
                const theirs = c ? Number(c[0]) : fi.defaultPart(part);
                const mine = ownPart(fi, me, part, data.frames[g]?.items ?? []);
                vs.part.frames++;
                if (mine === theirs) vs.part.same++;
                if (mine !== fi.defaultPart(part) || theirs !== fi.defaultPart(part)) {
                  vs.part.switched++;
                  const k = `${a.st.internalCharacterId}:${part}`;
                  const b = (vs.part.by[k] ??= [0, 0, {}]);
                  b[0]++;
                  if (mine === theirs) { vs.part.switchedSame++; b[1]++; }
                  else b[2][`${mine}/${theirs}`] = (b[2][`${mine}/${theirs}`] ?? 0) + 1;
                }
              }
            }
          }
        }
        // (the reflector's three models and the shield's bubble are drawn
        // outside the effect world: their starts as the game numbers them,
        // from the track's pieces when it has them, else from the replay's states)
        const shapes = shapesAt(tr, g);
        if (shapes) {
          for (const [id, key] of shapes.startsAt(g - 123)) {
            const drawable = SHIELD_FX[id] !== undefined ? !!ek.bank?.models[SHIELD_FX[id]] : !!ek.reflector;
            if (drawable) starts.push([g, id, key, SHIELD_FX[id] !== undefined ? "shield" : "reflector"]);
          }
        }
        for (const p of shapes ? [] : data.frames[g]?.players ?? []) {
          // (a port no one plays)
          if (!p) continue;
          for (const nana of [false, true]) {
            const sh = p ? shineAt(data, g, p.playerIndex, nana) : null;
            const id = !sh ? 0 : sh.start === 0 ? 0x489 : sh.loop === 0 ? 0x488 : sh.hit === 0 ? 0x48a : 0;
            if (id) starts.push([g, id, actorKey(p!.playerIndex, nana), "reflector"]);
            // (and the shield's bubble: its model as its state's comes up, 0x417 + its number from 0xB)
            const s = nana ? p?.nanaState : p?.state;
            const q = nana ? data.frames[g - 1]?.players[p!.playerIndex]?.nanaState : data.frames[g - 1]?.players[p!.playerIndex]?.state;
            const which = s ? SHIELD_MODELS[s.actionStateId] : undefined;
            if (which && !(q && which.states.includes(q.actionStateId))) {
              starts.push([g, 0x417 + which.m - SHIELD_MODEL, actorKey(p!.playerIndex, nana), "shield"]);
            }
          }
        }
        for (const it of data.frames[g]?.items ?? []) {
          kinds[it.spawnId] = it.typeId;
          // (Yoshi's Story's Shy Guys are the stage's own drawing: drawShyGuys)
          if (it.typeId === SHY_GUY) continue;
          const k = (items[it.typeId] ??= { frames: 0, none: 0 });
          k.frames++;
          if (!articleOf(data, fs, it, g)) k.none++;
        }
      }
      if (ag) {
        for (let g = from; g <= last; g++) {
          if (!ag.valid(g - 123)) continue;
          if (own && theirs) {
            const i = g * CAM_STRIDE;
            vs.cam.frames++;
            vs.cam.eye.push(Math.hypot(own[i] - theirs[i], own[i + 1] - theirs[i + 1], own[i + 2] - theirs[i + 2]));
            vs.cam.aim.push(Math.hypot(own[i + 3] - theirs[i + 3], own[i + 4] - theirs[i + 4], own[i + 5] - theirs[i + 5]));
          }
        }
      }
      run.w.started = null;
      run.w.placed = null;
      run.w.unplaced = null;
      run.next = last + 1;
      return { from, to: last, frames: data.frames.length, starts, placed, unplaced, items, kinds, stage: data.settings.stageId,
               ...(generators ? { gens, born, ids, parts } : {}), ...(draws ? { drawn } : {}),
               // (each port's fighters' characters, the leader's and Nana's: internal, as the effects' owners are)
               chars: [0, 1, 2, 3].map((port) => {
                 for (const fr of data.frames) {
                   const p = fr?.players[port];
                   if (p) return [p.state.internalCharacterId, p.nanaState?.internalCharacterId ?? null];
                 }
                 return null;
               }),
               until: tr ? (tr.diverges ? tr.until + 123 : null) : null, track: !!tr,
               ...(ag ? { vs: { tint: vs.tint, tex: vs.tex, part: vs.part, stage: stageVs,
                                cam: { frames: vs.cam.frames, eye: quantiles(vs.cam.eye), aim: quantiles(vs.cam.aim) } } } : {}) };
    },
    /** the particles up on the last frame drawn: bank, kind, where, size, color */
    particles: () => (fxw?.ps.particles ?? []).map((p) => ({ file: p.bank.id, kind: p.kind, x: p.px, y: p.py, z: p.pz,
      size: p.size, a: p.prim.a, life: p.life, pose: p.pose, env: [p.env.r, p.env.g, p.env.b, p.env.a] })),
    /** where a point of the world lands on the canvas: 0..1 from the top left */
    project: (X: number, Y: number, Z: number) => {
      const m = viewProj;
      const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
      return [((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / cw + 1) / 2, (1 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / cw) / 2,
              (m[2] * X + m[6] * Y + m[10] * Z + m[14]) / cw];
    },
    /** the stage mirror's image and matrices (Fountain's pond) */
    mirror: () => renderer?.mirrorDebug() ?? null,
    /** the draw log (drawlog.ts): debug only, attached by { start: true } and never otherwise */
    drawLog: (cmd: Parameters<typeof drawLogCommand>[1]) => drawLogCommand(renderer, cmd),
    /** a pixel comparison: leave these groups out of the draws from now on (null:
     *  draw everything again), and draw now */
    setLayers: (off: Partial<Record<Layer, boolean>> | null) => { layersOff = { ...(off ?? {}) }; draw(); return true; },
    /** a pixel comparison's trials: the game's picture (picture.ts) made again with these options, then drawn */
    setPicture: (opts: { samples?: number }) => { renderer?.setPicture(opts); draw(); return true; },
    /** a pixel comparison's trials: where the HUD's shake draws start ("track": after the frame's gameplay, "ps":
     *  after the particles' update, the default; "trackprev": the frame before's; "off": a stand-in of our own) */
    setHudRng: (mode: "track" | "trackprev" | "ps" | "off") => { hudRng = mode; draw(); return true; },
    /** a pixel comparison: each fighter drawn on the last frame, every one of its parts on the canvas (0..1
     *  from the top left, and depth), and the parts the game names (FtPart 0..52) as their part numbers */
    partsOnScreen: () => {
      const ek = kit();
      if (!lastDepth || !ek) return null;
      const m = viewProj;
      const on = (X: number, Y: number, Z: number) => {
        const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
        return [+(((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / cw + 1) / 2).toFixed(5),
                +((1 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / cw) / 2).toFixed(5),
                +((m[2] * X + m[6] * Y + m[10] * Z + m[14]) / cw).toFixed(5)];
      };
      return lastDepth.actors.filter((fa) => fa.world !== NO_WORLD).map((fa) => {
        const c = fa.st.internalCharacterId, n = Math.floor(fa.world.length / 16);
        return { key: fa.key, char: c, x: fa.st.xPosition, y: fa.st.yPosition,
                 parts: Array.from({ length: n }, (_, k) => on(fa.world[k * 16 + 12], fa.world[k * 16 + 13], fa.world[k * 16 + 14])),
                 named: Array.from({ length: 53 }, (_, p) => ek.partToJoint(c, p)) };
      });
    },
    /** draw now and read a pixel of it (x, y from the canvas's bottom-left, in 0..1) */
    probe: (x: number, y: number) => {
      draw();
      const r = renderer;
      if (!r) return null;
      return r.pixel(x * (canvas.width - 1), y * (canvas.height - 1));
    },
  };
  (window as any).__viewer3d = handle;
  onCleanup(() => { if ((window as any).__viewer3d === handle) delete (window as any).__viewer3d; });

  const showFps = new URLSearchParams(location.search).has("fps");
  const [fpsText, setFpsText] = createSignal("");
  if (showFps) {
    const t = setInterval(() => {
      const s = stats();
      setFpsText(`${s.fps} fps · ${s.drawMs.toFixed(1)} ms · ${s.draws} draws · ${s.fighters} fighters`);
    }, 500);
    onCleanup(() => clearInterval(t));
  }

  // the line art draws the items the 3D view has no model of its own for
  const items = () => {
    const data = rawData();
    const fs = ready();
    kbCopyCount();
    return (data?.frames[replayStore.frame]?.items ?? []).filter((it) => it.typeId !== SHY_GUY && !articleOf(data!, fs, it, replayStore.frame));
  };
  // simulated runs keep the line art's projectiles (their hitboxes), where a
  // run's differ from the game's
  const ghostItems = () => {
    const real = rawData()?.frames[replayStore.frame]?.items ?? [];
    const out: { item: ReplayItem }[] = [];
    for (const g of rawGhosts()) {
      for (const it of g.replayData.frames[replayStore.frame]?.items ?? []) {
        if (it.typeId === SHY_GUY) continue;
        const same = real.some((q) => q.spawnId === it.spawnId && Math.abs(q.xPosition - it.xPosition) < 0.01 &&
                                      Math.abs(q.yPosition - it.yPosition) < 0.01);
        if (!same) out.push({ item: it });
      }
    }
    return out;
  };

  // The Console view's curve (crt.ts): the line art goes through the tube's
  // map too, the other way (unbend) - each item moved to where the picture
  // under it now shows, and shaped as the picture is there (the map taken at
  // the item: an item is small next to the screen) - and is cut at the
  // tube's edge. Flat, none of it: the overlay is as it always was.
  const curveNow = () => (look480() && crtPreset() !== "off" ? crtCurve() : 0);
  const bendAt = (x: number, y: number): string | undefined => {
    const k = curveNow();
    if (!k) return undefined;
    const [a, b, c, d, e, f] = itemMatrix(), [w, h] = size();
    // (x, y) on the canvas, flat; where it shows now, and the map's slope
    // there, a CSS pixel each way
    const X = a * x + c * y + e, Y = b * x + d * y + f;
    const s = unbend(k, X / w, Y / h), sx = unbend(k, (X + 1) / w, Y / h), sy = unbend(k, X / w, (Y + 1) / h);
    const j00 = (sx[0] - s[0]) * w, j01 = (sy[0] - s[0]) * w, j10 = (sx[1] - s[1]) * h, j11 = (sy[1] - s[1]) * h;
    // in game units: the slope through the item matrix (L^-1 J L), about
    // (x, y), taken to the game point the matrix puts at the new place
    const det = a * d - b * c;
    const p = j00 * a + j01 * b, q = j00 * c + j01 * d, r = j10 * a + j11 * b, t = j10 * c + j11 * d;
    const A00 = (d * p - c * r) / det, A01 = (d * q - c * t) / det, A10 = (a * r - b * p) / det, A11 = (a * t - b * q) / det;
    const Sx = s[0] * w - e, Sy = s[1] * h - f;
    const gx = (d * Sx - c * Sy) / det, gy = (a * Sy - b * Sx) / det;
    return `matrix(${A00} ${A10} ${A01} ${A11} ${gx - A00 * x - A01 * y} ${gy - A10 * x - A11 * y})`;
  };
  const tubeId = `crt-tube-${++tubes}`;
  const tube = createMemo(() => {
    const k = curveNow(), p = crtPreset();
    return k && p !== "off" ? tubeOutline(k, CRT_LOOKS[p].corner, size()[0], size()[1]) : null;
  });

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* the picture at the game's own shape, whatever the box (GameFrame) */}
      <GameFrame class="bg-slate-900">
        <canvas ref={canvas} class="absolute inset-0 h-full w-full" data-viewer3d />
        {/* the warm-up: the player says it is loading until it can play smoothly */}
        <Show when={replayStore.replayData && !warm()}>
          <div class="absolute inset-0 z-10 flex items-center justify-center gap-2.5 bg-slate-900 text-sm text-slate-300" data-warming>
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-slate-200" />
            {props.retrying ? "3D is catching up…" : "Loading"}
            <Show when={progress() > 0}><span class="tabular-nums text-slate-400">{progress()}%</span></Show>
          </div>
        </Show>
        <svg class="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size()[0]} ${size()[1]}`}
             preserveAspectRatio="none" aria-hidden="true">
          <Show when={tube()}>{(d) => <defs><clipPath id={tubeId}><path d={d()} /></clipPath></defs>}</Show>
          <g clip-path={tube() ? `url(#${tubeId})` : undefined}>
          <g transform={`matrix(${itemMatrix().join(" ")})`}>
            {/* by place in the list, so a moving tag or item is the same
                element moved, not a new one each frame */}
            <Index each={items()}>
              {(item) => <g transform={bendAt(item().xPosition, item().yPosition)} data-item><Item item={item()} /></g>}
            </Index>
            <Index each={ghostItems()}>
              {(g) => <g transform={bendAt(g().item.xPosition, g().item.yPosition)} opacity={0.8} data-ghost-item><Item item={g().item} /></g>}
            </Index>
            <Index each={runTags()}>
              {(t) => (
                <g transform={`${bendAt(t().x, t().y) ?? ""} translate(${t().x} ${t().y}) scale(1 -1)`} data-run-label={t().n}>
                  <circle r={3.6} fill={t().color} stroke="#0f172a" stroke-width={0.7} />
                  <text y={1.55} text-anchor="middle" font-size="4.6" font-weight="700" fill="#0f172a"
                        style="font-family: system-ui, sans-serif">{t().n}</text>
                </g>
              )}
            </Index>
          </g>
          </g>
        </svg>
        <Show when={replayStore.replayData && hudOf()}>
          {(h) => <Hud3D nametags={h().nametags()} onWords={(w) => { hudWords = { data: rawData(), w }; h().setWords(w); schedule(); }} />}
        </Show>
        <Show when={showFps}>
          <div class="absolute right-1 top-1 rounded bg-black/60 px-1.5 font-mono text-[11px] text-white" data-fps>{fpsText()}</div>
        </Show>
        {props.corner}
        <Show when={trackPending() && warm()}>
          <div class="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[11px] text-white" data-track-pending>
            Preparing this replay's effects…
          </div>
        </Show>
      </GameFrame>
      <Show when={!MINI}><Controls /></Show>
    </div>
  );
}

// Fox's and Falco's reflector, the game's own three models at the hip: the
// flash as it comes out, the hexagon while it is up, the flash of a reflect.
// Without the effect file: a bubble in the reflector's blue. The game's
// effect is on the hip (a position constraint, its size the fighter's:
// efLib_Create_Attach_Scale) and drawn with no depth test (its lifetimes have
// a tenths digit: prop.ts effectOverAll), so it covers the fighter.
function drawReflector(r: Renderer, ek: EffectKit | undefined, a: Actor, sh: { start: number; loop: number; hit: number }) {
  const at = a.hip ?? [a.st.xPosition, a.st.yPosition + 6.5, 0];
  const k = a.scale ?? 1;
  const rf = ek?.reflector;
  if (!rf) {
    if (sh.loop >= 0 || sh.start >= 0 || sh.hit >= 0) {
      r.drawSphere(at, 7.5, [0.3, 0.75, 1.0], 0.6);
      r.drawSphere(at, 4, [0.92, 0.98, 1.0], 0.55);
    }
    return;
  }
  const show = (pr: typeof rf.loop, t: number, loop: boolean) => {
    // a frame into its animation on the frame it is made (efLib_Update runs
    // it once that frame, after the fighter made it: the hexagon's pulse, as
    // Dolphin shows it, is a frame ahead of its age)
    pr.pose(t + 1, at[0], at[1], at[2], k, 0, loop);
    r.drawSkeleton(pr.skeleton, "opa");
    r.drawSkeleton(pr.skeleton, "xlu");
    r.endPass();
  };
  if (sh.loop >= 0) show(rf.loop, sh.loop, true);
  if (sh.start >= 0) show(rf.start, sh.start, false);
  if (sh.hit >= 0) show(rf.hit, sh.hit, false);
}

// The stand under a fighter entering the match (PlCo's entry 16), at its
// scale, its height alone the share the entry has reached
// (HSD_JObjSetScale(accessory, {s, s*t, s})); where the fighter is, set back
// by its gap (the Ice Climbers'), turned the way it faces
function drawStand(r: Renderer, stand: Prop, st: PlayerState, scale: number, share: number, gap: number) {
  const f = st.facingDirection < 0 ? -1 : 1;
  stand.poseScaled(st.xPosition - f * gap, st.yPosition, 0, [scale, scale * share, scale], f * Math.PI / 2);
  r.drawSkeleton(stand.skeleton, "opa");
  r.drawSkeleton(stand.skeleton, "xlu");
  r.endPass();
}

/** how many frames a fighter has been in its present state (0 on the frame
 *  it began), from the replay: the entry's states keep no count of their own */
function stateAge(data: ReplayData, fno: number, player: number, nana: boolean): number {
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  const s = at(fno)?.actionStateId;
  let g = fno;
  while (g > 0 && fno - g < 600 && at(g - 1)?.actionStateId === s) g--;
  return fno - g;
}

// The angel platform under a fighter coming back after a lost stock, at its
// own animation (it loops), sized for the fighter; without PlCo.dat a pale
// disc.
function drawPlatform(r: Renderer, ek: EffectKit | undefined, a: Actor, frame: number) {
  const pl = ek?.platform;
  if (!pl) {
    r.drawSphere([a.st.xPosition, a.st.yPosition - 0.6, 0], 7, [0.85, 0.95, 1.0], 0.75);
    return;
  }
  pl.pose(frame, a.st.xPosition, a.st.yPosition, 0, a.platform ?? 1, 0, true);
  r.drawSkeleton(pl.skeleton, "opa");
  r.drawSkeleton(pl.skeleton, "xlu");
  r.endPass();
}

// Yoshi's Story's Shy Guys: the stage file's own Shy Guy (a card whose
// texture animation is it flying) where the replay says each one is, facing
// the way it flies
function drawShyGuys(r: Renderer, sg: { prop: Prop; scale: number }, data: ReplayData, items: ReplayItem[], frame: number) {
  for (const it of items) {
    if (it.typeId !== SHY_GUY) continue;
    sg.prop.pose(shyGuyClock(data, frame, it), it.xPosition, it.yPosition, 2, sg.scale, it.facingDirection < 0 ? Math.PI : 0, true);
    r.drawSkeleton(sg.prop.skeleton, "opa");
    r.drawSkeleton(sg.prop.skeleton, "xlu");
    r.endPass();
  }
}

// The fighters' projectiles the replay has (its items): each its owner's own
// article (its fighter file's model and the animation of the item's state),
// turned as the game turns it. Replay item id -> article index.
// (`held`: the states it is held in, each by the joint of its holder it is
// tied to - a part of every fighter's, by number, "item", the joint the
// fighter holds items by, or { joint }, one its code names by number; `ownerSize`: sized as its owner is; `gone`: states
// its model is hidden in)
const LTHUMB = 31, RTHUMB = 49;
type HeldBy = number | "item" | { joint: number };
/** held on this joint in all its states */
const heldAll = (by: HeldBy): Record<number, HeldBy> => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, by]));
const HOOK_HELD = heldAll(RTHUMB);
const ARTICLES: Record<number, { art: number; tilt?: boolean | "z"; charge?: boolean; joint?: number; from?: Record<number, number>;
                                 held?: Record<number, HeldBy>; ownerSize?: boolean; gone?: number[];
                                 trail?: { state: number; at: number[] };
                                 /** held still at a frame of its animation its owner's state says */
                                 still?: (ownerState: number) => number | null;
                                 /** posed once at its color's frame and held there (pillColor) */
                                 colorPick?: boolean;
                                 /** hidden once it has been in this state as long as its special
                                  *  attribute at this offset says (its life: it_80275158), though
                                  *  the replay keeps it on a while more */
                                 lifeIn?: { state: number; attr: number };
                                 /** shown only between these frames of its animation, by state
                                  *  (its code hides and shows it as the frame passes them) */
                                 shownIn?: Record<number, [number, number]> }> = {
  0x30: { art: 0 },                // Mario's fireball
  0x31: { art: 1, colorPick: true }, // Dr. Mario's pill (his article 1: ftdrmario.c)
  0x36: { art: 0 },                // Fox's laser
  0x37: { art: 0 },                // Falco's laser
  // Fox's and Falco's blasters, held in the hand (on the right thumb's joint) in all their states
  0x4a: { art: 1, held: heldAll(RTHUMB) },
  0x4b: { art: 1, held: heldAll(RTHUMB) },
  0x4f: { art: 0, tilt: true },    // Sheik's needles, thrown
  0x59: { art: 1 },                // Pikachu's Thunder Jolt (his articles 1 and 2: ftpikachu.c)
  0x5a: { art: 2 },
  0x5b: { art: 1 },                // Pichu's, the same way
  0x5c: { art: 2 },
  0x56: { art: 0, gone: [2] },     // Yoshi's egg, thrown (state 2: broken, its pieces are effects)
  0x5d: { art: 0, gone: [3] },     // Samus's bomb (state 3: going off)
  0x5e: { art: 1, charge: true },  // Samus's charge shot
  0x5f: { art: 2, tilt: true, gone: [2, 3] }, // Samus's missile (states 2 and 3: bursting)
  0x63: { art: 1 },                // Peach's turnip
  // Peach's parasol: the game ties it to her joint 109 (ftpeachspecialhi.c
  // hands the joint list's 109th straight to Item_AttachToParent), so it
  // swings with her hand
  // (taken up, it starts its state 2 a step of 16 frames in: its pickup sets
  // that speed, steps it, then plays on at 1 - itpeachparasol.c)
  0x67: { art: 2, joint: 109, from: { 2: 16 } },
  0x69: { art: 0 },                // Luigi's fireball
  // Mewtwo's Shadow Ball (his article 1: ftmewtwo.c), held at his right
  // shoulder while it grows (joint 35, which his code names by number), and
  // Disable (article 0). States 10 to 17: the ball bursting, at each charge (item-effects.ts)
  0x70: { art: 1, held: { 0: { joint: 35 } }, gone: [10, 11, 12, 13, 14, 15, 16, 17] },
  0x6e: { art: 0 },
  // Mr. Game & Watch's props (his articles 0 to 9: ftgamewatch.c), each tied
  // to his joint for as long as it lasts (Item_AttachGameWatchArticle; the
  // joints his code names by number): the greenhouse, the manhole and Fire's
  // torch in his left hand (32), the parachute on his TransN (1), the turtle
  // on his left shoulder (17), the breath at his left hand (21), Judge's
  // hammer in his right thumb, the bucket's oil and Fire's trampoline on his
  // root (0); Chef's sausages fly free
  0x72: { art: 0, held: heldAll({ joint: 32 }) },
  0x73: { art: 1, held: heldAll({ joint: 32 }) },
  0x74: { art: 2, held: heldAll({ joint: 32 }) },
  // (the parachute: its pickup steps its animation once more as it is made -
  // itGameWatchParachute_Logic74_PickedUp, Item_802694CC - so it runs a frame ahead)
  0x75: { art: 3, held: heldAll({ joint: 1 }), from: { 0: 1 } },
  0x76: { art: 4, held: heldAll({ joint: 17 }) },
  0x77: { art: 5, held: heldAll({ joint: 21 }) },
  // (Judge: its number the frame of its animation it is held still at -
  // it_80273670 with the number, 1 to 9, which his side-B's state says:
  // SpecialS1..9 355..363, in the air 364..372)
  0x78: { art: 6, held: heldAll(RTHUMB), still: (s) => (s >= 355 && s <= 372 ? ((s - 355) % 9) + 1 : null) },
  0x79: { art: 7, held: heldAll({ joint: 0 }) },
  0x7a: { art: 8 },
  0x7c: { art: 9, held: heldAll({ joint: 0 }) },
  // Ness's (his articles: ftness.c): PK Fire and its pillar, PK Flash and its
  // explosion, PK Thunder's ball and its four trails
  0x42: { art: 0, tilt: true },
  0x43: { art: 1 },
  0x44: { art: 2 },
  0x4e: { art: 8 },
  0x45: { art: 3 },
  0x46: { art: 4 }, 0x47: { art: 5 }, 0x48: { art: 6 }, 0x49: { art: 7 },
  // the bat and the yo-yo, in his hand (his joint 42, by number:
  // ftnessattacks4.c, itnessyoyo.c)
  0x65: { art: 9, held: { 0: { joint: 42 } } },
  0x66: { art: 10, held: { 0: { joint: 42 }, 1: { joint: 42 }, 2: { joint: 42 }, 3: { joint: 42 } } },
  // Link's and Young Link's (their articles 0 to 4: ftlink.c, ftclink.c):
  // the bomb, held where he holds items as it is pulled; gone as it goes
  // off (itlinkbomb.c: state 5 hides it)
  0x3a: { art: 0, held: { 0: "item" }, gone: [5] },
  0x3b: { art: 0, held: { 0: "item" }, gone: [5] },
  // the boomerang, in his left thumb until it goes (ftlinkspecials.c)
  0x3c: { art: 1, held: { 0: LTHUMB, 1: LTHUMB } },
  0x3d: { art: 1, held: { 0: LTHUMB, 1: LTHUMB } },
  // the hookshot's grip, in his right thumb in all its states (itlinkhookshot.c: held
  // from when it is made; its place in the replay stays where it was made)
  0x3e: { art: 2, held: HOOK_HELD },
  0x3f: { art: 2, held: HOOK_HELD },
  // an arrow: in his left thumb while drawn, then along the way it flies,
  // and stuck at the angle it hit at (itlinkarrow.c: turned about the
  // picture's plane by the angle above the way it faces); his size. Stuck,
  // it goes when its life (its attributes +0x18) runs out, hidden for the
  // 300 frames the game keeps it after (itLinkarrow_UnkMotion4_Anim)
  0x40: { art: 3, tilt: "z", held: { 0: LTHUMB }, ownerSize: true, trail: { state: 1, at: [0x24, 0x28] }, lifeIn: { state: 4, attr: 0x18 } },
  0x41: { art: 3, tilt: "z", held: { 0: LTHUMB }, ownerSize: true, trail: { state: 1, at: [0x24, 0x28] }, lifeIn: { state: 4, attr: 0x18 } },
  // the bow, in his right thumb, its states his move's (itlinkbow.c)
  0x4c: { art: 4, held: { 0: RTHUMB, 1: RTHUMB, 2: RTHUMB, 3: RTHUMB, 4: RTHUMB, 5: RTHUMB }, ownerSize: true },
  0x4d: { art: 4, held: { 0: RTHUMB, 1: RTHUMB, 2: RTHUMB, 3: RTHUMB, 4: RTHUMB, 5: RTHUMB }, ownerSize: true },
  0x6a: { art: 0 },                // the Ice Climbers' ice
  // Kirby's (his articles: ftkirby.c): Final Cutter's wave, and the hammer,
  // in the hand his code names by number (44) while he swings it
  // (ftkirbyspecials.c, itkirbyhammer.c). His copies' projectiles are the
  // copies' own articles, drawn as the originals are (kirby.ts KIRBY_ITEMS)
  0x32: { art: 0 },
  0x33: { art: 1, held: heldAll({ joint: 44 }) },
  // Peach's Toad, on her joint 109 as the parasol is (ftpeachspecialn.c), and
  // its spores; Sheik's needles held in her hand (her joint 23:
  // ftseakspecialn.c); Yoshi's egg around the one he swallowed (his article 2)
  // (Toad: in the stance shown from its animation's frame 7 to 53; struck,
  // its counter's animation begins 10 frames in - he is out already - and he
  // goes at 60: itpeachtoad.c)
  0x68: { art: 3, held: heldAll({ joint: 109 }), from: { 1: 10 }, shownIn: { 0: [7, 53], 1: [0, 60] } },
  0x6f: { art: 4 },
  0x50: { art: 1, held: heldAll({ joint: 23 }) },
  0x57: { art: 2 },
};
type ReplayItem = NonNullable<ReplayData["frames"][number]["items"]>[number];

// A Shy Guy's animation is its own (itheiho.c): set from its start when it
// begins to fly (state 1, it_802D8918) or flees (state 4, at twice the rate:
// itHeiho_UnkMotion4_Anim), from the start again when it ends (256 frames:
// it_80272C6C), and each time it lands on a floor (itHeiho_UnkMotion1_Coll:
// it_8026DA70) - the frame the replay has its speed across as 0, its speed
// being recomputed from its bone that frame (it_802D98C4); in the states
// without an animation (0, 2, 3) it holds where it was. Stepped frame by frame
// from the last one it was asked for (a seek walks it again from the item's
// first frame).
const SHY_FLY = new Set([1, 4]);
const shyClocks = new WeakMap<ReplayData, Map<number, { at: number; state: number; t: number }>>();
function shyGuyClock(data: ReplayData, frame: number, it: ReplayItem): number {
  let clocks = shyClocks.get(data);
  if (!clocks) shyClocks.set(data, (clocks = new Map()));
  let c = clocks.get(it.spawnId);
  if (!c || c.at > frame || frame - c.at > 1) {
    let f = frame;
    while (f > 0 && data.frames[f - 1]?.items?.some((q) => q.spawnId === it.spawnId)) f--;
    c = { at: f - 1, state: -1, t: 0 };
    clocks.set(it.spawnId, c);
  }
  for (let f = c.at + 1; f <= frame; f++) {
    const q = f === frame ? it : data.frames[f]?.items?.find((x) => x.spawnId === it.spawnId);
    if (!q) continue;
    const rate = q.state === 4 ? 2 : 1;
    if (q.state !== c.state) { if (SHY_FLY.has(q.state)) c.t = 0; }
    else if (SHY_FLY.has(q.state)) {
      if (Math.abs(q.xVelocity) < 1e-6) c.t = 0;
      else { c.t += rate; if (c.t >= 256) c.t = 0; }
    }
    c.state = q.state;
    c.at = f;
  }
  return c.t;
}
// Kirby's hats on the last frame drawn (the checks read them)
let drawnKirbyHats: { player: number; kind: number; loaded: boolean }[] = [];
// the articles hung on a fighter on the last frame drawn (the checks read them)
let drawnArticles: Record<string, unknown>[] = [];

/** how long an item has been in its state: back through the frames while
 *  the same item (its spawn id) is in it */
/** how long an item has been in the game (its frames since it was made, whatever its state) */
function itemLife(data: ReplayData, frame: number, it: ReplayItem): number {
  let f = frame;
  while (f > 0 && frame - f < 600 && data.frames[f - 1]?.items?.some((q) => q.spawnId === it.spawnId)) f--;
  return frame - f;
}

// PK Flash's charge: a frame more each frame it flies held (its state 0), up
// to its attributes' +0x4; the flash is sized by it as it grows, and its
// explosion by what it reached (itnesspkflash.c, itnesspkflashexplode.c:
// size = charge x (growth - initial) / the most + initial)
const PK_FLASH = new Set([0x44, 0x91]), PK_FLASH_EXPLODE = new Set([0x4e, 0x92]);
function pkCharge(data: ReplayData, frame: number, spawnId: number): number {
  let n = 0;
  for (let f = frame; f >= 0 && frame - f < 600; f--) {
    const q = data.frames[f]?.items?.find((x) => x.spawnId === spawnId);
    if (!q) break;
    if (q.state === 0) n++;
  }
  return n;
}
/** the scale PK Flash or its explosion is drawn at, or null for neither */
function pkFlashScale(data: ReplayData, frame: number, it: ReplayItem, special: ((o: number) => number) | null | undefined): number | null {
  if (!special) return null;
  if (PK_FLASH.has(it.typeId)) {
    const most = special(0x4), c = Math.min(most, pkCharge(data, frame, it.spawnId));
    return most > 0 ? c * (special(0xc) - special(0x8)) / most + special(0x8) : null;
  }
  if (!PK_FLASH_EXPLODE.has(it.typeId)) return null;
  // (its flash: its owner's, gone as the explosion is made)
  let born = frame;
  while (born > 0 && data.frames[born - 1]?.items?.some((q) => q.spawnId === it.spawnId)) born--;
  const flash = data.frames[born - 1]?.items?.find((q) => PK_FLASH.has(q.typeId) && q.owner === it.owner &&
    !data.frames[born]?.items?.some((x) => x.spawnId === q.spawnId));
  const most = special(0x0);
  if (!flash || most <= 0) return null;
  const c = Math.min(most, pkCharge(data, born - 1, flash.spawnId));
  return c * (special(0x8) - special(0x4)) / most + special(0x4);
}

function itemAge(data: ReplayData, frame: number, it: ReplayItem): number {
  let f = frame;
  while (f > 0 && frame - f < 600) {
    const prev = data.frames[f - 1]?.items?.find((q) => q.spawnId === it.spawnId);
    if (!prev || prev.state !== it.state) break;
    f--;
  }
  return frame - f;
}

/** an item's animation clock in its state: its frames in it less those it
 *  stood still in its own hitlag (itemlag.ts) */
// A pill's colors: its animation is set once, at the frame of its colors, and
// taken off (itDrMarioPill_Spawn: it_80273670 at the pick, then
// HSD_JObjRemoveAnimAll), so it keeps them; the pick is one of 9 at random,
// never either of its thrower's two before (ftMr_SpecialN_VitaminRandom,
// ftkirbyspecialmario.c). The replay does not say which: a stand-in, the
// same rule over each thrower's pills in the order they come
const pillPicks = new WeakMap<ReplayData, Map<number, number>>();
function pillColor(data: ReplayData, it: ReplayItem): number {
  let m = pillPicks.get(data);
  if (!m) {
    m = new Map();
    const last = new Map<number, [number, number]>();
    for (const fr of data.frames) {
      for (const q of fr?.items ?? []) {
        if (m.has(q.spawnId) || !articleEntry(q.typeId)?.colorPick) continue;
        const [a, b] = last.get(q.owner) ?? [-1, -1];
        const cands = Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== a && i !== b);
        const pick = cands[(Math.imul(q.spawnId + 1, 2654435761) >>> 0) % cands.length];
        m.set(q.spawnId, pick);
        last.set(q.owner, [pick, a]);
      }
    }
    pillPicks.set(data, m);
  }
  return m.get(it.spawnId) ?? 0;
}

function itemAnimAge(data: ReplayData, frame: number, it: ReplayItem): number {
  if (articleEntry(it.typeId)?.colorPick) return pillColor(data, it);
  // (Samus's bomb: by its fuse, its animation going on through its rolling, falling and resting: item-facing.ts)
  if (it.typeId === 0x5d && it.state < 3) return samusBombClocks(data, frame, it, Infinity, 1).material;
  return itemAnimation(data, frame, it).age;
}

function ownerOf(data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number): Fighter | null {
  const p = it.owner < 0 ? undefined : data.frames[frame]?.players[it.owner];
  if (!p) return null;
  const costume = data.settings.playerSettings[it.owner]?.costumeIndex ?? 0;
  return fs.get(`${p.state.internalCharacterId}:${costume}`) ?? null;
}

/** the fighter whose article an item is: the one that made it, though another owns it now (a reflected missile:
 *  item-source.ts), else its owner */
function articleFighter(data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number): Fighter | null {
  const source = itemSource(data, it);
  return (source ? fs.get(`${source.character}:${source.costume}`) : null) ?? ownerOf(data, fs, it, frame);
}

// Kirby's copies' data files, as they load (their projectiles' articles)
const kirbyCopies = new Map<number, KirbyCopy | null>();

/** how an item is drawn: its own entry, or for Kirby's copy of a projectile
 *  the original's, held where his code holds it */
function articleEntry(typeId: number): (typeof ARTICLES)[number] | undefined {
  const k = KIRBY_ITEMS[typeId];
  if (!k) return ARTICLES[typeId];
  // (one with no original to be drawn as: its own article, held as it says)
  const like = k.like === undefined ? { art: 0 } : ARTICLES[k.like];
  return like && { ...like, held: k.held ?? like.held };
}

/** the element of an item's hitbox in its state (a fighter's article: its
 *  state's script), or null when not known */
function itemElement(data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number): number | null {
  const a = KIRBY_ITEMS[it.typeId] ? undefined : ARTICLES[it.typeId];
  if (!a) return null;
  return articleFighter(data, fs, it, frame)?.articleElement(a.art, itemAnimationIndex(it.typeId, it.state)) ?? null;
}

function articleOf(data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number) {
  // (the animation its state plays, which is not its state's number: item-animation.ts)
  const animation = itemAnimation(data, frame, it).index;
  // (a common item - one pulled from the ground, a stage's: ItCo.dat's own)
  if (it.typeId <= COMMON_ITEM_LAST) return commonItemArts?.article(it.typeId, animation) ?? null;
  const k = KIRBY_ITEMS[it.typeId];
  if (k) return kirbyCopies.get(k.kind)?.article(k.slot, animation) ?? null;
  // (which of its owner's articles the game made it with, when the viewer track says)
  const said = trackArticles.get(data)?.get(it.typeId);
  if (said !== undefined) return articleFighter(data, fs, it, frame)?.article(said, animation) ?? null;
  const a = ARTICLES[it.typeId];
  if (!a) return null;
  return articleFighter(data, fs, it, frame)?.article(a.art, animation) ?? null;
}

/** a list's median, 90th and 99th percentile and its largest (the harness's) */
function quantiles(v: number[]): [number, number, number, number] | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (x: number) => +s[Math.min(s.length - 1, Math.floor(x * s.length))].toFixed(2);
  return [q(0.5), q(0.9), q(0.99), +s[s.length - 1].toFixed(2)];
}

/** the common items' articles, once a replay has one (files.commonItems) */
let commonItemArts: files.CommonItems | null = null;
const COMMON_ITEM_LAST = 0x2a;

/** the learned effects (effect-table.json, optional), read once a page */
interface Learned { at: Map<string, LearnedFx[]>; byGfx: Map<number, LearnedPiece[]> }
function loadLearned(): Promise<Learned | null> {
  const shared = pageCache<Promise<Learned | null>>("learnedFx");
  let p = shared.get("table");
  if (!p) {
    p = files.effectTable()
      .then((j) => (j?.table ? {
        at: new Map(Object.entries(j.table) as [string, LearnedFx[]][]),
        byGfx: new Map(Object.entries(j.byGfx ?? {}).map(([k, v]) => [Number(k), v as LearnedPiece[]])),
      } : null))
      .catch(() => null);
    shared.set("table", p);
  }
  return p;
}

/** each replay's item kinds and its owner's article each is made with, from
 *  its viewer track ("art": [frame, "art", kind, character, index], the
 *  index into the fighter's ftData item list, -1 for none of them) */
const trackArticles = new WeakMap<ReplayData, Map<number, number>>();

/** a fighter's swinging joints as the track has them ("fp": by part, rot, scale, translate) laid on its
 *  pose; whether any was */
function layTrackSwing(fi: Fighter, char: number, joints: Map<number, Float32Array>, all: boolean): boolean {
  const sk = fi.skeleton;
  let laid = false;
  for (const [part, v] of joints) {
    const j = partToModelJoint(char, part);
    if (j < 0 || j >= sk.n) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isNaN(v[k])) sk.rot[j * 3 + k] = v[k];
      if (all && !Number.isNaN(v[3 + k])) sk.scale[j * 3 + k] = v[3 + k];
      if (all && !Number.isNaN(v[6 + k])) sk.trans[j * 3 + k] = v[6 + k];
    }
    laid = true;
  }
  return laid;
}
function useTrackArticles(data: ReplayData, tr: ViewerTrack | null) {
  const out = new Map<number, number>();
  for (const e of tr?.between("art", -1e9, 1e9) ?? []) {
    const kind = Number(e[2]), index = Number(e[4]);
    if (index >= 0) out.set(kind, index);
  }
  trackArticles.set(data, out);
}

// The grapple beam's glow: the beam item's own model, at the hand until it is fired and then at the head, pulsing
// by its animation at the special attributes' +0xA4 (itsamusgrapple.c), made with the beam. The chains' links
// themselves are drawn from the track's "lm" (drawTrackChain).
const CHAINS: Record<number, { art: number; itemType?: number; glowAnim?: number }> = {
  13: { art: 3, itemType: 0x60, glowAnim: 0xa4 },
};

// A chain's links as the item's code made them (itlinkhookshot.c, itseakchain.c, itnessyoyo.c,
// itclimbersstring.c): link i of n from the chain's start, each its own model - a link model of the item's
// special attributes (the hookshot's two in turn by i), drawn only while it is out (it_802A24A0), and the
// last, the end with no prev (the hookshot's head, Sheik's handle, the yo-yo, the belay's end), its own
// model, always drawn. The track's link 0 is that end. By the owner's character: its article, the link
// models' attribute offsets, the end's.
const TRACK_CHAINS: Record<number, { art: number; link: (i: number) => number; end: number;
                                      linkAnim?: (i: number) => number; endAnim?: number }> = {
  6: { art: 2, link: (i) => (i % 2 ? 0x54 : 0x58), end: 0x5c },
  20: { art: 2, link: (i) => (i % 2 ? 0x54 : 0x58), end: 0x5c },
  7: { art: -1, link: () => 0x64, end: 0x68 },
  8: { art: 10, link: () => 0x50, end: 0x54 },
  // (the grapple's links: three models in turn by i, each with its own animation (+0x74, +0x80, +0x8C), and
  // the claw (+0x70) with its own (+0x98), from when the item is made: itsamusgrapple.c it_802B743C)
  13: { art: 3, link: (i) => [0x64, 0x68, 0x6c][i % 3], end: 0x70, linkAnim: (i) => [0x74, 0x80, 0x8c][i % 3],
        endAnim: 0x98 },
  10: { art: -1, link: () => 0x24, end: 0x28 },
  11: { art: -1, link: () => 0x24, end: 0x28 },
};
const trackLinkMtx = new Float32Array(16);

function drawTrackChain(r: Renderer, f: Fighter, it: ReplayItem, links: TrackPose, said: number | undefined,
                        age: number, pass: "opa" | "xlu") {
  const c = TRACK_CHAINS[f.internalId];
  if (!c) return;
  const art = said ?? c.art;
  if (art < 0) return;
  const n = links.links;
  for (const [k, v] of links.joints) {
    const out = links.out?.get(k) ?? 0;
    const i = n - 1 - k;
    // (the end is drawn whatever its flag says - all but the grapple's claw, whose x2C_b0 it_802B743C
    // clears and sets as it does the links')
    if ((k !== 0 || f.internalId === 13) && !out) continue;
    if (v.some(Number.isNaN)) continue;
    const anim = k === 0 ? c.endAnim : c.linkAnim?.(i);
    const off = k === 0 ? c.end : c.link(i);
    const p = anim !== undefined ? f.articleAnimated(art, off, anim) : f.articleModel(art, off);
    if (!p) continue;
    // (rows 0-2 of the 3x4, as the renderer's column-major 4x4)
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) trackLinkMtx[col * 4 + row] = v[row * 4 + col];
    trackLinkMtx[3] = trackLinkMtx[7] = trackLinkMtx[11] = 0;
    trackLinkMtx[15] = 1;
    if (anim !== undefined) p.poseMatrix(trackLinkMtx, age);
    else p.poseMatrix(trackLinkMtx);
    r.drawSkeletonTrsp(p.skeleton, TRSP[pass]);
  }
  void it;
  r.endPass();
}

/** the game's passes a chain's two kinds of draw take: Camera_800311EC's two calls draw its opaque and cut-out
 *  meshes (HSD_TRSP_OPA, TEXEDGE), Camera_80031328 its see-through ones (XLU) */
const TRSP = { opa: 1 | 4, xlu: 2 } as const;

/** the way an item last flew, back through its frames while it was the same
 *  item (an arrow stuck where it hit keeps its angle), or null */
function lastFlight(data: ReplayData, frame: number, it: ReplayItem): [number, number] | null {
  for (let f = frame; f > 0 && frame - f < 600; f--) {
    const q = data.frames[f]?.items?.find((x) => x.spawnId === it.spawnId);
    if (!q) break;
    if (q.xVelocity || q.yVelocity) return [q.xVelocity, q.yVelocity];
  }
  return null;
}

const PLAIN_ARTICLE: (typeof ARTICLES)[number] = { art: 0 };
// the items whose look is a rope of links their code moves (the hookshots,
// the grapple beam, the yo-yo, Sheik's chain, the Ice Climbers' rope: drawn
// as chains from the track's "lm" where it has them): never drawn plainly as
// their model
const ROPES = new Set([62, 63, 96, 97, 102, 113]);

/** an item drawn with its joints as the viewer track has them ("jp", when it does: `poseOf`), else as its
 *  animation has them; the pose is the item's own, so it is taken off its model again after */
function drawArticleTracked(r: Renderer, data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number,
                            jointOf?: (owner: number, joint: number) => Float32Array | null,
                            partJoint?: (owner: number, part: number) => number,
                            turnOf?: (spawnId: number) => number[] | null,
                            shakeOf?: (owner: number) => [number, number] | undefined,
                            poseOf?: (spawnId: number) => Map<number, Float32Array> | null): boolean {
  const joints = poseOf?.(it.spawnId) ?? null;
  const art = joints ? articleOf(data, fs, it, frame) : null;
  if (art) art.prop.trackPose = joints;
  try {
    return drawArticle(r, data, fs, it, frame, jointOf, partJoint, turnOf, shakeOf);
  } finally {
    if (art) art.prop.trackPose = null;
  }
}

function drawArticle(r: Renderer, data: ReplayData, fs: Map<string, Fighter>, it: ReplayItem, frame: number,
                     jointOf?: (owner: number, joint: number) => Float32Array | null,
                     partJoint?: (owner: number, part: number) => number,
                     turnOf?: (spawnId: number) => number[] | null,
                     shakeOf?: (owner: number) => [number, number] | undefined): boolean {
  // (an item with no entry of its own - one the track or the common items'
  // file names - drawn plainly where it is, as its model's state animates it)
  if (!articleEntry(it.typeId) && ROPES.has(it.typeId)) return false;
  const a = articleEntry(it.typeId) ?? PLAIN_ARTICLE;
  const art = articleOf(data, fs, it, frame);
  if (!art || a.gone?.includes(it.state)) return false;
  if (a.lifeIn?.state === it.state && art.special && itemAge(data, frame, it) >= art.special(a.lifeIn.attr)) return false;
  const win = a.shownIn?.[it.state];
  if (win) {
    const t = itemAnimAge(data, frame, it) + (a.from?.[it.state] ?? 0);
    if (t < win[0] || t >= win[1]) return false;
  }
  const owner = a.ownerSize || a.held ? ownerOf(data, fs, it, frame) : null;
  // one the game hangs on its owner's joint: under that joint
  const by = a.held?.[it.state];
  const joint = a.joint ?? (by === "item" ? owner?.itemJoint : typeof by === "object" ? by.joint
    : by !== undefined ? partJoint?.(it.owner, by) : undefined);
  const on = joint !== undefined && joint >= 0 ? jointOf?.(it.owner, joint) ?? null : null;
  const size = a.ownerSize && owner ? owner.modelScale : art.scale;
  const ownerState = data.frames[frame]?.players[it.owner]?.state.actionStateId ?? -1;
  const still = a.still?.(ownerState) ?? null;
  // (Shadow Ball's size by its charge, set after its pose: shadow-ball.ts. The most charge is in its maker's
  // special attributes, Kirby's copy's at +0x384; its smallest and largest size in the ball's)
  const shadowOwner = isShadowBall(it.typeId) ? articleFighter(data, fs, it, frame) : null;
  let shadowScale: number | null = null;
  if (shadowOwner && art.special) {
    const most = shadowOwner.specialAttr(it.typeId === 0x90 ? 0x384 : 0);
    shadowScale = shadowBallScale(it.state, it.chargeShotChargeLevel, most, art.special(0x18), art.special(0x1c));
  }
  if (on) {
    art.prop.poseUnder(still ?? itemAnimAge(data, frame, it) + (a.from?.[it.state] ?? 0), on, size, false, art.attach);
    // (held: its place kept against Mewtwo's hand at his size)
    if (shadowScale !== null) art.prop.setGrandchildScale(shadowScale, shadowOwner?.modelScale);
    const w = art.prop.skeleton.world;
    drawnArticles.push({ type: it.typeId, state: it.state, x: w[12], y: w[13], z: w[14], scale: Math.hypot(w[0], w[1], w[2]),
                         joints: art.prop.skeleton.n, shown: Array.from(art.prop.skeleton.shown), replay: [it.xPosition, it.yPosition],
                         attach: art.attach, age: itemAge(data, frame, it),
                         on: [on[12], on[13], on[14]], owner: data.frames[frame]?.players[it.owner]?.state
                           ? [data.frames[frame].players[it.owner]!.state.xPosition, data.frames[frame].players[it.owner]!.state.yPosition,
                              data.frames[frame].players[it.owner]!.state.actionStateId] : null });
    // (held, it shakes with its holder: itdraw.c draws it with the holder's shake)
    const sh = shakeOf?.(it.owner);
    if (sh) r.shiftDraws(sh[0], sh[1]);
    drawProp(r, art);
    if (sh) r.shiftDraws(0, 0);
    return true;
  }
  const facing = it.facingDirection < 0 ? -1 : 1;
  let scale = size;
  const pk = pkFlashScale(data, frame, it, art.special);
  if (pk !== null && pk > 0) scale *= pk;
  // the charge shot grows with its charge (itsamuschargeshot: between its
  // attributes' +0x18 and +0x1C)
  if (a.charge && art.special) {
    const lo = art.special(0x18), hi = art.special(0x1c);
    if (lo > 0 && hi > 0 && hi < 50) scale *= lo + (hi - lo) * Math.min(1, it.chargeShotChargeLevel / 7);
  }
  // a needle (or missile) tilts along the way it flies
  const way = a.tilt ? (it.xVelocity || it.yVelocity ? [it.xVelocity, it.yVelocity] : lastFlight(data, frame, it)) : null;
  const along = (w: number[] | null) => !w ? 0 : a.tilt === "z" ? facing * Math.atan2(w[1], w[0] * facing)
    : -facing * Math.atan2(w[1], w[0]);
  const tilt = along(way);
  // an arrow in flight: its trail, two models of its own (its special
  // attributes +0x24, +0x28) where it was one and two frames before, turned
  // as it was then (itlinkarrow.c)
  if (a.trail && it.state === a.trail.state && owner) {
    a.trail.at.forEach((off, i) => {
      const q = data.frames[frame - 1 - i]?.items?.find((x) => x.spawnId === it.spawnId);
      const pr = art.modelAt ? art.modelAt(off) : owner.articleModel(a.art, off);
      if (!q || !pr || q.state !== it.state) return;
      const t = q.xVelocity || q.yVelocity ? along([q.xVelocity, q.yVelocity]) : tilt;
      pr.pose(0, q.xPosition, q.yPosition, -0.02, scale, facing * Math.PI / 2, true, t, 0);
      r.drawSkeleton(pr.skeleton, "opa");
      r.drawSkeleton(pr.skeleton, "xlu");
    });
  }
  const byZ = a.tilt === "z";
  // (Samus's bomb: the way it last rolled, and its joints' faster clock near the end of its fuse, from its
  // special attributes +4 and +8: item-facing.ts)
  const bomb = it.typeId === 0x5d;
  const rotationY = bomb ? samusBombRotation(data, frame, it) : facing * Math.PI / 2;
  const clock = bomb && art.special ? samusBombClocks(data, frame, it, art.special(4), art.special(8)) : null;
  // a thrown item's turn, as the game has it (the viewer track's: a
  // tumbling bomb), else the way it faces and flies
  const turn = a.tilt ? null : turnOf?.(it.spawnId) ?? null;
  if (turn) {
    art.prop.pose(itemAnimAge(data, frame, it), it.xPosition, it.yPosition, 0, scale, turn[1], true, turn[2], turn[0], false,
                  clock?.joint);
  }
  else {
    art.prop.pose(itemAnimAge(data, frame, it), it.xPosition, it.yPosition, 0, scale, rotationY, true, byZ ? tilt : 0,
                  byZ ? 0 : tilt, false, clock?.joint);
  }
  if (shadowScale !== null) art.prop.setGrandchildScale(shadowScale);
  drawnArticles.push({ type: it.typeId, state: it.state, x: it.xPosition, y: it.yPosition, tilt, scale,
                       shown: Array.from(art.prop.skeleton.shown) });
  drawProp(r, art);
  return true;
}

/** an article, posed: with its outline first when it has one (Mr. Game &
 *  Watch's props: itdraw.c - the prop's own joints hidden and the outline's
 *  shown, in the outline's color, writing no depth; then the prop without
 *  its outline) */
function drawProp(r: Renderer, art: NonNullable<ReturnType<Fighter["article"]>>) {
  const sk = art.prop.skeleton, o = art.outline;
  if (art.color) for (const s of sk.states) s.diffuse.set(art.color);
  if (o) {
    const saved = sk.shown.slice();
    for (const j of o.main) if (!(sk.parent[j] >= 0 && saved[sk.parent[j]] === 0)) sk.setBranchShown(j, false);
    for (const j of o.shell) if (!(sk.parent[j] >= 0 && saved[sk.parent[j]] === 0)) sk.setBranchShown(j, true);
    r.setOutline(o.color);
    r.setNoDepthWrite(true);
    r.drawSkeleton(sk, "opa");
    r.drawSkeleton(sk, "xlu");
    r.setNoDepthWrite(false);
    r.setOutline(null);
    sk.shown.set(saved);
    for (const j of o.shell) sk.setBranchShown(j, false);
  }
  r.drawSkeleton(sk, "opa");
  r.drawSkeleton(sk, "xlu");
  r.endPass();
}

// A debug aid, off unless the page's address asks: ?debug=flat draws every
// effect model in flat red over every pixel its material lets through, and
// ?debug=flat:<file>.<model> only that one (0.4: the common file's model 4).
// It tells an effect drawn faintly or nowhere from one never started.
const FLAT_DEBUG: string | null = (() => {
  const d = new URLSearchParams(location.search).get("debug");
  if (!d || !d.startsWith("flat")) return null;
  return d === "flat" ? "all" : d.slice(5);
})();

/** the picture in the drawing buffer, read whole and hashed (FNV-1a) */
function pictureHash(gl: WebGL2RenderingContext): number {
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let x = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) x = Math.imul(x ^ px[i], 16777619);
  return x >>> 0;
}

// The game's effect models where the world has them, each at its own frame
function drawFxModels(r: Renderer, w: FxWorld, pose = true): number {
  const slots = new Map<number, number>();
  let n = 0;
  for (const m of w.models) {
    if (m.hidden) continue;
    const k = m.bank.id * 1000 + m.index;
    const slot = slots.get(k) ?? 0;
    slots.set(k, slot + 1);
    const pr = m.bank.prop(m.index, slot, true);
    if (!pr) continue;
    // (posed once a frame: a second pass - the main one after a mirror's - draws them as they are)
    if (pose) w.poseModel(m, pr, m.age);
    if (m.tint) {
      // the colors the game sets (efLib_SetTevKonstColor): on one material
      // only, the first mesh of the root's first child, its first texture's
      // TEV; the rest keep the file's own
      const sk = pr.skeleton;
      const child = sk.joints.find((_, i) => i > 0 && sk.parent[i] === 0);
      const d = child?.dobjs[0];
      const tc = d ? sk.states[d.index]?.tex[0]?.tevColors : undefined;
      if (tc) {
        sk.states[d!.index].dirty = true;
        tc[0] = m.tint.konst[0]; tc[1] = m.tint.konst[1]; tc[2] = m.tint.konst[2];
        tc[4] = m.tint.tev0[0]; tc[5] = m.tint.tev0[1]; tc[6] = m.tint.tev0[2];
      }
    }
    const flat = FLAT_DEBUG && (FLAT_DEBUG === "all" || FLAT_DEBUG === `${m.bank.id}.${m.index}`);
    if (flat) r.setFlat([1, 0, 0]);
    r.drawSkeleton(pr.skeleton, "opa");
    r.drawSkeleton(pr.skeleton, "xlu");
    if (flat) r.setFlat(null);
    n++;
  }
  r.endPass();
  return n;
}

// Slippi Lab's shield size (ssbwiki): the shield's health and how hard the
// trigger is held. GuardOn, Guard, GuardSetOff (shield stun), GuardReflect.
const SHIELDED = new Set([178, 179, 181, 182]);
/** how far the trigger is in, past its dead zone: 0 (the lightest) .. 1 (all the way) */
function pressed(inputs: PlayerInputs | undefined): number {
  const trigger = inputs?.processed.anyTrigger || 1;
  return Math.min(1, Math.max(0, (trigger - 0.3) / 0.7));
}
function shieldSize(st: PlayerState, inputs: PlayerInputs | undefined): number | null {
  if (!SHIELDED.has(st.actionStateId)) return null;
  const ch = actionMapByInternalId[st.internalCharacterId];
  if (!ch) return null;
  const mult = 1 - 0.5 * pressed(inputs);
  return ch.shieldSize * (((st.shieldSize * mult) / 60) * 0.85 + 0.15);
}

// The shield: the game's own bubble in the player's color; the plain sphere
// only without the effect file. Each shield state starts its own common
// effect model as it begins (ftCo_Guard.c, efasync 0x417-0x41A), played from
// there: the bubble coming up (GuardOn, and a powershield: model 11, once),
// held (Guard: model 12, over and over), and struck (GuardSetOff: model 13,
// once). The game hangs it on the fighter's shield joint (ftData+8, byte
// 0x11), scaled as that joint is: the fighter's size and shield size times
// (ftCommonData) smallest + (1 - smallest) x health share x the press's share
// (1 the lightest, 0.5 the hardest). The model is a picture of a bubble on a
// card facing the camera, drawn with no depth test (its lifetimes have a
// tenths digit: prop.ts effectOverAll), so it covers the fighter inside it
// and anything else that crosses it.
function drawShield(r: Renderer, ek: EffectKit | undefined, a: Actor, data: ReplayData, fa: ActorFrame | undefined,
                    fno: number, said?: { m: number; age: number }) {
  const st = a.st;
  let radius = shieldSize(st, a.inputs);
  if (radius === null) return;
  const ch = actionMapByInternalId[st.internalCharacterId];
  let c = [st.xPosition + ch.shieldOffset[0] * st.facingDirection, st.yPosition + ch.shieldOffset[1], 0];
  const color = hex(getPlayerColor({ replayData: data } as any, a.player, a.nana));
  // which model, and how long it has run: the track's last spawn of one when
  // it has them (its size and color stay the replay's), else from the state
  let which = SHIELD_MODELS[st.actionStateId] ?? SHIELD_MODELS[179];
  let age = 0;
  if (said) {
    which = shieldModel(ek, said.m);
    age = said.age;
  } else {
    // (from the first frame of the states it spans - the bubble coming up
    // goes on through the powershield window)
    for (let g = fno - 1; g >= 0 && age < 600; g--) {
      const p = data.frames[g]?.players[a.player];
      const q = a.nana ? p?.nanaState : p?.state;
      if (!q || !which.states.includes(q.actionStateId)) break;
      age++;
    }
  }
  // (each of the three is a frame into its animation on its first frame
  // drawn: the effect's step runs once after it is made, before the draw -
  // read from the playback Dolphin's memory, its joints' matrices and
  // hidden flags frame by frame)
  age += SHIELD_LEAD;
  // one that plays once is gone when its time is up (a shield in its stun
  // shows none after its strike's bubble)
  if (!which.loop && age >= which.life) { drawnShields.push({ player: a.player, state: st.actionStateId, age, gone: true }); return; }
  const pr = ek?.bank?.prop(which.m, 0, true);
  if (!pr || !fa) { r.drawSphere(c, radius, color, 0.45); return; }
  const f = fa.fighter, j = f.shieldJoint;
  if (j > 0 && (j + 1) * 16 <= fa.world.length) c = [fa.world[j * 16 + 12], fa.world[j * 16 + 13], fa.world[j * 16 + 14]];
  const curve = ek!.shieldCurve;
  if (curve && f.shieldSize > 0) {
    const [full, least, light, hard] = curve;
    const press = light + pressed(a.inputs) * (hard - light);
    radius = f.modelScale * f.shieldSize * ((1 - least) * (Math.max(0, st.shieldSize) / full) * press + least);
  }
  const port = ek!.shieldColors[a.player] ?? color;
  // (its tracks as their own flags have them: none of the three models' loops - the game's animation stops at
  // its end and holds there, the bubble's turning layer at its last turn, however long the shield is held)
  pr.pose(age, c[0], c[1], c[2], radius / SHIELD_MODEL_RADIUS, 0, false);
  // how far the bubble's picture reaches: its card's own size in the model
  const W = pr.skeleton.world, k = pr.skeleton.n - 1;
  const drawn = Math.hypot(W[k * 16], W[k * 16 + 1], W[k * 16 + 2]);
  // as the game colors it (efasync 0x417-0x419): a texture's TEV (the
  // second of model 11's, the first of the others') mixes the port's color
  // (tev0) toward white (konst) by the texture, and its konst alpha is the
  // shield's: 64, up to 255 the harder it is held (ftCommonData 0x2F4)
  const alpha = (64 + Math.trunc(pressed(a.inputs) * 191)) / 255;
  // (on the first DObj of the root's first child only - and for GuardSetOff's, 0x419, of it and the next six
  // joints beside it: efLib_SetTevKonstColor and efLib_Cb_ApplyStoredAlpha take HSD_JObjGetDObj's)
  const sk = pr.skeleton, colored: number[] = [];
  for (let j = 1; j < sk.n && colored.length < (which.m === SHIELD_MODEL + 2 ? 7 : 1); j++) if (sk.parent[j] === 0) colored.push(j);
  for (const j of colored) {
    const s = pr.firstState(j);
    const tc = s?.tex[which.tex]?.tevColors;
    if (!s || !tc) continue;
    s.dirty = true;
    tc[0] = tc[1] = tc[2] = 1; tc[3] = alpha;
    tc[4] = port[0]; tc[5] = port[1]; tc[6] = port[2];
  }
  r.drawSkeleton(pr.skeleton, "xlu");
  r.endPass();
  drawnShields.push({ player: a.player, state: st.actionStateId, age, model: which.m, at: c.map((v) => +v.toFixed(1)), radius: +radius.toFixed(2), drawn: +drawn.toFixed(2), alpha });
}
// the shields drawn on the last frame (the checks read them)
let drawnShields: Record<string, unknown>[] = [];
let lastDepth: { view: Float32Array; actors: ActorFrame[] } | null = null;
// the model parts a fighter's own code switches in some states, for replays
// without a viewer track: Yoshi's shield is his egg, part 0's second variant,
// while he holds it and while it is struck (ftyoshiguard.c: GuardHold,
// GuardDamage), and as he rolls from it (ftCo_Escape.c ftCo_80099438);
// Marth's part 1 turns as his shield comes up, and in a powershield's window
// (ftCo_Guard.c ftCo_800923B4, ftCo_800939B4: GuardOn, GuardReflect; the
// change to Guard puts it back)
const STATE_PARTS: Record<number, { states: number[]; part: number; variant: number }[]> = {
  14: [{ states: [342, 344, 233, 234], part: 0, variant: 1 }],
  18: [{ states: [178, 182], part: 1, variant: 1 }],
};
// Link and Young Link, and their bombs (items 0x3A, 0x3B)
const LINKS = new Set([6, 20]), LINK_BOMBS = new Set([0x3a, 0x3b]);
// Bowser's up-B: his shell alone while its script's variable says so (the
// ground's third, the air's second, bit 1: ftkoopaspecialn.c
// ftKp_SpecialN_80135780, from ftkoopaspecialhi.c's animation callbacks)
const KOOPA = 5, KOOPA_HI = 359, KOOPA_AIR_HI = 360, GIGA_KOOPA = 29;
/** by stage (Slippi's id) and floor material: the effects a footstep, a
 *  landing and a bounce make there instead of the moves' own (-1: the move's) */
const FLOOR_FX: Record<number, Record<number, [number, number, number]>> = {
  2: { 10: [0x7537, 0x7538, 0x753b] }, // Fountain of Dreams
  3: { 10: [0x754a, 0x7539, -1] }, // Pokemon Stadium
};
/** a model part's variant worked out from the replay (no track's switches):
 *  what the state's script switched it to so far, else what its code does in
 *  the states known to switch one */
function ownPart(fi: Fighter, a: Pick<Actor, "st" | "player" | "nana" | "face" | "roll" | "stone">, part: number,
                 items: ReplayItem[]): number {
  let v = fi.defaultPart(part);
  const rule = STATE_PARTS[a.st.internalCharacterId]?.find((q) => q.part === part && q.states.includes(a.st.actionStateId));
  if (rule) v = rule.variant;
  const said = a.face?.models.get(part);
  if (said !== undefined) v = said;
  const code = codePart(a.st, part, a.face);
  if (code !== undefined) v = code;
  // (Link and Young Link holding their bomb: part 2's other
  // variant, from the pick-up to letting it go - ftLk_Init_OnItemPickupExt,
  // OnItemDropExt; the bomb held is its state 0, itlinkbomb.c)
  if (part === 2 && LINKS.has(a.st.internalCharacterId) && !a.nana &&
      items.some((it) => it.owner === a.player && LINK_BOMBS.has(it.typeId) && it.state === 0)) v = 1;
  if (part === 0 && a.roll?.part0 !== undefined) v = a.roll.part0;
  if (part === 0 && a.stone?.part0 !== undefined) v = a.stone.part0;
  if (part === 1 && a.stone?.part1 !== undefined) v = a.stone.part1;
  return v;
}

function codePart(st: PlayerState, part: number, face: Face | undefined): number | undefined {
  if (st.internalCharacterId === KOOPA && part === 0 && face &&
      (st.actionStateId === KOOPA_HI || st.actionStateId === KOOPA_AIR_HI)) {
    return face.vars[st.actionStateId === KOOPA_HI ? 2 : 1] & 1 ? 1 : 0;
  }
  return undefined;
}

// the shield model at scale 1 is a bubble of radius 1: the game scales it by
// the shield joint, whose scale is the bubble's radius
const SHIELD_MODEL_RADIUS = 1;
// each shield state's model (the common effect file's), the texture its
// colors go on, the states it runs through, whether it plays over and over,
// and else how many frames it lasts (its life in the file: 10.1)
const RISING = { m: SHIELD_MODEL, tex: 1, states: [178, 182], loop: false, life: 11 };
const SHIELD_LEAD = 1;
const SHIELD_MODELS: Record<number, { m: number; tex: number; states: number[]; loop: boolean; life: number }> = {
  178: RISING,                                                                   // GuardOn
  182: RISING,                                                                   // GuardReflect: the powershield window
  179: { m: SHIELD_MODEL + 1, tex: 0, states: [179], loop: true, life: Infinity }, // Guard
  181: { m: SHIELD_MODEL + 2, tex: 0, states: [181], loop: false, life: 11 },          // GuardSetOff
};

/** a shield model by its number (the track's): its entry above, or for one
 *  no state names (0xE) its life from the effect file */
function shieldModel(ek: EffectKit | undefined, m: number): (typeof SHIELD_MODELS)[number] {
  const known = Object.values(SHIELD_MODELS).find((x) => x.m === m);
  if (known) return known;
  const desc = ek?.bank?.models[m];
  const life = desc && desc.life >= 1 ? Math.trunc(desc.life) + 1 : Infinity;
  return { m, tex: 0, states: [], loop: life === Infinity, life };
}

/** the track's shapes for a replay frame (index), when it holds there and has pieces */
function shapesAt(tr: ViewerTrack | null, f: number): TrackShapes | null {
  if (!tr || !tr.valid(f - 123)) return null;
  const s = trackShapes(tr);
  return s.has ? s : null;
}

/** whether a fighter stands in hitlag on a game frame (its effects pause) */
function heldOf(data: ReplayData, player: number, nana: boolean): (frame: number) => boolean {
  return (frame) => {
    const p = data.frames[frame + 123]?.players[player];
    return ((nana ? p?.nanaState : p?.state)?.hitlagRemaining ?? 0) > 0;
  };
}

// simulated runs: a plain bubble in the run's color, to read them by
function ghostShield(r: Renderer, st: PlayerState, inputs: PlayerInputs | undefined, color: [number, number, number]) {
  const radius = shieldSize(st, inputs);
  if (radius === null) return;
  const ch = actionMapByInternalId[st.internalCharacterId];
  r.drawSphere([st.xPosition + ch.shieldOffset[0] * st.facingDirection, st.yPosition + ch.shieldOffset[1], 0], radius, color, 0.35);
}
