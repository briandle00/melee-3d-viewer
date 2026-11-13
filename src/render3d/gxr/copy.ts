/* GX renderer: EFB copies (spec section 12): the frame buffer encoded into a texture in main memory, and the clear after a copy.
 * The CPU reference; the shader encodes the same bytes. */
import { Efb, EFB_H, EFB_W, readColor } from "./raster";
import { bits } from "./state";

export interface CopyParams {
  x0: number; y0: number; wm: number; hm: number;
  dest: number; stride: number;
  tp: number; half: boolean; clear: boolean; toScreen: boolean; intensity: boolean;
  pixFmt: number;
}

export function copyParams(bp: Uint32Array): CopyParams {
  const c = bp[0x52];
  return {
    x0: bits(bp[0x49], 0, 10), y0: bits(bp[0x49], 10, 10), wm: bits(bp[0x4a], 0, 10), hm: bits(bp[0x4a], 10, 10),
    dest: bp[0x4b] * 32, stride: bp[0x4d] * 32,
    tp: bits(c, 3, 4), half: bits(c, 9, 1) === 1, clear: bits(c, 11, 1) === 1, toScreen: bits(c, 14, 1) === 1, intensity: bits(c, 15, 1) === 1,
    pixFmt: bits(bp[0x43], 0, 3),
  };
}

/** names of the encodings */
export type CopyFormat = "Z16" | "Z16L" | "I4" | "I8" | "IA4" | "IA8" | "RGB565" | "RGB5A3" | "RGBA8" | "R4" | "RA4" | "RA8" | "A8" | "R8" | "G8" | "B8" | "RG8" | "GB8" | "none";

export function copyFormat(tp: number, intensity: boolean): CopyFormat {
  const cf = (tp >> 1) + ((tp & 1) * 8);
  if (cf > 6 || (cf < 4 && !intensity)) {
    switch (cf) {
      case 0: return "R4"; case 2: return "RA4"; case 3: return "RA8"; case 7: return "A8";
      case 8: return "R8"; case 9: return "G8"; case 10: return "B8"; case 11: return "RG8"; case 12: return "GB8";
      default: return "none";
    }
  }
  switch (cf) {
    case 0: return "I4"; case 1: return "I8"; case 2: return "IA4"; case 3: return "IA8";
    case 4: return "RGB565"; case 5: return "RGB5A3"; default: return "RGBA8";
  }
}

/** the encoding of a copy: with the depth pixel format (3) the codes are the Z formats (12.4), whose texels are the depth's bytes (z2, z1, z0) in
 *  the place of (r, g, b) with alpha 255. Z4, Z8, Z8M, Z8L and Z24X8 use the layouts of R4, R8, G8, B8 and RGBA8 (Z24X8's half-size order swaps its
 *  last bytes: see the encoder), Z16 and Z16L write two bytes in the order the spec gives for the size. No intensity bit matters. */
export function copyFormatFor(p: { tp: number; intensity: boolean; pixFmt: number }): CopyFormat {
  if (p.pixFmt !== 3) return copyFormat(p.tp, p.intensity);
  const cf = (p.tp >> 1) + ((p.tp & 1) * 8);
  switch (cf) {
    case 0: return "R4";
    case 1: return "R8";
    case 3: case 11: return "Z16";
    case 6: return "RGBA8";
    case 9: return "G8";
    case 10: return "B8";
    case 12: return "Z16L";
    default: return "none";
  }
}

const BLOCK: Record<string, [number, number, number]> = {
  Z16: [2, 2, 32], Z16L: [2, 2, 32],
  I4: [3, 3, 32], I8: [3, 2, 32], IA4: [3, 2, 32], IA8: [2, 2, 32], RGB565: [2, 2, 32], RGB5A3: [2, 2, 32], RGBA8: [2, 2, 64],
  R4: [3, 3, 32], RA4: [3, 2, 32], RA8: [2, 2, 32], A8: [3, 2, 32], R8: [3, 2, 32], G8: [3, 2, 32], B8: [3, 2, 32], RG8: [2, 2, 32], GB8: [2, 2, 32],
};

/** the memory a copy to memory writes: [its first byte, how many] ([dest, 0] for an encoding it does not have) */
export function copyBytes(p: CopyParams): [number, number] {
  const fmt = copyFormatFor(p);
  if (fmt === "none") return [p.dest, 0];
  const [kw, kh, bsize] = BLOCK[fmt];
  const wm = p.wm >> (p.half ? 1 : 0), hm = p.hm >> (p.half ? 1 : 0);
  const bx = (wm >> kw) + 1, by = (hm >> kh) + 1;
  return [p.dest, (by - 1) * p.stride + bx * bsize];
}

/** the pixel at linear EFB index p as r, g, b, a (half size: the average of the 2 x 2 box at p) */
function texelAt(efb: Efb, p: number, half: boolean, fmt: number, out: number[]): void {
  const get = (i: number, o: number[]): void => {
    if (i < 0 || i >= EFB_W * EFB_H) { o[0] = o[1] = o[2] = 0; o[3] = 0; return; }
    if (fmt === 3) { const z = efb.depth[i]; o[0] = (z >> 16) & 255; o[1] = (z >> 8) & 255; o[2] = z & 255; o[3] = 255; return; }
    readColor(efb.color[i], fmt, o);
  };
  if (!half) { get(p, out); return; }
  const a = [0, 0, 0, 0], s = [0, 0, 0, 0];
  for (const d of [0, 1, EFB_W, EFB_W + 1]) { get(p + d, a); for (let k = 0; k < 4; k++) s[k] += a[k]; }
  for (let k = 0; k < 4; k++) out[k] = fmt === 1 ? Math.min(255, s[k] + (s[k] >> 6)) : s[k] >> 2;
}

