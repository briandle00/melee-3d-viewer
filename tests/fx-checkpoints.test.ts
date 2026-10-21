// fx/checkpoints.ts and FxWorld.save/load: a jump made from the nearest checkpoint and stepped on gives exactly
// the particles of playing straight through (made-up stage generators with random emission, no game files),
// and the checkpoints stay within their memory budget.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { FxWorld } from "../src/render3d/fx/world.ts";
import { Checkpoints, jumpTo, type Kept } from "../src/render3d/fx/checkpoints.ts";
import type { FxSnapshot } from "../src/render3d/fx/world.ts";

const cmd = (over: Partial<CmdList> = {}): CmdList => ({
  type: 0, texGroup: 0, genLife: 0, life: 90, kind: 0, grav: 0.02, fric: 0.98, vx: 0.3, vy: 1, vz: 0, radius: 2, angle: 0.5,
  random: 0.7, size: 1, param1: 0, param2: 0, param3: 0,
  // (its script: wait 8191 frames - the particle lives out its life)
  cmd: new Uint8Array([0x3f, 0xff, 0xff]), ...over,
});
const bank = (cmds: CmdList[] = []) => ({ id: 0, cmds, texGroups: [] } as unknown as EffectBank);

type Ev = (string | number)[];
function world(stage: EffectBank, events: Ev[]) {
  const w = new FxWorld(bank(), (_c, part) => part);
  w.trackFx = () => [];
  w.stageBank = () => stage;
  w.stageJoint = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  w.trackOrdered = (f) => events.filter((e) => Number(e[0]) + 123 === f) as never;
  w.trackStageBefore = (f) => events.filter((e) => Number(e[0]) + 123 < f) as never;
  return w;
}

function scene() {
  const stage = bank([]);
  const cmds = (stage as unknown as { cmds: CmdList[] }).cmds;
  cmds[30002] = cmd();
  cmds[30003] = cmd({ life: 200, random: 1.5, vx: -0.2, grav: 0.01 });
  // (two never-ending generators, made at different frames)
  const events: Ev[] = [[-113, "gen", 30, 30002, 0, 0, 0, 77, 1, 3], [87, "gen", 31, 30003, 10, 5, 0, 78, 1, 3]];
  return { stage, events };
}

/** what of a world's particles a jump must give exactly */
function state(w: FxWorld) {
  return {
    particles: w.ps.particles.map((p) => [p.px, p.py, p.pz, p.vx, p.vy, p.vz, p.life, p.size]),
    gens: w.ps.gens.map((g) => [g.px, g.py, g.pz, g.count, g.age]),
    rng: JSON.stringify(w.ps.rng),
  };
}

const keep = (w: FxWorld, f: number): Kept<FxSnapshot> => { const s = w.save(); return { frame: f, snap: s, bytes: s.bytes }; };

test("a jump from the nearest checkpoint is the frame played straight through", () => {
  const { stage, events } = scene();
  const END = 1000, TO = [100, 239, 240, 531, 777, 999];
  // (played through, the state of each frame asked for)
  const played = world(stage, events);
  const want = new Map<number, ReturnType<typeof state>>();
  for (let f = 0; f <= END; f++) {
    played.stepStage(f);
    if (TO.includes(f)) want.set(f, state(played));
  }
  assert.ok(want.get(531)!.particles.length > 10, "particles to compare");
  // (a world whose checkpoints are made as it plays, then jumped about, back and forth)
  const w = world(stage, events);
  const store = new Checkpoints(keep(w, -1), 240);
  jumpTo(store, END, (s) => w.load(s), (g) => w.stepStage(g), () => keep(w, -1));
  // (each checkpoint at the frame it was kept on)
  for (const x of store.snaps) if (x !== store.snaps[0]) assert.equal(x.frame % 240, 0);
  for (const f of [531, 100, 999, 240, 777, 239]) {
    const from = jumpTo(store, f, (s) => w.load(s), (g) => w.stepStage(g), () => keep(w, -1));
    assert.equal(from, store.nearest(f).frame);
    assert.deepEqual(state(w), want.get(f), `frame ${f} from ${from}`);
  }
});

test("a loaded checkpoint is the world's own copy: stepping on does not change it", () => {
  const { stage, events } = scene();
  const w = world(stage, events);
  for (let f = 0; f <= 300; f++) w.stepStage(f);
  const s = w.save(), before = state(w);
  for (let f = 301; f <= 400; f++) w.stepStage(f);
  w.load(s);
  assert.deepEqual(state(w), before);
  for (let f = 301; f <= 400; f++) w.stepStage(f);
  w.load(s);
  assert.deepEqual(state(w), before);
});

test("past their budget the checkpoints thin out, the first always kept", () => {
  const snap = (frame: number): Kept<number> => ({ frame, snap: frame, bytes: 1000 });
  const store = new Checkpoints<number>(snap(-1), 10, 10500);
  for (let f = 0; f <= 1000; f++) store.keep(f, () => snap(f));
  assert.ok(store.bytes <= 10500, `${store.bytes} bytes`);
  assert.equal(store.snaps[0].frame, -1);
  assert.ok(store.every > 10 && store.snaps.every((x, i) => i === 0 || x.frame % store.every === 0), `spacing ${store.every}`);
  assert.deepEqual(store.nearest(555).frame, Math.floor(555 / store.every) * store.every);
  assert.equal(store.nearest(-1).frame, -1);
});
