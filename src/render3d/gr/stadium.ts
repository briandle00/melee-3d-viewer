/* 3D replay viewer: Pokemon Stadium's big screen.
 *
 * The screen (the display part's joint 2) shows a picture the game renders
 * at run time into an image the file leaves blank; the stage's code decides
 * what, and for how long (grStadium_801D2528, grStadium_801D2A60): a text
 * page - the stage's type, the combatants, the time left - as the match
 * starts, then, each for a while, the match itself (a copy of the picture,
 * tinted the screen's green), a close-up of one player after another (a
 * 124 by 80 copy around them), the text page again, and after seven
 * changes the players' names in their colors. During a transformation it
 * shows the new type's picture (joints 3 to 9 are those pictures and two
 * logos: the code hides all but the one up).
 *
 * The choice among them is the game's random numbers, which neither the
 * replay nor (yet) the viewer track has: the order here comes from a
 * seeded stand-in, drawn with the game's weights and durations (the stage's
 * yakumono_param). The text is the game's own lettering (sistext.ts) when the
 * executable is there: each frame a quad per glyph is drawn into the picture
 * the screen shows (250 by 160), as the game draws them, and the browser's own
 * font otherwise.
 */
import type { ReplayData } from "../../common/types";
import { Rng } from "../fx/particles";
import { STADIUM_NORMAL, STADIUM_TIMES, stadiumEventsFromScreens, stadiumForms, type Stage, type StageFrame, type StageLogic, type StadiumTimes } from "../stage";
import type { Emitter, Ender } from "./particles";
import type { ViewerTrack } from "../track";
import { ascii, glyphAlpha, type Lettering, layoutSis, type SisCommon, type SisFont, type SisGlyph, sisString, type SisTextOpts } from "../sistext";
import { glyphAtlasOf } from "../plates";

/** what drawLetters asks of the renderer (renderer.ts): a target on the screen's picture, a camera into it, the
 *  glyph quads */
export interface LetterBatch { sprite: { key: string; w: number; h: number; rgba: Uint8Array }; additive: boolean; near: boolean;
                               zwrite: boolean; nozcomp: boolean; first: number; count: number }
export interface LetterRenderer {
  liveTarget(image: unknown, w: number, h: number): unknown;
  target(w: number, h: number): unknown;
  overlay(proj: Float32Array, view: Float32Array, target: unknown, clear: [number, number, number, number] | null, mirrored: boolean): void;
  drawParticles(data: Float32Array, batches: LetterBatch[]): void;
  endOverlay(): void;
}

/** a mode of the screen from a frame (the replay's index) */
interface Shown { at: number; mode: number; player: number }

const W = 250, H = 160;
/** the camera into the screen's picture: its pixels, y down, row 0 the top (its projection; the view is none) */
const SCREEN_PROJ = Float32Array.from([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1]);
const SCREEN_VIEW = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** the joint each mode shows (the code's bits: 0x40 the screen itself) */
const JOINT_OF: Record<number, number> = { 2: 6, 3: 3, 4: 4, 5: 9, 6: 7, 15: 8, 16: 5 };
const PICTURES = [2, 3, 4, 5, 6, 7, 8, 9];
/** the modes whose per-frame code writes the screen's text (grStadium_801D2344: the page cleared, the stage's
 *  information, a player defeated, the leaders, Ready and the rest) */
const TEXT_MODES = new Set([0, 1, 9, 10, 11, 12, 13, 14]);
/** the stage's form (the replay's type) -> the transformation's mode */
const FORM_MODE: Record<number, number> = { 5: 2, 3: 3, 4: 4, 9: 5, 6: 6 };
const FORM_NAME: Record<number, string> = { 5: "Normal", 3: "Fire", 4: "Grass", 9: "Water", 6: "Rock" };
/** the game's own names, by external character id */
const NAMES = ["Captain Falcon", "DK", "Fox", "Mr. Game & Watch", "Kirby", "Bowser", "Link", "Luigi", "Mario", "Marth", "Mewtwo",
  "Ness", "Peach", "Pikachu", "Ice Climbers", "Jigglypuff", "Samus", "Yoshi", "Zelda", "Sheik", "Falco", "Young Link", "Dr. Mario",
  "Roy", "Pichu", "Ganondorf"];
/** the hundredths the game's timer shows, by frame of the second */
const HUNDREDTHS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 17, 19, 21, 22, 24, 26, 27, 29, 31, 32, 34, 36, 37, 39, 41, 42, 44, 46, 47, 49,
  51, 53, 54, 56, 58, 59, 61, 63, 64, 66, 68, 69, 71, 73, 74, 76, 78, 79, 81, 83, 84, 86, 88, 89, 91, 93, 94, 96, 98, 99];