/** encode the copy into `mem` (main memory bytes); returns [start, length] ranges written */
export function encodeCopy(efb: Efb, p: CopyParams, mem: Uint8Array): void {
  const fmt = copyFormatFor(p);
  if (fmt === "none") return;
  const [kw, kh, bsize] = BLOCK[fmt];
  const k = p.half ? 2 : 1;
  const wm = p.wm >> (p.half ? 1 : 0), hm = p.hm >> (p.half ? 1 : 0);
  const bx = (wm >> kw) + 1, by = (hm >> kh) + 1;
  const bw = 1 << kw, bh = 1 << kh;
  const px = [0, 0, 0, 0];
  const Y = (): number => (4096 + 66 * px[0] + 129 * px[1] + 25 * px[2]) >> 8;
  let rowBase = p.dest;
  const at = (a: number): number => a & 0x1ffffff;
  const put = (off: number, v: number): void => { mem[at(off)] = v & 255; };
  for (let brow = 0; brow < by; brow++) {
    for (let bcol = 0; bcol < bx; bcol++) {
      const base = rowBase + bcol * bsize;
      let o = 0;
      const tex = (i: number, j: number): void => {
        const X = bcol * bw + i, Yy = brow * bh + j;
        texelAt(efb, (p.y0 + Yy * k) * EFB_W + p.x0 + X * k, p.half, p.pixFmt, px);
      };
      if (fmt === "RGBA8") {
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
          tex(i, j);
          const q = (j * 4 + i) * 2;
          const zh = p.pixFmt === 3 && p.half;
          put(base + q, px[3]); put(base + q + 1, zh ? px[2] : px[0]); put(base + 32 + q, px[1]); put(base + 32 + q + 1, zh ? px[0] : px[2]);
        }
        continue;
      }
      for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
          tex(i, j);
          switch (fmt) {
            case "I4": case "R4": {
              const v = fmt === "I4" ? Y() : px[0];
              if (i & 1) { const old = mem[at(base + o)]; put(base + o, (old & 0xf0) | (v >> 4)); o++; }
              else put(base + o, v & 0xf0);
              break;
            }
            case "I8": put(base + o++, Y()); break;
            case "IA4": put(base + o++, 0xf0 | (Y() >> 4)); break;
            case "IA8": put(base + o++, 255); put(base + o++, Y()); break;
            case "RGB565": {
              const v = ((px[0] << 8) & 0xf800) | ((px[1] << 3) & 0x07e0) | ((px[2] >> 3) & 0x001e);
              put(base + o++, v >> 8); put(base + o++, v); break;
            }
            case "RGB5A3": {
              const v = 0x8000 | ((px[0] << 7) & 0x7c00) | ((px[1] << 2) & 0x03e0) | ((px[2] >> 3) & 0x001e);
              put(base + o++, v >> 8); put(base + o++, v); break;
            }
            case "Z16": put(base + o++, p.half ? px[0] : px[1]); put(base + o++, p.half ? px[1] : px[0]); break;
            case "Z16L": put(base + o++, p.half ? px[1] : px[2]); put(base + o++, p.half ? px[2] : px[1]); break;
            case "RA4": put(base + o++, 0xf0 | (px[0] >> 4)); break;
            case "RA8": put(base + o++, 255); put(base + o++, px[0]); break;
            case "A8": put(base + o++, 255); break;
            case "R8": put(base + o++, px[0]); break;
            case "G8": put(base + o++, px[1]); break;
            case "B8": put(base + o++, px[2]); break;
            case "RG8": put(base + o++, px[1]); put(base + o++, px[0]); break;
            case "GB8": put(base + o++, px[2]); put(base + o++, px[1]); break;
          }
        }
      }
    }
    rowBase += p.stride;
  }
}

/** the clear after a copy (12.5) */
export function clearRect(efb: Efb, bp: Uint32Array, p: CopyParams): void {
  const mode = bp[0x41];
  const colorUpd = (mode >> 3) & 1, alphaUpd = (mode >> 4) & 1;
  const r = bp[0x4f] & 255, a = (bp[0x4f] >> 8) & 255, b = bp[0x50] & 255, g = (bp[0x50] >> 8) & 255;
  const zUpd = bits(bp[0x40], 4, 1) === 1;
  for (let y = p.y0; y <= p.y0 + p.hm && y < EFB_H; y++) {
    for (let x = p.x0; x <= p.x0 + p.wm && x < EFB_W; x++) {
      const i = y * EFB_W + x;
      if (colorUpd) {
        if (p.pixFmt === 1) {
          const old = efb.color[i];
          efb.color[i] = (alphaUpd ? a >> 2 : old & 63) | ((b >> 2) << 6) | ((g >> 2) << 12) | ((r >> 2) << 18);
        } else efb.color[i] = b | (g << 8) | (r << 16);
      } else if (alphaUpd && p.pixFmt === 1) efb.color[i] = (efb.color[i] & ~63) | (a >> 2);
      if (zUpd) efb.depth[i] = bp[0x51] & 0xffffff;
    }
  }
}
