/* 3D replay viewer: a strong hit's screen flash (lbBgFlash).
 *
 * A hit whose knockback passes PlCo's numbers for its element starts one of
 * LbBf.dat's color animations (ftCo_8008DB10, ft_0C8C: lbBgFlash_80021C48);
 * each frame lbBgFlash_Proc runs it (fn_80021C80) and, while its color is on,
 * gives the flash that color (lbBgFlash_InitState), and the frame it goes
 * off, none at all (fn_800208B0(0): black, alpha 0). From the first of those
 * on, fn_8001FEC4 draws the flash every frame: a 640 x 480 quad of that
 * color under a camera of its own (lbl_803BB028), three times (its camera's
 * HSD_GObj_803910D8 runs its link in all three passes). Before any flash of
 * the match it draws nothing (lbBgFlash_800208EC leaves it active).
 *
 * Which flash starts when is the viewer track's "bgflash" (the simulator's
 * lbBgFlash_80021C48 calls); the scripts are read from your LbBf.dat and run
 * by colanim.ts's Overlay, the game's ColorOverlay; nothing of them is in
 * this file.
 */
import type { Archive } from "../hsd";
import { ptr } from "../hsd";
import { ColAnimEntry, ColAnimTables, Overlay } from "./colanim";

/** LbBf.dat's lbBgFlashColAnimData: the table itself ({script, priority, slot}, 8 bytes each), as
 *  lbArchive_LoadSymbols hands its address to lbl_804D63DC */
export function bgFlashTables(a: Archive): ColAnimTables | null {
  const t = a.publics.get("lbBgFlashColAnimData");
  if (t === undefined) return null;
  const out: ColAnimEntry[] = [];
  // (the flashes the game starts are 2 to 6 and 0xE; entry 0 is what a reset one is compared against)
  for (let i = 0; i < 16 && t + i * 8 + 8 <= a.data.byteLength; i++) {
    const at = t + i * 8;
    out.push({ cmds: ptr(a, at), pri: a.data.getUint8(at + 4), slot: a.data.getUint8(at + 5) });
  }
  return new ColAnimTables(a, out, []);
}

/** the flash as of a game frame: whether fn_8001FEC4 draws it, and its color (bytes) */
export interface FlashState { drawn: boolean; color: [number, number, number, number] }

/** the flash played from the track's starts ([game frame, type, duration], in frame order) */
export class BgFlash {
  private o = new Overlay();
  /** the last game frame run, and the next start not yet made */
  private at = -Infinity;
  private next = 0;
  private readonly state: FlashState = { drawn: false, color: [0, 0, 0, 0] };

  constructor(private t: ColAnimTables, private starts: [number, number, number][]) {}

  /** how it stands after game frame `frame`'s lbBgFlash_Proc (played on from the last frame asked, or
   *  from the match's start for an earlier one; frames with nothing running are skipped) */
  stateAt(frame: number): FlashState {
    if (frame < this.at) this.restart();
    const s = this.state, list = this.starts;
    while (this.at < frame) {
      // (nothing runs and no start before the next: nothing changes until then)
      if (!this.o.running && !this.o.colorOn && !this.o.limited) {
        const nf = this.next < list.length ? list[this.next][0] : Infinity;
        if (nf > frame) { this.at = frame; break; }
        if (nf - 1 > this.at) this.at = nf - 1;
      }
      const f = ++this.at;
      // the frame's starts (lbBgFlash_80021C48: lb_800144C8 against what runs), then lbBgFlash_Proc
      for (; this.next < list.length && list[this.next][0] <= f; this.next++) {
        const [, type, frames] = list[this.next];
        this.o.start(this.t, type, frames, this.o.index);
      }
      const was = this.o.colorOn;
      // (fn_80021C80: run until it does not end; an ended one is reset, lb_80014498, as step leaves it)
      this.o.step(this.t, null);
      if (this.o.colorOn) {
        // (lbBgFlash_Proc: each byte times flash_scale, 1 in a match; alpha times lbBgFlash_Init's 0xFF over 255)
        s.drawn = true;
        for (let k = 0; k < 3; k++) s.color[k] = (this.o.color[k] | 0) & 0xff;
        s.color[3] = Math.trunc((((this.o.color[3] | 0) & 0xff) * 0xff) / 255);
      } else if (was) {
        s.drawn = true;
        s.color[0] = s.color[1] = s.color[2] = s.color[3] = 0;
      }
    }
    return s;
  }

  private restart() {
    this.o.reset();
    this.at = -Infinity;
    this.next = 0;
    this.state.drawn = false;
    this.state.color.fill(0);
  }
}

/** the flash camera's numbers (lbl_803BB028): eye and interest, field of view, aspect, near, far */
export const FLASH_CAMERA = { eye: [320, -240, 415.6922], interest: [320, -240, 0], fovy: 60, aspect: 1.3333333, near: 0.1, far: 30000 };

/** fn_8001FEC4's quad, for drawParticles (fx/draw.ts's 17 floats a corner): 0,0 to 640,-480 at z = 0, its
 *  vertex color, untextured, every pixel passing (GX_ALWAYS both); `k` the picture's width over the game's,
 *  the quad as wide as the picture. Into `out` (4 x 17 floats) */
export function flashQuad(out: Float32Array, color: ArrayLike<number>, k = 1): Float32Array {
  const x0 = 320 - 320 * k, x1 = 320 + 320 * k;
  for (let v = 0; v < 4; v++) {
    const o = v * 17;
    out[o] = v === 0 || v === 3 ? x0 : x1; out[o + 1] = v < 2 ? 0 : -480; out[o + 2] = 0;
    out[o + 3] = 0; out[o + 4] = 0;
    for (let c = 0; c < 4; c++) { out[o + 5 + c] = color[c] / 255; out[o + 9 + c] = 0; }
    // (the alpha compare: always and always)
    out[o + 13] = (7 << 3) | 7; out[o + 14] = 0; out[o + 15] = 0;
    out[o + 16] = 0;
  }
  return out;
}
