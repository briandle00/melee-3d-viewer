/* 3D replay viewer: Shadow Ball's size by its charge (itmewtwoshadowball.c).
 *
 * After each step of its animation the ball's code sets the scale of its
 * model's first grandchild joint from how charged it is (the root's own
 * scale, which ties it to Mewtwo's hand, is left alone). The replay records
 * the charge, for a ball held or thrown, Mewtwo's or Kirby's copy. State 9 is
 * another projectile, with no such callback.
 */

/** Mewtwo's Shadow Ball (0x70) and Kirby's copy (0x90) */
export const isShadowBall = (type: number) => type === 0x70 || type === 0x90;

/** the ball's scale in `state` at `charge` of `maximum`: from `low` (no charge) to `high` (full), or null
 *  when its code sets none */
export function shadowBallScale(state: number, charge: number, maximum: number, low: number, high: number): number | null {
  if (!(maximum > 0) || state < 0 || state > 8 || !Number.isFinite(charge)) return null;
  return low + (high - low) * Math.max(0, Math.min(1, charge / maximum));
}

/** Samus's charge shot's size (itsamuschargeshot.c): its code sets the scale of its model's first grandchild
 *  joint, not the root's, to charge x ((x1C - x18) / the most) + x18 in float32 - while it is held and grows
 *  (itSamuschargeshot_UnkMotion0_Anim) and, fired, at the charge it left with (it_802B56E4's xDE4,
 *  itSamuschargeshot_UnkMotion8_Anim). The charge and the most are whole numbers (ftSs_SpecialLw_80129100);
 *  null when its attributes are not sizes */
export function chargeShotScale(charge: number, most: number, low: number, high: number): number | null {
  if (!(low > 0) || !(high > 0) || high >= 50 || !Number.isFinite(charge)) return null;
  const m = Math.trunc(most) > 0 ? Math.trunc(most) : 7;
  const c = Math.max(0, Math.min(m, Math.trunc(charge)));
  const f = Math.fround;
  return f(f(c * f(f(high - low) / m)) + low);
}
