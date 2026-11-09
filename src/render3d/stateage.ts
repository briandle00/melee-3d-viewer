// How long a fighter has been in its state on a frame: the frames since the replay's state last changed, up to 600
// (entering, growing up; a layer's span). Where each frame's run of one state began is kept per replay and fighter
// as it is worked out: walked back up to 600 frames every time a fighter was posed, each frame a seek steps through.

import type { ReplayData } from "~/common/types";

export function stateAge(data: ReplayData, fno: number, player: number, nana: boolean): number {
  // (the runs made again when the replay's frames change in number)
  const runs = stateRuns(data, player, nana);
  const at = (g: number) => { const p = data.frames[g]?.players[player]; return nana ? p?.nanaState : p?.state; };
  if (!Number.isInteger(fno) || fno < 0 || fno >= runs.length) {
    const s = at(fno)?.actionStateId;
    let g = fno;
    while (g > 0 && fno - g < 600 && at(g - 1)?.actionStateId === s) g--;
    return fno - g;
  }
  // (runs[g]: 1 + the first frame of g's run, 0 not known yet)
  let g = fno;
  while (runs[g] === 0 && g > 0 && at(g - 1)?.actionStateId === at(g)?.actionStateId) g--;
  const start = runs[g] !== 0 ? runs[g] - 1 : g;
  for (let k = g; k <= fno; k++) runs[k] = start + 1;
  return Math.min(fno - start, 600);
}
const stateRunsOf = new WeakMap<ReplayData, { n: number; runs: Map<number, Int32Array> }>();
function stateRuns(data: ReplayData, player: number, nana: boolean): Int32Array {
  let e = stateRunsOf.get(data);
  if (!e || e.n !== data.frames.length) stateRunsOf.set(data, (e = { n: data.frames.length, runs: new Map() }));
  const key = player * 2 + (nana ? 1 : 0);
  let r = e.runs.get(key);
  if (!r) e.runs.set(key, (r = new Int32Array(e.n)));
  return r;
}
