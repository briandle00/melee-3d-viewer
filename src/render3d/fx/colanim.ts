/* 3D replay viewer: a fighter's color animations.
 *
 * The game tints a fighter for a while on many occasions - the white flash
 * of a hit, the blink of intangibility, a smash attack charging, a charge
 * held at full. Each is a small script in PlCo.dat (ftLoadCommonData's
 * entries 6 and 7): set a color, blend toward another over some frames,
 * set a light from a direction, wait, loop. A fighter has two of them
 * running (the main one and a second, weaker one); the main one is drawn
 * when it runs, else the second (ftcolanim.c, lb_013B.c, ftdevice.c). What
 * the color and the light do to the fighter's picture is ftmaterial.c's:
 * the color is blended over the material by its alpha; the light either
 * adds its color where it falls (its alpha the strength) or lights the
 * fighter as one more light. The scripts are read from your PlCo.dat
 * and run here; nothing of them is copied into this file.
 */
import type { Archive } from "../hsd";

/** a table entry: where its script is, its priority, and which of the two it runs in */
export interface ColAnimEntry { cmds: number | null; pri: number; slot: number }

/** PlCo's color animation tables: the common one (0 to 122) and the second (123 on) */
export class ColAnimTables {
  constructor(public a: Archive, public common: ColAnimEntry[], public second: ColAnimEntry[]) {}
  entry(i: number): ColAnimEntry | undefined {
    return i >= SECOND ? this.second[i - SECOND] : this.common[i];
  }
}
export const SECOND = 0x7b;

/** the tables from PlCo.dat's ftLoadCommonData */
export function colAnimTables(a: Archive, table: number, ptr: (a: Archive, at: number) => number | null): ColAnimTables {
  const read = (e: number, n: number) => {
    const tab = ptr(a, table + e * 4);
    const out: ColAnimEntry[] = [];
    for (let i = 0; tab !== null && i < n; i++) {
      const at = tab + i * 8;
      if (at + 8 > a.data.byteLength) break;
      out.push({ cmds: ptr(a, at), pri: a.data.getUint8(at + 4), slot: a.data.getUint8(at + 5) });
    }
    return out;
  };
  return new ColAnimTables(a, read(6, SECOND), read(7, 16));
}

/** Whether a change of state keeps the second color animation running.
 *  The game resets that one at every change of state (Fighter_ChangeMotionState
 *  -> ftCo_800C0134) but those made with Ft_MF_SkipColAnim: a move's ground
 *  and air versions switching as the fighter lands or leaves the floor
 *  mid-move (ftCommon_GroundAirColl_MF), which carry the move's animation on
 *  from the frame it was at. A replay tells those by the fighter going
 *  between the floor and the air with its animation's frame carrying on
 *  instead of starting over. */
export function keepsSecondColor(before: { grounded: boolean; counter: number },
                                  after: { grounded: boolean; counter: number }): boolean {
  return before.grounded !== after.grounded && after.counter > 0 && after.counter >= before.counter;
}

/** Whether a change of state ran the color animations a step of its own.
 *  Fighter_ChangeMotionState steps them (ftCo_800C0408) as it starts the
 *  new state's animation from its first frame, whatever part of the frame
 *  it is called from, on top of the frame's own step (Fighter_procAnim); one
 *  that starts the animation part way through (a ground and air version's
 *  switch, keepsSecondColor) does not. The replay's counter on the state's
 *  first frame says which: 0, or 1 when the code ran the animation a frame
 *  as it began, from the start (a shield raised shows -1: GuardOn starts its
 *  animation a frame before its first, not from it). */
export function startsOver(before: { grounded: boolean; counter: number },
                           after: { grounded: boolean; counter: number }): boolean {
  return after.counter > -0.5 && after.counter < 1.5 && !keepsSecondColor(before, after);
}

/** an effect a color animation's script starts (the burn of a fire hit) */
export interface ColAnimGfx { gfx: number; bone: number; common: boolean; offset: [number, number, number];
                              range: [number, number, number] }

