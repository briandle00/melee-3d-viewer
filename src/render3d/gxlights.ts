/* 3D replay viewer: the lights as GX is loaded with them, for a view.
 *
 * HSD lights a vertex in view space: HSD_LObjSetup hands GX each light
 * through the camera's view matrix, in single precision -
 *  - an infinite light: its LObj position, 2^20 times over, as a point
 *    (setup_infinite_lightobj: MTXMultVec), so its way to each vertex is
 *    that far point's;
 *  - a point or spot light: its position (MTXMultVec), a spot its light
 *    vector (HSD_LObjGetLightVector: interest - position, normalized, then
 *    PSMTXMultVecSR and PSVECNormalize), which GXInitLightDir stores negated:
 *    toward the light;
 *  - its specular light (setup_spec_lightobj): a point's position through
 *    the view, an infinite light's light vector through it and normalized;
 *    and each joint drawn with a specular material has the half-way
 *    direction between that and the way to the joint worked out on the CPU
 *    (HSD_LObjSetupSpecularInit), which GXInitLightDir again negates.
 * A fighter's color animation light (ftCo_8009F5AC's x588) is an infinite
 * light like the rest. All of it in float32 through gxmath.
 */
import type { Lighting } from "./lightset";
import { PSMTXMultVec, PSMTXMultVecSR, PSVECAdd, PSVECNormalize, PSVECSubtract, f32, madd } from "./gxmath";

/** the view-space lights: per light (8 x vec4) its position, its spot axis (toward the light), its specular
 *  light vector (an infinite light's way, a point's position); the color animation's light's position */
export interface ViewLights {
  pos: Float32Array; axis: Float32Array; lvec: Float32Array; over: Float32Array;
}

export const newViewLights = (): ViewLights => ({
  pos: new Float32Array(32), axis: new Float32Array(32), lvec: new Float32Array(32), over: new Float32Array(4),
});

const BIG = 1048576;
const vA = [0, 0, 0], vB = [0, 0, 0], vC = [0, 0, 0];

/** a point (or direction, w 0) 2^20 times over when infinite, through the view (3 x 4, GX's Mtx) */
function point(V: Float32Array, x: number, y: number, z: number, far: boolean, out: number[]) {
  vA[0] = f32(x); vA[1] = f32(y); vA[2] = f32(z);
  if (far) { vA[0] = f32(vA[0] * BIG); vA[1] = f32(vA[1] * BIG); vA[2] = f32(vA[2] * BIG); }
  return PSMTXMultVec(V, vA, out);
}

/** HSD_LObjGetLightVector through the view: interest - position, normalized, turned by the view, normalized */
function lightVector(V: Float32Array, px: number, py: number, pz: number, ix: number, iy: number, iz: number, out: number[]) {
  vA[0] = f32(ix); vA[1] = f32(iy); vA[2] = f32(iz);
  vB[0] = f32(px); vB[1] = f32(py); vB[2] = f32(pz);
  PSVECSubtract(vA, vB, vC);
  PSVECNormalize(vC, vC);
  PSMTXMultVecSR(V, vC, out);
  return PSVECNormalize(out, out);
}

const tmp = [0, 0, 0];

/** the lights of `l` as HSD_LObjSetup loads them for the view V (GX's Mtx), and the color animation's light
 *  from its direction (null: none) */
export function lightsInView(l: Lighting, V: Float32Array, overDir: ArrayLike<number> | null, out: ViewLights): ViewLights {
  for (let k = 0; k < l.n; k++) {
    const o = k * 4, w = l.pos[o + 3], Q = l.place, I = l.interest;
    point(V, Q[o], Q[o + 1], Q[o + 2], w === 0, tmp);
    out.pos[o] = tmp[0]; out.pos[o + 1] = tmp[1]; out.pos[o + 2] = tmp[2]; out.pos[o + 3] = 1;
    out.axis[o] = out.axis[o + 1] = out.axis[o + 2] = out.axis[o + 3] = 0;
    if (w === 0) {
      // (setup_spec_lightobj's infinite light: its light vector, interest - position: the interest the origin)
      lightVector(V, Q[o], Q[o + 1], Q[o + 2], 0, 0, 0, tmp);
      out.lvec[o] = tmp[0]; out.lvec[o + 1] = tmp[1]; out.lvec[o + 2] = tmp[2]; out.lvec[o + 3] = 0;
    } else {
      out.lvec[o] = out.pos[o]; out.lvec[o + 1] = out.pos[o + 1]; out.lvec[o + 2] = out.pos[o + 2]; out.lvec[o + 3] = 1;
      if (I[o + 3]) {
        // (a spot: its light vector, negated by GXInitLightDir: toward the light)
        lightVector(V, Q[o], Q[o + 1], Q[o + 2], I[o], I[o + 1], I[o + 2], tmp);
        out.axis[o] = -tmp[0]; out.axis[o + 1] = -tmp[1]; out.axis[o + 2] = -tmp[2];
      } else {
        // (a spot without an interest of its own: the lighting's axis through the view)
        vA[0] = -l.axis[o]; vA[1] = -l.axis[o + 1]; vA[2] = -l.axis[o + 2];
        PSVECNormalize(vA, vA);
        PSMTXMultVecSR(V, vA, tmp);
        PSVECNormalize(tmp, tmp);
        out.axis[o] = -tmp[0]; out.axis[o + 1] = -tmp[1]; out.axis[o + 2] = -tmp[2];
      }
    }
  }
  if (overDir) {
    point(V, overDir[0], overDir[1], overDir[2], true, tmp);
    out.over[0] = tmp[0]; out.over[1] = tmp[1]; out.over[2] = tmp[2]; out.over[3] = 1;
  } else out.over.fill(0);
  return out;
}

/** where a joint is in view space as its modelview has it: the view times the joint's world translation, as
 *  PSMTXConcat makes the modelview's last column (the translation HSD_LObjSetupSpecularInit reads, pmtx[*][3]) */
export function jointInView(V: Float32Array, x: number, y: number, z: number, out: number[]): number[] {
  for (let r = 0; r < 3; r++) {
    let v = f32(V[r * 4] * x);
    v = madd(V[r * 4 + 1], y, v);
    v = madd(V[r * 4 + 2], z, v);
    out[r] = madd(1, V[r * 4 + 3], v);
  }
  return out;
}

const cdir = [0, 0, 0], half = [0, 0, 0], ldir = [0, 0, 0];

/** HSD_LObjSetupSpecularInit for a joint at jpos (view space): each specular light's half-way direction between
 *  its light vector (or the way from it to the joint) and the way to the joint, normalized - as GXInitLightDir
 *  stores it, negated - into out (8 x vec4) */
export function specularDirs(l: Lighting, v: ViewLights, jpos: number[], out: Float32Array): Float32Array {
  PSVECNormalize(jpos, cdir);
  for (let k = 0; k < l.n; k++) {
    const o = k * 4;
    if (v.lvec[o + 3] === 0) {
      tmp[0] = v.lvec[o]; tmp[1] = v.lvec[o + 1]; tmp[2] = v.lvec[o + 2];
      PSVECAdd(tmp, cdir, half);
    } else {
      tmp[0] = v.lvec[o]; tmp[1] = v.lvec[o + 1]; tmp[2] = v.lvec[o + 2];
      PSVECSubtract(jpos, tmp, ldir);
      PSVECNormalize(ldir, ldir);
      PSVECAdd(ldir, cdir, half);
    }
    PSVECNormalize(half, half);
    out[o] = -half[0]; out[o + 1] = -half[1]; out[o + 2] = -half[2]; out[o + 3] = 0;
  }
  return out;
}
