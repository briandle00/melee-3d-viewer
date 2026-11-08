// A tornado particle's last place (psdisp.c calcTornadoLastPos): its velocity holds its angle round its generator,
// how far out and how far along, so its trail's tail and its way across the picture come from where its update put
// it a step back - not from its place less its velocity (the KO blast's spirals, common 0xD8, 30 to 50 pixels off
// until 2026-11-09). Made-up generator, no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { K, ParticleSystem } from "../src/render3d/fx/particles.ts";
import { buildParticles, FLOATS, tornadoLast } from "../src/render3d/fx/draw.ts";

const cmd = (over: Partial<CmdList> = {}): CmdList => ({
  type: 2, texGroup: 0, genLife: 1, life: 50, kind: K.TRAIL, grav: 0.15, fric: 1, vx: 0, vy: 0, vz: 1.5, radius: 12,
  angle: 0.2, random: -1, size: 2, param1: 0, param2: 0, param3: 0, cmd: new Uint8Array([0x3f, 0xff, 0xff]), ...over,
});

function spiral() {
  const cmds: CmdList[] = [];
  cmds[0] = cmd();
  const bank = { id: 0, cmds, texGroups: [] } as unknown as EffectBank;
  const ps = new ParticleSystem();
  const g = ps.generator(bank, 0)!;
  g.px = 3; g.py = -4; g.pz = 1;
  return { ps, g };
}

test("a tornado particle's last place is where its update put it a step back", () => {
  const { ps } = spiral();
  ps.step();
  const p = ps.particles.find((x) => x.kind & K.TORNADO)!;
  assert.ok(p, "a tornado particle");
  for (let i = 0; i < 6; i++) {
    const was = [p.px, p.py, p.pz];
    ps.step();
    const last = tornadoLast(p, [0, 0, 0]);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(last[k] - was[k]) < 1e-4, `step ${i}: ${last} against ${was}`);
    // (and not its place less its velocity, which holds its angle and its way out)
    assert.ok(Math.hypot(p.px - p.vx - was[0], p.py - p.vy - was[1], p.pz - p.vz - was[2]) > 0.5);
  }
});

test("a tornado trail's tail is drawn at its last place", () => {
  const { ps } = spiral();
  ps.step(); ps.step(); ps.step();
  const p = ps.particles.find((x) => x.kind & K.TORNADO)!;
  const last = tornadoLast(p, [0, 0, 0]);
  const { data } = buildParticles([p], { right: [1, 0, 0], up: [0, 1, 0] });
  // (corner 0 is the tail's place less the quad's first basis, corner 2 the head's plus it: the two less the head
  // are the tail. Until 2026-11-09 the place less the velocity)
  for (let k = 0; k < 3; k++) {
    const tail = data[k] + data[2 * FLOATS + k] - [p.px, p.py, p.pz][k];
    assert.ok(Math.abs(tail - last[k]) < 1e-3, `axis ${k}: the tail at ${tail}, its last place ${last[k]}`);
  }
});