const gfxIndexes = new WeakMap<ColAnimTables, Map<number, ColAnimGfx[]>>();

/** every effect the color animations' scripts start, by the effect's id (a
 *  fire hit's burn on a joint): each script run for up to 240 frames */
export function colAnimGfx(t: ColAnimTables): Map<number, ColAnimGfx[]> {
  let out = gfxIndexes.get(t);
  if (out) return out;
  out = new Map();
  const seen = new Set<string>();
  const n = SECOND + t.second.length;
  for (let i = 1; i < n; i++) {
    const o = new Overlay();
    if (!o.start(t, i, 0, 0)) continue;
    for (let k = 0; k < 240 && o.running; k++) {
      o.step(t, (g) => {
        const key = `${g.gfx}:${g.bone}:${g.common}`;
        if (seen.has(key)) return;
        seen.add(key);
        const list = out!.get(g.gfx) ?? [];
        list.push(g);
        out!.set(g.gfx, list);
      });
    }
  }
  gfxIndexes.set(t, out);
  return out;
}

const s = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);
const f32 = Math.fround;

/** one running color animation (the game's ColorOverlay) */
export class Overlay {
  index = 0;
  private p: number | null = null;
  private timer = 0;
  /** frames it may run for (0: until its script ends) */
  private frames = 0;
  private stack: { at: number; count: number }[] = [];
  colorOn = false;
  readonly color = [0, 0, 0, 0];
  private colorStep = [0, 0, 0, 0];
  /** the light: on, whether it adds its color (else it lights), its color, and where it comes from */
  lightOn = false;
  lightAdds = false;
  readonly light = [0, 0, 0, 0];
  private lightStep = [0, 0, 0, 0];
  rotX = 0;
  rotYZ = 0;
  /** how many times it has been started (to tell one started again) */
  starts = 0;

  get running(): boolean { return this.p !== null; }
  /** a run given frames of its own still counting them down (lb_800144C8's x4_pri) */
  get limited(): boolean { return this.frames > 0; }

  reset() {
    this.p = null; this.frames = 0; this.index = 0;
    this.colorOn = this.lightOn = false;
  }

  /** start entry `i` if it outranks what runs (lb_800144C8) */
  start(t: ColAnimTables, i: number, frames: number, current: number): boolean {
    const now = t.entry(current), next = t.entry(i);
    if (!next || next.cmds === null) return false;
    if ((now?.pri ?? 0) > next.pri) return false;
    this.index = i; this.frames = frames; this.p = next.cmds; this.timer = 0; this.stack.length = 0;
    this.colorOn = this.lightOn = false;
    this.starts++;
    return true;
  }

  /** start the script at `at` in its file, whatever runs (a stage part's: grMaterial_801C9604) */
  startAt(at: number) {
    this.index = -1; this.frames = 0; this.p = at; this.timer = 0; this.stack.length = 0;
    this.colorOn = this.lightOn = false;
    this.starts++;
  }

