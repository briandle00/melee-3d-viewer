/* 3D replay viewer: a few items' looks their own code sets frame by frame (the decompilation's item callbacks),
 * from what the replay has: how long the item has been in its state, its life timer, how it was made. */

/** Fox's and Falco's blaster's size (its scl): it_8026BAE8 sets it to a multiple of its attributes' scale
 *  (`attrScale`, +0x60) - 0.85 as their neutral special makes it (ftFox_SpecialN_SpawnBlaster), 0.85 times the
 *  fighter's size in a throw (ftFx_Throw_Anim: x34_scale.y, the player's size - 1 - times its model scaling,
 *  `modelScale`); in float32 */
export function blasterScale(inThrow: boolean, modelScale: number, attrScale: number): number {
  const f = Math.fround;
  const mul = inThrow ? f(f(0.85) * f(1 * modelScale)) : f(0.85);
  return f(mul * attrScale);
}
