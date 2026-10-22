/* 3D replay viewer: a posed HSD joint tree, the pieces of mesh
 * hanging off it, and the material values its animations change.
 *
 * A frame costs no allocation: the pose, the world matrices and every
 * drawable's skinning matrices live in arrays made once, and the renderer
 * skins on the GPU from those matrices. */
import {
  AObj, Archive, DObj, Image, JObj, JOBJ, MatAnim, Mesh, MObj, PObj, TObj, Tlut, Track,
  aobjFrame, decodePObj, sample, splineAt,
} from "./hsd";
import { Mat, ident, invert, mul } from "./math";
import {
  HSD_MtxSRT, PSMTXConcat, PSMTXIdentity, PSMTXInverse, PSMTXMultVec, concatGL, madd, mkBillBoardMtx, mtxFromGL, mtxToGL,
} from "./gxmath";

/** what a texture animation can change, per TObj */
export interface TexState {
  tobj: TObj;
  image: Image;
  tlut: Tlut | null;
  /** the TObj's own TEV colors (konst, tev0, tev1: 4 floats each), as its
   *  animation leaves them; null without one */
  tevColors: Float32Array | null;
  translate: [number, number];
  scale: [number, number];
  rotate: number;
  /** its turn about x and y (HSD_A_T_ROTX, ROTY): a turn about y folds the
   *  texture onto one column (Fountain of Dreams' pond rings) */
  rotX: number;
  rotY: number;
  blending: number;
  /** the renderer's own cache for it (its GL texture and matrix), by renderer */
  gl?: { owner: object; cache: unknown };
}

/** what a material animation can change, per DObj */
export interface MatState {
  mobj: MObj;
  diffuse: Float32Array; // rgba
  ambient: Float32Array; // rgba
  specular: Float32Array; // rgba
  alpha: number;
  tex: TexState[];
  /** set by the stage for placeholder colors its code fills in (FD's trims) */
  override: Float32Array | null;
  /** texture stages not to draw: images the game renders into at runtime */
  skip: Set<TObj> | null;
  /** texture stages drawn from the stage's mirror image (Fountain of Dreams' pond) */
  mirror: Set<TObj> | null;
  /** the renderer's own cache for it (its program, packed), by renderer */
  gl?: { owner: object; cache: unknown };
  /** whether anything may have changed it since it was last reset (what
   *  changes one says so; resetting one that is as it was is skipped) */
  dirty?: boolean;
}

/** a skeleton's meshes, together (the renderer gives them one set of buffers) */
export interface DrawGroup { tag: string; drawables: Drawable[] }

export interface Drawable {
  key: string; // stable per archive + pobj: the renderer's buffers are keyed on it
  archive: Archive;
  dobj: DObj;
  pobj: PObj;
  jobj: JObj;
  mesh: Mesh;
  mats: Float32Array; // up to 10 world-space matrices (16 floats each)
  nMats: number;
  // the envelope, as joint indices and weights (one entry per matrix)
  env: { joints: Int32Array; weights: Float32Array; u?: number }[];
  node: 0 | 1 | 2 | 3; // envelope node matrix: 0 none, 1 constant, 2 world(s)*inv(world(j)), 3 with invBind(s)
  nodeJoint: number;
  /** a rigid mesh's second joint (matrix 1 of a shared-vertex skin), or -1 */
  second: number;
  /** how many of `mats` its own joints fill; the rest, up to nMats (every
   *  index its vertices name), repeat the first */
  filled: number;
  nodeConst: Mat | null;
  state: MatState;
  translucent: boolean;
  /** changes whenever its matrices do (the renderer uploads them only then) */
  stamp: number;
  /** its mesh's bounding sphere, once the renderer has worked it out */
  sphere?: Float32Array;
  /** the pose its matrices are of (Skeleton.update's count of poses that changed something) */
  posedAt?: number;
  /** the model it is part of: the skeleton's meshes, under its tag */
  group?: DrawGroup;
  /** the renderer's own note of its buffers */
  gpu?: { owner: object; epoch: number; mesh: unknown };
  /** a billboard's modelview as the game makes it (HSD_JObjMakePositionMtx: the billboard made of the view times
   *  its joint's matrix), under the billboard view numbered bbMVView; the renderer loads it as it is when it draws
   *  through that view */
  bbMV?: Float32Array | null;
  bbMVView?: number;
  /** and what it is made of, to make it again under another camera (a mirror's, a shadow's: HSD_JObjMakePositionMtx
   *  takes the vmtx of the camera drawing): its joint's matrix, its kind of billboard, whether it faces the eye
   *  (JOBJ_PBILLBOARD), its joint's turn about z */
  bbW?: Float32Array;
  bbKind?: number;
  bbPersp?: boolean;
  bbRotZ?: number;
}

let stamps = 0;

// (JObjUpdateFunc's floor for an animated scale, 1e-3F)
const MIN_SCALE = Math.fround(1e-3);
const tmpB = new Float32Array(16), tmpC = new Float32Array(16);
const tmpL = new Float32Array(12), tmpP12 = new Float32Array(12), tmpRS = new Float32Array(3);
const tmpS3 = new Float32Array(3), tmpR3 = new Float32Array(3), tmpT3 = new Float32Array(3);
const tmpP = [0, 0, 0];

