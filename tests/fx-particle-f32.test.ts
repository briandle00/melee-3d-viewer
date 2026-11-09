// fx/particles.ts in single precision as main.dol computes it (particle.c hsd_8039930C, hsd_80398F8C, hsd_803991D8;
// generator.c hsd_8039DAD4, hsd_8039EE24): every step rounded to a float, a * b + c one fused multiply-add where the
// compiled code has an fmadds. Made-up generators and scripts: no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { hsdFloat, hsdNext, K, ParticleSystem } from "../src/render3d/fx/particles.ts";
import { madd, msub, sqrtf } from "../src/render3d/gxmath.ts";

const f32 = Math.fround;
const be = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v); return [...b]; };
const WAIT = [0x3f, 0xff, 0xff];

const cmd = (over: Partial<CmdList> = {}): CmdList => ({
  type: 0, texGroup: 0, genLife: 0, life: 50, kind: 0, grav: 0, fric: 1, vx: 0, vy: 0, vz: 0, radius: 0, angle: 0,
  random: -1, size: 1, param1: 0, param2: 0, param3: 0, cmd: new Uint8Array(WAIT), ...over,
});
function system(cmds: Record<number, CmdList>) {
  const list: CmdList[] = [];
  for (const [k, v] of Object.entries(cmds)) list[Number(k)] = v;
  return { ps: new ParticleSystem(), bank: { id: 0, cmds: list, texGroups: [] } as unknown as EffectBank };
}
const isF32 = (v: number) => Object.is(f32(v), v);

test("the script's adds and scales leave the particle's numbers floats (0x88, 0x98, 0xAB, 0xBE, 0xB6)", () => {
  const ops = [0x8f, ...be(0.1), ...be(0.2), ...be(0.3), // (0x88|7: pos += 0.1, 0.2, 0.3)
               0x9f, ...be(1 / 3), ...be(1 / 7), ...be(1 / 9), // (0x98|7: vel +=)
               0xab, ...be(1.1), 0xbe, ...be(0.7), ...be(1.3), ...be(0.9), 0xb6, 0, ...be(0.123), ...WAIT];
  const { ps, bank } = system({ 1: cmd({ vx: 0.37, vy: 1.91, vz: -2.3, cmd: new Uint8Array(ops) }) });
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  for (const k of ["px", "py", "pz", "vx", "vy", "vz", "rotate", "rotateTarget"] as const) assert.ok(isF32(p[k]), k);
  // (vel.x: (0.37 + 1/3) * 1.1 * 0.7, each step rounded, then pos.x += it)
  const vx = f32(f32(f32(f32(0.37) + f32(1 / 3)) * f32(1.1)) * f32(0.7));
  assert.equal(p.vx, vx);
  assert.equal(p.px, f32(f32(0.1) + vx));
});

test("0xA8: pos += 2v * rnd - v, one fmsubs on the rounded 2v, then the add", () => {
  const ops = [0xa8, ...be(0.3), ...be(0.7), ...be(1.9), ...WAIT];
  const { ps, bank } = system({ 1: cmd({ cmd: new Uint8Array(ops) }) });
  ps.rng.set(12345);
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  let s = 12345;
  const draw = () => { s = hsdNext(s); return hsdFloat(s); };
  // (the emission's own two draws first: its radius and its angle round the disc)
  draw(); draw();
  const at = (v: number) => msub(f32(2 * f32(v)), draw(), f32(v));
  assert.equal(p.px, f32(0 + at(0.3)));
  assert.equal(p.py, f32(0 + at(0.7)));
  assert.equal(p.pz, f32(0 + at(1.9)));
});

test("0xA9: the velocity spread in the game's fused order (hsd_80398F8C)", () => {
  const ops = [0xa9, ...be(0.4), ...WAIT];
  const { ps, bank } = system({ 1: cmd({ vx: 1.25, vy: -0.75, vz: 2.5, cmd: new Uint8Array(ops) }) });
  ps.rng.set(999);
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  for (const k of ["vx", "vy", "vz"] as const) assert.ok(isF32(p[k]), k);
  // (its speed is kept: |v| from sqrtf of the fused squares, to within the float steps)
  const m0 = sqrtf(madd(f32(2.5), f32(2.5), madd(f32(1.25), f32(1.25), f32(f32(-0.75) * f32(-0.75)))));
  const m1 = Math.hypot(p.vx, p.vy, p.vz);
  assert.ok(Math.abs(m1 - m0) < 1e-5 * m0);
});

test("a generator's count: count + random * rnd, one fmadds (hsd_8039EE24)", () => {
  const { ps, bank } = system({ 1: cmd({ random: 0.3, life: 5 }) });
  ps.rng.set(4242);
  const g = ps.generator(bank, 1)!;
  const c0 = g.count;
  ps.rng.set(777);
  ps.step();
  const r = hsdFloat(hsdNext(777));
  const want = madd(f32(0.3), r, c0);
  // (it emits once at 1 or more, 1 taken away)
  assert.equal(g.count, want >= 1 ? f32(want - 1) : want);
});

test("emission on a disc: the radius times the angle's cosine and sine, each rounded, the speed's frame PSMTXConcat'd", () => {
  // (a disc of radius 2 at a fixed place round the circle: angle range [0, 0] with the angle step, along +y)
  const { ps, bank } = system({ 1: cmd({ type: 0, radius: -2, angle: 0, vy: 3, random: -1, param1: 0.5, param2: 0.5 }) });
  const g = ps.generator(bank, 1)!;
  g.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  for (const k of ["px", "py", "pz", "vx", "vy", "vz"] as const) assert.ok(isF32(p[k]), k);
  // (the frame along +y turns the disc's x, y into world x, -z ...: the radius is kept - where it was made, its
  // first step's motion taken back)
  assert.ok(Math.abs(Math.hypot(p.px - p.vx, p.py - p.vy, p.pz - p.vz) - 2) < 1e-5);
  assert.ok(Math.abs(Math.hypot(p.vx, p.vy, p.vz) - 3) < 1e-5);
});

test("a leading particle's place is its joint's: moved by the difference to the joint's place, in float32", () => {
  // (0xBF 0: it leads slot 0; a follower aims at it with 0xB7)
  const lead = cmd({ vx: 1e-3, vy: 0, vz: 0, cmd: new Uint8Array([0xbf, 0, ...WAIT]) });
  const { ps, bank } = system({ 1: lead });
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  assert.equal(p.kind & K.LEADS, K.LEADS);
  // (a fresh joint at 0: its place is the particle's)
  const leaders = (ps as unknown as { leaders: number[][] }).leaders;
  assert.deepEqual(leaders[0], [p.px, p.py, p.pz]);
});
