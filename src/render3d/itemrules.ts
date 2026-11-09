/* 3D replay viewer: a few items' looks their own code sets frame by frame (the decompilation's item callbacks),
 * from what the replay has: how long the item has been in its state, its life timer, how it was made. */

/** whether PK Thunder's trail is shown, `age` frames after it is made (its animation's clock: item-animation.ts):
 *  itNesspkthundertrail_UnkMotion0_Anim hides its root's child and all under it (HSD_JObjSetFlagsAll) while its own
 *  count is odd, the count 0 the frame it is made (its first callback runs that frame: it is made in the ball's
 *  callback, before its own proc in that pass) and one more each frame */
export function trailShown(age: number): boolean {
  return age % 2 === 0;
}

/** whether Mr. Game & Watch's sausage, down (its state 1), is shown: itGamewatchchef_UnkMotion1_Anim takes one off
 *  its life, then shows it (it_8026BB20) while the life as a whole number ((s32)) has its bit 2 set and hides it
 *  (it_8026BB44) while not. `life`: the replay's item timer, which is that life as the frame ends */
export function sausageShown(life: number): boolean {
  return (Math.trunc(life) & 2) !== 0;
}

/** Fox's and Falco's blaster's size (its scl): it_8026BAE8 sets it to a multiple of its attributes' scale
 *  (`attrScale`, +0x60) - 0.85 as their neutral special makes it (ftFox_SpecialN_SpawnBlaster), 0.85 times the
 *  fighter's size in a throw (ftFx_Throw_Anim: x34_scale.y, the player's size - 1 - times its model scaling,
 *  `modelScale`); in float32 */
export function blasterScale(inThrow: boolean, modelScale: number, attrScale: number): number {
  const f = Math.fround;
  const mul = inThrow ? f(f(0.85) * f(1 * modelScale)) : f(0.85);
  return f(mul * attrScale);
}