// the camera the billboards face: its view matrix and that inverted (HSD
// turns a billboard in view space, then draws it there)
const bbView = ident(new Float32Array(16)), bbInv = ident(new Float32Array(16));
const bbA = new Float32Array(16), bbB = new Float32Array(16);
let bbIdentity = true;
// (each view set: a skeleton with billboards is posed again under a new one; the numbers only ever grow, so a view
// set back keeps its own and one set anew never takes an old one's)
let bbViewId = 0, bbViews = 0;
// (?noposeskip: every update poses again, for checking that skipping changes nothing)
const SKIP_SAME = typeof location === "undefined" || !new URLSearchParams(location.search).has("noposeskip");

const bbV12 = new Float32Array(12), bbW12 = new Float32Array(12), bbP12 = new Float32Array(12);

/** the number of the billboard view when it is this view (the renderer's frame view), else -1 */
export function billboardViewOf(view: ArrayLike<number>): number {
  if (bbIdentity) return -1;
  for (let k = 0; k < 16; k++) if (view[k] !== bbView[k]) return -1;
  return bbViewId;
}

/** the view the billboards face from now on (the viewer sets it each frame,
 *  before it poses anything); returns its number. With `id`, the number a call
 *  returned for this same view: the view set back (a camera's pass drawn in
 *  between - the mirror's - and the main camera's again), what was posed under
 *  it before still its own */
export function setBillboardView(view: Float32Array, id?: number): number {
  bbViewId = id ?? ++bbViews;
  bbView.set(view);
  invert(bbInv, view);
  bbIdentity = false;
  return bbViewId;
}

/** a joint that turns to face the camera (HSD's mkBillBoardMtx and kin): its
 *  world matrix carried into view space, the rotation replaced there, its
 *  scale and place kept, and carried back */
const nodeX = new Float32Array(12), nodeM = new Float32Array(12), nodeE = new Float32Array(12);

/** the node matrix of an envelope mesh on joint m whose skeleton joint (HSD_JObjFindSkeleton) is x, another joint:
 *  x's matrix - taken with its envelope matrix when x is a SKELETON joint (`envX`), alone when it is the
 *  SKELETON_ROOT (null) - times the inverse of m's, in float32 (PSMTXConcat, PSMTXInverse). This is the order the
 *  game's draws show in its recordings; read literally, _HSD_mkEnvelopeModelNodeMtx's HSD_MtxInverseConcat(x, m)
 *  would be the other one (inverse(x) times m), and the recordings say it is not. Column-major 4 x 4s at offsets;
 *  into out (16) */
export function envelopeNodeMtx(out: Float32Array, wx: Float32Array, xo: number, wm: Float32Array, mo: number,
                                envX: Float32Array | null): Float32Array {
  mtxFromGL(wx, nodeX, xo);
  if (envX) { mtxFromGL(envX, nodeE, 0); PSMTXConcat(nodeX, nodeE, nodeX); }
  mtxFromGL(wm, nodeE, mo);
  if (!PSMTXInverse(nodeE, nodeM)) PSMTXIdentity(nodeM);
  PSMTXConcat(nodeX, nodeM, nodeM);
  return mtxToGL(nodeM, out);
}

function billboard(out: Float32Array, m: Float32Array, kind: number, rotZ: number) {
  if (bbIdentity) { billboardInView(out, m, kind, rotZ); return; }
  mul(bbA, bbView, m);
  billboardInView(bbB, bbA, kind, rotZ);
  mul(out, bbInv, bbB);
}

/** the billboard's matrix, in view space (the camera looks down -z) */
function billboardInView(out: Float32Array, m: Float32Array, kind: number, rotZ: number) {
  const len = (x: number, y: number, z: number) => Math.hypot(x, y, z) || 1;
  const sx = len(m[0], m[1], m[2]), sy = len(m[4], m[5], m[6]), sz = len(m[8], m[9], m[10]);
  out.set(m);
  const put = (col: number, x: number, y: number, z: number, s: number) => {
    const l = len(x, y, z);
    out[col * 4] = (s * x) / l; out[col * 4 + 1] = (s * y) / l; out[col * 4 + 2] = (s * z) / l;
  };
  if (kind === 0x200) {
    // the y axis's lean in the screen kept, turned flat to the screen
    const ax = [m[5], -m[4], 0]; // ay x z
    put(0, ax[0], ax[1], 0, sx);
    put(1, -ax[1], ax[0], 0, sy); // z x ax
    put(2, 0, 0, 1, sz);
  } else if (kind === 0x400) {
    // upright: the y axis kept, turned about it to face the screen
    const ay = [m[4], m[5], m[6]];
    const ax = [ay[1], -ay[0], 0];
    const az = [ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]];
    put(0, ax[0], ax[1], ax[2], sx);
    put(2, az[0], az[1], az[2], sz);
  } else if (kind === 0x600) {
    // the x axis kept, turned about it to face the screen
    const ax = [m[0], m[1], m[2]];
    const az = [-ax[2], 0, ax[0]]; // ax x y
    const ay = [az[1] * ax[2] - az[2] * ax[1], az[2] * ax[0] - az[0] * ax[2], az[0] * ax[1] - az[1] * ax[0]];
    put(1, ay[0], ay[1], ay[2], sy);
    put(2, az[0], az[1], az[2], sz);
  } else {
    // flat to the screen, turned by the joint's own z rotation only
    const c = Math.cos(rotZ), s = Math.sin(rotZ);
    out[0] = c * sx; out[1] = s * sx; out[2] = 0;
    out[4] = -s * sy; out[5] = c * sy; out[6] = 0;
    out[8] = 0; out[9] = 0; out[10] = sz;
  }
}

