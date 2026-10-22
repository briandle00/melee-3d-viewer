// fx/appsrt.ts and the particle transforms' rules (psDispSubAppSRT, psAddGeneratorAppSRT's status,
// efLib_Cb_PtclAppSRTHook's private copies, generator.c's type 0x1000), on made-up generators: no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { type AppSRT, ParticleSystem, srtApply } from "../src/render3d/fx/particles.ts";
import { APP_ONCE, APP_STILL, appExtents, appMatrix, mtxGetScale, mtxPoint, mtxSRT } from "../src/render3d/fx/appsrt.ts";

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const srt = (over: Partial<AppSRT> = {}): AppSRT =>
  ({ tx: 3, ty: -2, tz: 5, rx: 0.3, ry: -1.1, rz: 2.4, sx: 1.5, sy: 0.75, sz: 2, follow: false, ...over });

test("HSD_MtxSRT's matrix places a point as the turn and scale do", () => {
  const s = srt(), m = mtxSRT(new Float32Array(12), s);
  for (const [x, y, z] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -3, 0.5]]) {
    const a = mtxPoint(m, x, y, z), b = srtApply(s, x, y, z);
    for (let i = 0; i < 3; i++) assert.ok(near(a[i], b[i]), `${a} ${b}`);
  }
  assert.ok(m.every((v) => Math.fround(v) === v), "every entry a float32");
});

test("a transform made ONCE keeps the matrix of its first draw; a dynamic one follows", () => {
  const once = srt({ status: APP_ONCE }), dyn = srt();
  const m0 = Float32Array.from(appMatrix(once));
  assert.equal(once.status, APP_STILL);
  once.tx = 100; once.sx = 9;
  assert.deepEqual(Array.from(appMatrix(once)), Array.from(m0));
  appMatrix(dyn);
  dyn.tx = 100;
  assert.equal(appMatrix(dyn)[3], 100);
});

test("a particle's quad is |view times the matrix's first column| by |its second| times its size", () => {
  const s = srt({ rx: 0, ry: 0, rz: 0.5, sx: 2, sy: 3 });
  const m = mtxSRT(new Float32Array(12), s);
  // (a view turned about y and moved: lengths kept)
  const c = Math.cos(0.7), n = Math.sin(0.7);
  const view = [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 10, -4, -300, 1];
  const [ex, ey] = appExtents(m, 1.5, view);
  assert.ok(near(ex, 3) && near(ey, 4.5), `${ex} ${ey}`);
  // (the scales are the columns', not the turn's: a turn about z leaves them)
  const [ax, ay] = appExtents(m, 1.5, null);
  assert.ok(near(ax, 3) && near(ay, 4.5), `${ax} ${ay}`);
});

test("HSD_MtxGetScale: each column's length, the first two taken out; negative when turned over", () => {
  const s = srt({ sx: 2, sy: 0.5, sz: 4, tx: 0, ty: 0, tz: 0 }), m = mtxSRT(new Float32Array(12), s);
  // (as a column-major 4 x 4, a joint's world matrix)
  const w = new Float32Array(16);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) w[k * 4 + r] = m[r * 4 + k];
  w[15] = 1;
  const [x, y, z] = mtxGetScale(w);
  assert.ok(near(x, 2) && near(y, 0.5) && near(z, 4), `${x} ${y} ${z}`);
  for (let r = 0; r < 3; r++) w[8 + r] = -w[8 + r];
  const t = mtxGetScale(w);
  assert.ok(t.every((v) => v < 0), `${t}`);
});

// ---- generators made up: bank 0's 0x96 (a private copy for each particle) and another

const cmd = (over: Partial<CmdList> = {}): CmdList => ({
  type: 0, texGroup: 0, genLife: 0, life: 50, kind: 0, grav: 0, fric: 1, vx: 0, vy: 0, vz: 0, radius: 0, angle: 0,
  random: -1, size: 1, param1: 0, param2: 0, param3: 0, cmd: new Uint8Array([0x3f, 0xff, 0xff]), ...over,
});
function system() {
  const cmds: CmdList[] = [];
  cmds[0x96] = cmd();
  cmds[0x99] = cmd();
  const bank = { id: 0, cmds, texGroups: [] } as unknown as EffectBank;
  return { ps: new ParticleSystem(), bank };
}

