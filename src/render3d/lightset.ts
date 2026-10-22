/* 3D replay viewer: a set of lights as the game makes them
 * active for what it draws - the stage's own set for the stage, the stage's
 * player lights (map_plit) for the fighters, items and effects.
 *
 * As the game's ground code does: a stage file can switch each light's
 * diffuse and specular parts on or off (and drops the lights it does not
 * name); the lights' places are at the stage's scale; their animations run
 * from the start of the match, looping where the stage says so. Then HSD's
 * light setup: hidden lights and ones that light nothing are left out, the
 * first ambient light is the ambient, at most eight others. */
import { Light, aobjFrame, sample, splineAt } from "./hsd";
import { GxLight, LOBJ, distAttn, spotAttn } from "./gx";
import { pickShadowLight } from "./shadow";

/** what the renderer's shaders take */
export interface Lighting {
  /** the ambient light's color (black when it does not light the diffuse channel) */
  ambient: [number, number, number];
  /** the ambient light's alpha when it lights the alpha channel (its LOBJ_ALPHA: HSD_SetupChannelMode's
   *  ambient alpha, HSD_LObjGetActiveByID(0x100)->color.a), else null */
  ambientAlpha: number | null;
  n: number;
  /** per light (8 x vec4): where it is (w 1) or the way to it (w 0) */
  pos: Float32Array;
  /** its axis, toward the light (spot lights) */
  axis: Float32Array;
  color: Float32Array;
  /** a0, a1, a2, and w: 1 lights the diffuse channel, 2 the specular one, 4 the alpha one (LOBJ_ALPHA:
   *  setup_diffuse_lightobj puts it in lightmask_alpha) */
  attnA: Float32Array;
  /** k0, k1, k2 */
  attnK: Float32Array;
  /** the lights, as the math in gx.ts takes them */
  lights: GxLight[];
  /** per light (8 x vec4): its place in the world as its LObj has it (float32), and a spot's interest (w 1 when
   *  it has one) */
  place: Float32Array;
  interest: Float32Array;
  /** changes whenever the rest does (the renderer uploads only then) */
  version: number;
}

let versions = 0;

export function packLighting(ambient: [number, number, number], lights: GxLight[],
                             ambientAlpha: number | null = null): Lighting {
  const out: Lighting = {
    ambient, ambientAlpha, n: Math.min(8, lights.length), pos: new Float32Array(32), axis: new Float32Array(32),
    color: new Float32Array(32), attnA: new Float32Array(32), attnK: new Float32Array(32), lights, version: ++versions,
    place: new Float32Array(32), interest: new Float32Array(32),
  };
  lights.slice(0, 8).forEach((l, i) => {
    out.pos.set(l.pos, i * 4);
    out.axis.set(l.axis, i * 4);
    out.color.set(l.color, i * 4);
    out.attnA.set([l.attn[0], l.attn[1], l.attn[2], (l.diffuse ? 1 : 0) + (l.specular ? 2 : 0) + (l.diffuse && l.alpha ? 4 : 0)], i * 4);
    out.attnK.set([l.attn[3], l.attn[4], l.attn[5], 0], i * 4);
    const pl = l.place ?? [l.pos[0], l.pos[1], l.pos[2]];
    out.place.set([pl[0], pl[1], pl[2], 1], i * 4);
    if (l.interest) out.interest.set([l.interest[0], l.interest[1], l.interest[2], 1], i * 4);
  });
  return out;
}

/** the lights the game falls back on when a stage has none of its own: a
 *  white ambient and one white light from the front, up and to the right */
export const DEFAULT_LIGHTS: Light[] = [
  { desc: -1, kind: "ambient", flags: LOBJ.DIFFUSE, color: [1, 1, 1, 1], position: null, interest: null, raw: null,
    spot: null, dist: null, anim: null },
  { desc: -2, kind: "infinite", flags: LOBJ.INFINITE | LOBJ.DIFFUSE | LOBJ.SPECULAR, color: [1, 1, 1, 1],
    position: [0.57, 0.57, 0.57], interest: null, raw: null, spot: null, dist: null, anim: null },
];