export class Skeleton {
  readonly n: number;
  readonly parent: Int32Array;
  readonly flags: Uint32Array;
  // the pose: rest values, then whatever the animations set
  readonly rot: Float32Array;
  readonly scale: Float32Array;
  readonly trans: Float32Array;
  /** whether each joint's own meshes are drawn: its HIDDEN flag, as the
   *  animations leave it (HSD draws a joint by its own flag alone, and goes
   *  on to its children whatever it is) */
  readonly shown: Uint8Array;
  /** where each joint's subtree ends in the (preorder) joint list */
  private readonly subEnd: Int32Array;
  /** each joint's PATH track's spline joint (its AObj's object), or -1 */
  private pathOf: Int32Array | null = null;
  private readonly rest: Float32Array; // rot, scale, trans per joint (9 each)
  /** each joint's accumulated scale (jobj->scl), and whether it has one */
  private readonly accScale: Float32Array;
  private readonly hasScl: Uint8Array;
  readonly world: Float32Array; // 16 per joint
  private readonly skin: Float32Array; // world * invBind, 16 per joint
  private readonly invBind: (Mat | null)[];
  private readonly skinUsed: Int32Array;
  readonly drawables: Drawable[] = [];
  readonly states: MatState[]; // by DObj index
  /** DObj indices never drawn (a costume's unused parts) */
  readonly hidden = new Set<number>();

  constructor(public archive: Archive, public joints: JObj[], dobjs: DObj[], tag: string) {
    const n = (this.n = joints.length);
    this.parent = Int32Array.from(joints, (j) => j.parent);
    this.flags = Uint32Array.from(joints, (j) => j.flags);
    this.rot = new Float32Array(n * 3);
    this.scale = new Float32Array(n * 3);
    this.trans = new Float32Array(n * 3);
    this.shown = new Uint8Array(n);
    this.subEnd = new Int32Array(n);
    for (let i = 0; i < n; i++) this.subEnd[i] = i + 1;
    for (let i = n - 1; i > 0; i--) {
      const p = this.parent[i];
      if (p >= 0 && this.subEnd[i] > this.subEnd[p]) this.subEnd[p] = this.subEnd[i];
    }
    this.rest = new Float32Array(n * 9);
    this.accScale = new Float32Array(n * 3);
    this.hasScl = new Uint8Array(n);
    this.world = new Float32Array(n * 16);
    this.skin = new Float32Array(n * 16);
    this.invBind = joints.map((j) => j.invBind);
    joints.forEach((j, i) => {
      this.rest.set(j.rot, i * 9);
      this.rest.set(j.scale, i * 9 + 3);
      this.rest.set(j.trans, i * 9 + 6);
    });
    this.resetPose();

    this.states = dobjs.map((d) => newState(d.mobj));
    const byOffset = new Map<number, number>();
    for (const j of joints) byOffset.set(j.offset, j.index);
    const used = new Set<number>();
    // (its meshes one model: the renderer puts them in one set of buffers)
    const group: DrawGroup = { tag, drawables: this.drawables };
    for (const j of joints)
      for (const d of j.dobjs)
        d.pobjs.forEach((p, i) => {
          if (p.kind === "shape") return;
          const mesh = decodePObj(archive, p);
          if (mesh.indices.length === 0) return;
          const env = p.kind === "envelope"
            ? p.envelopes.map((list) => ({
                joints: Int32Array.from(list, (e) => byOffset.get(e.joint) ?? 0),
                weights: Float32Array.from(list, (e) => e.weight),
              }))
            : [];
          env.forEach((e) => e.joints.forEach((k) => used.add(k)));
          // HSD's shared-vertex skin: a rigid mesh whose vertices pick between
          // its joint's matrix (0) and a second joint's (1) - Dream Land's
          // flowers, rooted in the ground and bent at the head
          const second = p.kind === "rigid" && p.skinJoint !== null ? byOffset.get(p.skinJoint) ?? -1 : -1;
          const filled = p.kind === "envelope" ? Math.max(1, Math.min(10, env.length)) : second >= 0 ? 2 : 1;
          // every matrix a vertex names gets one: a slot left as the last
          // draw had it would pull those vertices over to another model
          let top = 0;
          for (let k = 0; k < mesh.mtx.length; k++) if (mesh.mtx[k] > top) top = mesh.mtx[k];
          const nMats = Math.max(filled, Math.min(10, Math.round(top) + 1));
          const dr: Drawable = {
            key: `${tag}:${d.index}:${i}`,
            archive, dobj: d, pobj: p, jobj: j, mesh,
            mats: new Float32Array(16 * nMats),
            nMats,
            env: env.slice(0, 10),
            node: 0, nodeJoint: -1, nodeConst: null, second, filled,
            state: this.states[d.index],
            translucent: isTranslucent(d.mobj),
            stamp: 0,
            group,
          };
          if (p.kind === "envelope") this.setupNode(dr);
          this.drawables.push(dr);
        });
    this.skinUsed = Int32Array.from(used);
    // each weighted blend of joints once, however many meshes' matrices are it
    const blends = new Map<string, number>();
    for (const d of this.drawables) {
      for (const e of d.env) {
        if (e.joints.length < 2) continue;
        const k = e.joints.join(",") + "|" + Array.from(e.weights).join(",");
        let u = blends.get(k);
        if (u === undefined) blends.set(k, (u = blends.size));
        e.u = u;
      }
    }
    this.blendMats = new Float32Array(blends.size * 16);
    this.blendAt = new Int32Array(blends.size).fill(-1);
  }
  /** the blends of joints the envelopes use (16 each), and the pose each was made for */
  private blendMats: Float32Array;
  private blendAt: Int32Array;

