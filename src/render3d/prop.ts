/* 3D replay viewer: a small animated model that is not a
 * fighter or a stage part - an effect (Fox's reflector), the angel platform,
 * a stage's item (Yoshi's Story's Shy Guys). Its joint tree, and the joint
 * and material animations that play on it, all read from your game files;
 * the viewer only says where it is and which frame of its animation. */
import { AObj, Archive, DObj, JObj, MatAnim, loadAnimJoint, loadJoint, loadMatAnimJoint } from "./hsd";
import { RENDER } from "./gx";
import { ident, invert, Mat, mul } from "./math";
import { HSD_MtxSRT, mtxToGL } from "./gxmath";
import { Skeleton } from "./skeleton";

// the root's place as the game makes a joint's matrix: HSD_MtxSRT, in float32 with its own sinf and cosf
// (an item's turn of a quarter about y is the game's cosf of it, not 0)
const srtM = new Float32Array(12), srtS = [0, 0, 0], srtR = [0, 0, 0], srtT = [0, 0, 0];
export function gameSrt(out: Mat, sx: number, sy: number, sz: number, rx: number, ry: number, rz: number, tx: number, ty: number,
                 tz: number) {
  srtS[0] = sx; srtS[1] = sy; srtS[2] = sz;
  srtR[0] = rx; srtR[1] = ry; srtR[2] = rz;
  srtT[0] = tx; srtT[1] = ty; srtT[2] = tz;
  mtxToGL(HSD_MtxSRT(srtM, srtS, srtR, srtT, null), out);
}

const NO_DOBJS: DObj[] = [];

/** whether an effect model draws over everything: one whose descriptor's
 *  lifetime has a tenths digit (efLib_Create: (u32)(10 * lifetime) % 10 sets
 *  ZMODE_ALWAYS on all its materials) - the shield's bubbles (EfCoData 11-14)
 *  and Fox's and Falco's reflector (EfFxData 0-2) */
export function effectOverAll(life: number): boolean {
  return Math.trunc(Math.fround(10 * Math.fround(life))) % 10 !== 0;
}

export class Prop {
  skeleton: Skeleton;
  private joints: JObj[];
  private anim: (AObj | null)[] | null;
  private matAnim: (MatAnim | null)[][] | null;
  private place: Mat = new Float32Array(16);
  /** an item's model (loadArticle): its root's own scale is the item's (Item_8026849C sets it to the item's
   *  scl, x60_scale, over the file's - lb_8000B804 lays the file's rest down first when it is picked up,
   *  it_802742F4), so the file's rest scale of the root is not kept under the place's; a root whose
   *  animation sets its scale keeps the animation's */
  itemRoot = false;
  /** an item a fighter has picked up: it_802742F4 clears JOBJ_HIDDEN on the root's first child and everything
   *  under it (HSD_JObjClearFlagsAll), so the file's hidden joints there are shown until its animation or code
   *  hides them again */
  pickedUp = false;
  /** its joints as the game posed them, when the viewer track has them ("jp": by preorder joint, rot,
   *  scale, translate; NaN for a value not sent: the file's rest): laid over its animation's pose */
  trackPose: Map<number, Float32Array> | null = null;

  /** rootAtOrigin: the root joint's own translation is dropped, for a model
   *  the game places by its root (an item: the replay says where it is).
   *  blend: every part is blended by its alpha, as an effect's flashes are
   *  meant to be (their vertex alphas fade them out toward the edges) */
  constructor(a: Archive, joint: number, animJoint: number | null, matAnimJoint: number | null, tag: string,
              private rootAtOrigin = false, blend = false) {
    const { all, dobjs } = loadJoint(a, joint);
    this.joints = all;
    this.skeleton = new Skeleton(a, all, dobjs, tag);
    if (blend) for (const d of this.skeleton.drawables) d.translucent = true;
    this.anim = animJoint === null ? null : loadAnimJoint(a, animJoint);
    this.matAnim = matAnimJoint === null ? null : loadMatAnimJoint(a, matAnimJoint);
    this.rootScaled = !!this.anim?.[0]?.tracks.some((t) => t.type >= 8 && t.type <= 10);
  }
  /** whether its animation sets the root's scale (HSD_A_J_SCAX..SCAZ on joint 0) */
  private rootScaled: boolean;

