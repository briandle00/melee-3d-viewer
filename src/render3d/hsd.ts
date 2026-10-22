/* 3D replay viewer: a reader for HAL's sysdolphin (HSD)
 * archives, the .dat files Melee's characters and stages live in.
 *
 * Written for this viewer. The structure layouts are community knowledge; the
 * reference used while writing it was noclip.website's SYSDOLPHIN loader
 * (Jasper St. Pierre, MIT, github.com/magcius/noclip.website), plus the
 * sysdolphin headers of the Melee decompilation for field names. Some of it
 * is adapted from noclip's code: decodeKeys follows its
 * HSD_FObjLoadKeyframes step for step. Its MIT notice is LICENSE-noclip.txt
 * beside this file, and the build carries it (THIRD_PARTY_LICENSES.txt). No game
 * data is in this file, or anywhere in the repository: it reads your
 * own files, from your own disk, at runtime.
 */
import { srt } from "./math";

export interface Archive {
  data: DataView; // the data block (pointers are offsets into it)
  u8: Uint8Array;
  reloc: Set<number>; // offsets that hold a pointer
  publics: Map<string, number>;
}

/** Throws on anything that is not an HSD archive, so a wrong or damaged
 * file is an error the viewer can fall back on, never a garbage model. */
export function parseArchive(buf: ArrayBuffer, base = 0): Archive {
  if (buf.byteLength - base < 0x20) throw new Error("not an HSD archive: too short");
  const v = new DataView(buf, base);
  const fileSize = v.getUint32(0x00);
  const dataSize = v.getUint32(0x04);
  const nReloc = v.getUint32(0x08);
  const nPublic = v.getUint32(0x0c);
  const nExtern = v.getUint32(0x10);
  const end = 0x20 + dataSize + nReloc * 4 + (nPublic + nExtern) * 8;
  if (fileSize > buf.byteLength - base || end > buf.byteLength - base || dataSize === 0)
    throw new Error("not an HSD archive: its header does not fit the file");
  const data = new DataView(buf, base + 0x20, dataSize);
  let p = 0x20 + dataSize;
  const reloc = new Set<number>();
  for (let i = 0; i < nReloc; i++, p += 4) reloc.add(v.getUint32(p));
  const strBase = p + (nPublic + nExtern) * 8;
  const publics = new Map<string, number>();
  const bytes = new Uint8Array(buf, base, Math.min(buf.byteLength - base, fileSize || buf.byteLength));
  for (let i = 0; i < nPublic; i++, p += 8) {
    publics.set(readString(bytes, strBase + v.getUint32(p + 4)), v.getUint32(p));
  }
  return { data, u8: new Uint8Array(buf, base + 0x20, dataSize), reloc, publics };
}

