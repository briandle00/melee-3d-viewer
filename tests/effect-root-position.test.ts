import test from 'node:test';
import assert from 'node:assert/strict';
import { FxWorld } from '../src/render3d/fx/world.ts';
import { type EffectBank } from '../src/render3d/fx/bank.ts';
import { effectBanks, withGameFiles } from './game-files.ts';

const position: [number, number, number] = [-32, 26, 0];
const context = { pos: position, follow: null, facing: 1, angle: 0, damage: 0, scale: 1, owner: null };

test('0x3FA replaces the effect root translation when posing its flash', () => {
  // No game data: record the placement requested of a model with an authored root offset.
  const models = [];
  models[21] = { joint: 0, life: 8 };
  const common = { id: 0, models, prop: () => ({ length: 8 }) } as unknown as EffectBank;
  const world = new FxWorld(common, () => -1, new Map([[0, common]]));
  world.spawn(0x3fa, context);
  assert.equal(world.models.length, 1);
  const calls: unknown[][] = [];
  world.poseModel(world.models[0], { pose: (...args: unknown[]) => calls.push(args) } as any, 3);
  assert.deepEqual(calls[0].slice(1, 4), position);
  assert.equal(calls[0][9], true, 'the authored root translation must not be added to the spawn position');
});

test('the flash root stays at its spawn position across its animation', withGameFiles, () => {
  const banks = effectBanks([0]), world = new FxWorld(banks.get(0)!, () => -1, banks);
  world.spawn(0x3fa, context);
  const model = world.models[0], prop = model.bank.prop(model.index, 0, true)!;
  for (const age of [0, 1, 3, 5]) {
    world.poseModel(model, prop, age);
    assert.deepEqual(Array.from(prop.skeleton.world.slice(12, 15)), position);
  }
});
