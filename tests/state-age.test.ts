// How long a fighter has been in its state (stateage.ts): the runs it keeps give what walking back frame by frame
// gives - up to 600, from frame 0, a state missing on some frames, Nana's, frames asked in any order, and the replay
// growing.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { stateAge } from "../src/render3d/stateage.ts";
import type { ReplayData } from "../src/common/types.ts";

/** the walk stateAge was until 2026-11-10 */
function walked(data: ReplayData, fno: number, player: number, nana: boolean): number {
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  const s = at(fno)?.actionStateId;
  let g = fno;
  while (g > 0 && fno - g < 600 && at(g - 1)?.actionStateId === s) g--;
  return fno - g;
}

function replay(n: number, seed: number): ReplayData {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const frames = [];
  let a = 14, b = 14;
  for (let g = 0; g < n; g++) {
    // (long runs and short ones; now and then no state at all)
    if (rnd() < 0.02) a = Math.floor(rnd() * 6) + 10;
    if (rnd() < 0.3) b = Math.floor(rnd() * 3) + 10;
    const gone = rnd() < 0.01;
    frames.push({ players: [gone ? undefined : { state: { actionStateId: a }, nanaState: g % 400 < 200 ? { actionStateId: b } : undefined }] });
  }
  return { frames } as unknown as ReplayData;
}

test("a fighter's time in its state is the walk's, frames asked in any order", () => {
  for (const seed of [1, 7, 42]) {
    const data = replay(3000, seed);
    let x = seed;
    const order = [...Array(3000).keys()].sort(() => ((x = (x * 69069 + 1) % 4294967296) / 4294967296) - 0.5);
    for (const g of [2999, 0, ...order, 1200.5, -1, 3000, 5000]) {
      for (const nana of [false, true]) assert.equal(stateAge(data, g, 0, nana), walked(data, g, 0, nana), `seed ${seed} frame ${g} nana ${nana}`);
    }
  }
});

test("a long state counts to 600, and the replay growing makes the runs again", () => {
  const data = { frames: Array.from({ length: 1500 }, () => ({ players: [{ state: { actionStateId: 14 } }] })) } as unknown as ReplayData;
  assert.equal(stateAge(data, 1499, 0, false), 600);
  assert.equal(stateAge(data, 300, 0, false), 300);
  data.frames[1000] = { players: [{ state: { actionStateId: 20 } }] } as unknown as ReplayData["frames"][number];
  data.frames.push({ players: [{ state: { actionStateId: 14 } }] } as unknown as ReplayData["frames"][number]);
  for (const g of [999, 1000, 1001, 1500]) assert.equal(stateAge(data, g, 0, false), walked(data, g, 0, false), `frame ${g}`);
});
