/* What a GPU started fresh mid-game (a stream started again: the simulator sends every register file and memory block again, as the
 * native recorder starts a recording mid-game) cannot have: what the game made on the GPU in the frames before. A frame drawn from there
 * is the game's picture only when it reads nothing of that, nor anything made from it. FreshWatch, on a GxGpu (its `watch`), follows it:
 * the frame buffer is the game's (efbOk) from a whole clear in this stream until a draw reads any of the below; a copy to memory is the
 * game's when the frame buffer was then; and each picture (a copy to the screen) is, or is not, the game's (`exact`, with `why` not):
 *
 *  - the frame buffer before it was cleared whole in this stream: a draw outside the rectangle the last clear covered with color, alpha
 *    and depth all written (BP 0x41 bits 3, 4 and BP 0x40 bit 4, as the copy's clear writes them), a copy that reads outside it;
 *  - a texture of memory the stream has not written: memory the simulator sends is written as it arrives; a copy to memory writes its
 *    bytes only when its frame was drawn and it read the cleared rectangle - memory nobody wrote since the start is a copy the game made
 *    before it (the screens of Pokemon Stadium), and a copy of a frame not drawn is not the game's;
 *  - a palette not loaded in this stream, or a texture preloaded into TMEM (no preload is followed here).
 *
 * The textures are the ones the enabled TEV stages and the indirect stages read (the TEV orders, BP 0x28.., IREF 0x27), each by its whole
 * size with its mip levels, as the GL backend's hazard check reads them. A player that starts a stream fewer frames before a picture than
 * it would to be safe (engine.ts) draws with a watch and goes back to the safe way when a picture it shows is not the game's.
 */
import { bits, type GxRegs } from "./state";
import { copyBytes, copyParams } from "./copy";
import { formatInfo, levelOffset } from "./texunit";
import { MEM_SIZE } from "./dff";

const SHIFT = 5; // 32-byte blocks: textures and copies are 32-byte aligned

export class FreshWatch {
  /** the last picture copied to the screen is the game's (false before any), and pictures copied so far, and why the last one is not */
  exact = false;
  pictures = 0;
  why = "";
  /** the frame buffer holds the game's (within the clean rectangle): from a whole clear until a draw reads what this stream did not make */
  private efbOk = false;
  private written = new Uint8Array(MEM_SIZE >> SHIFT);
  /** the rectangle the frame buffer was last cleared whole in (color, alpha, depth): [L, T, R, B), or null */
  private clean: [number, number, number, number] | null = null;
  private tluts = new Set<number>();

  private mark(addr: number, n: number, v: number): void {
    const a = (addr & 0x1ffffff) >> SHIFT, b = Math.min(this.written.length, ((addr & 0x1ffffff) + n + 31) >> SHIFT);
    if (b > a) this.written.fill(v, a, b);
  }
  private fail(why: string): void { this.efbOk = false; this.why = why; }
  private inClean(L: number, T: number, R: number, B: number): boolean {
    const c = this.clean;
    return !!c && L >= c[0] && T >= c[1] && R <= c[2] && B <= c[3];
  }

  /** memory the stream wrote (the simulator's blocks) */
  wrote(addr: number, n: number): void { this.mark(addr, n, 1); }

  /** a copy of the frame buffer (to the screen, or to memory) and its clear, as the GPU ran them; `drawn`: its frame was drawn. A copy
   *  and clear the GPU did not run (a frame played through without them, fast-forward): what they would have written is not had */
  skipped(bp: Uint32Array): void {
    const p = copyParams(bp);
    if (!p.toScreen) { const [dest, total] = copyBytes(p); if (total > 0) this.mark(dest, total, 0); }
    if (p.clear) { this.clean = null; this.efbOk = false; }
  }