function readString(b: Uint8Array, at: number): string {
  let s = "";
  for (let i = at; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function str(a: Archive, off: number): string {
  return readString(a.u8, off);
}

/** a pointer field: null unless the relocation table says it is one */
export function ptr(a: Archive, at: number): number | null {
  return a.reloc.has(at) ? a.data.getUint32(at) : null;
}

// ---------------------------------------------------------------- joints

export const JOBJ = {
  SKELETON: 1 << 0,
  SKELETON_ROOT: 1 << 1,
  ENVELOPE: 1 << 2,
  CLASSICAL_SCALE: 1 << 3,
  HIDDEN: 1 << 4,
  PTCL: 1 << 5,
  BILLBOARD_MASK: 0xf << 9,
  INSTANCE: 1 << 12,
  SPLINE: 1 << 14,
  USE_QUATERNION: 1 << 17,
};

export interface JObj {
  offset: number;
  index: number; // preorder index in its tree
  parent: number; // preorder index, -1 for a root
  flags: number;
  rot: [number, number, number];
  scale: [number, number, number];
  trans: [number, number, number];
  invBind: Float32Array | null; // 4x4 column-major
  children: JObj[];
  dobjs: DObj[];
  /** a spline joint's curve (another joint's PATH track moves along it) */
  spline?: Spline;
}

/** An HSD spline: its kind (0 straight segments, 1 Bezier, 2 B-spline,
 *  3 cardinal), control points, and the tables the file keeps for walking it
 *  by arc length - each segment's start as a share of the whole length, and
 *  a quartic whose square root is the curve's speed along the segment. */
export interface Spline {
  type: number;
  n: number;
  tension: number;
  cv: Float32Array;
  total: number;
  seg: Float32Array;
  poly: Float32Array;
}

function loadSpline(a: Archive, o: number): Spline {
  const d = a.data;
  const type = d.getUint8(o), n = d.getInt16(o + 2);
  const cvAt = ptr(a, o + 8), segAt = ptr(a, o + 0x10), polyAt = ptr(a, o + 0x14);
  const floats = (at: number | null, count: number) => {
    const out = new Float32Array(Math.max(0, count));
    for (let i = 0; at !== null && i < count && at + i * 4 + 4 <= d.byteLength; i++) out[i] = d.getFloat32(at + i * 4);
    return out;
  };
  // a Bezier has three points a segment; the others read one either side
  const cvs = type === 1 ? (n - 1) * 3 + 1 : n + 2;
  return { type, n, tension: d.getFloat32(o + 4), cv: floats(cvAt, cvs * 3), total: d.getFloat32(o + 0x0c),
           seg: floats(segAt, n), poly: floats(polyAt, Math.max(0, n - 1) * 5) };
}

/** a point of a spline at parameter u (0..1 over all its segments) */
function splinePoint(s: Spline, u: number, out: number[]) {
  const segs = s.n - 1;
  let i = Math.min(segs - 1, Math.max(0, Math.floor(u * segs)));
  let t = u * segs - i;
  if (u >= 1) { i = segs - 1; t = 1; }
  const P = (k: number, c: number) => s.cv[k * 3 + c] ?? 0;
  for (let c = 0; c < 3; c++) {
    if (s.type === 0) out[c] = P(i, c) + t * (P(i + 1, c) - P(i, c));
    else if (s.type === 1) {
      const k = i * 3, m = 1 - t;
      out[c] = m * m * m * P(k, c) + 3 * t * m * m * P(k + 1, c) + 3 * t * t * m * P(k + 2, c) + t * t * t * P(k + 3, c);
    } else if (s.type === 2) {
      const t2 = t * t, t3 = t2 * t, m = 1 - t;
      out[c] = (m * m * m * P(i, c) + (3 * t3 - 6 * t2 + 4) * P(i + 1, c) + (-3 * t3 + 3 * t2 + 3 * t + 1) * P(i + 2, c) + t3 * P(i + 3, c)) / 6;
    } else {
      // cardinal: the curve through points i+1 and i+2, shaped by i and i+3
      const k = s.tension, t2 = t * t, t3 = t2 * t;
      out[c] = k * (-t3 + 2 * t2 - t) * P(i, c) + ((2 - k) * t3 + (k - 3) * t2 + 1) * P(i + 1, c) +
               ((k - 2) * t3 + (3 - 2 * k) * t2 + k * t) * P(i + 2, c) + k * (t3 - t2) * P(i + 3, c);
    }
  }
}

/** the point a share `f` (0..1) of the way along a spline by length, as a
 *  PATH track asks: the segment it falls in from the file's table, then the
 *  parameter within it found by halving, the length measured by Simpson's
 *  rule over the segment's speed */
export function splineAt(s: Spline, f: number, out: number[]) {
  f = Math.min(1, Math.max(0, f));
  const segs = s.n - 1;
  if (segs < 1) { splinePoint(s, 0, out); return; }
  let u: number;
  if (f <= 0) u = 0;
  else if (f >= 1) u = 1;
  else {
    let i = 0;
    while (i < segs - 1 && s.seg[i + 1] < f) i++;
    let t: number;
    if (s.type === 0) t = (f - s.seg[i]) / Math.max(1e-9, s.seg[i + 1] - s.seg[i]);
    else {
      const q = s.poly.subarray(i * 5, i * 5 + 5);
      const speed = (x: number) => Math.sqrt(Math.max(0, q[0] * x ** 4 + q[1] * x ** 3 + q[2] * x * x + q[3] * x + q[4]));
      const length = (a0: number, a1: number) => {
        const h = (a1 - a0) / 8;
        let sum = speed(a0) + speed(a1);
        for (let k = 1; k < 8; k++) sum += (k & 1 ? 4 : 2) * speed(a0 + k * h);
        return (sum * h) / 3;
      };
      let lo = 0, hi = 1, want = s.total * (f - s.seg[i]);
      t = 0.5;
      for (let it = 0; it < 40 && hi - lo >= 1e-5; it++) {
        t = (lo + hi) / 2;
        const got = length(lo, t);
        if (want < got + 1e-5) hi = t;
        else { lo = t; want -= got; }
      }
    }
    u = (t + i) / segs;
  }
  splinePoint(s, u, out);
}

export interface DObj {
  index: number; // preorder DObj index in the whole tree
  mobj: MObj | null;
  pobjs: PObj[];
}

export interface Image {
  offset: number;
  width: number;
  height: number;
  format: number;
  dataOff: number;
  /** its mip levels follow it in the file (HSD_ImageDesc.mipmap), down to maxLOD */
  mipmap?: boolean;
  minLOD?: number;
  maxLOD?: number;
}

export interface Tlut {
  offset: number;
  dataOff: number;
  format: number;
  count: number;
}

export interface TObj {
  id: number; // GXTexMapID: what a texture animation is matched by
  src: number;
  flags: number;
  rotate: [number, number, number];
  scale: [number, number, number];
  translate: [number, number, number];
  wrapS: number;
  wrapT: number;
  repeatS: number;
  repeatT: number;
  blending: number;
  /** GX_NEAR or GX_LINEAR */
  magFilt: number;
  /** HSD_TexLODDesc: the minification filter (GX_NEAR .. GX_LIN_MIP_LIN) and LOD bias, or null */
  lod: { minFilt: number; bias: number } | null;
  image: Image;
  tlut: Tlut | null;
  /** a TEV stage of its own ahead of the texture's blend: the texture mixed
   *  with constant colors (an effect's color, a shield's port color) */
  tev: TevDesc | null;
}

/** HSD_TObjTevDesc: inputs a..d per channel (GX_CC_* / GX_CA_*, or the
 *  TOBJ_TEV_* picks of konst, tev0, tev1), and which channels are on */
export interface TevDesc {
  colorOp: number; alphaOp: number;
  colorBias: number; alphaBias: number;
  colorScale: number; alphaScale: number;
  colorClamp: number; alphaClamp: number;
  colorIn: [number, number, number, number];
  alphaIn: [number, number, number, number];
  konst: [number, number, number, number];
  tev0: [number, number, number, number];
  tev1: [number, number, number, number];
  active: number;
}

export interface PEDesc {
  flags: number; // 0x10 z compare, 0x20 z update
  ref0: number;
  ref1: number;
  destAlpha: number;
  type: number; // 0 none, 1 blend, 2 logic, 3 subtract
  src: number;
  dst: number;
  logicOp: number;
  zComp: number;
  alphaComp0: number;
  alphaOp: number;
  alphaComp1: number;
}

export interface MObj {
  renderMode: number;
  tobjs: TObj[];
  ambient: [number, number, number, number];
  diffuse: [number, number, number, number];
  specular: [number, number, number, number];
  alpha: number;
  shininess: number;
  pe: PEDesc | null;
}

export interface VtxAttr {
  attr: number;
  type: number; // 1 direct, 2 index8, 3 index16
  cnt: number;
  compType: number;
  shift: number;
  stride: number;
  dataOff: number;
}

export interface PObj {
  flags: number;
  kind: "rigid" | "envelope" | "shape";
  attrs: VtxAttr[];
  dlOff: number;
  dlSize: number;
  envelopes: { joint: number; weight: number }[][];
  /** a rigid mesh's second joint (HSD's shared-vertex skin: a vertex whose
   *  matrix index is 1 hangs off this joint instead of its own), or null */
  skinJoint: number | null;
}

export function loadJoint(a: Archive, off: number): { root: JObj; all: JObj[]; dobjs: DObj[] } {
  const all: JObj[] = [];
  const dobjs: DObj[] = [];
  const seen = new Set<number>();
  const walk = (off: number, parent: number): JObj[] => {
    const out: JObj[] = [];
    for (let o: number | null = off; o !== null; o = ptr(a, o + 0x0c)) {
      if (seen.has(o)) throw new Error("joint tree loops back on itself");
      seen.add(o);
      const d = a.data;
      const flags = d.getUint32(o + 0x04);
      const j: JObj = {
        offset: o,
        index: all.length,
        parent,
        flags,
        rot: [d.getFloat32(o + 0x14), d.getFloat32(o + 0x18), d.getFloat32(o + 0x1c)],
        scale: [d.getFloat32(o + 0x20), d.getFloat32(o + 0x24), d.getFloat32(o + 0x28)],
        trans: [d.getFloat32(o + 0x2c), d.getFloat32(o + 0x30), d.getFloat32(o + 0x34)],
        invBind: null,
        children: [],
        dobjs: [],
      };
      all.push(j);
      const ib = ptr(a, o + 0x38);
      if (ib !== null) {
        const m = new Float32Array(16);
        // stored as a 3x4 row-major matrix
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 4; c++) m[c * 4 + r] = d.getFloat32(ib + (r * 4 + c) * 4);
        m[15] = 1;
        j.invBind = m;
      }
      const content = ptr(a, o + 0x10);
      if (content !== null && flags & JOBJ.SPLINE) j.spline = loadSpline(a, content);
      if (content !== null && !(flags & (JOBJ.SPLINE | JOBJ.PTCL))) {
        for (let dob: number | null = content; dob !== null; dob = ptr(a, dob + 0x04)) {
          const mo = ptr(a, dob + 0x08);
          const po = ptr(a, dob + 0x0c);
          const dobj: DObj = {
            index: dobjs.length,
            mobj: mo === null ? null : loadMObj(a, mo),
            pobjs: po === null ? [] : loadPObjs(a, po),
          };
          dobjs.push(dobj);
          j.dobjs.push(dobj);
        }
      }
      const child = ptr(a, o + 0x08);
      if (child !== null) j.children = walk(child, j.index);
      out.push(j);
    }
    return out;
  };
  const roots = walk(off, -1);
  return { root: roots[0], all, dobjs };
}

function loadImage(a: Archive, img: number): Image {
  const d = a.data;
  const has = img + 0x18 <= d.byteLength;
  return {
    offset: img,
    dataOff: d.getUint32(img + 0x00),
    width: d.getUint16(img + 0x04),
    height: d.getUint16(img + 0x06),
    format: d.getUint32(img + 0x08),
    mipmap: has && d.getUint32(img + 0x0c) !== 0,
    minLOD: has ? d.getFloat32(img + 0x10) : 0,
    maxLOD: has ? d.getFloat32(img + 0x14) : 0,
  };
}

function loadTlut(a: Archive, tl: number): Tlut {
  const d = a.data;
  return { offset: tl, dataOff: d.getUint32(tl), format: d.getUint32(tl + 4), count: d.getUint16(tl + 0x0c) };
}

function loadTev(a: Archive, o: number): TevDesc | null {
  const d = a.data;
  const active = d.getUint32(o + 0x1c);
  if (!(active & 0xc0000000)) return null;
  const b = (i: number) => d.getUint8(o + i);
  const c = (i: number): [number, number, number, number] => [b(i) / 255, b(i + 1) / 255, b(i + 2) / 255, b(i + 3) / 255];
  return {
    colorOp: b(0), alphaOp: b(1), colorBias: b(2), alphaBias: b(3), colorScale: b(4), alphaScale: b(5),
    colorClamp: b(6), alphaClamp: b(7),
    colorIn: [b(8), b(9), b(10), b(11)], alphaIn: [b(12), b(13), b(14), b(15)],
    konst: c(0x10), tev0: c(0x14), tev1: c(0x18), active,
  };
}

function loadMObj(a: Archive, o: number): MObj {
  const d = a.data;
  const tobjs: TObj[] = [];
  for (let t = ptr(a, o + 0x08); t !== null; t = ptr(a, t + 0x04)) {
    const img = ptr(a, t + 0x4c);
    if (img === null) continue;
    const tl = ptr(a, t + 0x50);
    const tv = ptr(a, t + 0x58);
    const lod = ptr(a, t + 0x54);
    tobjs.push({
      id: d.getUint32(t + 0x08),
      src: d.getUint32(t + 0x0c),
      rotate: [d.getFloat32(t + 0x10), d.getFloat32(t + 0x14), d.getFloat32(t + 0x18)],
      scale: [d.getFloat32(t + 0x1c), d.getFloat32(t + 0x20), d.getFloat32(t + 0x24)],
      translate: [d.getFloat32(t + 0x28), d.getFloat32(t + 0x2c), d.getFloat32(t + 0x30)],
      wrapS: d.getUint32(t + 0x34),
      wrapT: d.getUint32(t + 0x38),
      repeatS: d.getUint8(t + 0x3c),
      repeatT: d.getUint8(t + 0x3d),
      flags: d.getUint32(t + 0x40),
      blending: d.getFloat32(t + 0x44),
      magFilt: d.getUint32(t + 0x48) === 0 ? 0 : 1,
      lod: lod === null ? null : { minFilt: d.getUint32(lod) & 7, bias: d.getFloat32(lod + 4) },
      image: loadImage(a, img),
      tlut: tl === null ? null : loadTlut(a, tl),
      tev: tv === null ? null : loadTev(a, tv),
    });
  }
  const mat = ptr(a, o + 0x0c);
  const rgba = (at: number): [number, number, number, number] => [
    d.getUint8(at) / 255, d.getUint8(at + 1) / 255, d.getUint8(at + 2) / 255, d.getUint8(at + 3) / 255,
  ];
  const pe = ptr(a, o + 0x14);
  return {
    renderMode: d.getUint32(o + 0x04),
    tobjs,
    ambient: mat === null ? [0.5, 0.5, 0.5, 1] : rgba(mat),
    diffuse: mat === null ? [1, 1, 1, 1] : rgba(mat + 4),
    specular: mat === null ? [1, 1, 1, 1] : rgba(mat + 8),
    alpha: mat === null ? 1 : d.getFloat32(mat + 0x0c),
    shininess: mat === null ? 50 : d.getFloat32(mat + 0x10),
    pe: pe === null ? null : {
      flags: d.getUint8(pe), ref0: d.getUint8(pe + 1), ref1: d.getUint8(pe + 2), destAlpha: d.getUint8(pe + 3),
      type: d.getUint8(pe + 4), src: d.getUint8(pe + 5), dst: d.getUint8(pe + 6), logicOp: d.getUint8(pe + 7),
      zComp: d.getUint8(pe + 8), alphaComp0: d.getUint8(pe + 9), alphaOp: d.getUint8(pe + 10),
      alphaComp1: d.getUint8(pe + 11),
    },
  };
}

function loadPObjs(a: Archive, first: number): PObj[] {
  const d = a.data;
  const out: PObj[] = [];
  for (let o: number | null = first; o !== null; o = ptr(a, o + 0x04)) {
    const attrs: VtxAttr[] = [];
    const al = ptr(a, o + 0x08);
    if (al === null) continue;
    for (let p = al; ; p += 0x18) {
      const attr = d.getUint32(p);
      if (attr === 0xff) break;
      attrs.push({
        attr,
        type: d.getUint32(p + 0x04),
        cnt: d.getUint32(p + 0x08),
        compType: d.getUint32(p + 0x0c),
        shift: d.getUint8(p + 0x10),
        stride: d.getUint16(p + 0x12),
        dataOff: d.getUint32(p + 0x14),
      });
    }
    const flags = d.getUint16(o + 0x0c);
    const type = flags & 0x3000;
    const kind = type === 0x2000 ? "envelope" : type === 0x1000 ? "shape" : "rigid";
    const envelopes: { joint: number; weight: number }[][] = [];
    const contents = ptr(a, o + 0x14);
    if (kind === "envelope" && contents !== null) {
      for (let q = contents; ; q += 4) {
        const env = ptr(a, q);
        if (env === null) break;
        const list: { joint: number; weight: number }[] = [];
        for (let e = env; ; e += 8) {
          const j = ptr(a, e);
          if (j === null) break;
          list.push({ joint: j, weight: d.getFloat32(e + 4) });
        }
        envelopes.push(list);
      }
    }
    out.push({
      flags,
      kind,
      attrs,
      dlOff: d.getUint32(o + 0x10),
      dlSize: d.getUint16(o + 0x0e) * 32,
      envelopes,
      skinJoint: kind === "rigid" ? contents : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- display lists

export interface Mesh {
  // one entry per vertex
  pos: Float32Array; // 3
  nrm: Float32Array; // 3
  uv: Float32Array; // 2
  uv1: Float32Array; // 2, the second texture coordinate set (zeros when there is none)
  /** 2, the third texture coordinate set, when the mesh has one (Dream Land's birds) */
  uv2?: Float32Array;
  clr: Float32Array; // 4
  mtx: Float32Array; // envelope index (pnmtxidx / 3), as a float for the vertex shader
  hasNormals: boolean;
  hasColors: boolean;
  /** each vertex's binormal and tangent (3 each), when the mesh has them (an emboss bump map's) */
  bin?: Float32Array;
  tan?: Float32Array;
  indices: Uint16Array | Uint32Array; // triangles, or points when points: 
  /** a list of points only (GX_POINTS: Fountain of Dreams' stars), drawn a few pixels wide */
  points?: boolean;
}

const A_PNMTX = 0, A_POS = 9, A_NRM = 10, A_CLR0 = 11, A_TEX0 = 13, A_TEX1 = 14, A_TEX2 = 15, A_NBT = 25;

function readComp(d: DataView, at: number, compType: number, shift: number): [number, number] {
  const s = 1 / (1 << shift);
  switch (compType) {
    case 0: return [d.getUint8(at) * s, 1];
    case 1: return [d.getInt8(at) * s, 1];
    case 2: return [d.getUint16(at) * s, 2];
    case 3: return [d.getInt16(at) * s, 2];
    default: return [d.getFloat32(at), 4];
  }
}

function readColor(d: DataView, at: number, compType: number): [number, number, number, number, number] {
  switch (compType) {
    case 0: { const v = d.getUint16(at); return [((v >> 11) & 31) / 31, ((v >> 5) & 63) / 63, (v & 31) / 31, 1, 2]; }
    case 1: return [d.getUint8(at) / 255, d.getUint8(at + 1) / 255, d.getUint8(at + 2) / 255, 1, 3];
    case 2: return [d.getUint8(at) / 255, d.getUint8(at + 1) / 255, d.getUint8(at + 2) / 255, 1, 4];
    case 3: { const v = d.getUint16(at); return [((v >> 12) & 15) / 15, ((v >> 8) & 15) / 15, ((v >> 4) & 15) / 15, (v & 15) / 15, 2]; }
    case 4: {
      const v = (d.getUint8(at) << 16) | (d.getUint8(at + 1) << 8) | d.getUint8(at + 2);
      return [((v >> 18) & 63) / 63, ((v >> 12) & 63) / 63, ((v >> 6) & 63) / 63, (v & 63) / 63, 3];
    }
    default: return [d.getUint8(at) / 255, d.getUint8(at + 1) / 255, d.getUint8(at + 2) / 255, d.getUint8(at + 3) / 255, 4];
  }
}

/** Decode a PObj's display list into flat triangle data. */
export function decodePObj(a: Archive, p: PObj): Mesh {
  const d = a.data;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], uv1: number[] = [], clr: number[] = [], mtx: number[] = [];
  const uv2: number[] = [];
  const idx: number[] = [], pts: number[] = [];
  const has = (x: number) => p.attrs.some((t) => t.attr === x || (x === A_NRM && t.attr === A_NBT));
  const hasN = has(A_NRM), hasC = has(A_CLR0), hasT2 = has(A_TEX2);

  const readAttr = (t: VtxAttr, at: number, out: number[]) => {
    const attr = t.attr === A_NBT ? A_NRM : t.attr;
    if (attr === A_CLR0 || attr === 12) {
      const c = readColor(d, at, t.compType);
      out.push(c[0], c[1], c[2], c[3]);
      return c[4];
    }
    let n = 0, size = 0;
    if (attr === A_POS) n = t.cnt === 0 ? 2 : 3;
    else if (attr === A_NRM) n = t.attr === A_NBT ? 9 : 3; // NBT: normal, binormal, tangent
    else if (attr >= A_TEX0 && attr <= 20) n = t.cnt === 0 ? 1 : 2;
    // normals use a fixed fraction: s8 = 6 bits, s16 = 14 bits
    const shift = attr === A_NRM ? (t.compType === 1 ? 6 : t.compType === 3 ? 14 : 0) : t.shift;
    for (let i = 0; i < n; i++) {
      const [v, sz] = readComp(d, at + size, t.compType, shift);
      out.push(v);
      size += sz;
    }
    if (attr === A_POS && n === 2) out.push(0);
    if (attr >= A_TEX0 && n === 1) out.push(0);
    return size;
  };

  // the normal, binormal and tangent: the normal with the others, the rest apart
  const bin: number[] = [], tan: number[] = [];
  const hasNbt = p.attrs.some((t) => t.attr === A_NBT);
  const nbt: number[] = [];
  const readNbt = (t: VtxAttr, at: number) => {
    nbt.length = 0;
    const size = readAttr(t, at, nbt);
    nrm.push(nbt[0], nbt[1], nbt[2]);
    bin.push(nbt[3], nbt[4], nbt[5]);
    tan.push(nbt[6], nbt[7], nbt[8]);
    return size;
  };

  let o = p.dlOff;
  const end = Math.min(p.dlOff + p.dlSize, d.byteLength);
  while (o < end) {
    const op = d.getUint8(o);
    o += 1;
    if (op === 0) continue;
    const prim = op & 0xf8;
    if (prim < 0x80) break; // not a draw command: the list is over
    const count = d.getUint16(o);
    o += 2;
    const first = mtx.length;
    for (let v = 0; v < count; v++) {
      let m = 0;
      let gotPos = false, gotN = false, gotC = false, gotT = false, gotT1 = false, gotT2 = false;
      for (const t of p.attrs) {
        let at: number;
        if (t.type === 1) {
          // direct
          if (t.attr <= 8) {
            const val = d.getUint8(o);
            o += 1;
            if (t.attr === A_PNMTX) m = val / 3;
            continue;
          }
          at = o;
        } else {
          const i = t.type === 2 ? d.getUint8(o) : d.getUint16(o);
          o += t.type === 2 ? 1 : 2;
          at = t.dataOff + i * t.stride;
        }
        const attr = t.attr === A_NBT ? A_NRM : t.attr;
        const target = attr === A_POS ? pos : attr === A_NRM ? nrm : attr === A_CLR0 ? clr
          : attr === A_TEX0 ? uv : attr === A_TEX1 ? uv1 : attr === A_TEX2 ? uv2 : null;
        const size = t.attr === A_NBT ? readNbt(t, at) : readAttr(t, at, target ?? []);
        if (t.type === 1) o += size;
        if (attr === A_POS) gotPos = true;
        if (attr === A_NRM) gotN = true;
        if (attr === A_CLR0) gotC = true;
        if (attr === A_TEX0) gotT = true;
        if (attr === A_TEX1) gotT1 = true;
        if (attr === A_TEX2) gotT2 = true;
      }
      if (!gotPos) pos.push(0, 0, 0);
      if (!gotN) nrm.push(0, 0, 1);
      if (hasNbt && bin.length < nrm.length) { bin.push(0, 0, 0); tan.push(0, 0, 0); }
      if (!gotC) clr.push(1, 1, 1, 1);
      if (!gotT) uv.push(0, 0);
      if (!gotT1) uv1.push(0, 0);
      if (hasT2 && !gotT2) uv2.push(0, 0);
      mtx.push(m);
    }
    const n = count;
    if (prim === 0x90) for (let i = 0; i + 2 < n; i += 3) idx.push(first + i, first + i + 1, first + i + 2);
    else if (prim === 0x98)
      for (let i = 0; i + 2 < n; i++) {
        if (i & 1) idx.push(first + i + 1, first + i, first + i + 2);
        else idx.push(first + i, first + i + 1, first + i + 2);
      }
    else if (prim === 0xa0) for (let i = 1; i + 1 < n; i++) idx.push(first, first + i, first + i + 1);
    else if (prim === 0x80 || prim === 0x88)
      for (let i = 0; i + 3 < n; i += 4) idx.push(first + i, first + i + 1, first + i + 2, first + i, first + i + 2, first + i + 3);
    else if (prim === 0xb8) for (let i = 0; i < n; i++) pts.push(first + i);
    // lines are not drawn
  }
  // (a list of points alone is drawn as its points)
  const points = idx.length === 0 && pts.length > 0;
  if (points) for (const i of pts) idx.push(i);
  const vcount = mtx.length;
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    uv: new Float32Array(uv),
    uv1: new Float32Array(uv1),
    ...(hasT2 ? { uv2: new Float32Array(uv2) } : {}),
    clr: new Float32Array(clr),
    mtx: new Float32Array(mtx),
    hasNormals: hasN,
    hasColors: hasC,
    ...(hasNbt ? { bin: new Float32Array(bin), tan: new Float32Array(tan) } : {}),
    indices: vcount < 65536 ? new Uint16Array(idx) : new Uint32Array(idx),
    ...(points ? { points } : {}),
  };
}

// ---------------------------------------------------------------- textures

// (the 5, 6 and 3 bit channels spread over 0-255, as rgb565 and rgb5a3 below do: a lookup, not a sum a pixel)
const E5 = Uint8Array.from({ length: 32 }, (_, v) => v * 255 / 31 | 0);
const E6 = Uint8Array.from({ length: 64 }, (_, v) => v * 255 / 63 | 0);
const E3 = Uint8Array.from({ length: 8 }, (_, v) => v * 255 / 7 | 0);

/** Decode a GX texture to RGBA8. A color-indexed image needs its palette;
 * an index past the palette's end reads as transparent black. */
export function decodeImage(a: Archive, img: Image, tlut: Tlut | null): Uint8Array {
  const { width: w, height: h, format: f } = img;
  const d = a.data;
  const out = new Uint8Array(w * h * 4);
  // the palette, four bytes an entry
  const palN = tlut ? tlut.count : 0;
  const pal = new Uint8Array(palN * 4);
  if (tlut) {
    for (let i = 0; i < palN; i++) {
      const v = d.getUint16(tlut.dataOff + i * 2), at = i * 4;
      if (tlut.format === 0) { pal[at] = pal[at + 1] = pal[at + 2] = v & 0xff; pal[at + 3] = v >> 8; } // IA8
      else if (tlut.format === 1) { pal[at] = E5[(v >> 11) & 31]; pal[at + 1] = E6[(v >> 5) & 63]; pal[at + 2] = E5[v & 31]; pal[at + 3] = 255; }
      else rgb5a3Into(pal, at, v);
    }
  }
  const bw = [8, 8, 8, 4, 4, 4, 4, 0, 8, 8, 4, 0, 0, 0, 8][f];
  const bh = [8, 4, 4, 4, 4, 4, 4, 0, 8, 4, 4, 0, 0, 0, 8][f];
  if (!bw) throw new Error(`texture format ${f} is not a GX format`);
  let o = img.dataOff;
  const limit = d.byteLength;
  // (a pixel outside the picture - a size that is not a whole number of blocks - is read and left out)
  const cs = new Uint8Array(16);
  for (let by = 0; by < h; by += bh) {
    for (let bx = 0; bx < w; bx += bw) {
      if (o >= limit) return out;
      if (f === 14) {
        // CMPR: 2x2 DXT1 sub-blocks
        for (let s = 0; s < 4; s++) {
          const sx = bx + (s & 1) * 4, sy = by + (s >> 1) * 4;
          const c0 = d.getUint16(o), c1 = d.getUint16(o + 2);
          const r0 = E5[(c0 >> 11) & 31], g0 = E6[(c0 >> 5) & 63], b0 = E5[c0 & 31];
          const r1 = E5[(c1 >> 11) & 31], g1 = E6[(c1 >> 5) & 63], b1 = E5[c1 & 31];
          cs[0] = r0; cs[1] = g0; cs[2] = b0; cs[3] = 255;
          cs[4] = r1; cs[5] = g1; cs[6] = b1; cs[7] = 255;
          if (c0 > c1) {
            cs[8] = (2 * r0 + r1) / 3 | 0; cs[9] = (2 * g0 + g1) / 3 | 0; cs[10] = (2 * b0 + b1) / 3 | 0; cs[11] = 255;
            cs[12] = (r0 + 2 * r1) / 3 | 0; cs[13] = (g0 + 2 * g1) / 3 | 0; cs[14] = (b0 + 2 * b1) / 3 | 0; cs[15] = 255;
          } else {
            cs[8] = (r0 + r1) / 2 | 0; cs[9] = (g0 + g1) / 2 | 0; cs[10] = (b0 + b1) / 2 | 0; cs[11] = 255;
            cs[12] = cs[13] = cs[14] = cs[15] = 0;
          }
          for (let y = 0; y < 4; y++) {
            const row = d.getUint8(o + 4 + y);
            const Y = sy + y;
            for (let x = 0; x < 4; x++) {
              const X = sx + x;
              if (X >= w || Y >= h) continue;
              const c = ((row >> (6 - x * 2)) & 3) * 4, i = (Y * w + X) * 4;
              out[i] = cs[c]; out[i + 1] = cs[c + 1]; out[i + 2] = cs[c + 2]; out[i + 3] = cs[c + 3];
            }
          }
          o += 8;
        }
        continue;
      }
      if (f === 6) {
        // RGBA8: AR plane then GB plane
        for (let i = 0; i < 16; i++) {
          const X = bx + (i & 3), Y = by + (i >> 2);
          const r = d.getUint8(o + i * 2 + 1), g = d.getUint8(o + 32 + i * 2), b = d.getUint8(o + 32 + i * 2 + 1), al = d.getUint8(o + i * 2);
          if (X >= w || Y >= h) continue;
          const j = (Y * w + X) * 4;
          out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = al;
        }
        o += 64;
        continue;
      }
      for (let y = 0; y < bh; y++) {
        const Y = by + y;
        for (let x = 0; x < bw; x++) {
          const X = bx + x;
          let r = 0, g = 0, b = 0, al = 0;
          switch (f) {
            case 0: { // I4
              const c = d.getUint8(o + ((y * bw + x) >> 1));
              r = g = b = al = ((x & 1) ? c & 15 : c >> 4) * 17;
              break;
            }
            case 1: r = g = b = al = d.getUint8(o + y * bw + x); break;
            case 2: { // IA4
              const c = d.getUint8(o + y * bw + x);
              r = g = b = (c & 15) * 17; al = (c >> 4) * 17;
              break;
            }
            case 3: { // IA8
              const at = o + (y * bw + x) * 2;
              r = g = b = d.getUint8(at + 1); al = d.getUint8(at);
              break;
            }
            case 4: { const v = d.getUint16(o + (y * bw + x) * 2); r = E5[(v >> 11) & 31]; g = E6[(v >> 5) & 63]; b = E5[v & 31]; al = 255; break; }
            case 5: {
              const v = d.getUint16(o + (y * bw + x) * 2);
              if (v & 0x8000) { r = E5[(v >> 10) & 31]; g = E5[(v >> 5) & 31]; b = E5[v & 31]; al = 255; }
              else { r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17; al = E3[(v >> 12) & 7]; }
              break;
            }
            case 8: { // CI4
              const c = d.getUint8(o + ((y * bw + x) >> 1)), idx = (x & 1) ? c & 15 : c >> 4;
              if (idx < palN) { const at = idx * 4; r = pal[at]; g = pal[at + 1]; b = pal[at + 2]; al = pal[at + 3]; }
              break;
            }
            case 9: { // CI8
              const idx = d.getUint8(o + y * bw + x);
              if (idx < palN) { const at = idx * 4; r = pal[at]; g = pal[at + 1]; b = pal[at + 2]; al = pal[at + 3]; }
              break;
            }
            case 10: { // CI14
              const idx = d.getUint16(o + (y * bw + x) * 2) & 0x3fff;
              if (idx < palN) { const at = idx * 4; r = pal[at]; g = pal[at + 1]; b = pal[at + 2]; al = pal[at + 3]; }
              break;
            }
          }
          if (X >= w || Y >= h) continue;
          const i = (Y * w + X) * 4;
          out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = al;
        }
      }
      o += 32;
    }
  }
  return out;
}

/** an RGB5A3 color into four bytes of `out` at `at` */
function rgb5a3Into(out: Uint8Array, at: number, v: number) {
  if (v & 0x8000) { out[at] = E5[(v >> 10) & 31]; out[at + 1] = E5[(v >> 5) & 31]; out[at + 2] = E5[v & 31]; out[at + 3] = 255; }
  else { out[at] = ((v >> 8) & 15) * 17; out[at + 1] = ((v >> 4) & 15) * 17; out[at + 2] = (v & 15) * 17; out[at + 3] = E3[(v >> 12) & 7]; }
}

// ---------------------------------------------------------------- animation

export interface Key {
  time: number;
  duration: number;
  kind: 0 | 1 | 2; // constant, linear, spline
  p0: number;
  p1: number;
  d0: number;
  d1: number;
}

export interface Track {
  type: number; // joints: 1-3 rot xyz, 5-7 trans xyz, 8-10 scale xyz, 11 node, 12 branch
  keys: Key[];
}

/** HSD FObj keyframe stream (the data is little-endian). Adapted from
 * noclip.website's HSD_FObjLoadKeyframes (src/SYSDOLPHIN/SYSDOLPHIN.ts, MIT,
 * Copyright (c) 2018 Jasper St. Pierre; LICENSE-noclip.txt). */
export function decodeKeys(bytes: Uint8Array, fracValue: number, fracSlope: number, start = 0): Key[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const value = (frac: number) => {
    const fmt = frac >> 5, sh = 1 / (1 << (frac & 31));
    let r: number;
    switch (fmt) {
      case 0: r = v.getFloat32(i, true); i += 4; return r;
      case 1: r = v.getInt16(i, true); i += 2; return r * sh;
      case 2: r = v.getUint16(i, true); i += 2; return r * sh;
      case 3: r = v.getInt8(i); i += 1; return r * sh;
      default: r = v.getUint8(i); i += 1; return r * sh;
    }
  };
  const vlq = () => {
    let r = 0, s = 0, b = 0x80;
    while (b & 0x80 && i < bytes.byteLength) { b = v.getUint8(i++); r |= (b & 0x7f) << s; s += 7; }
    return r;
  };
  const keys: Key[] = [];
  let p0 = 0, p1 = 0, d0 = 0, d1 = 0, time = start, wait = 0, prevOp = 0, slp = false;
  while (i < bytes.byteLength) {
    const head = vlq();
    const op = head & 15;
    const n = (head >> 4) + 1;
    for (let k = 0; k < n && i < bytes.byteLength; k++) {
      if (op === 5) { d0 = d1; d1 = value(fracSlope); slp = true; continue; }
      if (op === 1 || op === 2) { p0 = p1; p1 = value(fracValue); if (!slp) { d0 = d1; d1 = 0; } }
      else if (op === 3) { p0 = p1; p1 = value(fracValue); d0 = d1; d1 = 0; }
      else if (op === 4) { p0 = p1; p1 = value(fracValue); d0 = d1; d1 = value(fracSlope); }
      else if (op === 6) { p0 = p1 = value(fracValue); }
      slp = false;
      if (prevOp === 1 || prevOp === 6) keys.push({ time, duration: wait, kind: 0, p0, p1: p0, d0: 0, d1: 0 });
      else if (prevOp === 2) keys.push({ time, duration: wait, kind: 1, p0, p1, d0: 0, d1: 0 });
      else if (prevOp === 3 || prevOp === 4) keys.push({ time, duration: wait, kind: 2, p0, p1, d0, d1 });
      time += wait;
      wait = vlq();
      prevOp = op;
    }
  }
  return keys;
}

/** A track's value at time t (null for an empty track). Binary search: a
 * fighter samples a few hundred of these a frame. */
export function sample(keys: Key[], t: number): number | null {
  const n = keys.length;
  if (n === 0) return null;
  let lo = 0, hi = n - 1;
  // (played forward, the key is the one of the frame before or the next:
  // looked for there first, the search only when it is neither)
  const was = (keys as KeysCursor)._at ?? 0;
  if (was < n && keys[was].time <= t && (was + 1 >= n || keys[was + 1].time > t)) lo = hi = was;
  else if (was + 1 < n && keys[was + 1].time <= t && (was + 2 >= n || keys[was + 2].time > t)) lo = hi = was + 1;
  else if (t < keys[0].time) hi = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  (keys as KeysCursor)._at = lo;
  const k = keys[lo];
  if (k.kind === 0) return k.p0;
  if (k.duration === 0) return k.p1;
  const dt = Math.min(Math.max(t - k.time, 0), k.duration);
  const u = dt / k.duration;
  if (k.kind === 1) return k.p0 + (k.p1 - k.p0) * u;
  // Hermite with per-frame slopes, as sysdolphin's splines are
  const u2 = u * u, u3 = u2 * u, D = k.duration;
  return k.p0 * (2 * u3 - 3 * u2 + 1) + k.p1 * (-2 * u3 + 3 * u2) + k.d0 * D * (u3 - 2 * u2 + u) + k.d1 * D * (u3 - u2);
}

/** a key list with the key last sampled (sample()) */
type KeysCursor = Key[] & { _at?: number };

export interface FigaTree {
  name: string;
  frames: number;
  tracks: Track[][]; // per joint, preorder
}

/** A fighter animation (figatree) archive. */
export function loadFigaTree(buf: ArrayBuffer, base: number): FigaTree {
  const a = parseArchive(buf, base);
  const [[name, root]] = [...a.publics];
  const d = a.data;
  const frames = d.getFloat32(root + 0x08);
  const counts = d.getUint32(root + 0x0c);
  const table = d.getUint32(root + 0x10);
  const tracks: Track[][] = [];
  let t = table;
  for (let j = 0; j < 512; j++) {
    const n = d.getUint8(counts + j);
    if (n === 0xff) break;
    const list: Track[] = [];
    for (let k = 0; k < n; k++, t += 0x0c) {
      const len = d.getUint16(t);
      const type = d.getUint8(t + 0x04);
      const fv = d.getUint8(t + 0x05), fs = d.getUint8(t + 0x06);
      const off = d.getUint32(t + 0x08);
      // (a track's own start frame, FigaTrack +2: its keys' clock is the animation's frame plus it - lbAnim_InitFrames
      // gives it to the track's HSD_FObj, HSD_FObjReqAnim adds it - so a track cut from a longer curve starts part
      // way along it: its first key that many frames before the animation's frame 0)
      const start = d.getInt16(t + 0x02);
      list.push({ type, keys: decodeKeys(a.u8.subarray(off, off + len), fv, fs, -start) });
    }
    tracks.push(list);
  }
  return { name, frames, tracks };
}

/** An AObj: its tracks, and how long it runs. */
export interface AObj {
  tracks: Track[];
  end: number;
  loop: boolean;
  /** the joint (by its offset) whose spline a PATH track follows, or null */
  obj: number | null;
}

function loadAObj(a: Archive, aobj: number): AObj {
  const d = a.data;
  const flags = d.getUint32(aobj);
  const tracks: Track[] = [];
  for (let f = ptr(a, aobj + 0x08); f !== null; f = ptr(a, f)) {
    const len = d.getUint32(f + 0x04);
    const start = d.getFloat32(f + 0x08);
    const type = d.getUint8(f + 0x0c);
    const fv = d.getUint8(f + 0x0d), fs = d.getUint8(f + 0x0e);
    const dat = d.getUint32(f + 0x10);
    // (an FObj's start frame is where its clock starts, HSD_FObjReqAnim: time = startframe + the request;
    // a positive one is that far into its keys at the animation's frame 0, a negative one waits)
    tracks.push({ type, keys: decodeKeys(a.u8.subarray(dat, dat + len), fv, fs, -start) });
  }
  return { tracks, end: d.getFloat32(aobj + 0x04), loop: (flags & (1 << 29)) !== 0, obj: ptr(a, aobj + 0x0c) };
}

/** an HSD AnimJoint tree (stages), flattened in preorder alongside the joints */
export function loadAnimJoint(a: Archive, off: number): (AObj | null)[] {
  const out: (AObj | null)[] = [];
  const walk = (o: number | null) => {
    for (; o !== null; o = ptr(a, o + 0x04)) {
      const aobj = ptr(a, o + 0x08);
      out.push(aobj === null ? null : loadAObj(a, aobj));
      walk(ptr(a, o + 0x00));
    }
  };
  walk(off);
  return out;
}

export interface TexAnim {
  id: number;
  aobj: AObj | null;
  images: Image[];
  tluts: Tlut[];
}

export interface MatAnim {
  aobj: AObj | null; // the material's colors and alpha (HSD_A_M_*)
  tex: TexAnim[]; // each matched to a TObj by id (HSD_A_T_*)
}

/** An HSD MatAnimJoint tree, flattened in preorder alongside the joints:
 * for each joint, one MatAnim per DObj, in the joint's DObj order. */
export function loadMatAnimJoint(a: Archive, off: number): (MatAnim | null)[][] {
  const d = a.data;
  const out: (MatAnim | null)[][] = [];
  const walk = (o: number | null) => {
    for (; o !== null; o = ptr(a, o + 0x04)) {
      const list: (MatAnim | null)[] = [];
      for (let m = ptr(a, o + 0x08); m !== null; m = ptr(a, m)) {
        const ao = ptr(a, m + 0x04);
        const tex: TexAnim[] = [];
        for (let t = ptr(a, m + 0x08); t !== null; t = ptr(a, t)) {
          const ta = ptr(a, t + 0x08);
          const imgs = ptr(a, t + 0x0c), tls = ptr(a, t + 0x10);
          const nImg = d.getUint16(t + 0x14), nTl = d.getUint16(t + 0x16);
          const images: Image[] = [], tluts: Tlut[] = [];
          for (let i = 0; i < nImg && imgs !== null; i++) {
            const p = ptr(a, imgs + i * 4);
            if (p !== null) images.push(loadImage(a, p));
          }
          for (let i = 0; i < nTl && tls !== null; i++) {
            const p = ptr(a, tls + i * 4);
            if (p !== null) tluts.push(loadTlut(a, p));
          }
          tex.push({ id: d.getUint32(t + 0x04), aobj: ta === null ? null : loadAObj(a, ta), images, tluts });
        }
        list.push({ aobj: ao === null ? null : loadAObj(a, ao), tex });
      }
      out.push(list);
      walk(ptr(a, o + 0x00));
    }
  };
  walk(off);
  return out;
}

/** A frame on an AObj's clock: looping ones (or all, with loop) wrap at
 * their end, the rest stop there. */
export function aobjFrame(ao: AObj, frame: number, loop = false): number {
  if (ao.end <= 0) return frame;
  if (ao.loop || loop) return ((frame % ao.end) + ao.end) % ao.end;
  return Math.min(frame, ao.end);
}

// ---------------------------------------------------------------- lights

/** a light's animation (HSD_LightAnim): its color and visibility tracks,
 *  and its position's and interest's (x, y, z, or a share of the way along a
 *  spline) */
export interface LightAnim {
  /** the HSD_LightAnim's offset (the stage says by it which ones loop) */
  offset: number;
  aobj: AObj | null;
  position: LightPlaceAnim | null;
  interest: LightPlaceAnim | null;
}

/** a light's position or interest animation: its AObj, the spline a PATH
 *  track walks, and the spline joint's matrix the point is taken through */
export interface LightPlaceAnim {
  aobj: AObj;
  spline: Spline | null;
  mtx: Float32Array | null;
}

export interface Light {
  /** its HSD_LightDesc's offset (a stage's light overrides name it by that) */
  desc: number;
  kind: "ambient" | "infinite" | "point" | "spot";
  /** LObj flags: 4 lights the diffuse channel, 8 the specular one, 0x10 the alpha, 0x20 hidden */
  flags: number;
  color: [number, number, number, number];
  position: [number, number, number] | null;
  interest: [number, number, number] | null;
  /** raw GX attenuation (a0, a1, a2, k0, k1, k2), when the file gives it so */
  raw: number[] | null;
  /** else a spot's cutoff and falloff, and the distance falloff: reference
   *  brightness, distance and function */
  spot: { cutoff: number; func: number } | null;
  dist: { refBright: number; refDist: number; func: number } | null;
  /** its first animation set, if it has one */
  anim: LightAnim | null;
}

const LIGHT_KINDS = ["ambient", "infinite", "point", "spot"] as const;

/** A light list: a null-terminated list of {LightDesc*, LightAnim**}, each
 *  read as HSD's LObjLoad does (an infinite light has a position only; a
 *  point light a distance falloff; a spot light both falloffs). */
export function loadLights(a: Archive, list: number): Light[] {
  const d = a.data;
  const out: Light[] = [];
  const wobj = (p: number | null): [number, number, number] | null =>
    p === null ? null : [d.getFloat32(p + 4), d.getFloat32(p + 8), d.getFloat32(p + 12)];
  const floats = (p: number, n: number) => Array.from({ length: n }, (_, i) => d.getFloat32(p + i * 4));
  // a WObj's animation (HSD_WObjAnim: its AObj first), with the spline its
  // path track follows (the AObj's object: a spline joint) and that joint's
  // matrix: HSD_WObjGetPosition takes the point on the curve through it
  // (HSD_JObjSetupMatrix, MTXMultVec), so the curve is in the joint's space
  const wanim = (p: number | null) => {
    const ao = p === null ? null : ptr(a, p);
    if (ao === null) return null;
    const aobj = loadAObj(a, ao);
    let spline: Spline | null = null, mtx: Float32Array | null = null;
    if (aobj.obj !== null) {
      try {
        const j = loadJoint(a, aobj.obj).root;
        spline = j.spline ?? null;
        mtx = srt(new Float32Array(16), ...j.scale, ...j.rot, ...j.trans);
      } catch { spline = null; }
    }
    return { aobj, spline, mtx };
  };
  for (let q = list; out.length < 16; q += 4) {
    const entry = ptr(a, q);
    if (entry === null) break;
    const desc = ptr(a, entry);
    if (desc === null) continue;
    const flags = d.getUint16(desc + 0x08), attnFlags = d.getUint16(desc + 0x0a);
    const kind = LIGHT_KINDS[flags & 3];
    const u = ptr(a, desc + 0x18);
    let raw: number[] | null = null, spot: Light["spot"] = null, dist: Light["dist"] = null;
    if (kind === "point" && u !== null) {
      if (attnFlags & 1) raw = [1, 0, 0, ...floats(u + 12, 3)];
      else dist = { refBright: d.getFloat32(u), refDist: d.getFloat32(u + 4), func: d.getUint32(u + 8) };
    } else if (kind === "spot" && u !== null) {
      if (attnFlags) raw = floats(u, 6);
      else {
        spot = { cutoff: d.getFloat32(u), func: d.getUint32(u + 4) };
        dist = { refBright: d.getFloat32(u + 8), refDist: d.getFloat32(u + 12), func: d.getUint32(u + 16) };
      }
    }
    // the game gives each light its first animation set
    let anim: LightAnim | null = null;
    const sets = ptr(a, entry + 4), first = sets === null ? null : ptr(a, sets);
    if (first !== null) {
      const ao = ptr(a, first + 4);
      anim = { offset: first, aobj: ao === null ? null : loadAObj(a, ao), position: wanim(ptr(a, first + 8)),
               interest: wanim(ptr(a, first + 12)) };
      if (!anim.aobj && !anim.position && !anim.interest) anim = null;
    }
    out.push({
      desc, kind, flags,
      color: [d.getUint8(desc + 0x0c) / 255, d.getUint8(desc + 0x0d) / 255, d.getUint8(desc + 0x0e) / 255,
              d.getUint8(desc + 0x0f) / 255],
      position: kind === "ambient" ? null : wobj(ptr(a, desc + 0x10)),
      interest: kind === "spot" ? wobj(ptr(a, desc + 0x14)) : null,
      raw, spot, dist, anim,
    });
  }
  return out;
}
