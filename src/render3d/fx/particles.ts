/* 3D replay viewer: the game's particle system.
 *
 * Written after the behavior of HAL's sysdolphin particle
 * library as the Melee decompilation describes it (generator.c: a
 * generator's emission shapes; particle.c: the per-particle command
 * interpreter). A generator comes from an effect file's particle bank and
 * emits particles for its life; each particle runs its bank's small command
 * script (waits, textures, sizes, colors, fades, velocities, child
 * particles and generators) and moves by its own gravity and friction.
 * Every number comes from your effect files; the randomness is
 * seeded, so a moment looks the same each time it is played.
 */
import { CmdList, EffectBank } from "./bank";
import { atan2f, cosf, sinf, tanf } from "./gamemath";
import { APP_ONCE, appMatrix, mtxGetScale, mtxSRT } from "./appsrt";
import { madd, msub, nmsub, PSMTXConcat, PSMTXIdentity, PSMTXMultVec, PSVECNormalize, sqrtf } from "../gxmath";

// particle kind bits (HSD_ParticleKind)
export const K = {
  GRAV: 1, FRIC: 2, TORNADO: 1 << 2, TEXEDGE: 1 << 3, MIRROR_S: 1 << 5, MIRROR_T: 1 << 6, PRIMENV: 1 << 7, TEX_NEAR: 1 << 9,
  DISP_TEX: 1 << 10, SKIP: 0x800, FLIP_S: 1 << 18, FLIP_T: 1 << 19, TRAIL: 1 << 20, DIRVEC: 1 << 21,
  LEADS: 0x8000, NOZCOMP: 1 << 28, POINT: 1 << 30,
} as const;

/** the game's random numbers (HSD_Rand, random.c): the state after one draw,
 *  state * 214013 + 2531011 in 32 bits */
export function hsdNext(state: number): number {
  return (Math.imul(state, 214013) + 2531011) >>> 0;
}
/** what a draw gives from the state it left (HSD_Randf): its high 16 bits, in [0, 1) */
export function hsdFloat(state: number): number {
  return (state >>> 16) / 65536;
}

/** the random numbers the particles draw: one stream, the game's (HSD_Randf: state * 214013 + 2531011, its
 *  high 16 bits over 65536). With the game's own state for the frame (set(), from a viewer track's "rng") they
 *  are the game's, draw for draw; without one (free()), the same stream from a seed of its own, so a moment
 *  still looks the same each time it is played. */
export class Rng {
  /** the game's state, and whether the draws are from it */
  private h = 0;
  private game = false;
  constructor(private s = 0x1234567) {}
  /** the stand-in stream's seed */
  seed(v: number) { this.s = v >>> 0; }
  /** draw from the game's state from here on */
  set(state: number) { this.h = state >>> 0; this.game = true; if (this.trace) this.trace.push(9, 0, -1, this.h); }
  /** back to the stand-in stream */
  free() { this.game = false; }
  /** the game's state now, or null on the stand-in stream */
  get state(): number | null { return this.game ? this.h : null; }
  /** the draw trace, for the check against the game's own order of draws (particle checks): when set,
   *  every draw from the game's state adds its phase (0 a making, 1 a model's later animation step, 2 the particle
   *  pass, 3 the generator pass, 4 a stage's making, 5 a model's first step), its kind (1 a generator's first
   *  count, 2 its count, 3 an emission's placing, 4 a particle's script, 5 a particle's make), the command of the
   *  generator it is for, and the state it leaves */
  trace: number[] | null = null;
  phase = 0;
  kind = 0;
  cmd = -1;
  /** a draw made from a state of its own (a seeded first count): in the trace, the stream untouched */
  note(state: number) { if (this.trace) this.trace.push(this.phase, this.kind, this.cmd, state >>> 0); }
  next(): number {
    if (this.game) {
      this.h = hsdNext(this.h);
      if (this.trace) this.trace.push(this.phase, this.kind, this.cmd, this.h);
      return hsdFloat(this.h);
    }
    this.s = hsdNext(this.s);
    return hsdFloat(this.s);
  }
}

/** a transform particles live under (the game's psAppSRT): its translate,
 *  rotation (Euler, radians) and scale; set by whoever spawned the effect */
export interface AppSRT {
  tx: number; ty: number; tz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
  /** a generator following a joint moves it (the game's type 0x800) */
  follow: boolean;
  /** how many have it (its generator and each particle under it): the game
   *  lets it go with the last (unset: its generator alone) */
  used?: number;
  /** the generator it goes along with (the game's gp) */
  owner?: Generator | null;
  /** true: only the player's way of placing what is under it - the game has
   *  no transform here, so a generator under it (its own, or one a particle
   *  under it made) has none when the game asks */
  player?: boolean;
  /** a generator's own that only follows (its kind's 0x20000, the game's xA2): the particles' places are in
   *  the camera's axes from its place (psDispSubAppSRT) */
  view?: boolean;
  /** psAddGeneratorAppSRT's status (appsrt.ts: APP_DYNAMIC, APP_ONCE, APP_STILL; unset: dynamic) and the
   *  matrix the draw last made of it (mmtx), kept as it is once STILL */
  status?: number;
  mmtx?: Float32Array;
}

/** the generators of bank 0 whose particles each take a private copy of their transform (efLib_Cb_PtclAppSRTHook) */
const PRIVATE_SRT = new Set([0x96, 0x97, 0x98, 0x21b]);

export interface Col { r: number; g: number; b: number; a: number }
const col = (r: number, g: number, b: number, a: number): Col => ({ r, g, b, a });

export interface Particle {
  bank: EffectBank;
  kind: number;
  texGroup: number;
  pose: number;
  cmd: Uint8Array | null;
  pc: number;
  wait: number;
  loopCount: number;
  loopPtr: number;
  markPtr: number;
  life: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  grav: number;
  fric: number;
  size: number;
  sizeTarget: number;
  sizeCount: number;
  rotate: number;
  rotateTarget: number;
  rotateCount: number;
  prim: Col; primTarget: Col; primCount: number; primRemain: number;
  env: Col; envTarget: Col; envCount: number; envRemain: number;
  aCmpMode: number; aCmp1: number; aCmp2: number;
  aCmp1Target: number; aCmp2Target: number; aCmpCount: number; aCmpRemain: number;
  trail: number;
  gen: Generator | null;
  srt: AppSRT | null;
  dead: boolean;
  /** which of the game's sixteen lists it is on, and the one after it there */
  linkNo: number;
  next: Particle | null;
}

export interface Generator {
  bank: EffectBank;
  /** which of its bank's commands it is */
  cmdId: number;
  type: number;
  kind: number;
  /** which of the game's sixteen particle lists its particles go on (0 but for a few effects) */
  linkNo: number;
  texGroup: number;
  life: number;
  genLife: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  grav: number; fric: number; size: number;
  cmd: Uint8Array;
  radius: number; angle: number; random: number;
  count: number;
  aux: number[];
  /** where it follows a joint: a function giving that joint's world matrix (handed the generator itself, so
   *  what it reads is the generator's own and stays so in a copy of the world) */
  follow: ((g: Generator) => Float32Array | null) | null;
  /** the joint a model's key generator last found (FxWorld.keyJoint), kept once the model has run out */
  keptJoint?: Float32Array | null;
  /** the turn of the joint it was made on, which its emission takes (a
   *  stage's, hsd_8039EFAC's type 0x400): row-major 3x3, or none */
  rot?: number[] | null;
  /** whose effect it is ("f:<fighter key>", "i:<item spawn id>"): the game
   *  ends them all together (efLib_DestroyAll: the track's "fxend") */
  tag?: string;
  /** its particles are left where they are made (baked out of its transform,
   *  which follows the joint): a trail from a moving effect's joint */
  bake?: boolean;
  srt: AppSRT | null;
  /** false: the transform it has here is only the player's way of placing
   *  it - the game's has none, so its particles do not go with it when its
   *  owner's effects end */
  gameSrt?: boolean;
  /** it is on a joint (the game's gen->jobj), when nothing here follows one for it */
  onJoint?: boolean;
  /** the effect model whose joint that is (any token for it): the game ends
   *  generators by the joint they are on, and one a particle makes is on its
   *  parent generator's joint - so every generator down from a model's own
   *  ends with the model (endModel) */
  model?: object | null;
  /** the stage's joint it is on (stage object * 65536 + the joint's place in
   *  that object's tree): the stage's own code ends generators by joint, and
   *  one a particle makes is on its parent generator's joint */
  stageAt?: number | null;
  numChild: number;
  /** which one it is, in the order made, and how it was made ("own": the player's own reading of a move;
   *  "piece": a track piece; "key": a model's animation key; "child": a particle's; "stage": the stage's) -
   *  for the checks against the game's list */
  uid: number;
  made: string;
  dead: boolean;
  /** frames it may live with no life of its own (an effect the game ends
   *  when the move does) */
  maxAge: number;
  age: number;
}