  /** one frame; true when its script has ended. `gfx` is told of the effects it starts */
  step(t: { a: Archive }, gfx: ((g: ColAnimGfx) => void) | null): boolean {
    const d = t.a.data, reloc = t.a.reloc;
    if (this.p !== null && this.timer > 0) this.timer--;
    for (let guard = 0; this.p !== null && this.timer === 0 && guard < 256; guard++) {
      const p: number = this.p;
      if (p + 4 > d.byteLength) { this.p = null; break; }
      const w = d.getUint32(p), op = w >>> 26, v = w & 0x3ffffff;
      const word = (k: number) => d.getUint32(p + 4 * k);
      const rgba = (x: number) => [x >>> 24, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
      switch (op) {
        case 0: this.p = null; break;                                  // stop
        case 1: this.timer += v; this.p = p + 4; break;                // wait
        case 2: this.timer = Math.max(0, v); this.p = p + 4; break;    // wait until (from its start)
        case 3: this.stack.push({ at: p + 4, count: v }); this.p = p + 4; break;
        case 4: {
          const top = this.stack[this.stack.length - 1];
          if (top && --top.count > 0) this.p = top.at;
          else { this.stack.pop(); this.p = p + 4; }
          break;
        }
        case 5: // subroutine
          this.stack.push({ at: p + 8, count: 0 });
          this.p = reloc.has(p + 4) ? word(1) : null;
          break;
        case 6: this.p = this.stack.pop()?.at ?? null; break;          // return
        case 7: this.p = reloc.has(p + 4) ? word(1) : null; break;     // goto
        case 8: this.timer = Infinity; this.p = p + 4; break;
        case 9: this.p = p + 4; break;                                 // the background flash: not a fighter's
        case 0xa: this.reset(); return true;                           // done
        case 0xb: this.timer += v; this.p = p + 4; break;
        case 0xc: this.colorOn = this.lightOn = false; this.p = p + 4; break;
        case 0xd: { // light: where from, whether it adds, and its color
          this.lightAdds = ((w >>> 25) & 1) === 1;
          this.rotX = s((w >>> 12) & 0xfff, 12); this.rotYZ = s(w & 0xfff, 12);
          const c = rgba(word(1));
          for (let k = 0; k < 4; k++) { this.light[k] = c[k]; this.lightStep[k] = 0; }
          this.lightOn = true;
          this.p = p + 8;
          break;
        }
        case 0xe: {
          const c = rgba(word(1));
          for (let k = 0; k < 4; k++) { this.light[k] = c[k]; this.lightStep[k] = 0; }
          this.p = p + 8;
          break;
        }
        case 0xf: {
          const c = rgba(word(1)), n = Math.max(1, v);
          for (let k = 0; k < 4; k++) this.lightStep[k] = f32(f32(f32(0.5 + c[k]) - ((this.light[k] | 0) & 0xff)) / n);
          this.p = p + 8;
          break;
        }
        case 0x10: this.rotX = s((w >>> 13) & 0x1fff, 13); this.rotYZ = s(w & 0x1fff, 13); this.p = p + 4; break;
        case 0x11: this.lightOn = false; this.p = p + 4; break;
        case 0x12: {
          const c = rgba(word(1));
          for (let k = 0; k < 4; k++) { this.color[k] = c[k]; this.colorStep[k] = 0; }
          this.colorOn = true;
          this.p = p + 8;
          break;
        }
        case 0x13: {
          const c = rgba(word(1)), n = Math.max(1, v);
          for (let k = 0; k < 4; k++) this.colorStep[k] = f32(f32(f32(0.5 + c[k]) - ((this.color[k] | 0) & 0xff)) / n);
          this.p = p + 8;
          break;
        }
        case 0x14: this.colorOn = false; this.p = p + 4; break;
        case 0x15: { // an effect on the fighter (as a move script's)
          const w1 = word(1), w2 = word(2), w3 = word(3), w4 = word(4);
          const s16 = (x: number) => (x << 16) >> 16;
          gfx?.({
            gfx: w1 >>> 16, bone: (w >>> 18) & 0xff, common: ((w >>> 17) & 1) === 1,
            offset: [s16(w2 >>> 16) / 256, s16(w2) / 256, s16(w3 >>> 16) / 256],
            range: [(w3 & 0xffff) / 256, (w4 >>> 16) / 256, (w4 & 0xffff) / 256],
          });
          this.p = p + 20;
          break;
        }
        case 0x16: this.p = p + (((w >>> 18) & 0xff) <= 6 ? 12 : 4); break; // a sound
        default: this.p = p + 4; break;
      }
    }
    // (each channel a float32 that the step adds to, its byte that float cut to an integer: lb_80014258)
    if (this.colorOn) for (let k = 0; k < 4; k++) this.color[k] = f32(this.color[k] + this.colorStep[k]);
    if (this.lightOn) for (let k = 0; k < 4; k++) this.light[k] = f32(this.light[k] + this.lightStep[k]);
    if (this.frames > 0 && --this.frames === 0) { this.reset(); return true; }
    return false;
  }
}

/** what a fighter's color animation does to its picture this frame */
export interface Tint {
  /** blended over the material by its alpha (0..1 each), or null */
  color: [number, number, number, number] | null;
  /** a light: its color (0..1), its strength (the alpha, when it adds), whether it adds its
   *  color (else it is one more light on the fighter), and the way it comes from (world) */
  light: { rgb: [number, number, number]; a: number; adds: boolean; dir: [number, number, number] } | null;
}

const byte = (v: number) => Math.max(0, Math.min(255, v | 0)) / 255;

/** a fighter's two color animations */
export class FighterColAnim {
  main = new Overlay();
  second = new Overlay();
  /** the second one's entry when a move's script started it (0: not), which goes with the move (changeState) */
  moveSecond = 0;
  /** the main or the second one was started after this frame's color
   *  animations ran (Fighter_procAnim's step: from a state's input or
   *  collision callback): its first step is the next frame's */
  mainHeld = false;
  secondHeld = false;