  /** the envelope's node matrix, which carries skinned vertices from the
   * skeleton's bind space into the joint the mesh hangs off */
  private setupNode(d: Drawable) {
    const j = d.jobj.index;
    if (this.flags[j] & JOBJ.SKELETON_ROOT) return;
    let s = j;
    while (s >= 0 && !(this.flags[s] & (JOBJ.SKELETON_ROOT | JOBJ.SKELETON))) s = this.parent[s];
    if (s < 0) return;
    d.nodeJoint = s;
    if (s === j) {
      d.node = 1;
      // (MTXInverse of the joint's envelope matrix: _HSD_mkEnvelopeModelNodeMtx)
      const ib = mtxFromGL(this.invBind[j] ?? ident(new Float32Array(16)), new Float32Array(12)), inv = new Float32Array(12);
      d.nodeConst = PSMTXInverse(ib, inv) ? mtxToGL(inv, new Float32Array(16)) : ident(new Float32Array(16));
    } else d.node = this.flags[s] & JOBJ.SKELETON_ROOT ? 2 : 3;
  }

  /** a joint's rest turn, scale or translation (9 floats a joint: rot, scale, trans) */
  restOf(j: number, what: "rot" | "scale" | "trans"): [number, number, number] {
    const o = j * 9 + (what === "rot" ? 0 : what === "scale" ? 3 : 6);
    return [this.rest[o], this.rest[o + 1], this.rest[o + 2]];
  }

  resetPose() {
    for (let i = 0; i < this.n; i++) {
      const r = i * 9;
      this.rot[i * 3] = this.rest[r]; this.rot[i * 3 + 1] = this.rest[r + 1]; this.rot[i * 3 + 2] = this.rest[r + 2];
      this.scale[i * 3] = this.rest[r + 3]; this.scale[i * 3 + 1] = this.rest[r + 4]; this.scale[i * 3 + 2] = this.rest[r + 5];
      this.trans[i * 3] = this.rest[r + 6]; this.trans[i * 3 + 1] = this.rest[r + 7]; this.trans[i * 3 + 2] = this.rest[r + 8];
      this.shown[i] = this.flags[i] & JOBJ.HIDDEN ? 0 : 1;
    }
  }

  private set(i: number, type: number, v: number) {
    if (type >= 1 && type <= 3) this.rot[i * 3 + type - 1] = v;
    else if (type >= 5 && type <= 7) this.trans[i * 3 + type - 5] = v;
    else if (type >= 8 && type <= 10) this.scale[i * 3 + type - 8] = v;
    else if (type === 11) this.shown[i] = v > 0.5 ? 1 : 0; // NODE: this joint's flag
    // BRANCH: the flag of this joint and every joint under it, shown or
    // hidden alike (a child's own track, applied after, still has its say)
    else if (type === 12) this.shown.fill(v > 0.5 ? 1 : 0, i, this.subEnd[i]);
  }

  /** a fighter animation: one track list per joint, preorder */
  applyTracks(tracks: Track[][], frame: number) {
    const n = Math.min(tracks.length, this.n);
    for (let i = 0; i < n; i++) {
      const list = tracks[i];
      for (let k = 0; k < list.length; k++) {
        // (a track whose own clock has not come to 0 yet - a start frame below 0 - writes nothing: HSD_FObjInterpretAnim)
        const keys = list[k].keys;
        if (keys.length && keys[0].time > frame) continue;
        const v = sample(keys, frame);
        if (v !== null) this.set(i, list[k].type, v);
      }
    }
  }

  /** a stage animation: one AObj per joint, each on its own clock (HSD_AObjInterpretAnim with JObjUpdateFunc: a
   *  scale nearer 0 than 1e-3 is set as 1e-3, so a joint shrunk away keeps a matrix of its own) */
  applyAObjs(aobjs: (AObj | null)[], frame: number, loop: boolean) {
    const n = Math.min(aobjs.length, this.n);
    for (let i = 0; i < n; i++) {
      const ao = aobjs[i];
      if (!ao) continue;
      const t = aobjFrame(ao, frame, loop);
      for (const tr of ao.tracks) {
        // (a track whose own clock has not come to 0 yet - its FObj's start frame below 0 - writes nothing, and
        // its joint stays as it was: HSD_FObjInterpretAnim. Effect models' joints hidden at rest wait so for
        // their branch key: Donkey Kong's Giant Punch's, EfDkData model 2)
        if (tr.keys.length && tr.keys[0].time > frame) continue;
        const v = sample(tr.keys, t);
        if (v === null) continue;
        if (tr.type === 4) this.path(i, ao.obj, v);
        else this.set(i, tr.type, tr.type >= 8 && tr.type <= 10 && Math.abs(v) < MIN_SCALE ? MIN_SCALE : v);
      }
    }
  }