const TAU = Math.PI * 2;
/** the game's float constants: FLT_MIN (1.1754944e-38F), FLT_EPSILON (1.1920929e-7F), 1.5707964F, and the sphere's
 *  0.001F (a double of that float) */
const FLT_MIN = Math.fround(1.1754944e-38), EPSILON = Math.fround(1.1920929e-7), HALF_PI = Math.fround(Math.PI / 2);
const SPHERE_EPS = Math.fround(0.001);

const f32 = Math.fround;

export class ParticleSystem {
  /** every particle, in the game's order: its sixteen lists one after the
   *  other, the newest of a list first (a child right after its parent) */
  particles: Particle[] = [];
  /** the generators, in the game's order: a new one goes after the one that
   *  follows `last` (second, when nothing follows it) */
  gens: Generator[] = [];
  rng = new Rng();
  private heads: (Particle | null)[] = new Array(16).fill(null);
  private madeCount = 0;
  /** the generator a pass over the list last stood on (the game's
   *  hsd_804D78F8): the one before the one being run in the frame's pass, the
   *  list's last after any pass */
  private last: Generator | null = null;
  /** where each leading particle is (the game keeps a joint at it, one of
   *  eight): the particles after it aim at it or are pulled to it */
  private leaders: ([number, number, number] | null)[] = new Array(8).fill(null);

  clear() {
    this.particles.length = 0;
    this.gens.length = 0;
    this.heads.fill(null);
    this.leaders.fill(null);
    this.last = null;
  }

