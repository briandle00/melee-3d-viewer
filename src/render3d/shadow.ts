/* 3D replay viewer: a fighter's shadow, as the game makes it.
 *
 * lbShadow_8000F38C, before the stage is drawn: for each fighter an
 * orthographic camera (HSD_Shadow, lbShadow_8000ED54) looks at its camera
 * bone from the fighters' shadow light, over a square 1.2 times its camera
 * box's depth each way; the fighter is drawn into a 256 x 256 picture
 * cleared white, in one flat gray (the stage's shadow intensity), and the
 * picture copied out as a texture (HSD_ShadowStartRender, HSD_ShadowEndRender).
 * Every material that takes shadows (RENDER_SHADOW) multiplies its color by
 * each such texture, at coordinates from the point's place through the
 * shadow camera (makeMatrix's MTXLightOrtho, TEX_COORD_SHADOW).
 */
import type { Light } from "./hsd";
import type { Mat } from "./math";

/** the shadow pictures' size (HSD_ShadowSetSize in lbShadow_8000ED54) */
export const SHADOW_SIZE = 256;

/** the light the shadows come from: the first of the fighters' lights flagged
 *  0x400 (a stage's light override's bit 0x20), else the last one that is not
 *  an ambient light; its place (at the stage's scale, as the fighters' set is
 *  made: Ground_801C2374) and its interest, if it has one */
export function pickShadowLight<T extends Light>(lights: T[]): T | null {
  let last: T | null = null;
  for (const l of lights) {
    if (l.kind !== "ambient") last = l;
    if (l.flags & 0x400) return l;
  }
  return last;
}

export interface ShadowCamera {
  /** world to view, the projection (GL), and the two together: world to the picture's clip space */
  view: Mat;
  proj: Mat;
  viewProj: Mat;
  /** world to the shadow texture's (s, t) (rows 0 and 1; column-major), for
   *  a picture drawn the GL way up */
  tex: Mat;
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** the shadow camera of a fighter (lbShadow_8000F38C): the light's place and
 *  interest, the fighter's camera bone, and its camera box's depth (the box's
 *  target_ext.v.z); null when the light is where its interest is */
export function shadowCamera(pos: number[], interest: number[] | null, bone: number[], depth: number): ShadowCamera | null {
  // (the light's way: its place less its interest; what it looks at, 0)
  let L = interest ? [pos[0] - interest[0], pos[1] - interest[1], pos[2] - interest[2]] : [pos[0], pos[1], pos[2]];
  const len = Math.hypot(L[0], L[1], L[2]);
  if (len < 0.001) return null;
  let up: number[];
  if (L[0] * L[0] + L[2] * L[2] > 0.0000010000001) {
    up = [0, 1, 0];
    const n = norm([-L[0], -L[1], -L[2]]);
    // (a light nearer than 100 is put 100 away, the same way)
    if (len < 100) L = [-100 * n[0], -100 * n[1], -100 * n[2]];
    const right = norm(cross(up, n));
    up = norm(cross(n, right));
  } else up = [0, 0, -1];
  const eye = [bone[0] + L[0], bone[1] + L[1], bone[2] + L[2]];
  // the view (MTXLookAt: eye, up, interest)
  const z = norm([eye[0] - bone[0], eye[1] - bone[1], eye[2] - bone[2]]);
  const x = norm(cross(up, z)), y = cross(z, x);
  const view = new Float32Array(16);
  view[0] = x[0]; view[4] = x[1]; view[8] = x[2]; view[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  view[1] = y[0]; view[5] = y[1]; view[9] = y[2]; view[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  view[2] = z[0]; view[6] = z[1]; view[10] = z[2]; view[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  view[15] = 1;
  // the box (HSD_ViewingRectAddRect at the bone, on the camera's axis: HSD_ShadowSetViewingRect's ortho)
  const h = 1.2 * depth, near = 0.001, far = 5000;
  const viewProj = new Float32Array(16);
  // (an ortho of top h, bottom -h, left -h, right h, times the view)
  const P = [1 / h, 1 / h, -2 / (far - near), -(far + near) / (far - near)];
  const proj = new Float32Array(16);
  proj[0] = P[0]; proj[5] = P[1]; proj[10] = P[2]; proj[14] = P[3]; proj[15] = 1;
  for (let c = 0; c < 4; c++) {
    viewProj[c * 4] = P[0] * view[c * 4];
    viewProj[c * 4 + 1] = P[1] * view[c * 4 + 1];
    viewProj[c * 4 + 2] = P[2] * view[c * 4 + 2] + (c === 3 ? P[3] : 0);
    viewProj[c * 4 + 3] = c === 3 ? 1 : 0;
  }
  // MTXLightOrtho(h, -h, -h, h, 0.45, -0.45, 0.5, 0.5) times the view: s = 0.45 x / h + 0.5, and t the same of y
  // turned over (the game's picture has its top row first; this one is drawn bottom row first)
  const tex = new Float32Array(16);
  const k = 0.45 / h;
  for (let c = 0; c < 4; c++) {
    tex[c * 4] = k * view[c * 4] + (c === 3 ? 0.5 : 0);
    tex[c * 4 + 1] = k * view[c * 4 + 1] + (c === 3 ? 0.5 : 0);
  }
  tex[15] = 1;
  return { view, proj, viewProj, tex };
}

/** the shadow's gray as the copy keeps it: the copy takes the red channel's
 *  top four bits (GXSetTexCopyDst's 0x20, R4), read back as I4 */
export function shadowGray(intensity: number): number {
  const n = Math.max(0, Math.min(255, intensity | 0)) >> 4;
  return ((n << 4) | n) / 255;
}