test("bank 0's 0x96 gives each particle a private transform made ONCE; others share their generator's", () => {
  const { ps, bank } = system();
  const own = ps.generator(bank, 0x96)!, shared = ps.generator(bank, 0x99)!;
  for (const g of [own, shared]) g.srt = srt({ tx: 0, used: 1, owner: g, follow: true });
  ps.step();
  const mine = ps.particles.filter((p) => p.gen === own), theirs = ps.particles.filter((p) => p.gen === shared);
  assert.ok(mine.length > 0 && theirs.length > 0, "particles made");
  for (const p of mine) {
    assert.notEqual(p.srt, own.srt);
    // (drawn once as the step ends: STILL from then on)
    assert.equal(p.srt!.status, APP_STILL);
  }
  for (const p of theirs) assert.equal(p.srt, shared.srt);
  // the generators move: the private ones stay as they were made, the shared one goes with its generator
  own.srt!.tx = 50; shared.srt!.tx = 50;
  assert.equal(appMatrix(mine[0].srt!)[3], 0);
  assert.equal(appMatrix(theirs[0].srt!)[3], 50);
});

test("a particle's children share its transform (its private one too)", () => {
  const { ps, bank } = system();
  // (0x96's script: a child of 0x99 at once, then wait)
  (bank as unknown as { cmds: CmdList[] }).cmds[0x96] = cmd({ cmd: new Uint8Array([0xa4, 0x00, 0x99, 0x3f, 0xff, 0xff]) });
  const g = ps.generator(bank, 0x96)!;
  g.srt = srt({ used: 1, owner: g, follow: true });
  ps.step();
  const parents = ps.particles.filter((p) => p.cmd?.[0] === 0xa4), children = ps.particles.filter((p) => p.cmd?.[0] === 0x3f);
  assert.ok(parents.length > 0 && children.length >= parents.length, `${parents.length} ${children.length}`);
  for (const c of children) assert.ok(parents.some((p) => p.srt === c.srt), "a child under its parent's transform");
});

// ---- the quads as drawn (fx/draw.ts buildParticles): a particle's corners from its middle, under a camera

import { buildParticles, FLOATS } from "../src/render3d/fx/draw.ts";
import { readFileSync } from "node:fs";

/** the first quad's corners, as built (world positions) */
function quadOf(data: Float32Array): number[][] {
  return [0, 1, 2, 3].map((v) => [data[v * FLOATS], data[v * FLOATS + 1], data[v * FLOATS + 2]]);
}
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("a quad under a transform is sized by the view it is drawn through (the stage mirror's camera too)", () => {
  const { ps, bank } = system();
  const g = ps.generator(bank, 0x99)!;
  g.srt = srt({ rx: 0, ry: 0, rz: 0, sx: 2, sy: 2, used: 1, owner: g, follow: true });
  ps.step();
  const one = ps.particles.slice(0, 1);
  assert.equal(one.length, 1);
  const axes = { right: [1, 0, 0], up: [0, 1, 0] };
  // (a view that doubles lengths: the quad's half-diagonal doubles with it - psDispSubAppSRT's |vmtx mmtx|)
  const view = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, -100, 1];
  const plain = quadOf(buildParticles(one, axes).data), viewed = quadOf(buildParticles(one, { ...axes, view }).data);
  const r0 = dist(plain[0], plain[2]), r1 = dist(viewed[0], viewed[2]);
  assert.ok(near(r1, 2 * r0), `${r0} ${r1}`);
  // the renderer hands the mirror pass its camera's view and projection (beginMirror), so its particles are
  // sized as the game's mirror camera draws them
  const src = readFileSync(new URL("../src/render3d/renderer.ts", import.meta.url), "utf8");
  assert.match(src, /beginMirror\(\): \{ right: number\[\]; up: number\[\]; view: Mat; viewProj: Mat \}/);
});

