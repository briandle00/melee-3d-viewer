/* 3D replay viewer: the game's particles as quads to draw.
 *
 * As the game's particle display (psdisp.c) builds them: a square facing
 * the camera, `size` from its middle to each side, turned by the
 * particle's rotation (or along its motion); a trail stretched from where
 * it was to where it is. Color: the texture blends the environment color
 * into the primary one (or the primary color alone, untextured); the
 * alpha-compare the particle carries decides which pixels are drawn; the
 * blend is plain or additive. Quads sharing a texture and blend are drawn
 * together. */
import { AppSRT, K, Particle, srtApply } from "./particles";

/** a direction through a transform: scaled and turned as srtApply does, not moved */
function srtTurn(s: AppSRT, x: number, y: number, z: number): [number, number, number] {
  x *= s.sx; y *= s.sy; z *= s.sz;
  let c = Math.cos(s.rx), n = Math.sin(s.rx);
  [y, z] = [y * c - z * n, y * n + z * c];
  c = Math.cos(s.ry); n = Math.sin(s.ry);
  [x, z] = [x * c + z * n, -x * n + z * c];
  c = Math.cos(s.rz); n = Math.sin(s.rz);
  [x, y] = [x * c - y * n, x * n + y * c];
  return [x, y, z];
}

export const FLOATS = 17; // pos 3, uv 2, prim 4, env 4, alpha-compare 3, textured 1

export interface Batch {
  sprite: { key: string; w: number; h: number; rgba: Uint8Array } | null;
  additive: boolean;
  /** its texture sampled nearest (the particle's TexInterpNear), else bilinear */
  near: boolean;
  zwrite: boolean;
  nozcomp: boolean;
  first: number; // quad index
  count: number;
}

// the game's corner texture coordinates, by its flip bits (0, S, T, S+T)
const UV = [
  [0, 1, 0, 0, 1, 0, 1, 1],
  [1, 1, 1, 0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1, 1, 1, 0],
  [1, 0, 1, 1, 0, 1, 0, 0],
];

let scratch = new Float32Array(FLOATS * 4 * 256);
// (the grouping's and a quad's scratch, kept between frames)
let groupOf = new Int32Array(256), order = new Int32Array(256);
const CORNERS = new Float64Array(8);

/** a particle's color byte part-way to its target as the game draws it (getColorPrimEnv): the share left,
 *  65536 * remain / count, an integer division, then ((target << 16) + (color - target) * share) >> 16, kept
 *  to a byte as the GXColor it is stored in */
export function psColorByte(cur: number, target: number, remain: number, count: number): number {
  if (!count) return cur & 0xff;
  const scale = Math.trunc((65536 * remain) / count);
  return (((target << 16) + (cur - target) * scale) >> 16) & 0xff;
}
const shown = (cur: number, target: number, remain: number, count: number) => psColorByte(cur, target, remain, count) / 255;

const WORLD_AXES = { right: [1, 0, 0], up: [0, 1, 0] };

/** the particles as quads, grouped into batches by texture and blend, each
 *  in the plane of the camera whose right and up (world directions) are
 *  given; with its perspective projection (viewProj), a trail's or a
 *  direction particle's way across the picture is where the projection
 *  puts it and where it was, as the game's psDispSub measures it */
