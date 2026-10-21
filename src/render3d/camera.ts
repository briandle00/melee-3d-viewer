/* 3D replay viewer: the game's own match camera, run from the
 * replay.
 *
 * Slippi does not record the camera, but in a versus match the game's camera
 * follows from nothing the replay lacks: each fighter's position, facing and
 * state, the fighter's camera box (its data file), and the stage's camera
 * settings (grGroundParam and its general points). What it does each frame
 * was read from the Melee decompilation's camera code (cm/camera.c and
 * ft/ftcamera.c); this is our own writing of it:
 *
 *  - every fighter is a subject: a point (its position, lifted by its box)
 *    with extents left, right, up and down that ease toward the box's own
 *    half a unit a frame. A fighter who is KO'd stops updating (the camera
 *    keeps looking where they went) until the game puts them to sleep, and
 *    one coming back snaps to their box;
 *  - the subjects' extents, scaled by a factor for how many there are and the
 *    stage's track ratio, and each held inside the stage's camera range, make
 *    a box to frame;
 *  - the field of view eases toward the stage's own (grGroundParam +0x08,
 *    passed to the camera at the match's start); the distance is what fits the
 *    box, between the stage's nearest and farthest; the camera tilts down as
 *    the box sits low and turns as it sits to a side, both by the stage's
 *    factors, within limits, plus the stage's own pan;
 *  - if the picture's corners would reach past the camera range on the
 *    stage's plane, the target moves back in;
 *  - the camera's interest eases toward its target by a speed that grows with
 *    the spread, and its position by 0.15 a frame, both times the stage's
 *    smoothing.
 * It is stateful, so it is run once for a whole replay, from its first frame.
 */

import { Key, sample } from "./hsd";
import { C_MTXPerspective, cobjViewingMtx, madd, msub, mtxToGL, nmsub, projectionToGL, sqrtf } from "./gxmath";
import { atan2f, tanf } from "./fx/gamemath";

/** the stage's camera settings (in world units, the stage's scale applied) */
export interface StageCamera {
  /** the camera range, absolute */
  left: number; right: number; top: number; bottom: number;
  /** its center (general point 0x94) */
  cx: number; cy: number;
  /** the blast zones, absolute */
  blast: { left: number; right: number; top: number; bottom: number };
  /** the stage's quakes (loop, small, medium, large): the x and y the quake
   *  joint's animation moves it by, and how long it runs */
  quakes: ({ x: Key[] | null; y: Key[] | null; end: number } | null)[];
  /** grGroundParam: tilt and turn factors, pan (degrees), nearest and
   *  farthest distance, track ratio, smoothing, fixed zoom */
  pitchK: number; yawK: number; pan: number; near: number; far: number;
  trackRatio: number; smooth: number; fixedZoom: number;
  /** grGroundParam +0x08: the field of view the camera eases toward (degrees;
   *  Yoshi's Story 20, Battlefield 30), 0 when the file has none */
  fov: number;
}

/** a fighter's camera box (ftData+0x3C): its lift, horizontal extents
 *  (behind, ahead), vertical extents and depth, before its model scale */
export interface CameraBox { lift: number; back: number; ahead: number; v: [number, number, number] }

/** one fighter on one frame, as the camera needs it; `quake`: the quake it
 *  starts this frame (a hit's, a bounce's, its move script's: hitlag.ts quakeOf), 0 or none */
export interface CamActor { key: string; x: number; y: number; facing: number; state: number; box: CameraBox | null; scale: number;
                            quake?: number }