  copied(bp: Uint32Array, drawn: boolean): void {
    const p = copyParams(bp);
    const L = p.x0, T = p.y0, R = p.x0 + p.wm + 1, B = p.y0 + p.hm + 1;
    const read = drawn && this.efbOk && this.inClean(L, T, R, B);
    if (p.toScreen) {
      if (drawn) {
        this.pictures++;
        this.exact = read;
        if (!read && this.efbOk) this.why = "the picture copied from outside the frame buffer cleared in this stream";
      }
    } else {
      const [dest, total] = copyBytes(p);
      if (total > 0) this.mark(dest, total, read ? 1 : 0);
    }
    if (p.clear) {
      const whole = ((bp[0x41] >> 3) & 1) === 1 && ((bp[0x41] >> 4) & 1) === 1 && bits(bp[0x40], 4, 1) === 1;
      if (whole) { this.clean = [L, T, R, B]; this.efbOk = true; }
      // (a clear of some channels only leaves the others as they were: clean only where it was clean)
    }
  }

  /** a palette loaded into TMEM at `tmem` (from memory the stream sent) */
  tlut(tmem: number): void { this.tluts.add(tmem); }

  /** a draw with the registers now: what it reads */
  draw(regs: GxRegs): void {
    if (!this.efbOk) return;
    const bp = regs.bp;
    // its pixels: the scissor box, inside the cleared rectangle
    const tl = bp[0x20], br = bp[0x21], off = bp[0x59];
    const ox = 2 * bits(off, 0, 10), oy = 2 * bits(off, 10, 10);
    const L = Math.max(0, bits(tl, 12, 12) - ox), T = Math.max(0, bits(tl, 0, 12) - oy);
    const R = Math.min(640, bits(br, 12, 12) - ox + 1), B = Math.min(528, bits(br, 0, 12) - oy + 1);
    if (R > L && B > T && !this.inClean(L, T, R, B)) { this.fail("a draw on a frame buffer not cleared in this stream"); return; }
    // its textures: the TEV stages' and the indirect stages'
    const maps = new Set<number>();
    const gm = bp[0x00], nStages = bits(gm, 10, 4) + 1, nInd = bits(gm, 16, 3);
    for (let si = 0; si < nStages; si++) {
      const ord = bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (bits(ord, 6, 1)) maps.add(bits(ord, 0, 3));
    }
    for (let i = 0; i < nInd; i++) maps.add(bits(bp[0x27], 6 * i, 3));
    for (const m of maps) {
      const hi = m >= 4, k = m & 3;
      const img0 = bp[(hi ? 0xa8 : 0x88) + k], img1 = bp[(hi ? 0xac : 0x8c) + k], img3 = bp[(hi ? 0xb4 : 0x94) + k];
      const fmt = bits(img0, 20, 4), W = bits(img0, 0, 10), H = bits(img0, 10, 10);
      if (bits(img1, 21, 1)) { this.fail(`texture map ${m} preloaded into TMEM`); return; }
      if (fmt === 8 || fmt === 9 || fmt === 10) {
        if (!this.tluts.has(bp[(hi ? 0xb8 : 0x98) + k] & 0x3ff)) { this.fail(`texture map ${m}'s palette not loaded in this stream`); return; }
      }
      // (its mip levels when it has them: the levels up to its largest LOD, TX_SETMODE1 bits 8-15 in 4.4)
      const maxLod = Math.ceil(bits(bp[(hi ? 0xa4 : 0x84) + k], 8, 8) / 16);
      let levels = 1, mw = W + 1, mh = H + 1;
      while ((mw > 1 || mh > 1) && levels <= maxLod) { mw >>= 1; mh >>= 1; levels++; }
      const fi = formatInfo(fmt);
      const size = levelOffset(fmt, W, H, levels - 1) + Math.max(mw, fi.bw) * Math.max(mh, fi.bh) * fi.nibbles / 2;
      const a = ((img3 & 0xffffff) * 32) & 0x1ffffff, b = Math.min(this.written.length, (a + size + 31) >> SHIFT);
      for (let i = a >> SHIFT; i < b; i++) {
        if (!this.written[i]) { this.fail(`texture map ${m} reads memory not written in this stream (${(i << SHIFT).toString(16)})`); return; }
      }
    }
  }
}
