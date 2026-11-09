/**
 * The frame of an animation to show for a replay's action-state frame
 * counter. The game loops a looping animation itself (a Fall's counter never
 * passes its length: it starts over), and holds a held one on its last frame
 * (a DamageFlyN's counter sits at 29 for the whole flight). So the counter is
 * the frame, and past the end it is the end - never wrapped back to the
 * start, which showed a launched Falco in the first, upright frame of his
 * tumble pose, as if he stood in midair.
 */
export function animTime(counter: number, frames: number): number {
  const t = Math.max(0, counter);
  return frames > 0 ? Math.min(t, frames) : t;
}

/**
 * The frame an animation started at 0 and stepped once a frame shows on its
 * frame t (0 the first): t + 1 steps of `rate`, each added in float32
 * (HSD_AObjInterpretAnim: a first play lays frame 0, each later one adds the
 * rate first). Samus's throw beam is made and played once as her throw
 * begins (ftSs_Init_CreateThrowGrappleBeam) and played again the same frame
 * in Fighter_procCollPos, so its first frame shows one step.
 */
export function steppedFrame(t: number, rate: number): number {
  let f = 0;
  for (let k = 0; k <= t; k++) f = Math.fround(f + rate);
  return f;
}