// the game's camera numbers, as the float32s they are: cm_803BCCA0 (x8 the pitch's base, xC and x10 its limits,
// x14 and x18 the yaw's, x1C to x28 the pitch bias and its spreads, x2C to x38 the follow speeds and theirs, x3C the
// position's ease, x40 the field of view (the stage's: Camera_80030730), x44 its ease, x54 to x60 a quake's share
// near and far), cm_803BCB64 (the start's field of view, the aspect) and cm_803BCB9C (the weight by subject count)
const f32 = Math.fround;
const FOV = f32(38), FOV_EASE = f32(0.1), FOV_START = f32(30), ASPECT = f32(1.2173333);
const PITCH_BASE = f32(-30), PITCH_MAX = f32(5), PITCH_MIN = f32(-7), YAW_MAX = f32(17.5), YAW_MIN = f32(-17.5);
const BIAS_LOW = f32(0), BIAS_HIGH = f32(0.0682), BIAS_FROM = f32(60), BIAS_TO = f32(120);
const FOLLOW_SLOW = f32(0.05), FOLLOW_FAST = f32(0.1), FOLLOW_FROM = f32(120), FOLLOW_TO = f32(900);
const POSITION_EASE = f32(0.15);
// a quake's share at the nearest distance and at the farthest (x54, x5C: y; x58, x60: x)
const QUAKE_NEAR = f32(1), QUAKE_FAR = f32(0.6);
const WEIGHT = [0, 1.5, 1.32, 1.16, 1.0].map(f32);
const DEFAULT_BOX: CameraBox = { lift: 10, back: -8, ahead: 8, v: [12, -2, 0] };
/** MTXDegToRad's factor (deg_to_rad, 0.017453292f) */
const DEG = f32(0.017453292);
const F32_MAX = 3.4028234663852886e38;

interface Subject { x: number; y: number; ext: number[]; target: number[]; on: boolean; frozen: boolean; lastState: number;
                    since: number }
// a screen KO's frames on the screen before it is gone (fighter.ts)
const SCREEN_GONE = 43;


/** each player's scale, which their camera box is taken at: the match's own
 *  model scale (1 in a versus match; ftCamera_UpdateCameraBox multiplies the
 *  box by x34_scale.y, which is Player_GetModelScale), not the character's
 *  model scaling */
export function playerScales(players: ({ modelScale?: number } | null | undefined)[]): number[] {
  return players.map((p) => (p?.modelScale && p.modelScale > 0 ? p.modelScale : 1));
}

/** floats a frame in runCamera's track */
export const CAM_STRIDE = 7;

/** the camera on each frame: eye x y z, interest x y z, vertical field of
 *  view in degrees */
export function runCamera(st: StageCamera, frames: CamActor[][]): Float32Array {
  const run = cameraRun(st, (f) => frames[f], frames.length);
  run.advance(frames.length);
  return run.out;
}

/** a camera run that goes on as far as it is asked: the frames' fighters come from `actorsAt` one frame at a time,
 *  `advance(to)` runs the frames up to `to` (the game's camera is a state from one frame to the next, so they are
 *  run in order, from the first), and `out` is the whole track, filled as far as `done`. `fixed`: the first frames
 *  of a track the game's own camera made, which replace what the run makes for them (the run goes on from its own
 *  state, as it always did). */