  // PATH: the joint stands a share of the way along another joint's spline
  // (Yoshi's Story's Randall rides his cloud path this way). The curve's
  // point is the joint's translate as it is (JObjUpdateFunc's HSD_A_J_PATH:
  // splArcLengthPoint, then HSD_JObjSetTranslateX/Y/Z); the matrix carries it
  // through the spline joint's (placeOnPaths)
  private path(i: number, splineJoint: number | null, f: number) {
    const sj = splineJoint === null ? undefined : this.joints.find((j) => j.offset === splineJoint);
    if (!sj?.spline) return;
    splineAt(sj.spline, f, tmpP);
    (this.pathOf ??= new Int32Array(this.n).fill(-1))[i] = sj.index;
    this.trans[i * 3] = tmpP[0]; this.trans[i * 3 + 1] = tmpP[1]; this.trans[i * 3 + 2] = tmpP[2];
  }

  resetMaterials() {
    for (const s of this.states) if (s.dirty !== false) resetState(s);
  }

  /** a stage's material animation: per joint, one MatAnim per DObj */
  applyMatAnims(anims: (MatAnim | null)[][], dobjsOf: (j: number) => DObj[], frame: number, loop: boolean) {
    const n = Math.min(anims.length, this.n);
    for (let i = 0; i < n; i++) {
      const list = anims[i];
      if (!list.length) continue;
      const ds = dobjsOf(i);
      for (let k = 0; k < list.length && k < ds.length; k++) {
        const ma = list[k];
        if (ma) applyMatAnim(this.states[ds[k].index], ma, frame, loop);
      }
    }
  }

  /** world matrices from the pose, then every drawable's matrices */
  update(parentWorld: Mat | null = null) {
    // (the same pose as last time - a fighter in hitlag, a part standing
    // still on its animation - leaves the matrices as they are; only meshes
    // shown since, or not posed then, get theirs)
    if (this.unchanged(parentWorld)) {
      for (const d of this.drawables) {
        if (d.posedAt !== this.updates && (this.isVisible(d) || this.alsoPosed.has(d.dobj.index))) this.matrices(d);
      }
      return;
    }
    this.remember(parentWorld);
    this.updates++;
    const W = this.world;
    // HSD_JObjMakeMatrix: each joint's HSD_MtxSRT, given its parent's accumulated scale (jobj->scl) when it has
    // one, then PSMTXConcat(parent->mtx, jobj->mtx); in float32, as the game does
    for (let i = 0; i < this.n; i++) this.makeMatrix(i, parentWorld);
    if (this.pathOf) this.placeOnPaths(parentWorld);
    // the joints the envelopes use: world * inverse bind
    const S = this.skin;
    for (let k = 0; k < this.skinUsed.length; k++) {
      const j = this.skinUsed[k], o = j * 16;
      const ib = this.invBind[j];
      // (MTXConcat(jobj->mtx, jobj->envelopemtx): SetupEnvelopeModelMtx)
      if (ib) concatGL(S, o, W, o, ib, 0);
      else for (let q = 0; q < 16; q++) S[o + q] = W[o + q];
    }
    for (const d of this.drawables) {
      if (this.isVisible(d) || this.alsoPosed.has(d.dobj.index)) this.matrices(d);
    }
  }

  /** one joint's world matrix from its pose and its parent's (HSD_JObjMakeMatrix) */
  private makeMatrix(i: number, parentWorld: Mat | null) {
    const W = this.world;
    const L = tmpL, P = tmpP12, R = this.rot, Sc = this.scale, T = this.trans, A = this.accScale;
    const rs = this.rootScale;
    const p = this.parent[i];
    const r = i * 3;
    let ps: Float32Array | null = null;
    if (p >= 0) { if (this.hasScl[p]) { tmpRS[0] = A[p * 3]; tmpRS[1] = A[p * 3 + 1]; tmpRS[2] = A[p * 3 + 2]; ps = tmpRS; } }
    else if (rs) { tmpRS[0] = rs[0]; tmpRS[1] = rs[1]; tmpRS[2] = rs[2]; ps = tmpRS; }
    // (a parent scale with a 0 in it - or one not a number - would make HSD_MtxSRT's 1.0 / scale infinite and
    // the joint NaN; the game's draws in its recordings have no such joints, so the turn is made without the
    // parent's scale taken out, as for a joint without one)
    const psOk = !!ps && ps[0] !== 0 && ps[1] !== 0 && ps[2] !== 0 && Number.isFinite(ps[0] + ps[1] + ps[2]);
    if (this.flags[i] & JOBJ.CLASSICAL_SCALE) {
      if (ps) { A[r] = ps[0]; A[r + 1] = ps[1]; A[r + 2] = ps[2]; }
      this.hasScl[i] = ps ? 1 : 0;
    } else {
      if (ps) { A[r] = Sc[r] * ps[0]; A[r + 1] = Sc[r + 1] * ps[1]; A[r + 2] = Sc[r + 2] * ps[2]; }
      else { A[r] = Sc[r]; A[r + 1] = Sc[r + 1]; A[r + 2] = Sc[r + 2]; }
      this.hasScl[i] = 1;
    }
    for (let k = 0; k < 3; k++) { tmpS3[k] = Sc[r + k]; tmpR3[k] = R[r + k]; tmpT3[k] = T[r + k]; }
    HSD_MtxSRT(L, tmpS3, tmpR3, tmpT3, psOk ? ps : null);
    const o = i * 16;
    if (p >= 0) { mtxFromGL(W, P, p * 16); PSMTXConcat(P, L, L); }
    else if (parentWorld) { mtxFromGL(parentWorld, P, 0); PSMTXConcat(P, L, L); }
    mtxToGL(L, W, o);
    // (a joint held somewhere else, its children with it)
    if (this.shift && this.shift.joint === i) { W[o + 12] += this.shift.d[0]; W[o + 13] += this.shift.d[1]; W[o + 14] += this.shift.d[2]; }
  }