  /** start entry `i` in the one its table entry names; `frames`: how long at
   *  most (0: its own); `held`: started after this frame's step */
  start(t: ColAnimTables, i: number, frames = 0, held = false): boolean {
    const e = t.entry(i);
    if (!e) return false;
    const second = i < SECOND && e.slot !== 0;
    const o = second ? this.second : this.main;
    const ok = o.start(t, i, frames, o.index);
    if (ok && second) this.secondHeld = held;
    else if (ok) this.mainHeld = held;
    return ok;
  }

  /** start entry `i` for a move's script (its color animation command): one
   *  of the second kind then ends with the move (changeState). `held`: the
   *  move began after the frame's color animations ran (from its input
   *  check), so it shows from the next frame */
  startForMove(t: ColAnimTables, i: number, frames = 0, held = false): boolean {
    const ok = this.start(t, i, frames, held);
    if (ok && this.second.index === i) this.moveSecond = i;
    return ok;
  }

  /** the fighter changing state (its animation's frame and whether it is on
   *  the floor, the frame before and now): the second one, when a move's
   *  script started it, is reset as the game resets it (the reflector's
   *  glow, a helpless fall's shade), unless the change keeps it
   *  (keepsSecondColor). What else runs there the player starts again
   *  itself (a stored charge's, as the game's own callback does) or keeps
   *  as the game keeps it (the entry's flash, the platform's) */
  changeState(before: { grounded: boolean; counter: number }, after: { grounded: boolean; counter: number }) {
    if (!this.moveSecond || keepsSecondColor(before, after)) return;
    if (this.second.index === this.moveSecond) this.second.reset();
    this.moveSecond = 0;
  }

  /** the one drawn: the main one while it runs, else the second */
  get shown(): Overlay { return this.main.index !== 0 ? this.main : this.second; }

  /** the tint for this frame; `facing` turns the light's side (as the game's fighter turns) */
  tint(facing: number): Tint | null {
    const o = this.shown;
    if (!o.colorOn && !o.lightOn) return null;
    let light: Tint["light"] = null;
    if (o.lightOn) {
      const yz = (o.rotYZ * Math.PI) / 180, x = ((o.rotX * Math.PI) / 180) * (facing < 0 ? -1 : 1);
      const z = Math.cos(yz);
      light = { rgb: [byte(o.light[0]), byte(o.light[1]), byte(o.light[2])], a: byte(o.light[3]), adds: o.lightAdds,
                dir: [z * Math.sin(x), Math.sin(yz), z * Math.cos(x)] };
    }
    return { color: o.colorOn ? [byte(o.color[0]), byte(o.color[1]), byte(o.color[2]), byte(o.color[3])] : null, light };
  }
}