export interface CameraRun {
  readonly out: Float32Array;
  readonly total: number;
  readonly done: number;
  advance(to: number): void;
}
export function cameraRun(st: StageCamera, actorsAt: (f: number) => CamActor[], total: number,
                          fixed?: { track: Float32Array; frames: number }): CameraRun {
  const out = new Float32Array(total * CAM_STRIDE);
  let done = 0;
  const subjects = new Map<string, Subject>();
  let quake: { kind: number; from: number } | null = null;
  // the stage's numbers as the game holds them (floats)
  const left = f32(st.left), right = f32(st.right), top = f32(st.top), bottom = f32(st.bottom);
  const cx = f32(st.cx), cy = f32(st.cy), near = f32(st.near), far = f32(st.far);
  const trackRatio = f32(st.trackRatio), smooth = f32(st.smooth), fixedZoom = f32(st.fixedZoom);
  const blastTop = f32(st.blast.top);
  const targetFov = st.fov > 0 ? f32(st.fov) : FOV;
  // where the game's camera starts (its scene's camera: cm_803BCB3C, cm_803BCB50)
  const pos = [0, f32(40.241425), f32(300.241)], interest = [0, 10, 0];
  const targetPos = [...pos], targetInterest = [...interest];
  let fov = FOV_START;
  // (Camera_80029124's test and its clamp to the camera range, without the ground's slope under the bottom)
  const inX = (x: number) => (x < left ? left : x > right ? right : x);
  const inY = (y: number) => (y > top ? top : y < bottom ? bottom : y);
  const step = (f: number) => {
    // the subjects: each fighter's box, as its state has it (ftCamera_UpdateCameraBox, ftCamera_80076018: the box
    // times the model's scale)
    for (const a of actorsAt(f)) {
      const box = a.box ?? DEFAULT_BOX, k = f32(a.scale);
      const back = f32(box.back * k), ahead = f32(box.ahead * k);
      const t = a.facing >= 0
        ? [back, f32(ahead * fixedZoom), f32(box.v[0] * k), f32(box.v[1] * k), f32(box.v[2] * k)]
        : [f32(-ahead * fixedZoom), -back, f32(box.v[0] * k), f32(box.v[1] * k), f32(box.v[2] * k)];
      const ax = f32(a.x), ay = f32(f32(a.y) + f32(box.lift * k));
      let s = subjects.get(a.key);
      const dead = a.state <= 10, asleep = a.state === 11;
      if (!s) {
        s = { x: ax, y: ay, ext: [...t], target: [...t], on: !asleep, frozen: false, lastState: a.state, since: f };
        subjects.set(a.key, s);
      }
      if (asleep) { s.on = false; s.lastState = a.state; continue; }
      // a hit that launches, a missed tech's bounce, a wall's, a move's
      // script's: the stage's quake of that size (Camera_RequestQuake), the
      // latest one's (the largest of those asked for on one frame)
      const asked = quake as { kind: number; from: number } | null;
      if (a.quake && !a.key.startsWith("g") && !(asked?.from === f && asked.kind >= a.quake)) quake = { kind: a.quake, from: f };
      if (!s.on) {
        // coming back: framed again, at its box at once
        s.on = true; s.frozen = false;
        s.ext = [...t];
      }
      if (dead) {
        // a KO: the camera keeps the box where it was, except a star or
        // screen KO, which is followed up to the top (ftCamera_80076320)
        if (a.state >= 4) {
          const span = f32(blastTop - cy);
          s.x = span !== 0 ? f32(f32(ax * f32(top - cy)) / span) : ax;
          s.y = blastTop;
          s.target = t;
        }
        if (a.state !== s.lastState) s.since = f;
        // the stage's large quake: a KO through a blast line; a screen KO as
        // it hits the screen (7, 8, 10) and as it slides out of sight
        const real = !a.key.startsWith("g");
        if (real && a.state <= 3 && s.lastState > 3) quake = { kind: 3, from: f };
        if (real && (a.state === 7 || a.state === 8 || a.state === 10)
            && (s.since === f || f - s.since === SCREEN_GONE)) quake = { kind: 3, from: f };
        s.lastState = a.state;
        continue;
      }
      s.lastState = a.state;
      s.x = ax; s.y = ay; s.target = t;
    }
    // extents ease toward their box, half a unit a frame (Camera_800293E0)
    let count = 0;
    for (const s of subjects.values()) {
      if (!s.on) continue;
      count++;
      for (let i = 0; i < 5; i++) {
        const d = f32(s.target[i] - s.ext[i]);
        if (d === 0) continue;
        s.ext[i] = d > 0.5 ? f32(s.ext[i] + 0.5) : d < -0.5 ? f32(s.ext[i] - 0.5) : s.target[i];
      }
    }
    // the box to frame (Camera_8002958C): each subject's place held in the range, its extents laid off from it
    // (ext * multiplier + base, one fused multiply-add) and held in it too
    let x0: number, x1: number, y0: number, y1: number;
    if (count) {
      const m = f32((count < 5 ? WEIGHT[count] : 1) * trackRatio);
      x0 = y0 = F32_MAX; x1 = y1 = -F32_MAX;
      for (const s of subjects.values()) {
        if (!s.on) continue;
        const bx = inX(s.x), by = inY(s.y);
        for (const e of [s.ext[0], s.ext[1]]) {
          const px = inX(madd(e, m, bx));
          if (px < x0) x0 = px;
          if (px > x1) x1 = px;
        }
        for (const e of [s.ext[3], s.ext[2]]) {
          const py = inY(madd(e, m, by));
          if (py < y0) y0 = py;
          if (py > y1) y1 = py;
        }
      }
    } else {
      x0 = f32(cx - 40); x1 = f32(40 + cx); y0 = f32(cy - 40); y1 = f32(40 + cy);
    }
    const z = Math.abs(pos[2]);
    const zf = z < 80 ? 0 : z > 5000 ? 1 : f32(f32(z - 80) / 4920);
    y0 = f32(y0 - madd(390, zf, 10));
    // field of view, eased toward the stage's (update_transform: fov += (target - fov) * x44, fused); the match
    // starts with the camera put where it aims, at its field of view (Camera_8002F3AC)
    fov = f === 0 ? targetFov : madd(f32(targetFov - fov), FOV_EASE, fov);
    // the distance that fits the box at the target's field of view (Camera_80029BC4: the bounds' z)
    const tanT = tanf(f32(DEG * targetFov));
    let zfit = f32(f32(y1 - y0) / tanT);
    const zx = f32(f32(x1 - x0) / f32(ASPECT * tanT));
    if (zx > zfit) zfit = zx;
    if (zfit < near) zfit = near;
    if (zfit > far) zfit = far;
    cameraAim(st, x0, x1, y0, y1, fov, targetInterest, targetPos);
    cameraCorrect(st, targetPos, targetInterest, f32(0.5 * f32(DEG * targetFov)));
    if (f === 0) {
      for (let i = 0; i < 3; i++) { pos[i] = targetPos[i]; interest[i] = targetInterest[i]; }
    }
    // ease toward the target (Camera_80029AAC, Camera_80029C88: each a fused multiply-add)
    const spread = count ? Math.max(f32(x1 - x0), f32(y1 - y0)) : 99999;
    const speed = spread > FOLLOW_TO ? FOLLOW_FAST : spread < FOLLOW_FROM ? FOLLOW_SLOW
      : madd(f32(FOLLOW_FAST - FOLLOW_SLOW), f32(f32(spread - FOLLOW_FROM) / f32(FOLLOW_TO - FOLLOW_FROM)), FOLLOW_SLOW);
    let follow = f32(f32(speed * smooth) * 1);
    if (follow > 1) follow = 1; else if (follow < f32(0.0001)) follow = f32(0.0001);
    interest[0] = madd(f32(targetInterest[0] - interest[0]), follow, interest[0]);
    interest[1] = madd(f32(targetInterest[1] - interest[1]), follow, interest[1]);
    let ease = f32(POSITION_EASE * smooth);
    if (ease > 1) ease = 1;
    for (let i = 0; i < 3; i++) pos[i] = madd(f32(targetPos[i] - pos[i]), ease, pos[i]);
    // a quake: the stage's quake joint, frame by frame, moves the whole
    // picture by as much as it would move it on a 640 x 480 screen seen from
    // the distance that fits the box (Camera_ApplyQuake; the move added to the eye and the interest by
    // Camera_8002AF68)
    let qx = 0, qy = 0;
    const q = quake ? st.quakes[quake.kind] : null;
    if (quake && q) {
      // (the quake's own object, made as it is asked for, first moves the
      // camera on the frame after: its animation's frame 0 there - as the
      // simulator's camera has it, two frames after the hit or the KO)
      const t = f - quake.from - 1;
      if (t > q.end) quake = null;
      else if (t >= 0) {
        const ox = f32(f32(q.x ? sample(q.x, t) ?? 0 : 0) * 10), oy = f32(f32(q.y ? sample(q.y, t) ?? 0 : 0) * 10);
        const half = f32(zfit * tanf(f32(0.5 * f32(DEG * fov))));
        const sx = f32(ASPECT * f32(half / f32(0.5 * 640))), sy = f32(half / f32(0.5 * 480));
        const span = f32(far - near);
        const r = span < f32(0.001) ? 0.5 : f32(f32(zfit - near) / span);
        const fallY = madd(r, f32(QUAKE_FAR - QUAKE_NEAR), QUAKE_NEAR), fallX = madd(r, f32(QUAKE_FAR - QUAKE_NEAR), QUAKE_NEAR);
        qx = f32(fallX * f32(ox * sx));
        qy = f32(fallY * f32(oy * sy));
      }
    }
    const o = f * CAM_STRIDE;
    out[o] = f32(pos[0] + qx); out[o + 1] = f32(pos[1] + qy); out[o + 2] = pos[2];
    out[o + 3] = f32(interest[0] + qx); out[o + 4] = f32(interest[1] + qy); out[o + 5] = interest[2]; out[o + 6] = fov;
    if (fixed && f < fixed.frames) out.set(fixed.track.subarray(f * CAM_STRIDE, (f + 1) * CAM_STRIDE), f * CAM_STRIDE);
  };
  return {
    out,
    total,
    get done() { return done; },
    advance(to: number) {
      const end = Math.min(total, to);
      while (done < end) step(done++);
    },
  };
}