const TEXT = "#c0c0ff", WHITE = "#f0f0f0";

/** a page's ops up to the 0x00 that ends it (each op's arguments stepped over), or none */
export function pageOps(p: Uint8Array | null | undefined): number[] {
  if (!p) return [];
  const ARGS: Record<number, number> = { 5: 2, 6: 4, 7: 4, 8: 4, 9: 4, 0x0a: 4, 0x0c: 3, 0x0e: 4 };
  let i = 0;
  while (i < p.length && p[i] !== 0) i += 1 + (p[i] >= 0x20 ? 1 : ARGS[p[i]] ?? 0);
  return [...p.subarray(0, Math.min(i, p.length))];
}

/** a word in full-width Shift-JIS letters, as the code's own strings have them ("Ｐｌａｙｅｒ") */
function fullWidth(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x41 && c <= 0x5a) out.push(0x82, 0x60 + c - 0x41);
    else if (c >= 0x61 && c <= 0x7a) out.push(0x82, 0x81 + c - 0x61);
    else out.push(c);
  }
  return out;
}

/** the fire form's flames, on its joints 0x13 to 0x19 in turn (grStadium_801D1840) */
const FLAMES = [0x753f, 0x7549, 0x7549, 0x753f, 0x753f, 0x7549, 0x753f];
/** the outline the dust is made along while a form changes, and each
 *  stretch's weight, as the game's table has them (lbl_803E1630: the weights
 *  are not all the stretches' lengths) */
const DUST: [number, number, number, number][] = [[-50, 5, 50, 100], [50, 5, 50, 28.28], [70, 5, 30, 53.85], [70, 5, -30, 5],
  [50, 5, -50, 100], [-50, 5, -50, 28.28], [-70, 5, -30, 60], [-70, 5, 30, 28.28], [-50, 5, 50, 0]];
const f32 = Math.fround;
const DUST_ALL = DUST.reduce((a, d) => f32(a + f32(d[3])), 0);
/** one dust generator's place (before the stage's scale), from a number in [0, 1) (grStadium_801D435C) */
export function dustAt(r: number): [number, number, number] {
  let v = f32(DUST_ALL * r), i = 0;
  for (; v > f32(DUST[i][3]) && i < 8; i++) v = f32(v - f32(DUST[i][3]));
  const t = f32(v / f32(DUST[i][3])), a = DUST[i], b = DUST[i + 1];
  return [f32(a[0] + f32((b[0] - a[0]) * t)), f32(a[1] + f32((b[1] - a[1]) * t)), f32(a[2] + f32((b[2] - a[2]) * t))];
}

/** Pokemon Stadium's transformations: which form is up on a frame and how
 *  the game's code has it - flat, coming up, or whole (stage.ts
 *  stadiumForms) - from the replay's own events, or for a replay too old to
 *  have them from a viewer track's screens. And the one joint a form's code
 *  turns itself: the water form's windmill (its main part's joint 7), half a
 *  degree a frame from the frame the form is made (grStadium_801D1B48). */
export class StadiumForms implements StageLogic {
  /** the code's steps as a replay has them (frames as its index); the checks may set their own */
  events: { frame: number; event: number; type: number }[];
  private times: StadiumTimes;

  /** the generators the forms' code makes (gr/particles.ts), for a game with no track: a track has the game's */
  readonly emitters: Emitter[] = [];
  /** and the ends by joint it makes */
  readonly enders: Ender[] = [];

  constructor(st: Stage, data: ReplayData, tr: ViewerTrack | null = null) {
    const y = st.file.publics.get("yakumono_param"), d = st.file.data;
    this.times = y === undefined ? STADIUM_TIMES : { wait: d.getInt32(y + 0x10), change: d.getInt32(y + 0x14), hold: d.getInt32(y + 0x18) };
    this.events = data.stadium?.length ? data.stadium
      : tr?.has("stadscreen") ? stadiumEventsFromScreens(
          tr.changes("stadscreen", "").map(([f, mode]) => ({ frame: Number(f) + 123, mode: Number(mode) })), this.times)
      : [];
    this.makeEmitters(st.scale, data.frames.length - 1);
  }