  // HSD_JObjMakeMatrix's last step: a joint on a PATH animation (its AObj's
  // object, the spline joint) has its matrix's translation replaced by the
  // spline joint's matrix times its translate (HSD_JObjSetupMatrix on that
  // joint, then MTXMultVec) - its turn and scale its own and its parent's.
  // Its children are made again on it. (Yoshi's Story's Randall: the path's
  // point carried through the spline joint, turned half round and moved.)
  private placeOnPaths(parentWorld: Mat | null) {
    const W = this.world, P = tmpP12, T = this.trans, at = this.pathOf!;
    for (let i = 0; i < this.n; i++) {
      const k = at[i];
      if (k < 0) continue;
      mtxFromGL(W, P, k * 16);
      for (let c = 0; c < 3; c++) tmpT3[c] = T[i * 3 + c];
      PSMTXMultVec(P, tmpT3, tmpS3);
      const o = i * 16;
      W[o + 12] = tmpS3[0]; W[o + 13] = tmpS3[1]; W[o + 14] = tmpS3[2];
      for (let j = i + 1; j < this.subEnd[i]; j++) this.makeMatrix(j, parentWorld);
    }
  }

  /** the pose as of the last update that changed something, to know one that changes nothing */
  private last: { rot: Float32Array; scale: Float32Array; trans: Float32Array; shown: Uint8Array; parent: Float32Array;
                  hasParent: boolean; shifted: boolean; view: number } | null = null;
  /** whether any joint faces the camera (its matrices follow the view) */
  private billboards: boolean | null = null;
  private unchanged(parentWorld: Mat | null): boolean {
    const L = this.last;
    if (!SKIP_SAME || !L || this.shift || L.shifted || !!parentWorld !== L.hasParent) return false;
    if ((this.billboards ??= this.flags.some((f) => (f & 0xe00) !== 0)) && L.view !== bbViewId) return false;
    if (parentWorld) for (let k = 0; k < 16; k++) if (parentWorld[k] !== L.parent[k]) return false;
    const n3 = this.n * 3, R = this.rot, S = this.scale, T = this.trans;
    for (let k = 0; k < n3; k++) if (R[k] !== L.rot[k] || S[k] !== L.scale[k] || T[k] !== L.trans[k]) return false;
    const sh = this.shown;
    for (let k = 0; k < this.n; k++) if (sh[k] !== L.shown[k]) return false;
    return true;
  }
  private remember(parentWorld: Mat | null) {
    const L = (this.last ??= { rot: new Float32Array(this.n * 3), scale: new Float32Array(this.n * 3), trans: new Float32Array(this.n * 3),
                                shown: new Uint8Array(this.n), parent: new Float32Array(16), hasParent: false, shifted: false, view: 0 });
    L.rot.set(this.rot); L.scale.set(this.scale); L.trans.set(this.trans); L.shown.set(this.shown);
    L.hasParent = !!parentWorld;
    if (parentWorld) L.parent.set(parentWorld.subarray(0, 16));
    L.shifted = !!this.shift;
    L.view = bbViewId;
  }
  private matrices(d: Drawable) {
    d.stamp = ++stamps;
    d.posedAt = this.updates;
    const W = this.world, S = this.skin;
    const j = d.jobj.index;
    if (d.pobj.kind !== "envelope") {
      const bb = this.flags[j] & 0xe00;
      const M = d.mats, o = j * 16;
      if (bb && !bbIdentity) {
        // (in view space, as the game makes it: mkBillBoardMtx and kin on PSMTXConcat(vmtx, jobj->mtx), in
        // float32; the world matrix the rest takes - the lighting, the culling - is the view's inverse times it)
        mtxFromGL(bbView, bbV12, 0);
        mtxFromGL(W, bbW12, o);
        PSMTXConcat(bbV12, bbW12, bbW12);
        mkBillBoardMtx(bb, (this.flags[j] & 0x2000) !== 0, this.rot[j * 3 + 2], bbW12, bbP12);
        const mv = (d.bbMV ??= new Float32Array(16));
        mtxToGL(bbP12, mv);
        d.bbMVView = bbViewId;
        (d.bbW ??= new Float32Array(16)).set(W.subarray(o, o + 16));
        d.bbKind = bb;
        d.bbPersp = (this.flags[j] & 0x2000) !== 0;
        d.bbRotZ = this.rot[j * 3 + 2];
        mul(M, bbInv, mv);
      } else if (bb) { billboard(M, W.subarray(o, o + 16), bb, this.rot[j * 3 + 2]); d.bbMV = null; }
      else for (let q = 0; q < 16; q++) M[q] = W[o + q];
      if (d.second >= 0) for (let q = 0, s = d.second * 16; q < 16; q++) M[16 + q] = W[s + q];
      for (let m = d.filled; m < d.nMats; m++) d.mats.copyWithin(m * 16, 0, 16);
      return;
    }
    const rootMesh = (this.flags[j] & JOBJ.SKELETON_ROOT) !== 0;
    // (the node matrix, the same for all of the mesh's matrices)
    if (d.node >= 2) {
      const s = d.nodeJoint;
      envelopeNodeMtx(tmpC, W, s * 16, W, j * 16, d.node === 3 ? this.invBind[s] : null);
    }
    const M = d.mats;
    for (let m = 0; m < d.env.length; m++) {
      const { joints, weights } = d.env[m];
      const o = m * 16;
      if (joints.length === 1) {
        const src = rootMesh ? W : S, e = joints[0] * 16;
        for (let q = 0; q < 16; q++) M[o + q] = src[e + q];
      } else {
        const u = d.env[m].u!, B = this.blendMats, b = u * 16;
        if (this.blendAt[u] !== this.updates) {
          // the weighted sum, from zero, each joint's matrix added by HSD_MtxScaledAdd (a fused multiply-add an
          // entry); a 3 x 4 to GX, so the last row stays 0 0 0 1
          for (let q = 0; q < 16; q++) B[b + q] = 0;
          for (let k = 0; k < joints.length; k++) {
            const e = joints[k] * 16, w = Math.fround(weights[k]);
            for (let c = 0; c < 4; c++) for (let q = 0; q < 3; q++) B[b + c * 4 + q] = madd(w, S[e + c * 4 + q], B[b + c * 4 + q]);
          }
          B[b + 15] = 1;
          this.blendAt[u] = this.updates;
        }
        for (let q = 0; q < 16; q++) M[o + q] = B[b + q];
      }
      if (d.node === 0) continue;
      // (MTXConcat(mtxp, right))
      concatGL(M, o, M, o, d.node === 1 ? d.nodeConst! : tmpC, 0);
    }
    for (let m = d.filled; m < d.nMats; m++) d.mats.copyWithin(m * 16, 0, 16);
  }