/** the target interest and place that frame the box x0..x1, y0..y1 at this field of view (Camera_80029CF8): the
 *  pitch from where the box sits in height (get_pitch_angle), the yaw from where it sits across, each held to its
 *  limits, and the distances that fit it at them, in float32 with the game's fused multiply-adds */
export function cameraAim(st: StageCamera, x0: number, x1: number, y0: number, y1: number, fov: number,
                          targetInterest: number[], targetPos: number[]) {
  const cx = f32(st.cx), cy = f32(st.cy), near = f32(st.near), far = f32(st.far);
  const pitchK = f32(st.pitchK), yawK = f32(st.yawK), panRad = f32(f32(st.pan) * DEG);
  x0 = f32(x0); x1 = f32(x1); y0 = f32(y0); y1 = f32(y1); fov = f32(fov);
  const dx = f32(x1 - x0), dy = f32(y1 - y0);
  const len = dx > dy ? dx : dy;
  const bias = len > BIAS_TO ? BIAS_HIGH : len < BIAS_FROM ? BIAS_LOW
    : madd(f32(BIAS_HIGH - BIAS_LOW), f32(f32(len - BIAS_FROM) / f32(BIAS_TO - BIAS_FROM)), BIAS_LOW);
  let pitch = madd(f32(f32(y0 - cy) + f32(y1 - cy)), f32(0.5 - bias), cy);
  pitch = f32(pitch + PITCH_BASE);
  pitch = -f32(DEG * f32(pitch * pitchK));
  const pMax = f32(DEG * PITCH_MAX);
  if (pitch > pMax) pitch = pMax;
  const pMin = f32(DEG * PITCH_MIN);
  if (pitch < pMin) pitch = pMin;
  pitch = f32(pitch + panRad);
  const fovRad = f32(DEG * fov);
  const fovU = madd(0.5, fovRad, pitch), fovD = msub(0.5, fovRad, pitch);
  const tanU = tanf(fovU);
  const distY = f32(dy / f32(tanU + tanf(fovD)));
  const yOff = f32(distY * tanf(pitch));
  targetInterest[1] = f32(yOff + nmsub(distY, tanU, y1));
  const midX = f32(0.5 * f32(x0 + x1));
  const yMax = f32(DEG * YAW_MAX);
  let yaw = -f32(DEG * f32(f32(midX - cx) * yawK));
  if (yaw > yMax) yaw = yMax;
  const yMin = f32(DEG * YAW_MIN);
  if (yaw < yMin) yaw = yMin;
  const fovR = msub(0.5, fovRad, yaw), fovL = madd(0.5, fovRad, yaw);
  const tanR = f32(ASPECT * tanf(fovR)), tanL = f32(ASPECT * tanf(fovL));
  const distX = f32(dx / f32(tanR + tanL));
  const xOff = f32(ASPECT * f32(distX * tanf(yaw)));
  targetInterest[0] = f32(nmsub(distX, tanR, x1) - xOff);
  targetInterest[2] = 0;
  let dist = distY > distX ? distY : distX;
  if (dist < near) dist = near;
  if (dist > far) dist = far;
  targetPos[0] = f32(targetInterest[0] + xOff);
  targetPos[1] = f32(targetInterest[1] - yOff);
  targetPos[2] = f32(targetInterest[2] + dist);
}

