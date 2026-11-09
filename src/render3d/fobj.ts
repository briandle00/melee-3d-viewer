/* 3D replay viewer: an animation track played as the game plays it, in float32.
 *
 * sample() (hsd.ts) gives a track's value at a frame, looking the time into its segment up from the frame. The game
 * does not look it up: HSD_AObjInterpretAnim steps the animation's clock each frame (curr_frame += rate) and
 * HSD_FObjInterpretAnim steps each track's own (time += rate), taking a key's wait off it as it passes the key
 * (time -= fterm) and reading the next; FObjUpdateAnim then works the value out from the time left (hsd.ts
 * segmentValue, the same float32 code sample() uses). At a whole-number speed the two times are the same; at
 * another speed (Samus's throw beam) each float32 sum rounds on its own, and the stepped time drifts from the frame
 * times the speed. Once the clock reaches the animation's end (end_frame <= curr_frame) the AObj stops
 * (AOBJ_NO_ANIM): the joint keeps the value of that last step and no later one is made.
 */
import { f32 } from "./gxmath";
import { segmentValue, type Key } from "./hsd";

/** A track's value after its animation was asked for at frame 0 (HSD_AObjReqAnim: a first play) and played
 *  `steps` more times at `rate` (each HSD_AObjInterpretAnim), as the game plays it; `end` the AObj's end_frame
 *  (0: none), where it stops - or, `loop` (AOBJ_LOOP), goes back: its clock to fmodf(curr_frame, end) (its rewind
 *  frame 0) and each track asked for again there (HSD_FObjReqAnimAll), played on with no step that time. Null
 *  when the track never wrote (its own clock still below 0). The value after the last key's is that key's (its
 *  trailing wait 0, as the files have it) */
export function playedValue(keys: Key[], steps: number, rate: number, end: number, loop = false): number | null {
  const n = keys.length;
  if (n === 0) return null;
  const r32 = f32(rate);
  // (a loop at speed 1 over a whole number of frames is back at its start every end frames: the same as a first
  // play there - its clock 0, the tracks asked for at 0, no step)
  if (loop && end > 0 && r32 === 1 && Number.isInteger(end) && steps >= end) steps %= end;
  // (HSD_FObjReqAnim: time = startframe + the frame asked; the first key sits at -startframe: decodeKeys)
  const start = f32(-keys[0].time);
  let time = start, curr = 0, s = 0;
  let out: number | null = null;
  for (let k = 0; k <= steps; k++) {
    // (a first play adds nothing: AOBJ_FIRST_PLAY)
    let r = 0;
    if (k > 0) { r = r32; curr = f32(curr + r32); }
    if (loop && end > 0 && end <= curr) { curr = f32(curr % end); time = f32(start + curr); s = 0; r = 0; }
    time = f32(time + r);
    if (!(time < 0)) {
      while (s < n && keys[s].duration <= time) { time = f32(time - keys[s].duration); s++; }
      out = s < n ? segmentValue(keys[s], time) : keys[n - 1].p1;
    }
    if (!loop && end > 0 && end <= curr) break;
  }
  return out;
}