  isVisible(d: Drawable): boolean {
    return this.shown[d.jobj.index] === 1 && !(this.passHidden ?? this.hidden).has(d.dobj.index);
  }

  /** a joint and every joint under it shown or hidden (HSD_JObjSet/ClearFlagsAll) */
  setBranchShown(j: number, on: boolean) {
    if (j >= 0 && j < this.n) this.shown.fill(on ? 1 : 0, j, this.subEnd[j]);
  }

  /** the meshes on a joint and the joints under it */
  dobjsUnder(j: number): number[] {
    const out: number[] = [];
    if (j < 0 || j >= this.n) return out;
    for (const d of this.drawables) if (d.jobj.index >= j && d.jobj.index < this.subEnd[j]) out.push(d.dobj.index);
    return out;
  }

  /** meshes posed although hidden (drawn in a pass of their own: an outline) */
  readonly alsoPosed = new Set<number>();
  /** its point lists' points, pixels across in the game's 480 lines (GX_SetPointSize: 1 unless its code says) */
  pointSize = 1;
  /** a stage part's shadow check (grDisplay_801C5B90): a shadow is laid on a
   *  joint when its fighter's height plus this is above the joint's; null:
   *  every shadow on every joint */
  shadowBias: number | null = null;
  /** while set, the meshes hidden instead of `hidden` (a pass of its own) */
  passHidden: Set<number> | null = null;

  private updates = 0;
  private passPosed: Set<number> | null = null;
  private passPosedAt = -1;
  /** the matrices of the meshes a pass's hidden set shows that `hidden`
   *  does not (posing leaves them out), once per pose */
  posePass(hiddenInPass: Set<number>) {
    if (this.passPosed === hiddenInPass && this.passPosedAt === this.updates) return;
    this.passPosed = hiddenInPass;
    this.passPosedAt = this.updates;
    for (const d of this.drawables) {
      const i = d.dobj.index;
      if (this.hidden.has(i) && !hiddenInPass.has(i) && !this.alsoPosed.has(i) && this.shown[d.jobj.index] === 1) this.matrices(d);
    }
  }
  /** the scale of the joint the game has above this tree's root, when it is
   *  not the same on every axis (Pokemon Stadium's forms, flattened as they
   *  change): HSD hands a joint its parent's scale so that a turned joint is
   *  not sheared by it, and the root takes this one. Set together with the
   *  matrix given to update(). */
  rootScale: [number, number, number] | null = null;
  /** one joint moved by d in the world after it is posed, and its children
   *  with it (a fighter held: its XRotN where its holder's TransN2 is) */
  shift: { joint: number; d: [number, number, number] } | null = null;

  /** a joint's world position */
  position(j: number): [number, number, number] {
    const W = this.world;
    return [W[j * 16 + 12], W[j * 16 + 13], W[j * 16 + 14]];
  }
}