import { drawPoint, followMatrix } from "../src/render3d/fx/appsrt.ts";
import { madd, mtxFromGL } from "../src/render3d/gxmath.ts";

test("a follow-only transform (xA2): its place through the view, the view's scale alone, no turn", () => {
  // a view turned about y and moved (GL's column-major), as GX's 3 x 4
  const c = Math.fround(Math.cos(0.7)), n = Math.fround(Math.sin(0.7));
  const view = [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 10, -4, -300, 1];
  const V = mtxFromGL(view, new Float32Array(12), 0);
  const s = srt({ tx: 3, ty: -2, tz: 5, rx: 1, ry: 2, rz: 3, sx: 4, sy: 4, sz: 4, view: true });
  const D = followMatrix(s, V, new Float32Array(12));
  // (no turn: off the diagonal 0; on it the view's scale, 1 to a float's precision)
  for (const k of [1, 2, 4, 6, 8, 9]) assert.equal(D[k], 0);
  for (const k of [0, 5, 10]) assert.ok(near(D[k], 1, 1e-6), `${D[k]}`);
  // (the place: the view times the transform's place)
  const want = [c * 3 + n * 5 + 10, -2 - 4, -n * 3 + c * 5 - 300];
  for (let r = 0; r < 3; r++) assert.ok(near(D[r * 4 + 3], want[r], 1e-6), `${D[r * 4 + 3]} ${want[r]}`);
  // a point through it, in the game's order: m03 + (m02 z + (m00 x + m01 y)), each sum's first product fused
  const p = drawPoint(D, 1.5, -2.25, 0.75, [0, 0, 0]);
  for (let r = 0; r < 3; r++) {
    const m = D.subarray(r * 4, r * 4 + 4);
    assert.equal(p[r], Math.fround(m[3] + madd(m[2], 0.75, madd(m[0], 1.5, Math.fround(m[1] * -2.25)))));
  }
});

test("a follow-only transform's particle is drawn at the transform's place plus its own in the camera's axes", () => {
  const { ps, bank } = system();
  const g = ps.generator(bank, 0x99)!;
  g.srt = srt({ tx: 7, ty: 1, tz: -3, rx: 0, ry: 0, rz: 0, sx: 2, sy: 2, sz: 2, used: 1, owner: g, follow: true, view: true });
  ps.step();
  const one = ps.particles.slice(0, 1);
  const p = one[0];
  p.px = 1; p.py = 2; p.pz = 0; p.vx = 0; p.vy = 0; p.vz = 0;
  const c = Math.fround(Math.cos(0.4)), n = Math.fround(Math.sin(0.4));
  const view = [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, -50, 1];
  const axes = { right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], view };
  const q = quadOf(buildParticles(one, axes).data);
  const mid = [0, 1, 2].map((i) => (q[0][i] + q[2][i]) / 2);
  // (the camera's right is (c, 0, n), its up (0, 1, 0): the place moves 1 along the right and 2 up from the transform's)
  const want = [7 + c, 1 + 2, -3 + n];
  for (let i = 0; i < 3; i++) assert.ok(near(mid[i], want[i], 1e-4), `${mid} ${want}`);
  // (and the quad is sized by the transform's scale through the view: twice the particle's size across)
  const half = dist(q[0], q[2]) / 2;
  assert.ok(near(half, Math.hypot(2 * p.size, 2 * p.size), 1e-4), `${half}`);
});

