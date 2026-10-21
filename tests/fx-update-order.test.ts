// fx/particles.ts: the order the game updates particles in (particle.c hsd_8039930C, eflib.c
// efLib_particles_proc_main), its random numbers (HSD_Randf), on made-up generators and scripts: no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { hsdFloat, hsdNext, K, ParticleSystem, Rng } from "../src/render3d/fx/particles.ts";

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

test("HSD_Randf: state * 214013 + 2531011, its high 16 bits over 65536; one stream, seeded or the game's", () => {
  assert.equal(hsdNext(1), 2745024);
  assert.equal(hsdFloat(hsdNext(1)), 41 / 65536);
  assert.equal(hsdNext(0xffffffff), (0xffffffff * 214013 + 2531011) % 2 ** 32);
  // (the stand-in stream is the same arithmetic from its own seed)
  const r = new Rng();
  r.seed(77);
  let s = 77;
  for (let i = 0; i < 5; i++) { s = hsdNext(s); assert.equal(r.next(), hsdFloat(s)); }
  // (and from the game's state, once set, the draws are the game's)
  r.set(1234);
  assert.equal(r.next(), hsdFloat(hsdNext(1234)));
  assert.equal(r.state, hsdNext(1234));
});

test("a particle's step: its counters, its script when its wait runs out, --life, then vel.y -= grav, vel *= fric, pos += vel", () => {
  // (its script sets vy to 2 the frame it runs: the motion that frame already has it)
  const { ps, bank } = system({ 1: cmd({ kind: K.GRAV | K.FRIC, grav: 0.5, fric: 0.5, vy: 10, life: 3,
                                        cmd: new Uint8Array([0x92, ...be(2), ...WAIT]) }) });
  const g = ps.generator(bank, 1)!;
  g.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  // (made by the generator pass, it ran its whole step at once: the script's vy, then gravity, friction, motion)
  const vy = f32(f32(2 - 0.5) * 0.5);
  assert.equal(p.vy, vy);
  assert.equal(p.py, vy);
  assert.equal(p.life, 3);
  // (the next frame: no script, the same physics again)
  ps.step();
  const vy2 = f32(f32(vy - 0.5) * 0.5);
  assert.equal(p.vy, vy2);
  assert.equal(p.py, f32(vy + vy2));
  assert.equal(p.life, 2);
});

test("a new particle runs its commands at once, with no step of its counters that frame", () => {
  // (its script starts a size fade to 3 over 2 frames: the size is 1 still after the frame it is made)
  const { ps, bank } = system({ 1: cmd({ cmd: new Uint8Array([0xa0, 2, ...be(3), ...WAIT]) }) });
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  const [p] = ps.particles;
  assert.equal(p.size, 1);
  ps.step();
  assert.equal(p.size, 2);
  ps.step();
  assert.equal(p.size, 3);
});

test("a child a command makes in the particle pass runs twice before it is first drawn", () => {
  // (the parent waits a frame, then makes child 2: at once (hsd_8039930C(child, parent)), and again as the pass
  // comes to it right after its parent; the child moves 1 up a step)
  const { ps, bank } = system({
    1: cmd({ cmd: new Uint8Array([0x01, 0xa4, 0x00, 0x02, ...WAIT]) }),
    2: cmd({ vy: 1 }),
  });
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  assert.equal(ps.particles.length, 1);
  ps.step();
  const child = ps.particles.find((p) => p.cmd === bank.cmds[2].cmd)!;
  assert.ok(child, "the child");
  assert.equal(child.py, 2);
  ps.step();
  assert.equal(child.py, 3);
});

test("a generator a particle makes emits the same frame; the particles step before the generators", () => {
  // (a particle made by generator 1 on frame 1; on frame 2 its wait runs out and it makes generator 3, which
  // emits in that frame's generator pass)
  const { ps, bank } = system({
    1: cmd({ cmd: new Uint8Array([0x01, 0xa5, 0x00, 0x03, ...WAIT]) }),
    3: cmd({ vy: 1 }),
  });
  ps.generator(bank, 1)!.genLife = 1;
  ps.step();
  assert.equal(ps.particles.length, 1);
  ps.step();
  const made = ps.particles.filter((p) => p.cmd === bank.cmds[3].cmd);
  assert.equal(made.length, 1, "emitted the frame it was made");
  // (made in the generator pass: its own step once, at its making)
  assert.equal(made[0].py, 1);
});
