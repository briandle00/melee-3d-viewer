/* GX renderer: the triangles of a pass binned into the pixel shader's tiles (glsl-pixel.ts TILE x TILE pixels), for gl.ts.
 *
 * Every triangle goes into the tiles its blocks can reach and where its three edge tests can pass for some pixel. The edge test of a pixel is
 * C + DX * 16y - DY * 16x > 0 (32-bit); its largest value over a tile is at one corner, so a tile where that corner fails an edge holds no
 * covered pixel. Triangles with edge numbers too big for plain arithmetic to match the wrapping 32-bit arithmetic of the shader are binned by
 * their bounds only. An entry names the tile and the triangle (its texel offset in the queue) with a mask of the tile's 8 x 8 quarters it can reach.
 *
 * The front half's worker threads bin the triangles of their own draws as they make them (frontpool.ts); a pass then only counts and places
 * the entries in draw order. The entries are the same as binning the whole queue at once: a triangle's entries depend on its words alone.
 */
import { HEADER_TEXELS } from "./front";

export const TILE_SHIFT = 4;
export const TILE = 1 << TILE_SHIFT;
export const EFB_W = 640, EFB_H = 528;
export const TILES_X = EFB_W / TILE, TILES_Y = EFB_H / TILE;

/** entries as pairs of words: the tile, then the triangle's texel offset | quarter mask << 24 */
export class Entries {
  a = new Int32Array(1 << 15);
  n = 0;
  ensure(extra: number): void {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length;
    while (cap < this.n + extra) cap *= 2;
    const b = new Int32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

/**
 * Bin the triangles in words [0, n) of a queue (a header and its planes each). Entries are appended to `out` with the triangle's texel offset
 * plus `base` (the texel the words will start at in the pass's queue). Returns the number of triangles.
 */
export function binTriangles(I: Int32Array, U: Uint32Array, n: number, base: number, out: Entries): number {
  let tris = 0;
  for (let o = 0; o < n; o += (HEADER_TEXELS + U[o + 18]) * 4) {
    tris++;
    const minx = I[o], maxx = I[o + 1], miny = I[o + 2], maxy = I[o + 3];
    const tx0 = Math.max(0, minx) >> TILE_SHIFT, ty0 = Math.max(0, miny) >> TILE_SHIFT, tx1 = Math.min(EFB_W - 1, maxx) >> TILE_SHIFT, ty1 = Math.min(EFB_H - 1, maxy) >> TILE_SHIFT;
    const dx12 = I[o + 4], dy12 = I[o + 5], dx23 = I[o + 6], dy23 = I[o + 7], dx31 = I[o + 8], dy31 = I[o + 9], c1 = I[o + 10], c2 = I[o + 11], c3 = I[o + 12];
    const safe = Math.abs(dx12) < 16384 && Math.abs(dy12) < 16384 && Math.abs(dx23) < 16384 && Math.abs(dy23) < 16384 && Math.abs(dx31) < 16384 &&
      Math.abs(dy31) < 16384 && Math.abs(c1) < 1073741824 && Math.abs(c2) < 1073741824 && Math.abs(c3) < 1073741824;
    if (tx1 < tx0 || ty1 < ty0) continue;
    out.ensure(2 * (tx1 - tx0 + 1) * (ty1 - ty0 + 1));
    const A = out.a;
    let ne = out.n;
    const tri = (o >> 2) + base;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        // which 8 x 8 quarters of the tile the triangle can reach: inside its bounds, and where each edge test passes at the quarter's best corner
        let mask = 0;
        for (let sy = 0; sy < 2; sy++) {
          const y0 = (ty << TILE_SHIFT) + (sy << 3), y1 = y0 + 7;
          if (y1 < miny || y0 > maxy) continue;
          for (let sx = 0; sx < 2; sx++) {
            const x0 = (tx << TILE_SHIFT) + (sx << 3), x1 = x0 + 7;
            if (x1 < minx || x0 > maxx) continue;
            if (safe) {
              if (c1 + 16 * (dx12 > 0 ? dx12 * y1 : dx12 * y0) - 16 * (dy12 > 0 ? dy12 * x0 : dy12 * x1) <= 0) continue;
              if (c2 + 16 * (dx23 > 0 ? dx23 * y1 : dx23 * y0) - 16 * (dy23 > 0 ? dy23 * x0 : dy23 * x1) <= 0) continue;
              if (c3 + 16 * (dx31 > 0 ? dx31 * y1 : dx31 * y0) - 16 * (dy31 > 0 ? dy31 * x0 : dy31 * x1) <= 0) continue;
            }
            mask |= 1 << (sy * 2 + sx);
          }
        }
        if (mask === 0) continue;
        A[ne++] = ty * TILES_X + tx;
        A[ne++] = tri | (mask << 24);
      }
    }
    out.n = ne;
  }
  return tris;
}
