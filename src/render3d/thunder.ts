/* 3D replay viewer: Pikachu's and Pichu's Thunder, the bolt shrinking where it struck (itpikachuthunder.c). */

/** Pikachu's and Pichu's Thunder (it_802B1DF8 makes either, by the kind its maker asks) */
export const THUNDERS = new Set([0x51, 0x52]);

/** the bolt's size along y `age` frames into its state 2 (struck), as itPikachuthunder_UnkMotion2_Anim sets it
 *  each frame: its length (xC, its special attributes' +4 when it was made) shortened by its fall's speed (x1C.y,
 *  `vy`: the speed it was made with, which it keeps), and while still above 0 the scale that length over the full
 *  one, cut to four places (pika_scale) and no less than 0.01. Not on the frame it enters the state: its
 *  callbacks of that frame ran in state 1 (it_802B22B8, from them or from its collision after them) */
export function thunderScaleY(age: number, vy: number, length: number): number {
  const full = Math.fround(length), v = Math.fround(vy);
  let left = full, scale = 1;
  for (let k = 0; k < age; k++) {
    const next = Math.fround(left + v);
    if (next > 0) {
      const f = Math.fround(Math.fround(10000 * next) / full);
      scale = Math.fround(Math.trunc(Math.fround(f + 1)) / 10000);
      if (scale <= 0) scale = Math.fround(0.01);
      left = next;
    }
  }
  return scale;
}