test("0xB2: the place through the transform's matrix made again, each row reading the rows already written; none under a follow-only one", () => {
  const { ps, bank } = system();
  // (0x99's script: wait a frame, then 0xB2, then wait)
  (bank as unknown as { cmds: CmdList[] }).cmds[0x99] = cmd({ cmd: new Uint8Array([0x01, 0xb2, 0x3f, 0xff, 0xff]) });
  const g = ps.generator(bank, 0x99)!;
  g.srt = srt({ status: APP_ONCE, used: 1, owner: g });
  g.genLife = 1;
  ps.step();
  const p = ps.particles.find((q) => q.gen === g)!;
  const s = p.srt!;
  const used = s.used!;
  p.px = 1.5; p.py = -2.25; p.pz = 0.75; p.vx = p.vy = p.vz = 0;
  // (STILL since its first draw; the command makes the matrix again from where the transform is now)
  appMatrix(s);
  s.tx = 40;
  const m = mtxSRT(new Float32Array(12), s);
  const x = Math.fround(m[3] + madd(m[2], 0.75, madd(m[0], 1.5, Math.fround(m[1] * -2.25))));
  const y = Math.fround(m[7] + madd(m[6], 0.75, madd(m[4], x, Math.fround(m[5] * -2.25))));
  const z = Math.fround(m[11] + madd(m[10], 0.75, madd(m[8], x, Math.fround(m[9] * y))));
  ps.step();
  assert.equal(p.srt, null);
  assert.equal(s.used, used - 1);
  assert.deepEqual([p.px, p.py, p.pz], [x, y, z]);
  assert.deepEqual(Array.from(s.mmtx!), Array.from(m));
  // (under a follow-only transform, xA2, the command does nothing)
  const { ps: ps2, bank: bank2 } = system();
  (bank2 as unknown as { cmds: CmdList[] }).cmds[0x99] = cmd({ cmd: new Uint8Array([0x01, 0xb2, 0x3f, 0xff, 0xff]) });
  const g2 = ps2.generator(bank2, 0x99)!;
  g2.srt = srt({ used: 1, owner: g2, follow: true, view: true });
  g2.genLife = 1;
  ps2.step();
  const p2 = ps2.particles.find((q) => q.gen === g2)!;
  p2.px = 1.5; p2.vx = p2.vy = p2.vz = 0;
  ps2.step();
  assert.equal(p2.srt, g2.srt);
  assert.equal(p2.px, 1.5);
});

import { FxWorld } from "../src/render3d/fx/world.ts";

test("a generator the stage's code places (grLib_801C96F8): its transform made ONCE; its own, kind 0x20000, no longer only follows", () => {
  const cmds: CmdList[] = [];
  cmds[30001] = cmd();
  cmds[30002] = cmd({ kind: 0x20000 });
  const stage = { id: 30, cmds, texGroups: [] } as unknown as EffectBank;
  const w = new FxWorld({ id: 0, cmds: [], texGroups: [] } as unknown as EffectBank, (_c, part) => part);
  w.stageBank = () => stage;
  w.stageScale = 2;
  const gen = (w as unknown as { stageGen(e: unknown[]): { srt: AppSRT | null; px: number } }).stageGen.bind(w);
  // (["sgen", running object, file, id, x, y, z, seed, stage object, joint]: no joint)
  const a = gen([0, "sgen", 0, 30, 30001, 5, 6, 7, 1, -1, -1])!;
  assert.equal(a.srt!.status, APP_ONCE);
  assert.deepEqual([a.srt!.tx, a.srt!.ty, a.srt!.tz, a.srt!.sx, a.px], [5, 6, 7, 2, 0]);
  const b = gen([0, "sgen", 0, 30, 30002, 5, 6, 7, 1, -1, -1])!;
  assert.equal(b.srt!.view, false);
  assert.equal(b.srt!.status ?? 0, 0);
  assert.deepEqual([b.srt!.tx, b.srt!.sx], [5, 2]);
  // (one of the common bank, 0: the stage's scale all the same)
  (w as unknown as { banks: Map<number, EffectBank> }).banks.set(0, { id: 0, cmds: [cmd()], texGroups: [] } as unknown as EffectBank);
  const c = gen([0, "sgen", 0, 0, 0, 5, 6, 7, 1, -1, -1])!;
  assert.equal(c.srt!.sx, 2);
});