// lbvector.c's sine and cosine: quintics for (-pi, pi), the cubic term subtracted with the linear product fused
// and the a * (c5 a^4) product fused into the sum (lbVector_Sin, lbVector_Cos)
export function lbSin(angle: number): number {
  angle = f32(angle);
  if (angle > Math.PI) angle = f32(angle - 2 * Math.PI);
  else if (angle < -Math.PI) angle = f32(angle + 2 * Math.PI);
  const a3 = f32(f32(f32(f32(0.15527099370956421) * angle) * angle) * angle);
  const a4 = f32(f32(f32(f32(f32(0.0056429998949170113) * angle) * angle) * angle) * angle);
  return madd(angle, a4, msub(f32(0.9878619909286499), angle, a3));
}
export function lbCos(angle: number): number {
  return lbSin(f32(f32(angle) + Math.PI / 2));
}

/** lbVector_Rotate: v turned by angle about axis 1 (x), 2 (y) or 4 (z); each two-product term an fmadds or
 *  fmsubs with the first product fused, the second rounded first */
export function lbVectorRotate(v: number[], axis: 1 | 2 | 4, angle: number): number[] {
  const s = lbSin(angle), c = lbCos(angle);
  const x = v[0], y = v[1], z = v[2];
  if (axis === 1) { v[1] = msub(y, c, f32(z * s)); v[2] = madd(y, s, f32(z * c)); }
  else if (axis === 2) { v[0] = madd(x, c, f32(z * s)); v[2] = msub(z, c, f32(x * s)); }
  else { v[0] = msub(x, c, f32(y * s)); v[1] = madd(x, s, f32(y * c)); }
  return v;
}

