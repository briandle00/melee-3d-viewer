// Yoshi's Story's Shy Guys (itheiho.c): the clock of the card's animation.

import type { ItemUpdate, ReplayData } from "../common/types";

// A Shy Guy's animation is its own (itheiho.c): set from its start when it
// begins to fly (state 1, it_802D8918) or flees (state 4, at twice the rate:
// itHeiho_UnkMotion4_Anim), from the start again when it ends (256 frames:
// it_80272C6C), and each time it lands on a floor (itHeiho_UnkMotion1_Coll:
// it_8026DA70) - the frame the replay has its speed across as 0, its speed
// being recomputed from its bone that frame (it_802D98C4); in the states
// without an animation (0, 2, 3) it holds where it was. Stepped frame by frame
// from the last one it was asked for (a seek walks it again from the item's
// first frame).
// The rate: Item_80268E5C starts an animation at the item's own rate (1:
// lb_8000BA0C) and lays its frame 0 (HSD_JObjReqAnimAll, HSD_JObjAnimAll); the
// next frame's step (Item_802694CC) goes at that rate, and only then does
// state 4's callback set its card's rate to 2 (HSD_AObjSetRate). So a start in
// the item's physics or collision (a new state, a landing) steps 0, 1, 3, 5...
// (bot-mario_luigi 1316 on), while the start at the animation's end comes from
// the callback itself, which then sets the rate: 0, 2, 4...
const SHY_FLY = new Set([1, 4]);
const shyClocks = new WeakMap<ReplayData, Map<number, { at: number; state: number; t: number; anim: number; rate: number }>>();
export function shyGuyClock(data: ReplayData, frame: number, it: ItemUpdate): number {
  let clocks = shyClocks.get(data);
  if (!clocks) shyClocks.set(data, (clocks = new Map()));
  let c = clocks.get(it.spawnId);
  if (!c || c.at > frame || frame - c.at > 1) {
    let f = frame;
    while (f > 0 && data.frames[f - 1]?.items?.some((q) => q.spawnId === it.spawnId)) f--;
    c = { at: f - 1, state: -1, t: 0, anim: 0, rate: 1 };
    clocks.set(it.spawnId, c);
  }
  for (let f = c.at + 1; f <= frame; f++) {
    const q = f === frame ? it : data.frames[f]?.items?.find((x) => x.spawnId === it.spawnId);
    if (!q) continue;
    if (q.state !== c.state) {
      if (SHY_FLY.has(q.state)) { c.t = 0; c.rate = 1; }
      // (states 1 and 4 start their animations, 0 and 2; the others keep the one playing)
      if (q.state === 1) c.anim = 0;
      else if (q.state === 4) c.anim = 2;
    }
    else if (SHY_FLY.has(q.state)) {
      if (Math.abs(q.xVelocity) < 1e-6) { c.t = 0; c.rate = 1; }
      else {
        c.t += c.rate;
        if (c.t >= 256) c.t = 0;
        c.rate = q.state === 4 ? 2 : 1;
      }
    }
    c.state = q.state;
    c.at = f;
  }
  return c.t;
}

/** the animation the Shy Guy's clock last played (0: its flight's, state 1; 2: its flight away's, state 4) */
export function shyGuyAnim(data: ReplayData, spawnId: number): number | undefined {
  return shyClocks.get(data)?.get(spawnId)?.anim;
}