/** a stage's light overrides (map_head's list: a light and which of its
 *  parts are on), applied as the game's ground code does: when the list
 *  names any of the lights, every light but the ambient ones must be named
 *  with something on, and gets its diffuse (0x40) and specular (0x80) parts
 *  from the list */
export function applyOverrides(lights: Light[], overrides: Map<number, number>): Light[] {
  const on = (l: Light) => (overrides.get(l.desc) ?? 0) & 0xe0;
  if (!lights.some((l) => on(l))) return lights;
  return lights.filter((l) => l.kind === "ambient" || on(l)).map((l) => {
    if (l.kind === "ambient") return l;
    const o = overrides.get(l.desc)!;
    let flags = l.flags & ~(LOBJ.DIFFUSE | LOBJ.SPECULAR | 0x400);
    if (o & 0x40) flags |= LOBJ.DIFFUSE;
    if (o & 0x80) flags |= LOBJ.SPECULAR;
    if (o & 0x20) flags |= 0x400;
    return { ...l, flags };
  });
}

export interface LightClock {
  /** every animation loops (a stage's code can say so for a whole set, as
   *  grIzumi_OnLoad does for the fighters' lights) */
  loopAll?: boolean;
  /** how many frames the set's animations have run at the replay's first
   *  frame: the light objects are made as the match is set up, before it */
  ahead?: number;
}

export class LightSet {
  private last = -1;
  private lit: Lighting | null = null;

  /** `scale`: the stage's (the lights' places are at it); `loops`: the
   *  animations the stage says loop (by their offset); `clock`: where the
   *  animations stand against the replay's frames */
  constructor(readonly lights: Light[], private scale = 1, private loops: Set<number> = new Set(),
              private clock: LightClock = {}) {}

  /** whether anything about it changes from frame to frame */
  get animated(): boolean {
    return this.lights.some((l) => l.anim);
  }

  /** the lighting at a frame of the match */
  at(frame: number): Lighting {
    if (this.lit && (frame === this.last || !this.animated)) return this.lit;
    this.last = frame;
    this.lit = this.build(frame);
    return this.lit;
  }

  /** the light the fighters' shadows come from at a frame (shadow.ts
   *  pickShadowLight): its place and interest, at the stage's scale as the
   *  set's own places are */
  shadowLight(frame: number): { pos: number[]; interest: number[] | null } | null {
    const all = this.lights.map((l) => this.animate(l, frame));
    const l = pickShadowLight(all);
    if (!l || !l.position) return null;
    const k = l.animatedPlace ? 1 : this.scale;
    return { pos: l.position.map((v) => v * k), interest: l.interest ? l.interest.map((v) => v * k) : null };
  }