export function buildParticles(list: Particle[],
                               axes: { right: number[]; up: number[]; viewProj?: ArrayLike<number> } = WORLD_AXES,
                               shift: ((p: Particle) => [number, number] | null) | null = null):
    { data: Float32Array; batches: Batch[] } {
  const R = axes.right, U = axes.up;
  // Each particle's batch: its texture and blend. The batches in the order
  // of their first particle, each's particles in theirs (a stable grouping),
  // without an object or a string a particle: a frame has hundreds.
  const groups: Batch[] = [];
  const bySprite = new Map<Batch["sprite"], Batch[]>();
  if (groupOf.length < list.length) groupOf = new Int32Array(list.length * 2);
  let kept = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.dead || p.size < 1e-7 || p.kind & K.POINT) { groupOf[i] = -1; continue; }
    const sprite = p.kind & K.DISP_TEX ? p.bank.image(p.texGroup, p.pose) : null;
    const additive = ((p.kind >>> 22) & 3) === 1;
    const zwrite = (p.kind & K.TEXEDGE) !== 0;
    const noz = (p.kind & K.NOZCOMP) !== 0;
    const near = (p.kind & K.TEX_NEAR) !== 0;
    let same = bySprite.get(sprite);
    if (!same) bySprite.set(sprite, (same = []));
    let g = same.find((b) => b.additive === additive && b.zwrite === zwrite && b.nozcomp === noz && b.near === near);
    if (!g) { g = { sprite, additive, near, zwrite, nozcomp: noz, first: groups.length, count: 0 }; same.push(g); groups.push(g); }
    g.count++;
    groupOf[i] = g.first;
    kept++;
  }
  // each batch's first quad, then the particles into their places
  let at = 0;
  for (const g of groups) { const c = g.count; g.count = 0; (g as { at?: number }).at = at; at += c; }
  if (order.length < kept) order = new Int32Array(kept * 2);
  for (let i = 0; i < list.length; i++) {
    const gi = groupOf[i];
    if (gi < 0) continue;
    const g = groups[gi] as Batch & { at: number };
    order[g.at + g.count++] = i;
  }
  for (const g of groups) { g.first = (g as { at?: number }).at!; delete (g as { at?: number }).at; }
  const batches = groups;
  const need = kept * 4 * FLOATS;
  if (scratch.length < need) scratch = new Float32Array(need * 2);
  const out = scratch;
  let o = 0;
  for (let qi = 0; qi < kept; qi++) {
    const p = list[order[qi]];
    const textured = groups[groupOf[order[qi]]].sprite ? 1 : 0;
    // where it is, and how big, through its transform
    let cx = p.px, cy = p.py, cz = p.pz, scale = 1;
    let wx = p.vx, wy = p.vy, wz = p.vz;
    if (p.srt) {
      [cx, cy, cz] = srtApply(p.srt, p.px, p.py, p.pz);
      [wx, wy, wz] = srtTurn(p.srt, p.vx, p.vy, p.vz);
      scale = Math.abs(p.srt.sx);
    }
    // (drawn somewhere else than the game has it: the HUD's, at this player's own HUD's place)
    const moved = shift ? shift(p) : null;
    if (moved) { cx += moved[0]; cy += moved[1]; }
    // its motion as the camera sees it (across and up the picture): with a perspective camera, from where it is
    // and where it was (one step of its velocity back) as the projection puts them (psDispSub); else its
    // velocity in the camera's plane
    let vx = wx * R[0] + wy * R[1] + wz * R[2], vy = wx * U[0] + wy * U[1] + wz * U[2];
    const P = axes.viewProj;
    if (P && (p.kind & (K.TRAIL | K.DIRVEC))) {
      const qx = cx - wx, qy = cy - wy, qz = cz - wz;
      const w0 = P[3] * cx + P[7] * cy + P[11] * cz + P[15], w1 = P[3] * qx + P[7] * qy + P[11] * qz + P[15];
      if (w0 !== 0 && w1 !== 0) {
        vx = (P[0] * cx + P[4] * cy + P[8] * cz + P[12]) / w0 - (P[0] * qx + P[4] * qy + P[8] * qz + P[12]) / w1;
        vy = (P[1] * cx + P[5] * cy + P[9] * cz + P[13]) / w0 - (P[1] * qx + P[5] * qy + P[9] * qz + P[13]) / w1;
      }
    }
    const size = p.size * scale;
    // the game turns a quad clockwise (about the axis away from the
    // camera): by its rotation, or to point along its motion
    let turn = p.rotate;
    const trail = (p.kind & K.TRAIL) !== 0;
    if (trail || p.kind & K.DIRVEC) {
      turn = Math.abs(vy) < 1e-30 ? (vx >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(vx, vy);
      if (p.kind & K.DIRVEC) turn += p.rotate;
    }
    const angle = -turn;
    const c = Math.cos(angle), s = Math.sin(angle);
    // the game's diagonal basis: R = right + up, U = right - up, turned
    const rx = (c - s) * size, ry = (s + c) * size, ux = (c + s) * size, uy = (s - c) * size;
    // corners, across and up the picture from its middle: -R, -U, +R, +U
    // (a trail's first and last from where it was: one step of its velocity back, in the world - psDispSubMakePolygon)
    const corners = CORNERS;
    corners[0] = -rx; corners[1] = -ry; corners[2] = -ux; corners[3] = -uy;
    corners[4] = rx; corners[5] = ry; corners[6] = ux; corners[7] = uy;
    const uv = UV[((p.kind >>> 18) & 3)];
    const ms = p.kind & K.MIRROR_S ? 2 : 1, mt = p.kind & K.MIRROR_T ? 2 : 1, mtOff = p.kind & K.MIRROR_T ? 1 : 0;
    const pr = shown(p.prim.r, p.primTarget.r, p.primRemain, p.primCount);
    const pg = shown(p.prim.g, p.primTarget.g, p.primRemain, p.primCount);
    const pb = shown(p.prim.b, p.primTarget.b, p.primRemain, p.primCount);
    const pa = shown(p.prim.a, p.primTarget.a, p.primRemain, p.primCount);
    const primEnv = (p.kind & K.PRIMENV) !== 0;
    const er = primEnv ? shown(p.env.r, p.envTarget.r, p.envRemain, p.envCount) : 0;
    const eg = primEnv ? shown(p.env.g, p.envTarget.g, p.envRemain, p.envCount) : 0;
    const eb = primEnv ? shown(p.env.b, p.envTarget.b, p.envRemain, p.envCount) : 0;
    const ea = primEnv ? shown(p.env.a, p.envTarget.a, p.envRemain, p.envCount) : 0;
    const a1 = p.aCmpCount ? p.aCmp1Target + ((p.aCmp1 - p.aCmp1Target) * p.aCmpRemain) / p.aCmpCount : p.aCmp1;
    const a2 = p.aCmpCount ? p.aCmp2Target + ((p.aCmp2 - p.aCmp2Target) * p.aCmpRemain) / p.aCmpCount : p.aCmp2;
    for (let k = 0; k < 4; k++) {
      const a = corners[k * 2], b = corners[k * 2 + 1];
      const back = trail && (k === 0 || k === 3) ? 1 : 0;
      const ox = cx - back * wx, oy = cy - back * wy, oz = cz - back * wz;
      out[o++] = ox + a * R[0] + b * U[0]; out[o++] = oy + a * R[1] + b * U[1]; out[o++] = oz + a * R[2] + b * U[2];
      out[o++] = uv[k * 2] * ms; out[o++] = uv[k * 2 + 1] * mt + mtOff;
      const fade = trail && (k === 0 || k === 3) ? p.trail : 1;
      out[o++] = pr; out[o++] = pg; out[o++] = pb; out[o++] = pa * fade;
      out[o++] = er; out[o++] = eg; out[o++] = eb; out[o++] = ea * fade;
      out[o++] = p.aCmpMode; out[o++] = a1; out[o++] = a2;
      out[o++] = textured;
    }
  }
  return { data: out.subarray(0, o), batches };
}