  /** a generator from a bank (the game's hsd_8039F05C); null if not there.
   *  `seed`: the game's random state as it made this one (a track piece's),
   *  which its first count is drawn from, the stream left as it was */
  generator(bank: EffectBank, idx: number, seed?: number | null): Generator | null {
    const c: CmdList | null | undefined = bank.cmds[idx];
    if (!c) return null;
    const g: Generator = {
      bank, cmdId: idx, type: c.type, kind: c.kind, linkNo: 0, texGroup: c.texGroup, life: c.life, genLife: c.genLife,
      px: 0, py: 0, pz: 0, vx: c.vx, vy: c.vy, vz: c.vz, grav: c.grav, fric: c.fric, size: c.size,
      cmd: c.cmd, radius: c.radius, angle: c.angle, random: c.random, count: 0, aux: [],
      follow: null, srt: null, numChild: 0, dead: false, maxAge: 600, age: 0, uid: ++this.madeCount, made: "own",
    };
    if (g.kind & 0x100) g.count = g.random < 0 ? (f32(1 + g.random) > EPSILON ? 1 : 0) : f32(0.9999999);
    else if (g.random < 0) g.count = 0;
    else {
      const was = [this.rng.kind, this.rng.cmd];
      this.rng.kind = 1; this.rng.cmd = idx;
      if (seed != null) { g.count = hsdFloat(hsdNext(seed)); this.rng.note(hsdNext(seed)); }
      else g.count = this.rng.next();
      this.rng.kind = was[0]; this.rng.cmd = was[1];
    }
    const shape = g.type & 0xf;
    if (shape === 0 || shape === 3 || shape === 4) g.aux = c.param1 === 0 && c.param2 === 0 ? [0, f32(TAU)] : [c.param1, c.param2];
    else if (shape === 1) g.aux = [c.param1, c.param2, c.param3];
    else if (shape === 2) g.aux = [0];
    else if (shape === 6 || shape === 7) g.aux = [...(c.param1 === 0 && c.param2 === 0 ? [0, f32(TAU)] : [c.param1, c.param2]), c.param3];
    else if (shape === 5) {
      // (its sides, then its three axes - x, y, z - then which sides are faces)
      g.aux = [c.param1, c.param2, c.param3, c.param1, 0, 0, 0, c.param2, 0, 0, 0, c.param3,
               (c.param1 < 0 ? 1 : 0) | (c.param2 < 0 ? 2 : 0) | (c.param3 < 0 ? 4 : 0)];
    } else if (shape === 8) {
      // (hsd_8039F05C: sqrtf of vz^2 + (vx^2 + vy^2) and of vx^2 + vz^2, each product and sum rounded)
      const speed = sqrtf(f32(f32(g.vz * g.vz) + f32(f32(g.vx * g.vx) + f32(g.vy * g.vy))));
      const mag = sqrtf(f32(f32(g.vx * g.vx) + f32(g.vz * g.vz)));
      const lat = Math.abs(c.param1), sp = c.param1 < 0 ? -speed : speed;
      g.aux = [sp, mag < FLT_MIN ? (g.vy >= 0 ? HALF_PI : -HALF_PI) : atan2f(g.vy, mag),
               Math.abs(g.vx) < FLT_MIN ? (g.vz >= 0 ? HALF_PI : -HALF_PI) : atan2f(g.vz, g.vx), lat, c.param2];
    }
    // (one whose particles go under a transform of its own)
    if (g.kind & 0x20000) {
      g.type |= 0x800;
      g.srt = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, follow: true, used: 1, owner: g, view: true };
    }
    // (the game's hsd_8039D9C8)
    const at = this.last ? this.gens.indexOf(this.last) : -1;
    if (at < 0 || at === this.gens.length - 1) {
      if (this.gens.length) this.gens.splice(1, 0, g);
      else this.gens.push(g);
    } else this.gens.splice(at + 2, 0, g);
    return g;
  }

  /** one frame, as the game runs it (efLib_particles_proc_main, then _aux):
   *  every particle of the first list, then every generator of it - going
   *  along its joint, counting up, emitting - then the other lists' */
  step() {
    const main = (l: number) => l === 0, rest = (l: number) => l !== 0;
    this.rng.phase = 2; this.runParticles(main);
    this.rng.phase = 3; this.runGenerators(main);
    this.rng.phase = 2; this.runParticles(rest);
    this.rng.phase = 3; this.runGenerators(rest);
    this.rng.phase = 0;
    for (let l = 0; l < 3; l++) this.displayOrder(l);
    this.settleOnce();
    const out = this.particles;
    out.length = 0;
    for (const h of this.heads) for (let p = h; p; p = p.next) out.push(p);
  }

  /** The display's order. When the game draws a particle list (lists 0 and
   *  2 from one effect object's draw, list 1 from the other's) it first puts
   *  the list in order, once a frame, and leaves it so (psdisp.c
   *  particleSort): by the kind's bits 25-27, those with bit 3 before those
   *  without, each group keeping the order it had. The next frame's update
   *  walks the lists as the display left them, so which particle takes which
   *  random draw, and where the generators its particles make go, follow
   *  from it. Seen in the game's memory: the lists are in this order after
   *  every drawn frame. */
  private displayOrder(l: number) {
    let p = this.heads[l];
    if (!p) return;
    const key = (q: Particle) => ((q.kind >>> 25) & 7) + (q.kind & 8 ? 0 : 8);
    // (nearly always one group, or already in order: nothing to do)
    let last = key(p), sorted = true;
    for (let q = p.next; q; q = q.next) { const k = key(q); if (k < last) { sorted = false; break; } last = k; }
    if (sorted) return;
    const head = this.orderHead.fill(null), tail = this.orderTail.fill(null);
    while (p) {
      const next: Particle | null = p.next, k = key(p);
      if (head[k]) tail[k]!.next = p; else head[k] = p;
      tail[k] = p;
      p.next = null;
      p = next;
    }
    let first: Particle | null = null, end: Particle | null = null;
    for (let k = 0; k < 16; k++) {
      if (!head[k]) continue;
      if (end) end.next = head[k]; else first = head[k];
      end = tail[k];
    }
    this.heads[l] = first;
  }
  private orderHead: (Particle | null)[] = new Array(16).fill(null);
  private orderTail: (Particle | null)[] = new Array(16).fill(null);

  private runParticles(lists: (l: number) => boolean) {
    for (let i = 0; i < 16; i++) {
      if (!lists(i)) continue;
      let cur = this.heads[i], prev: Particle | null = null;
      while (cur) {
        const next = this.run(cur, prev);
        if (prev === null) { if (this.heads[i] !== next) prev = cur; }
        else if (next !== prev.next) prev = cur;
        cur = next;
      }
    }
  }

  private runGenerators(lists: (l: number) => boolean) {
    let i = 0;
    this.last = null;
    while (i < this.gens.length) {
      const g = this.gens[i];
      if (!lists(g.linkNo) || (g.kind & 0x800)) { this.last = g; i++; continue; }
      g.age++;
      this.follow(g);
      if (g.random < 0) g.count = f32(g.count - g.random);
      else { this.rng.kind = 2; this.rng.cmd = g.cmdId; g.count = madd(g.random, this.rng.next(), g.count); }
      if (g.count >= 1) g.count = this.emit(g);
      if (g.genLife !== 0) {
        g.genLife--;
        // (gone: the one after it is at this place now)
        if (g.genLife === 0 && this.release(g)) continue;
      } else if (g.age > g.maxAge && this.release(g)) continue;
      this.last = g;
      i = this.gens.indexOf(g) + 1;
    }
  }

  private follow(g: Generator) {
    if (!g.follow) return;
    const m = g.follow(g);
    if (!m) return;
    if (g.srt && g.srt.follow) { g.srt.tx = m[12]; g.srt.ty = m[13]; g.srt.tz = m[14]; }
    else if (g.type & 0x200) { g.px = m[12]; g.py = m[13]; g.pz = m[14]; }
    // (type 0x1000: its own transform takes the joint's size each frame, hsd_8039D214)
    // (generator.c: HSD_MtxGetScale of the joint's matrix into the transform's scale)
    if ((g.type & 0x1000) && g.srt && g.srt.owner === g) [g.srt.sx, g.srt.sy, g.srt.sz] = mtxGetScale(m);
  }

  /** a generator let go (the game's hsd_8039D3AC): it stays, making no more,
   *  while a particle of its is left or its transform is still used; true
   *  when it is gone */
  private release(g: Generator): boolean {
    if (g.type & 0x80) this.dropParticles(g);
    const waits = g.numChild !== 0 ||
      (!!(g.type & 0x100) && (!!g.follow || !!g.onJoint) && !!(g.type & 0x1800) && !!g.srt && g.srt.owner === g &&
       (g.srt.used ?? 1) !== 1);
    if (waits) { g.random = 0; g.genLife = 1; return false; }
    const i = this.gens.indexOf(g);
    if (i >= 0) this.gens.splice(i, 1);
    if (g.srt) {
      if (g.srt.owner === g) g.srt.owner = null;
      g.srt.used = (g.srt.used ?? 1) - 1;
      g.srt = null;
    }
    g.dead = true;
    return true;
  }

  /** every particle of a generator's, gone at once (the game's hsd_8039D0A0) */
  private dropParticles(g: Generator) {
    let prev: Particle | null = null;
    for (let p = this.heads[g.linkNo]; p; p = p.next) {
      if (p.gen !== g) { prev = p; continue; }
      if (prev === null) this.heads[g.linkNo] = p.next;
      else prev.next = p.next;
      g.numChild--;
      if (p.srt) { p.srt.used = (p.srt.used ?? 1) - 1; p.srt = null; }
      if (p.kind & K.LEADS) this.leaders[(p.kind & 0x7000) >> 12] = null;
      p.dead = true;
    }
  }

  /** a generator ended with the joint it is on (the game's hsd_8039D688):
   *  under a transform, its particles go with it at once */
  endOwned(g: Generator) {
    if (!g.dead) {
      if (g.srt && !g.srt.player && (g.type & 0x100) && g.gameSrt !== false) g.type |= 0x80;
      // (one that stays - a particle of its is left - keeps its joint: hsd_8039D3AC leaves gen->jobj, and each
      // generator pass still takes it to the joint, hsd_8039D214; a child generator one of its particles makes is
      // on that joint too)
      this.release(g);
    }
    this.passed();
  }

  /** a generator ended outright (the game's hsd_8039D4DC: a stage's code
   *  ending one it made), `withParticles`: its particles at once too. It
   *  stays, making no more, while a particle of its is left */
  end(g: Generator, withParticles = false) {
    if (!g.dead) {
      if (withParticles) g.type |= 0x80;
      // (one that stays - a particle of its is left - keeps its joint: hsd_8039D3AC leaves gen->jobj, and each
      // generator pass still takes it to the joint, hsd_8039D214; a child generator one of its particles makes is
      // on that joint too)
      this.release(g);
    }
    this.passed();
  }

  /** a generator placed once from a joint and then left there (the game's
   *  hsd_8039D71C, for one made with hsd_8039F6CC: a stage's puff). `w`: the
   *  joint's world matrix. Its place, and its motion and line turned as the
   *  joint is turned */
  placeOnce(g: Generator, w: Float32Array) {
    if (g.type & 0x200) { g.px = w[12]; g.py = w[13]; g.pz = w[14]; }
    if ((g.type & 0x800) && g.srt && g.srt.owner === g) { g.srt.tx = w[12]; g.srt.ty = w[13]; g.srt.tz = w[14]; }
    // (the joint's three axes PSVECNormalize'd, the motion through them: col0 * vx + col1 * vy + col2 * vz, two fmadds
    // on the col1 product)
    const r = turnOf(w);
    const [vx, vy, vz] = [g.vx, g.vy, g.vz];
    g.vx = madd(r[2], vz, madd(r[0], vx, f32(r[1] * vy)));
    g.vy = madd(r[5], vz, madd(r[3], vx, f32(r[4] * vy)));
    g.vz = madd(r[8], vz, madd(r[6], vx, f32(r[7] * vy)));
    if ((g.type & 0xf) === 1) {
      // (the line through the joint's matrix itself, unnormalized: mtx[r][0] ax + mtx[r][1] ay + mtx[r][2] az)
      const [ax, ay, az] = g.aux;
      g.aux = [madd(w[8], az, madd(w[0], ax, f32(w[4] * ay))), madd(w[9], az, madd(w[1], ax, f32(w[5] * ay))),
               madd(w[10], az, madd(w[2], ax, f32(w[6] * ay)))];
    }
    g.follow = null;
    g.onJoint = false;
  }

  /** a pass over the generators was made (the game walks them all whenever
   *  an owner's effects end, whether it has any or not) */
  passed() {
    this.last = this.gens.length ? this.gens[this.gens.length - 1] : null;
  }

  /** end the generators on an effect's owner's joints, and what they made
   *  (efLib_DestroyAll: the ones made at a place go on) */
  endTag(tag: string, keepNew = false) {
    for (const g of [...this.gens]) {
      if (g.tag === tag && (g.follow || g.onJoint) && !(keepNew && g.age === 0)) this.endOwned(g);
    }
    this.passed();
  }

  /** end the generators on an effect model's joints (efLib_DestroyAll walks
   *  the model's joints with hsd_8039D688): its own and every one made down
   *  from them that is still on a joint */
  endModel(model: object) {
    for (const g of [...this.gens]) {
      if (g.model === model && (g.follow || g.onJoint)) this.endOwned(g);
    }
    this.passed();
  }

  /** the stage's code ends the generators on `count` of a stage object's
   *  joints from `from` on (grLib_801C9854, grLib_801C98A0, grLib_801C9908:
   *  hsd_8039D4DC for each one found, `withParticles` its particles at once).
   *  Nothing found, nothing walked: where the next new one goes is unchanged */
  endStage(from: number, count: number, withParticles: boolean) {
    for (const g of [...this.gens]) {
      if (g.stageAt == null || g.stageAt < from || g.stageAt >= from + count || !(g.follow || g.onJoint)) continue;
      this.end(g, withParticles);
    }
  }

  /** end a generator an effect made (the move ended): it makes no more, and
   *  goes when its particles have */
  kill(owner: Generator) {
    if (!owner.dead) this.release(owner);
    this.passed();
  }

  /** a particle made (the game's psGenerateParticle0): at the head of its
   *  list, or right after `after`; run once as it is made when `interpret` */
  private spawn(g: Generator | null, bank: EffectBank, kind: number, texGroup: number, cmd: Uint8Array | null, life: number,
                x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grav: number,
                fric: number, interpret: boolean, after: Particle | null = null, linkNo = g?.linkNo ?? 0): Particle {
    const p: Particle = {
      bank, kind, texGroup, pose: 0, cmd, pc: 0, wait: cmd ? 1 : 0, loopCount: 0, loopPtr: 0, markPtr: 0,
      life: (life + 1) & 0xffff, px: x, py: y, pz: z, vx, vy, vz, grav, fric, size, sizeTarget: size, sizeCount: 0,
      rotate: 0, rotateTarget: 0, rotateCount: 0,
      prim: col(255, 255, 255, 255), primTarget: col(255, 255, 255, 255), primCount: 0, primRemain: 0,
      env: col(0, 0, 0, 0), envTarget: col(0, 0, 0, 0), envCount: 0, envRemain: 0,
      aCmpMode: 0x33, aCmp1: 1, aCmp2: 255, aCmp1Target: 1, aCmp2Target: 255, aCmpCount: 0, aCmpRemain: 0,
      trail: 1, gen: g, srt: null, dead: false, linkNo, next: null,
    };
    if (g?.srt) this.under(p, g.srt);
    // (its generator's creation hook: efLib_Cb_PtclAppSRTHook gives the generators of bank 0's 0x96, 0x97, 0x98
    // and 0x21B efLib_Cb_ParticleRender, which makes each particle under a transform a private copy of it, made
    // ONCE: the particle stays where its generator's transform was as it was made)
    if (g && p.srt && g.bank.id === 0 && PRIVATE_SRT.has(g.cmdId)) this.privateSrt(p);
    if (after) { p.next = after.next; after.next = p; }
    else { p.next = this.heads[linkNo]; this.heads[linkNo] = p; }
    const tg = bank.texGroups[texGroup];
    if (tg && tg.palOffsets.length) p.kind |= 0x10;
    if (g) g.numChild++;
    if (g?.bake && p.srt) this.bakeOut(p);
    if (interpret) this.run(p, null);
    return p;
  }

  /** efLib_Cb_ParticleRender: the particle's transform let go (psRemoveParticleAppSRT) and one of its own made
   *  ONCE in its place, with the same place, turn and scale */
  private privateSrt(p: Particle) {
    const s = p.srt!;
    s.used = (s.used ?? 1) - 1;
    p.srt = { tx: s.tx, ty: s.ty, tz: s.tz, rx: s.rx, ry: s.ry, rz: s.rz, sx: s.sx, sy: s.sy, sz: s.sz, follow: false, used: 1,
              owner: null, status: APP_ONCE };
  }

  /** the frame's draw of the particles (psDispSubAppSRT): each transform made ONCE that a particle is drawn
   *  under has its matrix made now and is STILL from then on - done as the step ends, so that a frame stepped
   *  without being drawn (a jump's) leaves them as playing does */
  private settleOnce() {
    for (const h of this.heads) for (let p = h; p; p = p.next) if (p.srt?.status === APP_ONCE) appMatrix(p.srt);
  }

  private under(p: Particle, srt: AppSRT) {
    if (p.srt) return;
    p.srt = srt;
    srt.used = (srt.used ?? 1) + 1;
  }

  /** a particle's child (the script's): right after it in its list, where
   *  it is, of its generator and under its transform, run once at once */
  private child(parent: Particle, idx: number, inheritVel: boolean) {
    const c = parent.bank.cmds[idx];
    if (!c || parent.linkNo >= 8) return;
    const p = this.spawn(null, parent.bank, c.kind, c.texGroup, c.cmd, c.life, parent.px, parent.py, parent.pz,
                         inheritVel ? parent.vx : c.vx, inheritVel ? parent.vy : c.vy, inheritVel ? parent.vz : c.vz,
                         c.size, c.grav, c.fric, false, parent, parent.linkNo);
    p.gen = parent.gen;
    if (parent.gen) parent.gen.numChild++;
    if (parent.srt) this.under(p, parent.srt);
    this.run(p, parent);
  }

  private childGen(parent: Particle, idx: number, flags: number | null) {
    const g = this.generator(parent.bank, idx);
    if (!g) return;
    g.made = "child";
    g.linkNo = parent.linkNo;
    g.type |= 0x100;
    if (parent.gen) {
      g.tag = parent.gen.tag;
      g.follow = parent.gen.follow;
      g.onJoint = parent.gen.onJoint;
      g.model = parent.gen.model;
      g.stageAt = parent.gen.stageAt;
      // (how long one with no life of its own may go on: its parent's rule - the game's never end of
      // themselves, and one made down from a track's generator is ended as the track says)
      g.maxAge = parent.gen.maxAge;
      g.rot = parent.gen.rot;
      g.type |= parent.gen.type & 0x1e00;
      if (g.kind & (1 << 17)) g.type &= ~(1 << 9);
    }
    if (flags !== null) g.kind = (g.kind & 0xf1ffffff) | ((flags & 7) << 25);
    if (parent.gen?.bake && parent.gen.srt && !g.srt) {
      // (made by a particle left where it was made: the new generator goes
      // on with the parent generator's following transform)
      g.srt = parent.gen.srt;
      g.srt.used = (g.srt.used ?? 1) + 1;
      g.bake = true;
      g.px = g.py = g.pz = 0;
      return;
    }
    if (parent.srt && !g.srt) { g.srt = parent.srt; parent.srt.used = (parent.srt.used ?? 1) + 1; }
    if (parent.srt) {
      if (!g.srt) return;
      if (g.srt === parent.srt) { g.px = parent.px; g.py = parent.py; g.pz = parent.pz; }
      else { g.srt.tx = parent.srt.tx; g.srt.ty = parent.srt.ty; g.srt.tz = parent.srt.tz; }
    } else if (g.srt) { g.srt.tx = parent.px; g.srt.ty = parent.py; g.srt.tz = parent.pz; }
    else { g.px = parent.px; g.py = parent.py; g.pz = parent.pz; }
  }

  /** a particle's place and motion out of its transform, into the world */
  private bakeOut(p: Particle) {
    const s = p.srt!;
    const w = srtApply(s, p.px, p.py, p.pz);
    const v = srtApply({ ...s, tx: 0, ty: 0, tz: 0 }, p.vx, p.vy, p.vz);
    p.px = w[0]; p.py = w[1]; p.pz = w[2];
    p.vx = v[0]; p.vy = v[1]; p.vz = v[2];
    s.used = (s.used ?? 1) - 1;
    p.srt = null;
  }

  // ---------------------------------------------------------------- emission

  private emit(g: Generator): number {
    const was = [this.rng.kind, this.rng.cmd];
    this.rng.kind = 3; this.rng.cmd = g.cmdId;
    try { return this.emitInner(g); } finally { this.rng.kind = was[0]; this.rng.cmd = was[1]; }
  }

  private emitInner(g: Generator): number {
    // hsd_8039DAD4, a step at a time in single precision as main.dol takes it (-fp_contract: a * b + c one fmadds)
    const R = this.rng;
    // (the velocity's length: sqrtf of vz^2 + (vx^2 + vy^2), each product and sum rounded, no fused step)
    const speed = sqrtf(f32(f32(g.vz * g.vz) + f32(f32(g.vx * g.vx) + f32(g.vy * g.vy))));
    // the emission frame (rot_mtx): identity, the joint's turn (each axis PSVECNormalize'd), then along the velocity
    const rot = PSMTXIdentity(this.emitRot);
    const shape = g.type & 0xf;
    let r = g.rot;
    if (!r && g.follow && (g.type & 0x500) === 0x500 && !(g.kind & 0x30000)) {
      const w = g.follow(g);
      if (w) r = turnOf(w);
    }
    if (r && !(g.kind & 0x30000)) {
      rot[0] = r[0]; rot[1] = r[1]; rot[2] = r[2];
      rot[4] = r[3]; rot[5] = r[4]; rot[6] = r[5];
      rot[8] = r[6]; rot[9] = r[7]; rot[10] = r[8];
    }
    if (shape !== 1 && speed > EPSILON) {
      const n = PSVECNormalize([g.vx, g.vy, g.vz], this.emitN);
      const az = Math.abs(n[2]) < FLT_MIN ? (n[1] >= 0 ? HALF_PI : -HALF_PI) : atan2f(n[1], n[2]);
      const ca = sinf(az), sa = cosf(az); // (the game's names are swapped; its values are kept)
      const pz = madd(n[1], ca, f32(n[2] * sa));
      const el = Math.abs(pz) < FLT_MIN ? (n[0] >= 0 ? HALF_PI : -HALF_PI) : atan2f(n[0], pz);
      const se = sinf(el), ce = cosf(el);
      const t = this.emitTrig;
      t[0] = ce; t[1] = 0; t[2] = se; t[3] = 0;
      t[4] = f32(-ca * se); t[5] = sa; t[6] = f32(ca * ce); t[7] = 0;
      t[8] = f32(-sa * se); t[9] = -ca; t[10] = f32(sa * ce); t[11] = 0;
      PSMTXConcat(rot, t, rot);
    }
    // (a tornado's two turns, off the emission frame: rot[1][2], rot[2][2], rot[0][2])
    let turn1 = 0, turn3 = 0;
    if (shape === 2) {
      turn1 = Math.abs(rot[10]) < FLT_MIN ? (rot[6] >= 0 ? HALF_PI : -HALF_PI) : atan2f(rot[6], rot[10]);
      const comb = madd(rot[6], sinf(turn1), f32(rot[10] * cosf(turn1)));
      turn3 = Math.abs(comb) < FLT_MIN ? (rot[2] >= 0 ? HALF_PI : -HALF_PI) : atan2f(rot[2], comb);
    }
    const ring = shape === 0 || shape === 3 || shape === 4 || shape === 6 || shape === 7;
    let curAngle = 0, step = 0;
    if (g.angle < 0) {
      if (ring) {
        const rnd = R.next();
        step = f32(f32(g.aux[1] - g.aux[0]) / Math.trunc(g.count));
        curAngle = madd(step, rnd, g.aux[0]);
      } else {
        curAngle = f32(2 * (Math.PI * R.next()));
        step = f32(TAU / Math.trunc(g.count));
      }
    }
    const e = this.emitE, v = this.emitV;
    while (g.count >= 1) {
      if (ring) {
        let rr: number, radius: number;
        if (g.radius < 0) { rr = -g.radius; radius = 1; }
        else {
          radius = R.next();
          if (shape === 3 || shape === 4) radius = sqrtf(radius);
          rr = f32(radius * g.radius);
        }
        let cone: number;
        if (shape === 6) {
          const h = g.aux[2];
          if (g.angle < 0) {
            curAngle = f32(curAngle + step);
            cone = Math.abs(rr) < FLT_MIN ? (h >= 0 ? -g.angle : f32(Math.PI - g.angle)) : f32(Math.PI / 2 - atan2f(h, rr) - g.angle);
          } else {
            curAngle = madd(f32(g.aux[1] - g.aux[0]), R.next(), g.aux[0]);
            cone = Math.abs(rr) < FLT_MIN ? (h >= 0 ? g.angle : f32(Math.PI + g.angle)) : f32(g.angle + (Math.PI / 2 - atan2f(h, rr)));
          }
        } else if (shape === 7) {
          if (g.angle < 0) { cone = f32(Math.PI / 2 - g.angle); curAngle = f32(curAngle + step); }
          else { curAngle = madd(f32(g.aux[1] - g.aux[0]), R.next(), g.aux[0]); cone = f32(Math.PI / 2 + g.angle); }
        } else if (g.angle < 0) {
          curAngle = f32(curAngle + step);
          cone = f32(radius * -g.angle);
        } else {
          cone = f32(radius * g.angle);
          curAngle = madd(f32(g.aux[1] - g.aux[0]), R.next(), g.aux[0]);
        }
        e[0] = f32(rr * cosf(curAngle)); e[1] = f32(rr * sinf(curAngle)); e[2] = 0;
        if (shape === 6 || shape === 7) {
          e[2] = R.next();
          if (shape === 6) { const k = f32(1 - e[2]); e[0] = f32(e[0] * k); e[1] = f32(e[1] * k); }
          e[2] = f32(e[2] * g.aux[2]);
        }
        const sc = f32(speed * sinf(cone));
        v[0] = f32(sc * cosf(curAngle)); v[1] = f32(sc * sinf(curAngle)); v[2] = f32(speed * cosf(cone));
        if (shape === 3) { v[0] = f32(v[0] * radius); v[1] = f32(v[1] * radius); v[2] = f32(v[2] * radius); }
        PSMTXMultVec(rot, e, e);
        PSMTXMultVec(rot, v, v);
        this.spawn(g, g.bank, g.kind, g.texGroup, g.cmd, g.life, f32(e[0] + g.px), f32(e[1] + g.py), f32(e[2] + g.pz),
                   v[0], v[1], v[2], g.size, g.grav, g.fric, true);
      } else if (shape === 1) {
        const rnd = R.next();
        e[0] = f32(rnd * g.aux[0]); e[1] = f32(rnd * g.aux[1]); e[2] = f32(rnd * g.aux[2]);
        PSMTXMultVec(rot, e, e);
        v[0] = g.vx; v[1] = g.vy; v[2] = g.vz;
        PSMTXMultVec(rot, v, v);
        this.spawn(g, g.bank, g.kind, g.texGroup, g.cmd, g.life, f32(e[0] + g.px), f32(e[1] + g.py), f32(e[2] + g.pz),
                   v[0], v[1], v[2], g.size, g.grav, g.fric, true);
      } else if (shape === 5) {
        let ex = R.next(), ey = R.next(), ez = R.next();
        const a = g.aux, sx = a[0], sy = a[1], sz = a[2], flag = a[12];
        const edge = (q: number) => (q > 0.5 ? 1 : 0);
        if (flag === 1) ex = edge(ex);
        else if (flag === 2) ey = edge(ey);
        else if (flag === 4) ez = edge(ez);
        else if (flag === 3) { if (R.next() > f32(sx / f32(sx + sy))) ey = edge(ey); else ex = edge(ex); }
        else if (flag === 5) { if (R.next() > f32(sx / f32(sx + sz))) ez = edge(ez); else ex = edge(ex); }
        else if (flag === 6) { if (R.next() > f32(sy / f32(sy + sz))) ez = edge(ez); else ey = edge(ey); }
        else if (flag === 7) {
          const rnd = R.next(), r0 = f32(1 / madd(sx, f32(sy + sz), f32(sy * sz)));
          if (rnd < f32(r0 * f32(sx * sy))) ez = edge(ez);
          else if (rnd > nmsub(r0, f32(sx * sz), 1)) ey = edge(ey);
          else ex = edge(ex);
        }
        ex = f32(ex - 0.5); ey = f32(ey - 0.5); ez = f32(ez - 0.5);
        // (the box's axes: xx a[3], xy a[4], xz a[5], yx a[6], yy a[7], yz a[8], zx a[9], zy a[10], zz a[11])
        e[0] = madd(a[9], ez, madd(a[3], ex, f32(a[6] * ey)));
        e[1] = madd(a[10], ez, madd(a[4], ex, f32(a[7] * ey)));
        e[2] = madd(a[11], ez, madd(a[5], ex, f32(a[8] * ey)));
        PSMTXMultVec(rot, e, e);
        const mag = sqrtf(f32(f32(a[11] * a[11]) + f32(f32(a[9] * a[9]) + f32(a[10] * a[10]))));
        const sc = f32(speed / mag);
        v[0] = f32(a[9] * sc); v[1] = f32(a[10] * sc); v[2] = f32(a[11] * sc);
        PSMTXMultVec(rot, v, v);
        this.spawn(g, g.bank, g.kind, g.texGroup, g.cmd, g.life, f32(e[0] + g.px), f32(e[1] + g.py), f32(e[2] + g.pz),
                   v[0], v[1], v[2], g.size, g.grav, g.fric, true);
      } else if (shape === 8) {
        // (aux[0] the speed, signed; aux[3] the latitude's range, the game's aux.sphere.latRange)
        const r0 = g.aux[3];
        let lat: number;
        if (r0 === 0 || Math.abs(r0 - Math.PI) < SPHERE_EPS) {
          lat = f32((Math.PI / 2) * sqrtf(R.next()));
          if (R.next() < 0.5) lat = f32(Math.PI - lat);
        } else lat = f32(r0 * sqrtf(R.next()));
        const lon = f32(2 * (Math.PI * R.next()));
        const rr = g.radius < 0 ? -g.radius : f32(g.radius * sqrtf(R.next()));
        const sl = sinf(lat);
        v[0] = f32(sl * cosf(lon)); v[1] = f32(sl * sinf(lon)); v[2] = cosf(lat);
        PSMTXMultVec(rot, v, e);
        const sp = g.aux[0];
        v[0] = f32(e[0] * sp); v[1] = f32(e[1] * sp); v[2] = f32(e[2] * sp);
        if (g.radius >= 0 && sp < 0) { const k = f32(rr / g.radius); v[0] = f32(v[0] * k); v[1] = f32(v[1] * k); v[2] = f32(v[2] * k); }
        this.spawn(g, g.bank, g.kind, g.texGroup, g.cmd, g.life, madd(rr, e[0], g.px), madd(rr, e[1], g.py), madd(rr, e[2], g.pz),
                   v[0], v[1], v[2], g.size, g.grav, g.fric, true);
      } else if (shape === 2) {
        // a tornado: its particles circle the generator (their motion holds
        // the angle round it, how far out and how far along; run()'s own way)
        const out = g.radius < 0 ? 1 : R.next();
        if (g.angle < 0) curAngle = f32(curAngle + step);
        else curAngle = f32(2 * (Math.PI * R.next()));
        g.aux[0] = speed;
        this.spawn(g, g.bank, g.kind | K.TORNADO, g.texGroup, g.cmd, g.life, 0, 0, 0, curAngle, out, 0, g.size, turn1, turn3, true);
      }
      g.count = f32(g.count - 1);
    }
    return g.count;
  }
  private emitRot = new Float32Array(12);
  private emitTrig = new Float32Array(12);
  private emitN = new Float32Array(3);
  private emitE = new Float32Array(3);
  private emitV = new Float32Array(3);

  // ---------------------------------------------------------------- interpreter

  /** one frame of a particle (the game's hsd_8039930C): its fades, its
   *  script, its life, its motion. `prev`: the one before it in its list.
   *  Gives the one to run next */
  private run(p: Particle, prev: Particle | null): Particle | null {
    const was = [this.rng.kind, this.rng.cmd];
    this.rng.kind = 4; this.rng.cmd = p.gen ? p.gen.cmdId : -1;
    try { return this.runInner(p, prev); } finally { this.rng.kind = was[0]; this.rng.cmd = was[1]; }
  }

  private runInner(p: Particle, prev: Particle | null): Particle | null {
    if (p.kind & K.SKIP) return p.next;
    if (p.sizeCount) { p.size = f32(p.size + f32(f32(p.sizeTarget - p.size) / p.sizeCount)); p.sizeCount--; }
    if (p.primCount && ((p.primRemain = (p.primRemain - 1) & 0xffff) === 0)) { p.primCount = 0; p.prim = { ...p.primTarget }; }
    if (p.envCount && ((p.envRemain = (p.envRemain - 1) & 0xffff) === 0)) { p.envCount = 0; p.env = { ...p.envTarget }; }
    if (p.aCmpCount && ((p.aCmpRemain = (p.aCmpRemain - 1) & 0xffff) === 0)) { p.aCmpCount = 0; p.aCmp1 = p.aCmp1Target; p.aCmp2 = p.aCmp2Target; }
    if (p.rotateCount) { p.rotate = f32(p.rotate + f32(f32(p.rotateTarget - p.rotate) / p.rotateCount)); p.rotateCount--; }
    if (p.wait !== 0 && --p.wait === 0) this.interpret(p);
    p.life = (p.life - 1) & 0xffff;
    if (p.life === 0) return this.remove(p, prev);
    if (p.kind & K.TORNADO) {
      // round its generator: out by the radius and the cone, along by its speed
      // (hsd_8039930C's tornado step, single precision in main.dol's order)
      const g = p.gen!;
      const sinA = sinf(p.grav), sinB = sinf(p.fric), cosA = cosf(p.grav), cosB = cosf(p.fric);
      p.vz = f32(p.vz + (g.aux[0] ?? 0));
      const R = f32(madd(p.vz, tanf(Math.abs(g.angle)), Math.abs(g.radius)) * p.vy);
      p.vx = f32(p.vx + g.grav);
      const d = f32(R * cosf(p.vx)), e = f32(R * sinf(p.vx)), nd = -d, vz = p.vz;
      p.px = f32(g.px + madd(d, cosB, f32(vz * sinB)));
      p.py = f32(g.py + madd(cosB, f32(vz * sinA), madd(sinB, f32(nd * sinA), f32(e * cosA))));
      p.pz = f32(g.pz + madd(cosB, f32(vz * cosA), msub(sinB, f32(nd * cosA), f32(e * sinA))));
    } else {
      if (p.kind & K.GRAV) p.vy = f32(p.vy - p.grav);
      if (p.kind & K.FRIC) { p.vx = f32(p.vx * p.fric); p.vy = f32(p.vy * p.fric); p.vz = f32(p.vz * p.fric); }
      p.px = f32(p.px + p.vx); p.py = f32(p.py + p.vy); p.pz = f32(p.pz + p.vz);
    }
    if (p.kind & K.LEADS) {
      // (the game keeps a joint at it: made with no place, then moved by the difference to its matrix's place,
      // HSD_JObjAddTranslationX/Y/Z of pos - mtx[r][3] - the place the others read back is that joint's)
      const i = (p.kind & 0x7000) >> 12;
      const t = this.leaders[i] ??= [0, 0, 0];
      t[0] = f32(t[0] + f32(p.px - t[0])); t[1] = f32(t[1] + f32(p.py - t[1])); t[2] = f32(t[2] + f32(p.pz - t[2]));
    }
    return p.next;
  }

  /** a particle gone: out of its list, off its generator's count and its transform */
  private remove(p: Particle, prev: Particle | null): Particle | null {
    if (prev === null) this.heads[p.linkNo] = p.next;
    else prev.next = p.next;
    let next = p.next;
    if (p.gen) p.gen.numChild--;
    if (p.kind & K.LEADS) this.leaders[(p.kind & 0x7000) >> 12] = null;
    if (p.srt) {
      const left = (p.srt.used = (p.srt.used ?? 1) - 1);
      p.srt = null;
      if (left === 0 && prev === null && this.heads[p.linkNo] !== next) next = this.heads[p.linkNo];
    }
    p.dead = true;
    return next;
  }

  private interpret(p: Particle) {
    const c = p.cmd!, R = this.rng;
    let pc = p.pc, operand = 0;
    const byte = () => (pc < c.length ? c[pc++] : 0xff);
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const float = () => { const v = pc + 4 <= c.length ? dv.getFloat32(pc) : 0; pc += 4; return v; };
    const count = () => { let n = byte(); if (n & 0x80) n = ((n & 0x7f) << 8) + byte(); return n; };
    // the color shown now, when a fade is under way (settles it before a new one)
    const settle = (cur: Col, target: Col, remain: number, n: number) => {
      if (!n) return;
      const s = part(remain, n);
      cur.r = between(target.r, cur.r, s); cur.g = between(target.g, cur.g, s);
      cur.b = between(target.b, cur.b, s); cur.a = between(target.a, cur.a, s);
    };
    for (let guard = 0; guard < 256; guard++) {
      const op = byte();
      if (op < 0x80) {
        operand = op & 0x1f;
        if (op & 0x20) operand = (operand << 8) + byte();
        if ((op & 0xc0) === 0x40) {
          p.pose = byte();
          const tg = p.bank.texGroups[p.texGroup];
          if (tg && tg.offsets[p.pose] !== undefined) p.kind |= K.DISP_TEX;
        }
      } else {
        operand = 0;
        let cls = op & 0xf8;
        if (cls > 0x98) { cls = op & 0xf0; if (cls !== 0xc0 && cls !== 0xd0) cls = op; }
        switch (cls) {
          case 0x80: if (op & 1) p.px = float(); if (op & 2) p.py = float(); if (op & 4) p.pz = float(); break;
          case 0x88: if (op & 1) p.px = f32(p.px + float()); if (op & 2) p.py = f32(p.py + float()); if (op & 4) p.pz = f32(p.pz + float()); break;
          case 0x90: if (op & 1) p.vx = float(); if (op & 2) p.vy = float(); if (op & 4) p.vz = float(); break;
          case 0x98: if (op & 1) p.vx = f32(p.vx + float()); if (op & 2) p.vy = f32(p.vy + float()); if (op & 4) p.vz = f32(p.vz + float()); break;
          case 0xa0: p.sizeCount = count(); p.sizeTarget = float(); if (!p.sizeCount) p.size = p.sizeTarget; break;
          case 0xa1: p.kind &= ~K.DISP_TEX; break;
          case 0xa2: p.grav = float(); p.kind = p.grav === 0 ? p.kind & ~K.GRAV : p.kind | K.GRAV; break;
          case 0xa3: p.fric = float(); p.kind = p.fric === 1 ? p.kind & ~K.FRIC : p.kind | K.FRIC; break;
          case 0xa4: case 0xf1: { const idx = (byte() << 8) + byte(); this.child(p, idx, false); break; }
          case 0xb9: case 0xf2: { const idx = (byte() << 8) + byte(); this.child(p, idx, true); break; }
          case 0xa5: { const idx = (byte() << 8) + byte(); this.childGen(p, idx, null); break; }
          case 0xef: case 0xf0: { const idx = (byte() << 8) + byte(); const fl = byte(); this.childGen(p, idx, fl); break; }
          case 0xa6: { const base = (byte() << 8) + byte(); const rnd = (byte() << 8) + byte(); p.life = (base + Math.trunc(f32(rnd * R.next()))) & 0xffff; break; }
          case 0xa7: { const t = byte(); if (t >= Math.trunc(f32(100 * R.next()))) { p.life = 1; p.pc = pc; p.wait = 0; return; } break; }
          case 0xa8: {
            // (pos += 2v * rnd - v: one fmsubs on the rounded 2v, then the add)
            let x = float(); p.px = f32(p.px + msub(f32(2 * x), R.next(), x));
            x = float(); p.py = f32(p.py + msub(f32(2 * x), R.next(), x));
            x = float(); p.pz = f32(p.pz + msub(f32(2 * x), R.next(), x));
            break;
          }
          case 0xa9: this.spread(p, float()); break;
          case 0xaa: { const idx = (byte() << 8) + byte(); const rnd = (byte() << 8) + byte(); this.child(p, idx + Math.trunc(f32(rnd * R.next())), false); break; }
          case 0xab: { const s = float(); p.vx = f32(p.vx * s); p.vy = f32(p.vy * s); p.vz = f32(p.vz * s); break; }
          case 0xac: { p.sizeCount = count(); p.sizeTarget = float(); const r = float(); p.sizeTarget = madd(r, R.next(), p.sizeTarget); if (!p.sizeCount) p.size = p.sizeTarget; break; }
          case 0xad: p.kind |= K.PRIMENV; break;
          case 0xae: p.kind &= ~(K.MIRROR_S | K.MIRROR_T); break;
          case 0xaf: p.kind = (p.kind & ~K.MIRROR_T) | K.MIRROR_S; break;
          case 0xb0: p.kind = (p.kind & ~K.MIRROR_S) | K.MIRROR_T; break;
          case 0xb1: p.kind |= K.MIRROR_S | K.MIRROR_T; break;
          case 0xb2: { // the transform baked into the place, and left (particle.c's 0xB2)
            const s = p.srt;
            if (!s) break;
            // (only the player's way of placing it: the game's particle has no transform, its place is the world's)
            if (s.player) { const w = srtApply(s, p.px, p.py, p.pz); p.px = w[0]; p.py = w[1]; p.pz = w[2]; p.srt = null; break; }
            // (none under a transform that only follows, xA2)
            if (s.view) break;
            // its generator first goes along its joint (hsd_803983A4), then the matrix is made again whatever its
            // status (HSD_MtxSRT into mmtx) and the place goes through it a coordinate at a time, each row reading
            // the ones already written (pos.x is new for y and z, pos.y for z); then the transform is let go
            // (psRemoveParticleAppSRT)
            const gp = s.owner;
            if (gp && !(gp.kind & 0x800) && gp.type & 0x100) this.follow(gp);
            const m = mtxSRT(s.mmtx ??= new Float32Array(12), s);
            p.px = f32(m[3] + madd(m[2], p.pz, madd(m[0], p.px, f32(m[1] * p.py))));
            p.py = f32(m[7] + madd(m[6], p.pz, madd(m[4], p.px, f32(m[5] * p.py))));
            p.pz = f32(m[11] + madd(m[10], p.pz, madd(m[8], p.px, f32(m[9] * p.py))));
            s.used = (s.used ?? 1) - 1;
            p.srt = null;
            break;
          }
          case 0xb3: {
            if (p.aCmpCount) {
              const s = part(p.aCmpRemain, p.aCmpCount);
              p.aCmp1 = between(p.aCmp1Target, p.aCmp1, s);
              p.aCmp2 = between(p.aCmp2Target, p.aCmp2, s);
            }
            p.aCmpCount = count(); p.aCmpMode = byte(); p.aCmp1Target = byte(); p.aCmp2Target = byte();
            if (!p.aCmpCount) { p.aCmp1 = p.aCmp1Target; p.aCmp2 = p.aCmp2Target; p.aCmpRemain = 0; }
            else p.aCmpRemain = p.aCmpCount;
            break;
          }
          case 0xb4: case 0xb5: break;
          case 0xb6: p.rotateCount = count(); p.rotateTarget = f32(p.rotateTarget + float()); if (!p.rotateCount) p.rotate = p.rotateTarget; break;
          case 0xb7: {
            // its motion turned to head for the leading particle, as fast as it goes now
            const at = this.leaders[byte() & 7];
            if (!at) break;
            // (the speed's square with no fused step, the distance's with two; each root MSL's sqrtf)
            const speed = sqrtf(f32(f32(p.vz * p.vz) + f32(f32(p.vx * p.vx) + f32(p.vy * p.vy))));
            const dx = f32(at[0] - p.px), dy = f32(at[1] - p.py), dz = f32(at[2] - p.pz);
            const far = madd(dz, dz, madd(dx, dx, f32(dy * dy)));
            if (far === 0) break;
            const k = f32(speed / sqrtf(far));
            p.vx = f32(dx * k); p.vy = f32(dy * k); p.vz = f32(dz * k);
            break;
          }
          case 0xb8: {
            // pulled toward the leading particle, the more the nearer; within `range` of it, it ends
            const at = this.leaders[byte() & 7];
            const force = float(), range = float();
            if (!at || range < 0) break;
            const dx = f32(at[0] - p.px), dy = f32(at[1] - p.py), dz = f32(at[2] - p.pz);
            // (hsd_803991D8: dx^2 + dy^2 + dz^2 fused on the dy product; v += k d each one fmadds)
            const far = madd(dz, dz, madd(dx, dx, f32(dy * dy)));
            if (far <= f32(range * range)) { p.life = 1; p.pc = pc; p.wait = 0; return; }
            if (far === 0) break;
            const k = f32(force / far);
            p.vx = madd(k, dx, p.vx); p.vy = madd(k, dy, p.vy); p.vz = madd(k, dz, p.vz);
            break;
          }
          case 0xba: case 0xbb: {
            const prim = cls === 0xba;
            const cur = prim ? p.prim : p.env, tgt = prim ? p.primTarget : p.envTarget;
            settle(cur, tgt, prim ? p.primRemain : p.envRemain, prim ? p.primCount : p.envCount);
            for (const k of ["r", "g", "b", "a"] as const) { const rnd = R.next(); const dd = (byte() << 24) >> 24; tgt[k] = toU8(f32(tgt[k] + f32(dd * 2 * rnd))); }
            if (prim) { if (!p.primCount) p.prim = { ...tgt }; else p.primRemain = p.primCount; }
            else { if (!p.envCount) p.env = { ...tgt }; else p.envRemain = p.envCount; }
            break;
          }
          case 0xbc: { p.pose = byte(); const r = byte(); p.pose = Math.trunc(madd(r, R.next(), p.pose)); const tg = p.bank.texGroups[p.texGroup]; if (tg && tg.offsets[p.pose] !== undefined) p.kind |= K.DISP_TEX; break; }
          case 0xbd: {
            // (the speed's square with no fused step, MSL's sqrtf; over 1e-10F the motion takes the new speed)
            let s = float(); const r = float(); s = madd(r, R.next(), s);
            const mag = sqrtf(f32(f32(p.vz * p.vz) + f32(f32(p.vx * p.vx) + f32(p.vy * p.vy))));
            if (mag > TINY) { s = f32(s / mag); p.vx = f32(p.vx * s); p.vy = f32(p.vy * s); p.vz = f32(p.vz * s); }
            break;
          }
          case 0xbe: p.vx = f32(p.vx * float()); p.vy = f32(p.vy * float()); p.vz = f32(p.vz * float()); break;
          case 0xbf: p.kind |= ((byte() & 7) << 12) | K.LEADS; break;
          case 0xc0: case 0xd0: {
            const prim = cls === 0xc0;
            const cur = prim ? p.prim : p.env, tgt = prim ? p.primTarget : p.envTarget;
            settle(cur, tgt, prim ? p.primRemain : p.envRemain, prim ? p.primCount : p.envCount);
            const n = count();
            const t = { ...cur };
            if (op & 1) t.r = byte(); if (op & 2) t.g = byte(); if (op & 4) t.b = byte(); if (op & 8) t.a = byte();
            if (prim) { p.primTarget = t; p.primCount = n; if (!n) { p.prim = { ...t }; p.primRemain = 0; } else p.primRemain = n; }
            else { p.envTarget = t; p.envCount = n; if (!n) { p.env = { ...t }; p.envRemain = 0; } else p.envRemain = n; }
            break;
          }
          case 0xe0: {
            settle(p.prim, p.primTarget, p.primRemain, p.primCount);
            settle(p.env, p.envTarget, p.envRemain, p.envCount);
            for (const k of ["r", "g", "b", "a"] as const) {
              const rnd = R.next();
              const dd = f32(((byte() << 24) >> 24) * 2 * rnd);
              p.primTarget[k] = toU8(f32(p.primTarget[k] + dd));
              p.envTarget[k] = toU8(f32(p.envTarget[k] + dd));
            }
            if (!p.primCount) p.prim = { ...p.primTarget };
            p.primRemain = p.primCount;
            if (!p.envCount) p.env = { ...p.envTarget };
            p.envRemain = p.envCount;
            break;
          }
          case 0xe9: {
            settle(p.prim, p.primTarget, p.primRemain, p.primCount);
            settle(p.env, p.envTarget, p.envRemain, p.envCount);
            const flags = byte(), timing = byte();
            const scale = timing ? f32(Math.trunc(f32((timing + 1) * R.next())) / timing) : R.next();
            for (const [bit, k] of [[1, "r"], [2, "g"], [4, "b"]] as const) {
              if (!(flags & bit)) continue;
              const dd = f32(scale * (((byte() << 24) >> 24) * 2));
              if (flags & 0x10) p.primTarget[k] = toU8(f32(p.primTarget[k] + dd));
              if (flags & 0x20) p.envTarget[k] = toU8(f32(p.envTarget[k] + dd));
            }
            if (flags & 8) {
              // (a draw of its own; with timing 0 the game divides 0 by 0, and the NaN makes the byte 0)
              const rnd = R.next();
              const n = Math.trunc(f32((timing + 1) * rnd));
              const dd = f32(f32(((byte() << 24) >> 24) * 2 * n) / timing);
              if (flags & 0x10) p.primTarget.a = toU8(f32(p.primTarget.a + dd));
              if (flags & 0x20) p.envTarget.a = toU8(f32(p.envTarget.a + dd));
            }
            if (!p.primCount) p.prim = { ...p.primTarget };
            p.primRemain = p.primCount;
            if (!p.envCount) p.env = { ...p.envTarget };
            p.envRemain = p.envCount;
            break;
          }
          case 0xe1: byte(); break;
          case 0xec: byte(); float(); break;
          case 0xe2: p.kind |= K.TEXEDGE; break;
          case 0xe3: byte(); break;
          case 0xe4: case 0xe5: {
            const mode = byte() & 3, bit = cls === 0xe4 ? K.FLIP_S : K.FLIP_T;
            if (mode === 0) p.kind &= ~bit; else if (mode === 1) p.kind |= bit; else if (mode === 2) p.kind ^= bit;
            else p.kind = R.next() < 0.5 ? p.kind & ~bit : p.kind | bit;
            break;
          }
          case 0xe6: p.kind |= K.DIRVEC; break;
          case 0xe7: p.kind &= ~K.DIRVEC; break;
          case 0xe8: { const t = float(); if (t < 0) p.kind &= ~K.TRAIL; else { p.kind |= K.TRAIL; p.trail = t; } break; }
          case 0xea: case 0xeb: { count(); const fl = byte(); if (fl & 1) byte(); if (fl & 8) byte(); break; }
          case 0xed: {
            let base = float(); const range = float(), timing = byte();
            base = timing ? f32(base + f32(f32(range * Math.trunc(f32((timing + 1) * R.next()))) / timing)) : madd(range, R.next(), base);
            p.rotateTarget = f32(p.rotateTarget + base); p.rotate = f32(p.rotate + base);
            break;
          }
          case 0xfa: p.loopCount = byte(); p.loopPtr = pc; break;
          case 0xfb: if (--p.loopCount !== 0) pc = p.loopPtr; break;
          case 0xfc: p.markPtr = pc; break;
          case 0xfd: pc = p.markPtr; break;
          case 0xfe: case 0xff: p.life = 1; p.pc = pc; p.wait = 0; return;
          default: break;
        }
      }
      if (operand !== 0) break;
    }
    p.pc = pc;
    p.wait = operand;
  }

  /** the game's velocity spread (hsd_80398F8C): the velocity turned by
   *  `angle` off its own axis, at a random roll */
  private spread(p: Particle, angle: number) {
    const vx = p.vx, vy = p.vy, vz = p.vz;
    const az = f32(Math.abs(vz) < 1.1754944e-38 ? (vy >= 0 ? Math.PI / 2 : -Math.PI / 2) : atan2f(vy, vz));
    const sa = sinf(az), ca = cosf(az);
    const t = madd(vy, sa, f32(vz * ca));
    const el = f32(Math.abs(t) < 1.1754944e-38 ? (vx >= 0 ? Math.PI / 2 : -Math.PI / 2) : atan2f(vx, t));
    const se = sinf(el), ce = cosf(el);
    const mag = sqrtf(madd(vz, vz, madd(vx, vx, f32(vy * vy))));
    const wasKind = this.rng.kind;
    this.rng.kind = 5;
    const roll = f32(Math.PI * this.rng.next() * 2);
    this.rng.kind = wasKind;
    const sAng = f32(mag * sinf(angle)), cr = f32(sAng * cosf(roll)), sr = f32(sAng * sinf(roll)), cAng = f32(mag * cosf(angle));
    p.vx = madd(cr, ce, f32(cAng * se));
    p.vy = madd(ce, f32(cAng * sa), madd(se, f32(-cr * sa), f32(sr * ca)));
    p.vz = madd(ce, f32(cAng * ca), msub(se, f32(-cr * ca), f32(sr * sa)));
  }
}

