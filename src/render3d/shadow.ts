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
import { lbVectorNormalize } from "./camera";
import {
  C_MTXLightOrtho, C_MTXLookAt, C_MTXOrtho, f32, mtxToGL, nmsub, projectionToGL, PSMTXConcat, PSVECAdd,
  PSVECCrossProduct, PSVECDotProduct, PSVECNormalize, PSVECScale, PSVECSubtract, sqrtf,
} from "./gxmath";
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
  /** the projection as GX has it (row major, C_MTXOrtho's): what the draw log reads */
  gx: Float32Array;
}

/** the shadow camera of a fighter, in single precision op for op as the game makes it (lbShadow_8000F38C, then
 *  HSD_ShadowStartRender's HSD_CObjSetCurrent and HSD_ShadowEndRender's makeMatrix): `pos` and `interest` the
 *  shadow light's (HSD_LObjGetPosition / HSD_LObjGetInterest, world), `bone` the fighter's camera bone (its camera
 *  box's bone_pos: ftLib_800866DC), `depth` its camera box's target_ext.v.z; null when the light is where its
 *  interest is (the game then flags the fighter's shadow off: fp->x20A4.x0_b0) */
export function shadowCamera(pos: number[], interest: number[] | null, bone: number[], depth: number): ShadowCamera | null {
  // the light's way: its place less its interest (lbVector_Sub), the interest then 0
  const lightPos = [f32(pos[0]), f32(pos[1]), f32(pos[2])];
  const lightDir = [0, 0, 0];
  if (interest) for (let i = 0; i < 3; i++) lightPos[i] = f32(lightPos[i] - f32(interest[i]));
  const v = [f32(lightPos[0] - lightDir[0]), f32(lightPos[1] - lightDir[1]), f32(lightPos[2] - lightDir[2])];
  // (dist only decides: z^2 + (x^2 + y^2), my_sqrtf)
  const dist = sqrtf(f32(f32(v[2] * v[2]) + f32(f32(v[0] * v[0]) + f32(v[1] * v[1]))));
  if (dist < f32(0.001)) return null;
  let up: number[];
  if (f32(f32(v[0] * v[0]) + f32(v[2] * v[2])) > f32(0.0000010000001)) {
    up = [0, 1, 0];
    const n = [f32(lightDir[0] - lightPos[0]), f32(lightDir[1] - lightPos[1]), f32(lightDir[2] - lightPos[2])];
    // (a light nearer than 100 is put 100 away the same way: -(100 n - dir), one fused fmsubs)
    if (lbVectorNormalize(n) < 100) for (let i = 0; i < 3; i++) lightPos[i] = nmsub(100, n[i], lightDir[i]);
    const right = PSVECCrossProduct(up, n, [0, 0, 0]) as number[];
    lbVectorNormalize(right);
    up = PSVECCrossProduct(n, right, [0, 0, 0]) as number[];
    lbVectorNormalize(up);
  } else up = [0, 0, -1];
  const eye = PSVECAdd(bone, lightPos, [0, 0, 0]);
  const at = PSVECAdd(bone, lightDir, [0, 0, 0]);
  // the camera's up: HSD_CObjSetUpVector (flag 1) keeps it normalized (vec_normalize_check)
  const tiny = 1.1754943508222875e-38;
  const camUp = Math.abs(up[0]) <= tiny && Math.abs(up[1]) <= tiny && Math.abs(up[2]) <= tiny
    ? [0, 1, 0] : PSVECNormalize(up, [0, 0, 0]);
  // the box: HSD_ViewingRectInit (orthographic), HSD_ViewingRectAddRect at the bone, 1.2 times the depth each way
  const eyeV = PSVECSubtract(at, eye, [0, 0, 0]);
  const eyeVn = PSVECNormalize(eyeV, [0, 0, 0]);
  const upN = PSVECNormalize(up, [0, 0, 0]);
  const rightV = PSVECCrossProduct(eyeVn, upN, [0, 0, 0]);
  const upV = PSVECCrossProduct(rightV, eyeVn, [0, 0, 0]);
  const top = f32(f32(1.2) * f32(depth)), bot = f32(f32(1.2) * f32(-depth));
  const o2p = PSVECSubtract(bone, eye, [0, 0, 0]);
  const dot = PSVECDotProduct(o2p, eyeVn);
  const e2p = PSVECSubtract(o2p, PSVECScale(eyeVn, [0, 0, 0], dot), [0, 0, 0]);
  const x = PSVECDotProduct(rightV, e2p), y = PSVECDotProduct(upV, e2p);
  let rTop = f32(y + top), rBottom = f32(y + bot), rLeft = f32(x + bot), rRight = f32(x + top);
  // (a box that is not one - no depth - is tried 20 times, then the game's fixed one: HSD_CObjSetOrtho(128, -128, -128, 128))
  if (!(rTop > rBottom && rRight > rLeft)) { rTop = 128; rBottom = -128; rLeft = -128; rRight = 128; }
  // the view (HSD_CObjSetupViewingMtx: C_MTXLookAt) and the projection (makeProjectionMtx: C_MTXOrtho, near 0.001,
  // far 5000: lbShadow_8000ED54)
  const V = C_MTXLookAt(new Float32Array(12), eye, camUp, at);
  const gx = C_MTXOrtho(new Float32Array(16), rTop, rBottom, rLeft, rRight, 0.001, 5000);
  const view = mtxToGL(V, new Float32Array(16));
  const proj = projectionToGL(gx, new Float32Array(16));
  const viewProj = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += proj[k * 4 + r] * view[c * 4 + k];
    viewProj[c * 4 + r] = sum;
  }
  // the texture's: makeMatrix's C_MTXLightOrtho(top, bottom, left, right, 0.45, -0.45, 0.5, 0.5) times the view
  // (PSMTXConcat), t turned over for a picture drawn bottom row first (GL's: 1 - t)
  const L = C_MTXLightOrtho(new Float32Array(12), rTop, rBottom, rLeft, rRight, 0.45, -0.45, 0.5, 0.5);
  const T = PSMTXConcat(L, V, new Float32Array(12));
  const tex = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    tex[c * 4] = T[c];
    tex[c * 4 + 1] = c === 3 ? 1 - T[4 + c] : -T[4 + c];
  }
  tex[15] = 1;
  return { view, proj, viewProj, tex, gx };
}

/** the shadow's gray as the copy keeps it: the copy takes the red channel's
 *  top four bits (GXSetTexCopyDst's 0x20, R4), read back as I4 */
export function shadowGray(intensity: number): number {
  const n = Math.max(0, Math.min(255, intensity | 0)) >> 4;
  return ((n << 4) | n) / 255;
}