  private build(frame: number): Lighting {
    let ambient: [number, number, number] | null = null, ambientAlpha: number | null = null;
    const out: GxLight[] = [];
    const s = this.scale;
    for (const l0 of this.lights) {
      const l = this.animate(l0, frame);
      if (l.flags & LOBJ.HIDDEN) continue;
      if (l.kind === "ambient") {
        if (!ambient) {
          ambient = l.flags & LOBJ.DIFFUSE ? [l.color[0], l.color[1], l.color[2]] : [0, 0, 0];
          if (l.flags & LOBJ.ALPHA) ambientAlpha = l.color[3];
        }
        continue;
      }
      const diffuse = (l.flags & LOBJ.DIFFUSE) !== 0, specular = (l.flags & LOBJ.SPECULAR) !== 0;
      const alpha = (l.flags & LOBJ.ALPHA) !== 0;
      if ((!diffuse && !specular) || out.length >= 8 || !l.position) continue;
      // (an animated place is the animation's own, not at the stage's scale:
      // the game's ground code scales only the ones the file starts with)
      const k = l.animatedPlace ? 1 : s;
      const p = l.position.map((v) => v * k) as [number, number, number];
      let attn: GxLight["attn"];
      let pos: GxLight["pos"], axis: GxLight["axis"] = [0, 0, 1];
      if (l.kind === "infinite") {
        const n = Math.hypot(p[0], p[1], p[2]) || 1;
        pos = [p[0] / n, p[1] / n, p[2] / n, 0];
        attn = [1, 0, 0, 1, 0, 0];
      } else {
        pos = [p[0], p[1], p[2], 1];
        const dist = l.dist ? distAttn(l.dist.refDist, l.dist.refBright, l.dist.func) : [1, 0, 0];
        if (l.kind === "point") attn = l.raw ? [1, 0, 0, l.raw[3], l.raw[4], l.raw[5]] : [1, 0, 0, ...dist] as GxLight["attn"];
        else {
          const sp = l.spot ? spotAttn(l.spot.cutoff, l.spot.func) : [1, 0, 0];
          attn = l.raw ? l.raw.slice(0, 6) as GxLight["attn"] : [...sp, ...dist] as GxLight["attn"];
          const t = (l.interest ?? [0, 0, 0]).map((v) => v * k);
          const d = [p[0] - t[0], p[1] - t[1], p[2] - t[2]], n = Math.hypot(d[0], d[1], d[2]) || 1;
          axis = [d[0] / n, d[1] / n, d[2] / n];
          out.push({ pos, axis, color: [...l.color], attn, diffuse, specular, alpha, place: p, interest: t as [number, number, number] });
          continue;
        }
      }
      out.push({ pos, axis, color: [...l.color], attn, diffuse, specular, alpha, place: p });
    }
    return packLighting(ambient ?? [0, 0, 0], out, ambientAlpha);
  }

  /** a light as its animation leaves it at a frame */
  private animate(l: Light, frame: number): Light & { animatedPlace?: boolean } {
    const an = l.anim;
    if (!an) return l;
    const loop = this.clock.loopAll === true || this.loops.has(an.offset);
    frame += this.clock.ahead ?? 0;
    const out: Light & { animatedPlace?: boolean } = { ...l, color: [...l.color] as Light["color"] };
    if (an.aobj) {
      const t = aobjFrame(an.aobj, frame, loop);
      for (const tr of an.aobj.tracks) {
        const v = sample(tr.keys, t);
        if (v === null) continue;
        // (LObjUpdateFunc keeps the color as bytes: 255.0 times the track's
        // value, cut to a whole number as it is stored)
        const c = Math.floor(255 * Math.fround(Math.min(Math.max(v, 0), 1))) / 255;
        if (tr.type >= 9 && tr.type <= 11) out.color[tr.type - 9] = c; // LITC_R, G, B
        else if (tr.type === 22) out.color[3] = c; // LITC_A
        else if (tr.type === 12) out.flags = v < 0.5 ? out.flags & ~LOBJ.HIDDEN : out.flags | LOBJ.HIDDEN; // VIS
      }
    }
    const place = (w: LightAnimPart | null, from: [number, number, number] | null): [number, number, number] | null => {
      if (!w) return from;
      const t = aobjFrame(w.aobj, frame, loop);
      const p: [number, number, number] = from ? [...from] : [0, 0, 0];
      for (const tr of w.aobj.tracks) {
        const v = sample(tr.keys, t);
        if (v === null) continue;
        if (tr.type === 4 && w.spline) {
          // (WObjUpdateFunc: the point a share of the way along the curve by
          // length; HSD_WObjGetPosition then takes it through the spline
          // joint's matrix)
          const q = [0, 0, 0];
          splineAt(w.spline, Math.min(Math.max(v, 0), 1), q);
          const m = w.mtx;
          if (m) {
            p[0] = m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12];
            p[1] = m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13];
            p[2] = m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14];
          } else { p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; }
        } else if (tr.type >= 5 && tr.type <= 7) p[tr.type - 5] = v;
      }
      return p;
    };
    out.position = place(an.position, l.position);
    out.animatedPlace = an.position !== null;
    if (l.kind === "spot") out.interest = place(an.interest, l.interest);
    return out;
  }
}

type LightAnimPart = NonNullable<NonNullable<Light["anim"]>["position"]>;