  /** What the forms' code makes, from the steps: while a form goes flat and
   *  the next comes up (steps 4 and 5, through the frame of step 6) the dust
   *  round the arena, five a frame (grStadium_801D435C); as a form is made
   *  (step 5) its own (each form's setup in grpstadium.c), ended as it is
   *  removed (step 6 of the next change: its teardown). The dust's places
   *  are drawn from a seeded stand-in, the game's own numbers being in no
   *  replay. */
  private makeEmitters(s: number, last: number) {
    const rng = new Rng(0x57ad);
    const place = (gen: number, from: number, at: [number, number, number], to: number | null = null, now = false): Emitter =>
      ({ gen, from, to, now, srt: { tx: at[0] * s, ty: at[1] * s, tz: at[2] * s, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false } });
    let cur = STADIUM_NORMAL, at4 = -1, at5 = -1, coming = -1;
    let made: Emitter[] = [];
    const dust = (from: number, to: number) => {
      for (let f = from; f <= Math.min(to, last); f++) for (let k = 0; k < 5; k++) this.emitters.push(place(0x7548, f, dustAt(rng.next())));
    };
    for (const e of this.events) {
      if (e.event === 4) { at4 = e.frame; at5 = -1; }
      else if (e.event === 5) {
        at5 = e.frame; coming = e.type;
        const now: Emitter[] = [];
        if (coming === 3) {
          // the fire form's flames, made on its joints 0x13 to 0x19 and going with them (grStadium_801D1840)
          FLAMES.forEach((gen, k) => now.push({ ...place(gen, at5, [0, 0, 0]), joint: { part: 3, joint: 0x13 + k }, on: 3 * 65536 + 0x13 + k, untilEnded: true }));
        } else if (coming === 9) now.push({ ...place(0x7544, at5, [0, 0, 0]), untilEnded: true });   // the water form's (grStadium_801D1A38)
        else if (coming === 6) now.push({ ...place(0x7546, at5, [0, 0, 0]), untilEnded: true });     // the rock form's (grStadium_801D1720)
        this.emitters.push(...now);
        // (what the form going out made, waiting for its end)
        made = [...made, ...now];
      } else if (e.event === 6) {
        if (at4 >= 0) dust(at4 + 1, e.frame);
        // the form going out is removed: its teardown ends its own (grStadium_801D19F8: every generator on the
        // fire form's joints 0x12 on, particles at once; 801D1D84: the water form's, particles at once;
        // 801D1808: the rock form's, its particles left to run out)
        for (const m of made) {
          if (m.joint) continue;
          if (cur === 9 && m.gen === 0x7544) { m.to = e.frame; m.now = true; }
          if (cur === 6 && m.gen === 0x7546) { m.to = e.frame; m.now = false; }
        }
        if (cur === 3) this.enders.push({ at: e.frame, from: 3 * 65536 + 0x12, count: 8, now: true });
        for (const m of made) if (m.joint && cur === 3) m.to = e.frame;
        made = made.filter((m) => m.to === null);
        cur = coming >= 0 ? coming : e.type;
        at4 = at5 = coming = -1;
      }
    }
    // (a game that ends while a form changes)
    if (at4 >= 0) dust(at4 + 1, last);
  }

  apply(st: Stage, frame: number) {
    st.setForms(stadiumForms(this.events, frame, this.times, st.scale));
  }

  pose(st: Stage, frame: number, _sf: StageFrame | undefined) {
    const water = st.formsUp.find((f) => f.form === 9);
    const sk = water ? st.formParts(9).find((p) => p.index === 9)?.skeleton : undefined;
    if (water && sk && sk.n > 7) sk.rot[7 * 3 + 2] += (-0.5 * Math.PI / 180) * Math.max(0, frame - water.born);
  }
}