  /** an item's root at the item's own scale alone (itemRoot): the file's rest scale of it dropped */
  private itemRootScale() {
    if (!this.itemRoot || this.rootScaled) return;
    const sk = this.skeleton;
    sk.scale[0] = sk.scale[1] = sk.scale[2] = 1;
  }

  /** the rest pose, with a picked-up item's joints under the root's first child shown (pickedUp) */
  private reset() {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.pickedUp) {
      const child = sk.parent.indexOf(0);
      if (child > 0) sk.setBranchShown(child, true);
    }
  }

  /** every material drawn with no depth test (HSD's ZMODE_ALWAYS): over
   *  whatever was drawn before it, a fighter inside it or in front of it */
  zAlways() {
    for (const s of this.skeleton.states) s.mobj = { ...s.mobj, renderMode: s.mobj.renderMode | RENDER.ZMODE_ALWAYS };
  }

  /** how long its animations run (frames), the longest of them */
  get length(): number {
    let n = 0;
    for (const a of this.anim ?? []) if (a) n = Math.max(n, a.end);
    for (const list of this.matAnim ?? []) for (const m of list) {
      if (m?.aobj) n = Math.max(n, m.aobj.end);
      for (const t of m?.tex ?? []) if (t.aobj) n = Math.max(n, t.aobj.end);
    }
    return n;
  }

  /** at frame `frame` of its animations (looped when loop), at (x, y, z),
   *  scaled by `scale`, turned `rotY` about the vertical and `rotZ` in the
   *  picture's plane (as the game sets an effect's root joint), and `rotX`
   *  about its own x axis. `rootSet`: the place is the
   *  root joint's own, over the file's (an effect model the game's dispatch
   *  made at a place or on a joint: HSD_JObjSetTranslate on its root).
   *  `jointFrame`: the joints' animation at a frame of its own, the materials'
   *  staying at `frame` (Samus's bomb, whose joints speed up near the end of
   *  its fuse while its colors do not: item-facing.ts) */
  pose(frame: number, x: number, y: number, z: number, scale: number, rotY = 0, loop = true, rotZ = 0, rotX = 0,
       rootSet = false, jointFrame = frame) {
    const sk = this.skeleton;
    this.reset();
    if (this.anim) sk.applyAObjs(this.anim, jointFrame, loop);
    this.layTrackPose();
    if (this.rootAtOrigin || rootSet) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    this.itemRootScale();
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    gameSrt(this.place, scale, scale, scale, rotX, rotY, rotZ, x, y, z);
    sk.update(this.place);
  }

  /** the material of a joint's first DObj (HSD_JObjGetDObj, what an effect's code colors), or null */
  firstState(joint: number): Skeleton["states"][number] | null {
    const d = this.joints[joint]?.dobjs[0];
    return d ? this.skeleton.states[d.index] ?? null : null;
  }

  /** after the pose, the root's turn about y set to `value` (an effect's callback: HSD_JObjSetRotationY,
   *  which replaces the animated turn; turning the parent matrix instead would add the two) */
  setRootRotationY(value: number) {
    this.skeleton.rot[1] = value;
    this.skeleton.update(this.place);
  }

  /** after the pose, the root's size along z set to `value` (an item's code: HSD_JObjSetScaleZ) */
  setRootScaleZ(value: number) {
    this.skeleton.scale[2] = value;
    this.skeleton.update(this.place);
  }

  /** after the pose, the root's size along y set to `value` (an item's code: HSD_JObjSetScaleY) */
  setRootScaleY(value: number) {
    this.skeleton.scale[1] = value;
    this.skeleton.update(this.place);
  }

  /** after the pose, the root's turn about z set to `value`, the same way (HSD_JObjSetRotationZ) */
  setRootRotationZ(value: number) {
    this.skeleton.rot[2] = value;
    this.skeleton.update(this.place);
  }

  /** after the pose, the turn about x of the root's first child set to `value` (an item's code:
   *  HSD_JObjSetRotationX on HSD_JObjGetChild of its root - a thrown needle's or a missile's tilt) */
  setChildRotationX(value: number) {
    const sk = this.skeleton;
    const child = sk.parent.indexOf(0);
    if (child <= 0) return;
    sk.rot[child * 3] = value;
    sk.update(this.place);
  }

  /** after the pose, the root's first child's next joint and everything under it hidden (HSD_JObjSetFlagsAll
   *  HIDDEN on HSD_JObjGetNext(HSD_JObjGetChild(root)): an effect's callback). Hidden meshes are not drawn, so
   *  no matrix is made again */
  hideSecondChild() {
    const sk = this.skeleton;
    const first = sk.parent.indexOf(0);
    if (first < 0) return;
    for (let j = first + 1; j < sk.n; j++) if (sk.parent[j] === 0) { sk.setBranchShown(j, false); return; }
  }

  /** after the pose, a joint's z place set to `value` (an effect's callback moving one of its joints) */
  setJointTranslationZ(joint: number, value: number) {
    if (joint < 0 || joint >= this.skeleton.n) return;
    this.skeleton.trans[joint * 3 + 2] = value;
    this.skeleton.update(this.place);
  }

  /** after the pose, the scale of the root's first grandchild set to `value` each way, the root's own left
   *  alone (Shadow Ball's animation callback: itmewtwoshadowball.c). `heldScale`: the ball is held, and the
   *  grandchild's place is its file's place the other way at the fighter's size (from the file, never
   *  from the draw before) */
  setGrandchildScale(value: number, heldScale?: number) {
    const sk = this.skeleton;
    const child = sk.parent.findIndex((p) => p === 0);
    if (child < 0) return;
    const grandchild = sk.parent.findIndex((p) => p === child);
    if (grandchild < 0) return;
    sk.scale.fill(value, grandchild * 3, grandchild * 3 + 3);
    if (heldScale !== undefined) {
      for (let c = 0; c < 3; c++) sk.trans[grandchild * 3 + c] = -this.joints[grandchild].trans[c] * heldScale;
    }
    sk.update(this.place);
  }

  /** at rest, at (x, y, z), scaled each way by `scale` and turned `rotY`
   *  about the vertical (a stand whose height alone grows) */
  poseScaled(x: number, y: number, z: number, scale: [number, number, number], rotY: number) {
    const sk = this.skeleton;
    this.reset();
    if (this.rootAtOrigin) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    this.itemRootScale();
    gameSrt(this.place, scale[0], scale[1], scale[2], 0, rotY, 0, x, y, z);
    sk.update(this.place);
  }

  /** at frame `frame`, held: its joint `attach` takes the place and the turn
   *  of another model's joint (its world matrix `parent`), at its own
   *  `scale`, and the rest of it goes with that joint - an item the game
   *  ties to a fighter's hand (a position and an orientation constraint) */
  poseUnder(frame: number, parent: Float32Array, scale: number, loop = true, attach = 0) {
    const sk = this.skeleton;
    this.reset();
    if (this.anim) sk.applyAObjs(this.anim, frame, loop);
    this.layTrackPose();
    if (this.rootAtOrigin) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    this.itemRootScale();
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    // where the tied joint sits in the item: the root put so that it lands
    // on the holder's joint, turned as that joint is (its size the item's)
    ident(this.place);
    sk.update(this.place);
    const a = Math.max(0, Math.min(attach, sk.n - 1));
    const local = sk.world.slice(a * 16, a * 16 + 16) as Mat;
    invert(this.inv, local);
    for (let c = 0; c < 3; c++) {
      const len = Math.hypot(parent[c * 4], parent[c * 4 + 1], parent[c * 4 + 2]) || 1;
      for (let r = 0; r < 3; r++) this.tied[c * 4 + r] = (parent[c * 4 + r] / len) * scale;
      this.tied[c * 4 + 3] = 0;
    }
    this.tied[12] = parent[12]; this.tied[13] = parent[13]; this.tied[14] = parent[14]; this.tied[15] = 1;
    // (the tied joint's own scale is kept: its local matrix carries it)
    const ls = Math.hypot(local[0], local[1], local[2]) || 1;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) this.tied[c * 4 + r] *= ls;
    mul(this.place, this.tied, this.inv);
    sk.update(this.place);
  }

  /** at frame `frame`, held to another model's joint (its world matrix `parent`) by place and turn
   *  constraints (efLib_Create_AttachChild): the root takes the joint's place and axes, each axis as long as
   *  the root's own animation makes it (HSD's resolveCnsOrientation copies the target's axes, so the root's
   *  animated turn is not added on top) */
  poseConstrained(frame: number, parent: Float32Array, scale: number, loop = true) {
    this.pose(frame, 0, 0, 0, scale, 0, loop);
    const sk = this.skeleton;
    for (let c = 0; c < 3; c++) {
      const j = c * 4;
      const own = Math.hypot(sk.world[j], sk.world[j + 1], sk.world[j + 2]);
      const len = Math.hypot(parent[j], parent[j + 1], parent[j + 2]) || 1;
      for (let r = 0; r < 3; r++) this.place[j + r] = parent[j + r] * own / len;
      this.place[j + 3] = 0;
      sk.rot[c] = 0;
      sk.trans[c] = 0;
      sk.scale[c] = 1;
    }
    for (let r = 12; r < 15; r++) this.place[r] = parent[r];
    this.place[15] = 1;
    sk.update(this.place);
  }

  /** at frame `frame`, a child of another model's joint (its world matrix
   *  `parent`, taken at size `scale`): its root's own animation under it (an
   *  effect the game makes a child of a fighter's joint) */
  poseChild(frame: number, parent: Float32Array, scale: number, loop = true) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.anim) sk.applyAObjs(this.anim, frame, loop);
    this.layTrackPose();
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    for (let c = 0; c < 3; c++) {
      const len = Math.hypot(parent[c * 4], parent[c * 4 + 1], parent[c * 4 + 2]) || 1;
      for (let r = 0; r < 3; r++) this.place[c * 4 + r] = (parent[c * 4 + r] / len) * scale;
      this.place[c * 4 + 3] = 0;
    }
    this.place[12] = parent[12]; this.place[13] = parent[13]; this.place[14] = parent[14]; this.place[15] = 1;
    sk.update(this.place);
  }

  /** its root given another model's joint's matrix outright (HSD_JObjCopyMtx
   *  with a user-defined matrix: the root's own place is not applied, only
   *  what hangs under it) */
  poseMatrix(m: Float32Array, frame?: number) {
    const sk = this.skeleton;
    sk.resetPose();
    sk.rot[0] = sk.rot[1] = sk.rot[2] = 0;
    sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    sk.scale[0] = sk.scale[1] = sk.scale[2] = 1;
    // (at a frame of its animations, when it has some: each looping as its own says)
    if (frame !== undefined) {
      if (this.anim) sk.applyAObjs(this.anim, frame, false);
      if (this.matAnim) {
        sk.resetMaterials();
        sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, false);
      }
      // (the root's matrix is the one given, whatever its animation says of it)
      sk.rot[0] = sk.rot[1] = sk.rot[2] = 0;
      sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
      sk.scale[0] = sk.scale[1] = sk.scale[2] = 1;
    }
    this.place.set(m.subarray(0, 16));
    sk.update(this.place);
  }
  /** at frame `frame` of its animations, as the child of a root given the matrix `m` outright: a model the
   *  game loads whole, gives its root a matrix of its own (HSD_JObjCopyMtx) and animates from the root's child
   *  down (HSD_JObjAddAnimAll on jobj->child), this tree being that child's - its own turn, size and place,
   *  as its animation has them, under the root's matrix (the grapple beam's links: itsamusgrapple.c) */
  poseUnderMatrix(m: Float32Array, frame: number) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.anim) sk.applyAObjs(this.anim, frame, false);
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, false);
    }
    this.place.set(m.subarray(0, 16));
    sk.update(this.place);
  }
  /** the track's joints over the animation's (its root is the item's place, never in it) */
  private layTrackPose() {
    const tp = this.trackPose;
    if (!tp) return;
    const sk = this.skeleton;
    for (const [j, v] of tp) {
      if (j <= 0 || j >= sk.n) continue;
      // (a value never sent is the file's rest, whatever the animation says)
      const r = sk.restOf(j, "rot"), s = sk.restOf(j, "scale"), t = sk.restOf(j, "trans");
      for (let k = 0; k < 3; k++) {
        sk.rot[j * 3 + k] = Number.isNaN(v[k]) ? r[k] : v[k];
        sk.scale[j * 3 + k] = Number.isNaN(v[3 + k]) ? s[k] : v[3 + k];
        sk.trans[j * 3 + k] = Number.isNaN(v[6 + k]) ? t[k] : v[6 + k];
      }
    }
  }
  private inv: Mat = new Float32Array(16);
  private tied: Mat = new Float32Array(16);
}
