/* 3D replay viewer: where Fox's Illusion and Falco's Phantasm leave their copy (itfoxillusion.c).
 *
 * The move's item (It_Kind_Fox_Illusion, It_Kind_Falco_Phantasm) draws a second model of the fighter, its copy
 * (it_8029CD18): its anim callback (itFoxillusion_UnkMotion0_Anim, states 0 and 1) makes the copy once its owner's
 * command variable 2 is 2 (it_8029CD78: the model again, at rest, with the item's turn and scl), and each frame's
 * phys (states 0 to 2) puts it at the owner's ghostEffectPos[3]. Each frame of the dash and of its end the owner's
 * phys (ftFox_SpecialS_SetPhys: ftFx_SpecialS_Phys, ftFx_SpecialAirS_Phys, ftFx_SpecialSEnd_Phys,
 * ftFx_SpecialAirSEnd_Phys) moves the four places along and puts his place in the first - where he stood as the
 * frame began, the frame before's end; entering the dash (ftFox_SpecialS_SetVars, from the start's anim callback)
 * put that same place in all four. So the copy stands where he was four frames back, and catches up with him through
 * the dash's end.
 */

/** Fox's (and Falco's) SpecialSStart, SpecialS, SpecialSEnd, SpecialAirSStart, SpecialAirS, SpecialAirSEnd */
export const FOX_S_START = 347, FOX_S = 348, FOX_S_END = 349, FOX_S_AIR_START = 350, FOX_S_AIR = 351, FOX_S_AIR_END = 352;

/** what is read of the owner at a frame (the replay's: the frame's end) */
export interface IllusionOwnerState { actionStateId: number; actionStateFrameCounter: number; xPosition: number; yPosition: number }
/** a script command as the fighter's scripts list them (only "cmdVar" is read) */
export interface IllusionScriptEvent { kind: string; index?: number; frame: number; value?: number }

const shifts = (s?: number) => s === FOX_S || s === FOX_S_END || s === FOX_S_AIR || s === FOX_S_AIR_END;
const ends = (s?: number) => s === FOX_S_END || s === FOX_S_AIR_END;

/** where the copy stands at `frame`, or null when it is not made (yet). `owner(g)`: the owner's state at frame g;
 *  `itemState(g)`: the item's state at g, undefined when it is not there; `script(state)`: the owner's script
 *  of a state */
export function illusionCopyAt(owner: (g: number) => IllusionOwnerState | undefined, itemState: (g: number) => number | undefined,
                               script: (state: number) => readonly IllusionScriptEvent[], frame: number): [number, number] | null {
  // (the variable as the item's anim callback reads it, after its owner's frame: the dash's script sets it by its
  // frame counter, and the script's last command runs on the frame the dash's animation ends - the end's first
  // frame, which then keeps what the dash left: Fighter_ChangeMotionState leaves cmd_vars as they are)
  const var2 = (g: number): number => {
    let st = owner(g);
    let whole = false;
    if (st && ends(st.actionStateId)) {
      let e = g;
      while (e > 0 && ends(owner(e - 1)?.actionStateId)) e--;
      st = owner(e - 1);
      whole = true;
    }
    if (!st || (st.actionStateId !== FOX_S && st.actionStateId !== FOX_S_AIR)) return 0;
    let v = 0;
    for (const e of script(st.actionStateId)) {
      if (e.kind === "cmdVar" && e.index === 2 && (whole || e.frame <= st.actionStateFrameCounter + 0.001)) v = e.value ?? 0;
    }
    return v;
  };
  // (made: on a frame of the item's states 0 and 1 the variable was 2)
  let made = false;
  for (let g = frame; g >= 0 && frame - g < 120; g--) {
    const s = itemState(g);
    if (s === undefined) break;
    if (s <= 1 && var2(g) === 2) { made = true; break; }
  }
  if (!made) return null;
  // (ghostEffectPos[3] after this frame's owner's phys: the places of the frames before, the latest first, back to
  // the dash's entry)
  const back: [number, number][] = [];
  for (let g = frame; back.length < 4; g--) {
    const st = owner(g), prev = owner(g - 1);
    if (!st || !prev || !shifts(st.actionStateId)) return null;
    back.push([prev.xPosition, prev.yPosition]);
    if ((st.actionStateId === FOX_S || st.actionStateId === FOX_S_AIR) &&
        (prev.actionStateId === FOX_S_START || prev.actionStateId === FOX_S_AIR_START)) {
      while (back.length < 4) back.push([prev.xPosition, prev.yPosition]);
    }
  }
  return back[3];
}