/** lbVector_Normalize: by 1 / its length (MSL's sqrtf of the squares, the struct's fields: not fused) */
export function lbVectorNormalize(v: number[]): number {
  const len = sqrtf(f32(f32(f32(v[0] * v[0]) + f32(v[1] * v[1])) + f32(v[2] * v[2])));
  if (len === 0) return 0;
  const inv = f32(1 / len);
  v[0] = f32(v[0] * inv); v[1] = f32(v[1] * inv); v[2] = f32(v[2] * inv);
  return len;
}

const corner = [0, 0, 0];

// the picture's four corners, cast onto the stage's plane: if one reaches past the camera range, the target
// moves back in by as much (the game's correction, Camera_8002A768, as the match calls it: arg1 0)
export function cameraCorrect(st: StageCamera, pos: number[], interest: number[], half: number) {
  const left = f32(st.left), right = f32(st.right), top = f32(st.top), bottom = f32(st.bottom);
  const d = [f32(interest[0] - pos[0]), f32(interest[1] - pos[1]), f32(interest[2] - pos[2])];
  lbVectorNormalize(d);
  const pitch = atan2f(d[1], -d[2]), yaw = atan2f(-d[0], -d[2]);
  let leftO = 0, rightO = 0, topO = 0, bottomO = 0, hit = 0;
  // top left, top right, bottom right, bottom left (cm_WorldForward turned)
  for (const [sy, sx] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const v = corner;
    v[0] = 0; v[1] = 0; v[2] = -1;
    lbVectorRotate(v, 1, sy > 0 ? half : -half);
    lbVectorRotate(v, 2, sx > 0 ? half : -half);
    v[0] = f32(v[0] * ASPECT);
    lbVectorNormalize(v);
    lbVectorRotate(v, 1, pitch);
    lbVectorRotate(v, 2, yaw);
    if (!(v[2] < f32(-0.001))) continue;
    const t = f32(-pos[2] / v[2]);
    const px = f32(f32(v[0] * t) + pos[0]), py = f32(f32(v[1] * t) + pos[1]);
    // which corner: top (sy 1) or bottom, and left (sx 1) or right
    if (sx > 0 && px < left && f32(left - px) > leftO) { leftO = f32(left - px); hit |= 4; }
    if (sx < 0 && px > right && f32(right - px) < rightO) { rightO = f32(right - px); hit |= 8; }
    if (sy > 0 && py > top && f32(top - py) < topO) { topO = f32(top - py); hit |= 1; }
    if (sy < 0 && py < bottom && f32(bottom - py) > bottomO) { bottomO = f32(bottom - py); hit |= 2; }
  }
  if (!hit) return;
  const cx = hit & 4 && hit & 8 ? f32(0.5 * f32(leftO + rightO)) : hit & 4 ? leftO : hit & 8 ? rightO : 0;
  const cy = hit & 1 && hit & 2 ? f32(0.5 * f32(bottomO + topO)) : hit & 1 ? topO : hit & 2 ? bottomO : 0;
  pos[0] = f32(pos[0] + cx); pos[1] = f32(pos[1] + cy); interest[0] = f32(interest[0] + cx); interest[1] = f32(interest[1] + cy);
}