export class StadiumScreen implements StageLogic {
  private shown: Shown[] = [];
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawn = "";
  version = 0;
  /** the game's lettering for the frame: each glyph's quad, drawn into the screen's picture each frame
   *  (drawLetters); what the stage's code wrote last, null before and without the executable */
  private letters: { data: Float32Array; batches: LetterBatch[] } | null = null;
  /** the mode up on the frame last applied */
  mode = 1;
  player = -1;

  /** the crowd's camera flashes: one frame in 200, at random either side of
   *  the stands (grStadium_801D1E20: generator 0x7530), from a seeded stand-in */
  readonly emitters: Emitter[] = [];

  constructor(private st: Stage, private data: ReplayData, tr: ViewerTrack | null = null) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    // the viewer track's screens ("stadscreen": the mode, and the player a close-up follows)
    if (tr?.has("stadscreen")) {
      this.shown = tr.changes("stadscreen", "").map(([f, mode, player]) =>
        ({ at: Math.max(0, Number(f) + 123), mode: Number(mode), player: Number(player) }));
    } else this.schedule();
    const rng = new Rng(0xf1a5), s = st.scale;
    for (let f = 0; f < data.frames.length; f++) {
      if (rng.next() >= 1 / 200) continue;
      const side = rng.next() < 0.5 ? -1 : 1, x = side * (100 + Math.floor(rng.next() * 200));
      this.emitters.push({ gen: 0x7530, from: f, to: null,
                           srt: { tx: x * s, ty: -100 * s, tz: -660 * s, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false } });
    }
  }

  /** the modes over the match: Ready, GO, the text page, then the game's weighted choices */
  private schedule() {
    const y = this.st.file.publics.get("yakumono_param");
    const d = this.st.file.data;
    const i32 = (o: number, dflt: number) => (y === undefined ? dflt : d.getInt32(y + o));
    const s16 = (o: number, dflt: number) => (y === undefined ? dflt : d.getInt16(y + o));
    const [info, closeLo, closeHi, liveLo, liveHi, names] = [i32(0x20, 600), i32(0x30, 600), i32(0x34, 1200), i32(0x38, 600),
      i32(0x3c, 1200), i32(0x2c, 300)];
    const wClose = s16(0x48, 5), wInfo = s16(0x4a, 2), wLive = s16(0x4c, 2), wLogo = s16(0x4e, 0), every = s16(0x50, 7);
    const players = this.data.settings.playerSettings.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const rng = new Rng(0x5da);
    const last = this.data.frames.length;
    // (frames as the replay's index: the game's -124 is before the first)
    const out: Shown[] = [{ at: 0, mode: 10, player: -1 }, { at: 83, mode: 11, player: -1 }];
    let at = 122, mode = 1, prev = 11, dur = info, count = 0, who = -1;
    out.push({ at, mode, player: -1 });
    // transformations: the screen shows the coming form's picture as the
    // code goes from step 2 to step 3 (grStadium_801D4548), on the frame the
    // replay records step 3
    const forms = (this.data.stadium ?? []).filter((e) => e.event === 3).map((e) => ({ at: e.frame, mode: FORM_MODE[e.type] ?? 2 }));
    while (at < last) {
      let next = at + dur + 2;
      const form = forms.find((f) => f.at > at && f.at < next);
      if (form) { next = form.at; }
      if (form) { prev = mode; mode = form.mode; dur = i32(0x28, 600); }
      else if (count >= every) { count = 0; prev = mode; mode = 14; dur = names; }
      else {
        let m: number;
        do {
          let v = rng.next() * (wClose + wInfo + wLive + wLogo) - wClose;
          if (v < 0) m = 8;
          else if ((v -= wLive) < 0) m = 7;
          else if ((v -= wInfo) < 0) m = 1;
          else if ((v -= wLogo) < 0) m = 15;
          else m = 1;
        } while (m === mode || m === prev);
        prev = mode; mode = m;
        dur = m === 1 ? info : m === 7 ? liveLo + Math.floor(rng.next() * (liveHi - liveLo))
          : m === 8 ? closeLo + Math.floor(rng.next() * (closeHi - closeLo)) : info;
        if (m === 8 && players.length) who = players[(players.indexOf(who) + 1) % players.length];
      }
      count++;
      at = next;
      out.push({ at, mode, player: mode === 8 ? who : -1 });
    }
    this.shown = out;
  }

  /** the text the screen has on a frame: the mode that wrote it last and the frame it did, or null before any */
  private lastText(frame: number): { mode: number; frame: number } | null {
    let i = 0;
    for (let k = 0; k < this.shown.length && this.shown[k].at <= frame; k++) i = k;
    if (TEXT_MODES.has(this.shown[i].mode)) return { mode: this.shown[i].mode, frame };
    for (let k = i - 1; k >= 0; k--) {
      if (TEXT_MODES.has(this.shown[k].mode)) return { mode: this.shown[k].mode, frame: this.shown[k + 1].at };
    }
    return null;
  }

  private at(frame: number): Shown {
    let s = this.shown[0];
    for (const x of this.shown) { if (x.at > frame) break; s = x; }
    return s;
  }

  apply(_st: Stage, frame: number) {
    const s = this.at(frame);
    this.mode = s.mode;
    this.player = s.player;
  }

  pose(st: Stage, _frame: number, _sf: StageFrame | undefined) {
    const p = st.screen?.part;
    if (!p) return;
    const sk = p.skeleton;
    const up = JOINT_OF[this.mode] ?? 2;
    for (const j of PICTURES) if (j < sk.n) sk.shown[j] = j === up ? 1 : 0;
  }

  /** the text page's picture (drawn again only when what it says changes) */
  draw(frame: number) {
    const m = this.mode;
    const lettering = this.st.lettering;
    // (the stage's code sets the text in these modes only; in the others it stays as it was, and is drawn all the same)
    if (lettering) {
      // (what the stage's code wrote last, whichever frame this is: in a mode that writes none, the last text of the
      // mode before it, as of the frame that mode ended - its code ran that frame too)
      const t = this.lastText(frame);
      if (t) this.drawGame(t.frame, lettering, t.mode);
      return;
    }
    if (m === 7 || m === 8) return;
    const ctx = this.ctx;
    const lines: string[] = [];
    if (m === 1 || m === 14) {
      const players = this.data.settings.playerSettings.filter((p) => p);
      const names = players.map((p) => NAMES[p.externalCharacterId] ?? "");
      if (m === 1) {
        const frames = Math.max(0, Math.min(this.data.settings.timerStart * 60, this.data.settings.timerStart * 60 - frame + 123));
        const time = `${String(Math.floor(frames / 3600)).padStart(2, "0")}:${String(Math.floor((frames % 3600) / 60)).padStart(2, "0")} ` +
          String(HUNDREDTHS[frames % 60]).padStart(2, "0");
        const form = FORM_NAME[this.formAt(frame)] ?? "Normal";
        lines.push(m + form + names.join("|") + time);
        if (lines[0] !== this.drawn) {
          this.drawn = lines[0];
          this.clear();
          this.text("Current Stage", 125, 22, 20, WHITE, 1.4);
          this.text(form, 125, 40, 20, TEXT, 1.4);
          this.text("Combatants", 125, 60, 20, WHITE, 1.4);
          const at: [number, number][] = names.length === 1 ? [[124, 86]] : names.length === 2 ? [[62, 86], [186, 86]]
            : [[62, 78], [186, 78], [names.length === 3 ? 124 : 62, 96], [186, 96]];
          names.forEach((n, i) => at[i] && this.text(n, at[i][0], at[i][1], 15, TEXT, 0.9, 110, "normal"));
          this.text("Time", 125, 113, 20, WHITE, 1.4);
          this.text(time, 125, 130, 17, TEXT, 1.4, 240, "normal");
          this.version++;
        }
        return;
      }
      // the names alone, each in its player's color
      const key = "14" + names.join("|");
      if (key !== this.drawn) {
        this.drawn = key;
        this.clear();
        const top = [0x50, 0x40, 0x30, 0x20][names.length - 1] ?? 0x20;
        const cols = ["#ff5050", "#5a78ff", "#ffe040", "#50ff64"];
        players.forEach((p, i) => this.text(names[i], 125, top + 32 * i + 16, 22, cols[p.playerIndex] ?? WHITE, 0.8, 230));
        this.version++;
      }
      return;
    }
    if (m === 9) {
      const key = `9:${this.player}`;
      if (key !== this.drawn) {
        this.drawn = key;
        this.clear();
        this.text(`Player ${this.player + 1} Defeated`, 125, 70, 22, TEXT, 1.4, 240);
        this.version++;
      }
      return;
    }
    // Ready, GO and the rest: the game's own lettering is not drawn here - the screen goes dark
    if (this.drawn !== "dark") { this.drawn = "dark"; this.clear(); this.version++; }
  }

  /** What the screen writes in a mode, as the stage's code has it, with the
   *  game's own text (sistext.ts): its file's pages, and the lines the code
   *  writes in with the executable's font (grStadium_801D3460 the text page:
   *  the form's name, the players' characters and the clock;
   *  grStadium_801D3BBC the current leaders in their colors; grStadium_801D3A0C
   *  a player defeated; grStadium_801D3F40 "Ready?", "Go!", "Time!", "Sudden
   *  Death"). The rest show the file's empty page. */
  private gameText(frame: number, L: Lettering, m: number): { page: number[]; lines: number[]; opts: SisTextOpts } {
    const c = L.common;
    const page = (k: number) => pageOps(L.file.pages[k]);
    const opts: SisTextOpts = { boxW: W, boxH: H, align: 1, dynamic: true };
    const lines: number[] = [];
    if (m === 1) {
      // the form's name between "Current Stage" and "Combatants ... Time" (its page 8 to 0xC)
      const form = { 3: 9, 9: 10, 6: 11, 4: 12 }[this.kindAt(frame)] ?? 8;
      if (c) {
        const names = this.names(frame, c, false);
        const at: [number, number][] = names.length === 1 ? [[124, 70]] : names.length === 2 ? [[62, 70], [186, 70]]
          : [[62, 60], [186, 60], [names.length === 3 ? 124 : 62, 80], [186, 80]];
        names.forEach((n, k) => at[k] && lines.push(...sisString(n.name, at[k][0], at[k][1], [0xc0, 0xc0, 0xff], [0.26, 0.625], c)));
        const total = this.data.settings.timerStart * 60;
        const frames = Math.max(0, Math.min(total, total - frame + 123));
        const clock = total > 0 ? `${String(Math.floor(frames / 3600)).padStart(2, "0")}:${String(Math.floor((frames % 3600) / 60)).padStart(2, "0")} ` +
          String(HUNDREDTHS[frames % 60]).padStart(2, "0") : "00:00 00";
        lines.push(...sisString(ascii(clock), 125, 120, [0xc0, 0xc0, 0xff], [0.625, 0.625], c));
      }
      return { page: [...page(6), ...page(form), ...page(7)], lines, opts };
    }
    if (m === 14) {
      const leaders = c ? this.names(frame, c, true) : [];
      const n = leaders.length;
      if (n < 1 || n > 4 || !c) return { page: page(3), lines, opts };
      const top = [0x50, 0x40, 0x30, 0x20][n - 1];
      leaders.forEach((l, k) => lines.push(...sisString(l.name, 125, top + 32 * k, l.color, [0.8, 1.0], c)));
      return { page: page(0xe + n - 1), lines, opts: { ...opts, kern: true, fit: true } };
    }
    if (m === 9 && c) {
      const human = (this.data.settings.playerSettings[this.player]?.playerType ?? 0) === 0;
      const s = human ? [...fullWidth("Player"), 0x20, ...ascii(String(this.player + 1)), 0x20, ...fullWidth("Defeated")]
        : [...ascii("Computer Player Defeated")];
      lines.push(...sisString(Uint8Array.from(s), 125, 56, [0xc0, 0xc0, 0xff], human ? [0.625, 1.5] : [0.42, 1.2], c));
      return { page: page(3), lines, opts: { ...opts, kern: true } };
    }
    if (m >= 10 && m <= 13) return { page: page(0x12 + m - 10), lines, opts };
    return { page: page(3), lines, opts };
  }

  /** the players' characters' names (the game's, Zelda's or Sheik's as she is now) in port order, and their
   *  colors as the leaders' screen has them; `leaders`: only the players no one outscores - in a stock match
   *  the most stocks left (gm_8016C5C0's standing, fn_80165AC0) */
  private names(frame: number, c: SisCommon, leaders: boolean): { name: Uint8Array; color: [number, number, number] }[] {
    const s = this.data.settings, f = this.data.frames[Math.min(frame, this.data.frames.length - 1)];
    const stocks = (i: number) => f?.players[i]?.state?.stocksRemaining ?? 0;
    const ports = s.playerSettings.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const best = Math.max(...ports.map(stocks));
    const out: { name: Uint8Array; color: [number, number, number] }[] = [];
    for (const i of ports) {
      if (leaders && stocks(i) < best) continue;
      const p = s.playerSettings[i]!;
      let ext = p.externalCharacterId;
      const now = f?.players[i]?.state?.internalCharacterId;
      if (ext === 18 || ext === 19) ext = now === 0x07 ? 19 : now === 0x13 ? 18 : ext;
      const name = c.names[ext];
      if (!name?.length) continue;
      // (gm_80160854: a human's by port or team, a computer's its own)
      const human = (p.playerType ?? 0) === 0;
      const team = [[0, 5], [1, 6], [3, 8], [2, 7]][p.teamId ?? 0];
      const k = s.isTeams ? (team ? team[human ? 0 : 1] : 4) : human ? Math.min(i, 3) : 4;
      const [r, g, b] = c.colors[k] ?? [255, 255, 255];
      // (each channel a quarter brighter, to 255 at most: the machine code's - the decompiled source has the
      // channels shifted, which the instructions do not)
      const up = (v: number) => Math.min(255, Math.trunc(1.25 * v));
      out.push({ name, color: [up(r), up(g), up(b)] });
    }
    return out;
  }

  /** the kind the stage's code has chosen (its xDE: each step's type, the replay's events), 5 before any */
  private kindAt(frame: number): number {
    let kind = 5;
    for (const e of this.data.stadium ?? []) { if (e.frame > frame) break; kind = e.type; }
    return kind;
  }

  private glyphs = new Map<SisFont, Map<string, HTMLCanvasElement>>();

  /** the screen's picture with the game's text, drawn again when what it says changes */
  private drawGame(frame: number, L: Lettering, m: number) {
    const { page, lines, opts } = this.gameText(frame, L, m);
    const key = `${m}:${page.length}:${page.join(",")}|${lines.join(",")}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.clear();
    const common = L.common?.font ?? null;
    const glyphs = [...layoutSis(Uint8Array.from([...page, 0]), { boxW: W, boxH: H }, L.file.font, common),
                    ...(lines.length ? layoutSis(Uint8Array.from([...lines, 0]), opts, L.file.font, common) : [])];
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (const g of glyphs) {
      let byFont = this.glyphs.get(g.font);
      if (!byFont) this.glyphs.set(g.font, (byFont = new Map()));
      const k = `${g.index}:${g.color.join(",")}`;
      let pic = byFont.get(k);
      if (!pic) {
        pic = document.createElement("canvas");
        pic.width = pic.height = 32;
        const a = glyphAlpha(g.font, g.index), img = pic.getContext("2d")!.createImageData(32, 32);
        for (let p = 0; p < 32 * 32; p++) {
          img.data[p * 4] = g.color[0]; img.data[p * 4 + 1] = g.color[1]; img.data[p * 4 + 2] = g.color[2]; img.data[p * 4 + 3] = a[p];
        }
        pic.getContext("2d")!.putImageData(img, 0, 0);
        byFont.set(k, pic);
      }
      ctx.drawImage(pic, g.x, g.y, g.w, g.h);
    }
    ctx.restore();
    // (the picture the screen shows is the game's way: the glyphs' quads drawn into it each frame, drawLetters;
    // the canvas keeps a copy for the checks, and is not uploaded)
    this.letters = this.lettersOf(glyphs, L);
  }

  /** the glyphs as quads for the renderer's particle pass (17 floats a vertex, four a quad), one batch for each run
   *  of one font's: in the picture's own pixels, y down. A glyph's color is its quad's, the texture's alpha its
   *  alpha. */
  private lettersOf(glyphs: SisGlyph[], L: Lettering): { data: Float32Array; batches: LetterBatch[] } {
    const out: number[] = [];
    const batches: LetterBatch[] = [];
    const common = L.common?.font ?? null;
    for (const g of glyphs) {
      const atlas = glyphAtlasOf(g.font, g.font === common ? "screen-font:common" : "screen-font:file");
      const last = batches[batches.length - 1];
      if (!last || last.sprite !== atlas.sprite) {
        batches.push({ sprite: atlas.sprite, additive: false, near: false, zwrite: false, nozcomp: true, first: out.length / 68, count: 0 });
      }
      batches[batches.length - 1].count++;
      const [r, gr, b] = g.color.map((v) => v / 255);
      const u0 = atlas.uv[g.index * 4], vTop = atlas.uv[g.index * 4 + 1], u1 = atlas.uv[g.index * 4 + 2], vBottom = atlas.uv[g.index * 4 + 3];
      const x0 = g.x, x1 = g.x + g.w, top = g.y, bottom = g.y + g.h;
      // (corners bottom left, top left, top right, bottom right: position 3, texture 2, primary 4, environment 4,
      // the alpha compare always passing 3, textured 1)
      const v = (x: number, y: number, u: number, t: number) => out.push(x, y, 0, u, t, r, gr, b, 1, r, gr, b, 0, 63, 0, 0, 1);
      v(x0, bottom, u0, vBottom); v(x0, top, u0, vTop); v(x1, top, u1, vTop); v(x1, bottom, u1, vBottom);
    }
    return { data: Float32Array.from(out), batches };
  }

  private scratch: unknown = null;

  /** The screen's lettering drawn into its picture, as the game does it every frame whatever the screen shows:
   *  the picture cleared to black, then a quad a glyph over it, through a camera of the picture's own pixels that
   *  turns it over (its first row is the top). While the screen shows the match the picture is the match's, and
   *  the lettering goes into one of its own. Nothing without the executable's font. */
  drawLetters(r: LetterRenderer, image: unknown) {
    if (!this.letters) return;
    const shows = this.mode === 7 || this.mode === 8;
    const target = shows ? (this.scratch ??= Object.assign(r.target(W, H) as object, { erase: true })) : r.liveTarget(image, W, H);
    if (!target) return;
    r.overlay(SCREEN_PROJ, SCREEN_VIEW, target, [0, 0, 0, 1], true);
    r.drawParticles(this.letters.data, this.letters.batches);
    r.endOverlay();
  }

  /** the stage's form at a frame (the replay's stadium events), 5 before any */
  private formAt(frame: number): number {
    let form = 5;
    for (const e of this.data.stadium ?? []) { if (e.frame > frame) break; if (e.event === 6 || e.event === 0) form = e.type; }
    return form;
  }

  private clear() {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, W, H);
  }

  /** a line centered on x, its baseline at y, stretched across by `squeeze`
   *  (no wider than `fit`) as the game's letters are */
  private text(s: string, x: number, y: number, size: number, color: string, squeeze: number, fit = 240, weight = "bold") {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${weight} ${size}px "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    const w = ctx.measureText(s).width * squeeze;
    const k = Math.min(squeeze, squeeze * (fit / Math.max(1, w)));
    ctx.translate(x, y);
    ctx.scale(k, 1);
    ctx.fillText(s, 0, 0);
    ctx.restore();
  }

  /** the screen's picture size, and the green its material is lit in while
   *  it shows the match (yakumono_param's color) */
  readonly size: [number, number] = [W, H];
  readonly tint: [number, number, number] = [150, 180, 160];

  /** the part of the frame just drawn the screen shows (modes 7 and 8: the
   *  match's own picture), as fractions of the picture from its top left
   *  (x, y, w, h); null in the other modes. The renderer copies it
   *  (Renderer.captureLive), scaled to the screen; the screen's material
   *  lays its green on it (Stage.setScreenConstant). */
  captureRect(where: ((player: number) => [number, number] | null)): [number, number, number, number] | null {
    const m = this.mode;
    if (m !== 7 && m !== 8) return null;
    // (the text page is drawn again when it comes back)
    this.drawn = "";
    // (the game copies 640 by 406 from 36 down)
    if (m === 7) return [0, 36 / 480, 1, 406 / 480];
    const at = this.player >= 0 ? where(this.player) : null;
    const cw = 124 / 640, ch = 80 / 480;
    const x = Math.max(0, Math.min(1 - cw, (at?.[0] ?? 0.5) - cw / 2));
    const y = Math.max(0, Math.min(1 - ch, (at?.[1] ?? 0.5) - ch / 2));
    return [x, y, cw, ch];
  }
}
