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
