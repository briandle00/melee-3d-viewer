import createRAF, { targetFPS } from "@solid-primitives/raf";
import { batch, createEffect, createResource, createSignal, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { sound } from "~/audio";
import {
  ActionName,
  actionNameById,
  AttackName,
  characterNameByExternalId,
  characterNameByInternalId,
} from "~/common/ids";
import {
  PlayerInputs,
  PlayerSettings,
  PlayerState,
  PlayerUpdate,
  PlayerUpdateWithNana,
  ReplayData,
} from "~/common/types";
import { parseReplay } from "~/parser/parser";
import { queries } from "~/search/queries";
import { Highlight, search } from "~/search/search";
import { currentSelectionStore } from "~/state/selectionStore";
import { CharacterAnimations, fetchAnimations } from "~/viewer/animationCache";
import { actionMapByInternalId } from "~/viewer/characters";
import { Character } from "~/viewer/characters/character";
import { getPlayerOnFrame, getStartOfAction } from "~/viewer/viewerUtil";
import colors from "tailwindcss/colors";
import { fileStore } from "~/state/fileStore";
import { action, landsAttack } from "~/search/framePredicates";
import { decode } from "@shelacek/ubjson";
import { pageCache, trim } from "~/state/pageCache";

export interface RenderData {
  playerState: PlayerState;
  playerInputs: PlayerInputs;
  playerSettings: PlayerSettings;

  // main render
  path?: string;
  innerColor: string;
  outerColor: string;
  transforms: string[];

  // shield/shine renders
  animationName: string;
  characterData: Character;
}

// other replays drawn over this one, frame for frame - simulated
// branches of a moment, which share the real game's frames up to the takeover
export interface Ghost {
  replayData: ReplayData;
  label: string;
  color: string;
}

export interface ReplayStore {
  replayData?: ReplayData;
  ghosts: Ghost[];
  ghostRenderDatas: RenderData[][];
  // play and seek only inside [start, end] (frame indexes), looping
  range?: [number, number];
  highlights: Record<string, Highlight[]>;
  selectedHighlight?: [string, Highlight];
  animations: (CharacterAnimations | undefined)[];
  frame: number;
  renderDatas: RenderData[];
  fps: number;
  framesPerTick: number;
  running: boolean;
  zoom: number;
  isDebug: boolean;
  isFullscreen: boolean;
  customAction: ActionName;
  customAttack: AttackName;
}
export const defaultReplayStoreState: ReplayStore = {
  highlights: Object.fromEntries(
    Object.entries(queries).map(([name]) => [name, []])
  ),
  frame: 0,
  renderDatas: [],
  ghosts: [],
  ghostRenderDatas: [],
  animations: Array(4).fill(undefined),
  fps: 60,
  framesPerTick: 1,
  running: false,
  zoom: 1,
  isDebug: false,
  isFullscreen: false,
  customAction: "Passive",
  customAttack: "Up Tilt",
};

const [replayState, setReplayState] = createStore<ReplayStore>(
  defaultReplayStoreState
);

export const replayStore = replayState;

// whether the line art is drawing. The 3D player draws from the
// replay itself; while it does, the line art's per-frame work (its
// animations, each fighter's and each run's drawing data) is not done.
const [lineArt, setLineArtSignal] = createSignal(true);
export function setLineArt(on: boolean): void {
  setLineArtSignal(on);
}

export function nextHighlight() {
  ensureHighlights();
  const highlights = Object.entries(replayState.highlights).flatMap(
    ([name, highlights]) =>
      highlights.map((highlight) => [name, highlight] as const)
  );
  const currentIndex =
    replayState.selectedHighlight !== undefined
      ? highlights.findIndex(
          ([, highlight]) => replayState.selectedHighlight![1] === highlight
        )
      : -1;
  const nextIndex = wrapHighlight(replayState, currentIndex + 1);
  batch(() => {
    setReplayState("selectedHighlight", highlights[nextIndex]);
    jump(highlights[nextIndex][1].startFrame - 30);
  });
}

export function previousHighlight() {
  ensureHighlights();
  const highlights = Object.entries(replayState.highlights).flatMap(
    ([name, highlights]) =>
      highlights.map((highlight) => [name, highlight] as const)
  );
  const currentIndex =
    replayState.selectedHighlight !== undefined
      ? highlights.findIndex(
          ([, highlight]) => replayState.selectedHighlight![1] === highlight
        )
      : 1;
  const previousIndex = wrapHighlight(replayState, currentIndex - 1);
  batch(() => {
    setReplayState("selectedHighlight", highlights[previousIndex]);
    jump(highlights[previousIndex][1].startFrame - 30);
  });
}

export function speedNormal(): void {
  batch(() => {
    setReplayState("fps", 60);
    setReplayState("framesPerTick", 1);
  });
}

export function speedFast(): void {
  setReplayState("framesPerTick", 2);
}

export function speedSlow(): void {
  setReplayState("fps", 30);
}

export function setZoom(z: number): void {
  if (z > 0 && isFinite(z)) setReplayState("zoom", z);
}

export function zoomIn(): void {
  setReplayState("zoom", (z) => z * 1.01);
}

export function zoomOut(): void {
  setReplayState("zoom", (z) => z / 1.01);
}

export function toggleDebug(): void {
  setReplayState("isDebug", (isDebug) => !isDebug);
}

export function toggleFullscreen(): void {
  setReplayState("isFullscreen", (isFullscreen) => !isFullscreen);
}

export function togglePause(): void {
  if (running()) stop();
  else if (playWanted) playWanted = false;
  else {
    // (from the last frame, play starts again at the first: with sound on,
    // playing stops at the last frame rather than wrapping around)
    const data = replayState.replayData;
    if (data && replayState.frame >= data.frames.length - 1) jump(0);
    begin();
  }
}

export function pause(): void {
  playWanted = false;
  stop();
}

// a player that is not ready to play smoothly yet (the 3D one
// warming up: Viewer3D) holds playing back; asked to play meanwhile, it plays
// once it is released, unless asked to stop first
let playHeld = false, playWanted = false;
function begin() {
  if (playHeld) { playWanted = true; return; }
  start();
}
/** hold playing back (on), or let it go - playing then if it was asked to */
export function holdPlay(on: boolean): void {
  playHeld = on;
  if (!on && playWanted) { playWanted = false; start(); }
}

export function setGhosts(ghosts: Ghost[]): void {
  setReplayState({ ghosts: ghosts.map((g) => ({ ...g, replayData: rawReplay(g.replayData) })), ghostRenderDatas: [] });
}

// a replay kept as it is, not as the store's proxies of it. The
// store wraps what it holds, object by object, as it is read, and copies it
// through once as it is set - for a replay, its tens of thousands of frames,
// seconds of the page's time; and every loop over the frames through the
// wrapping costs as much again. Nothing changes a replay once it is read, so
// the store keeps it whole (an object whose prototype is not Object's own is
// left as it is) and every read of it is the object itself.
/** the replay, marked to be kept as it is */
export function rawReplay<T extends object>(data: T): T {
  if (Object.getPrototypeOf(data) === Object.prototype) Object.setPrototypeOf(data, Object.create(Object.prototype));
  return data;
}

/** a replay's bytes, told apart well enough for the page's cache: its size and a sample of them */
function replayKey(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(u.length / 4096));
  for (let i = 0; i < u.length; i += step) h = Math.imul(h ^ u[i], 16777619);
  for (let i = Math.max(0, u.length - 256); i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return `${u.length}:${h >>> 0}`;
}
// (the replay the highlights being found are for, and their search while it is not done)
let highlightsFor = 0;
let pendingHighlights: (() => void) | null = null;
/** the highlights, found now if they were not yet */
export function ensureHighlights(): void {
  const f = pendingHighlights;
  pendingHighlights = null;
  f?.();
}

export function setRange(range?: [number, number]): void {
  setReplayState("range", range);
  if (range) jump(replayState.frame);
}

export function jump(target: number): void {
  const frame = wrapFrame(replayState, target);
  sound.seek(frame);
  setReplayState("frame", frame);
}

// percent is [0,1]
export function jumpPercent(percent: number): void {
  // inside a moment's range, percent of the range
  if (replayState.range) {
    const [a, b] = replayState.range;
    jump(Math.round(a + (b - a) * percent));
    return;
  }
  jump(Math.round((replayState.replayData?.frames.length ?? 0) * percent));
}

export function adjust(delta: number): void {
  // (through jump, so the sound follows a step or a skip too)
  jump(replayState.frame + delta);
}

const [running, start, stop] = createRAF(
  targetFPS(
    () => {
      // with sound on (audio.ts) the picture shows the frame being heard,
      // holds while the sound catches up with a seek, and stops at the end;
      // with it off, the next frame of the viewer's own clock
      const audioFrame = sound.frame();
      if (audioFrame === null) return;
      if (audioFrame === undefined) {
        setReplayState("frame", (f) =>
          wrapFrame(replayState, f + replayState.framesPerTick)
        );
        return;
      }
      const last = (replayState.replayData?.frames.length ?? 1) - 1;
      setReplayState("frame", Math.min(last, audioFrame));
      if (audioFrame >= last) pause();
    },
    () => replayState.fps
  )
);
createEffect(() => setReplayState("running", running()));
// playing or paused and the speed, told to the sound (1 = the game's speed).
// The frame is read untracked: playing moves it every tick, and seeks reach
// the sound through jump
createEffect(() => {
  const playing = running();
  const rate = (replayState.fps * replayState.framesPerTick) / 60;
  sound.transport(playing, untrack(() => replayState.frame), rate);
});

createEffect(async () => {
  const selected = currentSelectionStore().data.selectedFileAndStub;
  // (sound is off for a new replay, and opens this one when turned on)
  sound.load(selected?.[0]);
  if (selected === undefined) {
    setReplayState(defaultReplayStoreState);
    return;
  }

  // a replay another player on the page has read already is taken
  // from it (a preview and the main player read the same one)
  const buf = await selected[0].arrayBuffer();
  const key = replayKey(buf);
  const shared = pageCache<ReplayData>("replays");
  let replayData = shared.get(key);
  if (!replayData) {
    replayData = rawReplay(parseReplay(decode(buf, { useTypedArrays: true })));
    shared.set(key, replayData);
    trim(shared, 6);
  }
  const data = replayData;
  // (Slippi Lab's highlights - its own search over every frame, a tenth of a
  // second and more - when something asks for them: its highlight keys)
  const want = ++highlightsFor;
  const findHighlights = () => {
    if (want !== highlightsFor) return;
    const highlights = Object.fromEntries(
      Object.entries(queries).map(([name, query]) => [
        name,
        search(data, ...query),
      ])
    );
    highlights.customAction = search(data, [
      { predicate: action(replayState.customAction) },
    ]);
    highlights.customAttack = search(data, [
      { predicate: landsAttack(replayState.customAttack) },
    ]);
    setReplayState("highlights", highlights);
  };
  pendingHighlights = findHighlights;
  setReplayState({
    replayData,
    highlights: Object.fromEntries(Object.entries(queries).map(([name]) => [name, []])),
    frame: fileStore.urlStartFrame ?? 0,
    renderDatas: [],
    ghosts: [],
    ghostRenderDatas: [],
    range: undefined,
  });
  if (fileStore.urlStartFrame === undefined || fileStore.urlStartFrame === 0) {
    begin();
  }
});

const animationResources = [];
for (let playerIndex = 0; playerIndex < 4; playerIndex++) {
  animationResources.push(
    createResource(
      () => {
        const replay = replayState.replayData;
        if (replay === undefined || !lineArt()) {
          return undefined;
        }
        const playerSettings = replay.settings.playerSettings[playerIndex];
        if (playerSettings === undefined) {
          return undefined;
        }
        const playerUpdate =
          replay.frames[replayState.frame]?.players[playerIndex];
        if (playerUpdate === undefined) {
          return playerSettings.externalCharacterId;
        }
        if (
          playerUpdate.state.internalCharacterId ===
          characterNameByInternalId.indexOf("Zelda")
        ) {
          return characterNameByExternalId.indexOf("Zelda");
        }
        if (
          playerUpdate.state.internalCharacterId ===
          characterNameByInternalId.indexOf("Sheik")
        ) {
          return characterNameByExternalId.indexOf("Sheik");
        }
        return playerSettings.externalCharacterId;
      },
      (id) => (id === undefined ? undefined : fetchAnimations(id))
    )
  );
}
animationResources.forEach(([dataSignal], playerIndex) =>
  createEffect(() =>
    // I can't use the obvious setReplayState("animations", playerIndex,
    // dataSignal()) because it will merge into the previous animations data
    // object, essentially overwriting the previous characters animation data
    // forever
    setReplayState("animations", (animations) => {
      const newAnimations = [...animations];
      newAnimations[playerIndex] = dataSignal();
      return newAnimations;
    })
  )
);

createEffect(() => {
  if (replayState.replayData === undefined || !lineArt()) {
    return;
  }
  setReplayState(
    "renderDatas",
    (replayState.replayData.frames[replayState.frame]?.players ?? [])
      .filter((playerUpdate) => playerUpdate)
      .flatMap((playerUpdate) => {
        const animations = replayState.animations[playerUpdate.playerIndex];
        if (animations === undefined) return [];
        const renderDatas = [];
        renderDatas.push(
          computeRenderData(replayState, playerUpdate, animations, false)
        );
        if (playerUpdate.nanaState != null) {
          renderDatas.push(
            computeRenderData(replayState, playerUpdate, animations, true)
          );
        }
        return renderDatas;
      })
  );
});

// each ghost's players on the current frame, in the ghost's color
createEffect(() => {
  const frame = replayState.frame;
  const ghosts = replayState.ghosts;
  if (!lineArt()) return;
  if (!ghosts.length) {
    setReplayState("ghostRenderDatas", []);
    return;
  }
  setReplayState(
    "ghostRenderDatas",
    ghosts.map((ghost) => {
      const frameData = ghost.replayData.frames[frame];
      // (a ghost cut to its moment draws nothing before it: parser.ts's held)
      if (frameData === undefined || frame < (ghost.replayData.held ?? 0)) return [];
      // only the replay: copying the whole store would read ghostRenderDatas
      // here and set off this effect again, forever
      const ghostState = { replayData: ghost.replayData } as ReplayStore;
      return frameData.players
        .filter((playerUpdate) => playerUpdate)
        .flatMap((playerUpdate) => {
          const animations = replayState.animations[playerUpdate.playerIndex];
          if (animations === undefined) return [];
          const out = [computeRenderData(ghostState, playerUpdate, animations, false)];
          if (playerUpdate.nanaState != null) {
            out.push(computeRenderData(ghostState, playerUpdate, animations, true));
          }
          return out.map((rd) => ({ ...rd, innerColor: ghost.color, outerColor: ghost.color }));
        });
    })
  );
});

function computeRenderData(
  replayState: ReplayStore,
  playerUpdate: PlayerUpdate,
  animations: CharacterAnimations,
  isNana: boolean
): RenderData {
  const playerState = (playerUpdate as PlayerUpdateWithNana)[
    isNana ? "nanaState" : "state"
  ];
  const playerInputs = (playerUpdate as PlayerUpdateWithNana)[
    isNana ? "nanaInputs" : "inputs"
  ];
  const playerSettings = replayState
    .replayData!.settings.playerSettings.filter(Boolean)
    .find((settings) => settings.playerIndex === playerUpdate.playerIndex)!;

  const startOfActionPlayerState: PlayerState = (
    getPlayerOnFrame(
      playerUpdate.playerIndex,
      getStartOfAction(playerState, replayState.replayData!),
      replayState.replayData!
    ) as PlayerUpdateWithNana
  )[isNana ? "nanaState" : "state"];
  const actionName = actionNameById[playerState.actionStateId];
  const characterData = actionMapByInternalId[playerState.internalCharacterId];
  const animationName =
    characterData.animationMap.get(actionName) ??
    characterData.specialsMap.get(playerState.actionStateId) ??
    actionName;
  const animationFrames = animations[animationName];
  // TODO: validate L cancels, other fractional frames, and one-indexed
  // animations. I am currently just flooring. Converts - 1 to 0 and loops for
  // Entry, Guard, etc.
  const frameIndex =
    Math.floor(Math.max(0, playerState.actionStateFrameCounter)) %
    (animationFrames?.length ?? 1);
  // To save animation file size, duplicate frames just reference earlier
  // matching frames such as "frame20".
  const animationPathOrFrameReference = animationFrames?.[frameIndex];
  const path =
    animationPathOrFrameReference !== undefined &&
    (animationPathOrFrameReference.startsWith("frame") ?? false)
      ? animationFrames?.[
          Number(animationPathOrFrameReference.slice("frame".length))
        ]
      : animationPathOrFrameReference;
  const rotation =
    animationName === "DamageFlyRoll"
      ? getDamageFlyRollRotation(replayState, playerState)
      : isSpacieUpB(playerState)
      ? getSpacieUpBRotation(replayState, playerState)
      : 0;
  // Some animations naturally turn the player around, but facingDirection
  // updates partway through the animation and incorrectly flips the
  // animation. The solution is to "fix" the facingDirection for the duration
  // of the action, as the animation expects. However upB turnarounds and
  // Jigglypuff/Kirby mid-air jumps are an exception where we need to flip
  // based on the updated state.facingDirection.
  const facingDirection = actionFollowsFacingDirection(animationName)
    ? playerState.facingDirection
    : startOfActionPlayerState.facingDirection;
  return {
    playerState,
    playerInputs,
    playerSettings,
    path,
    innerColor: getPlayerColor(
      replayState,
      playerUpdate.playerIndex,
      playerState.isNana
    ),
    outerColor:
      startOfActionPlayerState.lCancelStatus === "missed"
        ? "red"
        : playerState.hurtboxCollisionState !== "vulnerable"
        ? "blue"
        : "black",
    transforms: [
      `translate(${playerState.xPosition} ${playerState.yPosition})`,
      // TODO: rotate around true character center instead of current guessed
      // center of position+(0,8)
      `rotate(${rotation} 0 8)`,
      `scale(${characterData.scale} ${characterData.scale})`,
      `scale(${facingDirection} 1)`,
      "scale(.1 -.1) translate(-500 -500)",
    ],
    animationName,
    characterData,
  };
}

// DamageFlyRoll default rotation is (0,1), but we calculate rotation from (1,0)
// so we need to subtract 90 degrees. Quick checks:
// 0 - 90 = -90 which turns (0,1) into (1,0)
// -90 - 90 = -180 which turns (0,1) into (-1,0)
// Facing direction is handled naturally because the rotation will go the
// opposite direction (that scale happens first) and the flip of (0,1) is still
// (0, 1)
function getDamageFlyRollRotation(
  replayState: ReplayStore,
  playerState: PlayerState
): number {
  const previousState = (
    getPlayerOnFrame(
      playerState.playerIndex,
      playerState.frameNumber - 1,
      replayState.replayData!
    ) as PlayerUpdateWithNana
  )[playerState.isNana ? "nanaState" : "state"];
  const deltaX = playerState.xPosition - previousState.xPosition;
  const deltaY = playerState.yPosition - previousState.yPosition;
  return (Math.atan2(deltaY, deltaX) * 180) / Math.PI - 90;
}

// Rotation will be whatever direction the player was holding at blastoff. The
// default rotation of the animation is (1,0), so we need to subtract 180 when
// facing left, and subtract 0 when facing right.
// Quick checks:
// 0 - 0 = 0, so (1,0) is unaltered when facing right
// 0 - 180 = -180, so (1,0) is flipped when facing left
function getSpacieUpBRotation(
  replayState: ReplayStore,
  playerState: PlayerState
): number {
  const startOfActionPlayer = getPlayerOnFrame(
    playerState.playerIndex,
    getStartOfAction(playerState, replayState.replayData!),
    replayState.replayData!
  );
  const joystickDegrees =
    ((startOfActionPlayer.inputs.processed.joystickY === 0 &&
    startOfActionPlayer.inputs.processed.joystickX === 0
      ? Math.PI / 2
      : Math.atan2(
          startOfActionPlayer.inputs.processed.joystickY,
          startOfActionPlayer.inputs.processed.joystickX
        )) *
      180) /
    Math.PI;
  return (
    joystickDegrees -
    ((startOfActionPlayer as PlayerUpdateWithNana)[
      playerState.isNana ? "nanaState" : "state"
    ].facingDirection === -1
      ? 180
      : 0)
  );
}

// All jumps and upBs either 1) Need to follow the current frame's
// facingDirection, or 2) Won't have facingDirection change during the action.
// In either case we can grab the facingDirection from the current frame.
function actionFollowsFacingDirection(animationName: string): boolean {
  return (
    animationName.includes("Jump") ||
    ["SpecialHi", "SpecialAirHi"].includes(animationName)
  );
}

function isSpacieUpB(playerState: PlayerState): boolean {
  const character = characterNameByInternalId[playerState.internalCharacterId];
  return (
    ["Fox", "Falco"].includes(character) &&
    [355, 356].includes(playerState.actionStateId)
  );
}

export function getPlayerColor(
  replayState: ReplayStore,
  playerIndex: number,
  isNana: boolean
): string {
  if (replayState.replayData!.settings.isTeams) {
    const settings =
      replayState.replayData!.settings.playerSettings[playerIndex];
    return [
      [colors.red["800"], colors.red["600"]],
      [colors.green["800"], colors.green["600"]],
      [colors.blue["800"], colors.blue["600"]],
    ][settings.teamId][isNana ? 1 : settings.teamShade];
  }
  return [
    [colors.red["700"], colors.red["600"]],
    [colors.blue["700"], colors.blue["600"]],
    [colors.yellow["500"], colors.yellow["400"]],
    [colors.green["700"], colors.green["600"]],
  ][playerIndex][isNana ? 1 : 0];
}

function wrapFrame(replayState: ReplayStore, frame: number): number {
  if (!replayState.replayData) return frame;
  if (replayState.range) {
    // loop inside the moment, like the video of it would (and no further
    // than the replay goes: a run can end before the moment's loop does)
    const last = replayState.replayData.frames.length - 1;
    const [a, b0] = replayState.range;
    const b = Math.max(a, Math.min(b0, last));
    const n = b - a + 1;
    if (frame < a || frame > b) return a + ((((frame - a) % n) + n) % n);
    return frame;
  }
  return (
    (frame + replayState.replayData.frames.length) %
    replayState.replayData.frames.length
  );
}

function wrapHighlight(replayState: ReplayStore, highlight: number): number {
  const length = Object.entries(replayState.highlights).flatMap(
    ([, highlights]) => highlights
  ).length;
  return (highlight + length) % length;
}