/** how much of a fade is left, as the game counts it: remain / count in 16.16 fixed point */
const part = (remain: number, count: number) => Math.trunc((remain << 16) / count);
/** a byte part-way from `from` to `target`, `left` of the way still to go (16.16), as the game rounds it */
const between = (target: number, from: number, left: number) => (((target << 16) + left * (from - target)) >> 16) & 0xff;

/** a joint's turn alone (its world matrix's three axes, each of length one),
 *  row-major 3x3: what an emission on the joint is turned by */
function turnOf(w: Float32Array): number[] {
  // (each axis PSVECNormalize'd, as hsd_8039DAD4 and hsd_8039D71C take them)
  const out = new Array(9), a = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    PSVECNormalize([w[c * 4], w[c * 4 + 1], w[c * 4 + 2]], a);
    out[c] = a[0]; out[3 + c] = a[1]; out[6 + c] = a[2];
  }
  return out;
}

/** a color byte as the game makes one of a float: below 0 is 0, over 255 is 255, then (u8)(s32) - fctiwz, which
 *  makes a NaN 0x80000000, its low byte 0 */
function toU8(v: number): number {
  if (v < 0) v = 0;
  if (v > 255) v = 255;
  return Number.isNaN(v) ? 0 : Math.trunc(v) & 0xff;
}
/** 1e-10F, the speed 0xBD scales from */
const TINY = Math.fround(1e-10);

/** a point through a particle transform (scale, then rotation X, Y, Z, then translate) */
export function srtApply(s: AppSRT, x: number, y: number, z: number): [number, number, number] {
  x *= s.sx; y *= s.sy; z *= s.sz;
  let c = Math.cos(s.rx), n = Math.sin(s.rx);
  [y, z] = [y * c - z * n, y * n + z * c];
  c = Math.cos(s.ry); n = Math.sin(s.ry);
  [x, z] = [x * c + z * n, -x * n + z * c];
  c = Math.cos(s.rz); n = Math.sin(s.rz);
  [x, y] = [x * c - y * n, x * n + y * c];
  return [x + s.tx, y + s.ty, z + s.tz];
}