// ---------------------------------------------------------------- the camera's matrices, as the game makes them

/** the near and far planes the match camera's CObj is given (Camera_8002A4AC: game_camera.nearz, farz, 0.1 and
 *  16384 from the camera's start) */
export const CAM_NEAR = 0.1, CAM_FAR = 16384;

/** the stages whose code gives the camera planes of its own (Camera_800311DC near, Camera_800311CC far), by the
 *  replay's stage id: Mushroom Kingdom (grinishie1.c) and Mushroom Kingdom II (grinishie2.c) 1 and 4000, Flat Zone
 *  (grflatzone.c) 1 and 1000, Final Destination (grlast.c) 1 and 30000 */
const STAGE_PLANES: Record<number, [number, number]> = { 19: [1, 4000], 20: [1, 4000], 27: [1, 1000], 32: [1, 30000] };

/** the match camera's near and far planes on this stage */
export function cameraPlanes(stageId: number | null | undefined): [number, number] {
  return (stageId != null && STAGE_PLANES[stageId]) || DEFAULT_PLANES;
}
const DEFAULT_PLANES: [number, number] = [CAM_NEAR, CAM_FAR];
/** the match camera's aspect (cm_803BCB64.aspect) */
export const CAM_ASPECT = ASPECT;

const viewScratch = new Float32Array(12), eyeScratch = [0, 0, 0], atScratch = [0, 0, 0];

/** the view matrix of the camera at `eye` looking at `interest` (column major, for the renderer), made as
 *  HSD_CObjSetupViewingMtx makes it: its up from its roll (0: the match camera's), C_MTXLookAt, in float32 */
export function gameView(out: Float32Array, eye: ArrayLike<number>, interest: ArrayLike<number>, roll = 0): Float32Array {
  for (let i = 0; i < 3; i++) { eyeScratch[i] = eye[i]; atScratch[i] = interest[i]; }
  cobjViewingMtx(viewScratch, eyeScratch, atScratch, roll);
  return mtxToGL(viewScratch, out);
}

/** the projection of a camera with this vertical field of view (degrees): GX's, as makeProjectionMtx makes it
 *  (C_MTXPerspective), into `gx` (row major, as GX is loaded with it) and as GL takes it into `out` */
export function gameProjection(out: Float32Array, gx: Float32Array, fovDeg: number, aspect = CAM_ASPECT,
                               near = CAM_NEAR, far = CAM_FAR): Float32Array {
  C_MTXPerspective(gx, fovDeg, aspect, near, far);
  return projectionToGL(gx, out);
}