export function isTranslucent(mo: MObj | null): boolean {
  if (!mo) return false;
  return (mo.renderMode & (1 << 30)) !== 0 || mo.pe?.type === 1;
}

function newState(mo: MObj | null): MatState {
  const m = mo ?? {
    renderMode: 0, tobjs: [], ambient: [0.5, 0.5, 0.5, 1], diffuse: [1, 1, 1, 1], specular: [1, 1, 1, 1],
    alpha: 1, shininess: 50, pe: null,
  } as MObj;
  const s: MatState = {
    mobj: m,
    diffuse: new Float32Array(4),
    ambient: new Float32Array(4),
    specular: new Float32Array(4),
    alpha: 1,
    tex: m.tobjs.map((t) => ({ tobj: t, image: t.image, tlut: t.tlut, tevColors: t.tev ? new Float32Array(12) : null,
                               translate: [0, 0], scale: [1, 1], rotate: 0, rotX: 0, rotY: 0,
                               blending: 1 })),
    override: null,
    skip: null,
    mirror: null,
  };
  resetState(s);
  return s;
}

function resetState(s: MatState) {
  s.dirty = false;
  // (element by element: a typed array's set() from a plain array costs more than the copies)
  const mo = s.mobj, d = s.diffuse, a = s.ambient, p = s.specular, md = mo.diffuse, ma = mo.ambient, mp = mo.specular;
  d[0] = md[0]; d[1] = md[1]; d[2] = md[2]; d[3] = md[3];
  a[0] = ma[0]; a[1] = ma[1]; a[2] = ma[2]; a[3] = ma[3];
  p[0] = mp[0]; p[1] = mp[1]; p[2] = mp[2]; p[3] = mp[3];
  s.alpha = byte255(Math.min(Math.max(mo.alpha, 0), 1));
  for (let i = 0; i < s.tex.length; i++) {
    const t = s.tex[i], o = t.tobj;
    t.image = o.image;
    t.tlut = o.tlut;
    t.translate[0] = o.translate[0]; t.translate[1] = o.translate[1];
    t.scale[0] = o.scale[0]; t.scale[1] = o.scale[1];
    t.rotate = o.rotate[2];
    t.rotX = o.rotate[0];
    t.rotY = o.rotate[1];
    t.blending = o.blending;
    const tv = o.tev, c = t.tevColors;
    if (tv && c) for (let k = 0; k < 4; k++) { c[k] = tv.konst[k]; c[4 + k] = tv.tev0[k]; c[8 + k] = tv.tev1[k]; }
  }
}

/** a color as the game's files and animations keep it: a byte, 255 times the
 *  value cut to a whole number */
const byte255 = (v: number) => Math.floor(255 * Math.fround(v)) / 255;

/** one material animation onto one material, at a frame (the HUD sets each
 *  digit's and icon's texture this way, each at a frame of its own) */
export function applyMatAnim(s: MatState, ma: MatAnim, frame: number, loop: boolean) {
  s.dirty = true;
  if (ma.aobj) {
    const t = aobjFrame(ma.aobj, frame, loop);
    for (const tr of ma.aobj.tracks) {
      const v = sample(tr.keys, t);
      if (v === null) continue;
      const c = Math.min(Math.max(v, 0), 1);
      // (MObjUpdateFunc keeps the colors as bytes, 255.0 times the value cut
      // to a whole number; the alpha as 1 - the value, which
      // HSD_SetMaterialColor takes to a byte the same way)
      if (tr.type >= 1 && tr.type <= 3) s.ambient[tr.type - 1] = byte255(c);
      else if (tr.type >= 4 && tr.type <= 6) s.diffuse[tr.type - 4] = byte255(c);
      else if (tr.type >= 7 && tr.type <= 9) s.specular[tr.type - 7] = byte255(c);
      else if (tr.type === 10) s.alpha = byte255(1 - c); // the track holds transparency
    }
  }
  for (const ta of ma.tex) {
    const ts = s.tex.find((x) => x.tobj.id === ta.id);
    if (!ts || !ta.aobj) continue;
    const t = aobjFrame(ta.aobj, frame, loop);
    for (const tr of ta.aobj.tracks) {
      const v = sample(tr.keys, t);
      if (v === null) continue;
      switch (tr.type) {
        // (the image and the palette by the value cut to a whole number, not rounded: TObjUpdateFunc's
        // (int) and (u8) casts)
        case 1: { const img = ta.images[Math.trunc(v)]; if (img) ts.image = img; break; } // TIMG
        case 10: { const tl = ta.tluts[Math.trunc(v) & 0xff]; if (tl) ts.tlut = tl; break; } // TCLT
        case 2: ts.translate[0] = v; break;
        case 3: ts.translate[1] = v; break;
        case 4: ts.scale[0] = v; break;
        case 5: ts.scale[1] = v; break;
        case 6: ts.rotX = v; break;
        case 7: ts.rotY = v; break;
        case 8: ts.rotate = v; break;
        case 9: case 24: ts.blending = v; break; // BLEND, TS_BLEND
        default:
          // KONST_R..TEV1_A (12..23): the TEV stage's colors
          if (tr.type >= 12 && tr.type <= 23 && ts.tevColors) ts.tevColors[tr.type - 12] = byte255(Math.min(Math.max(v, 0), 1));
      }
    }
  }
}
