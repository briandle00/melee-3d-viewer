/* GX renderer: the graphics processor's registers, and what writing them means.
 *
 * Three register files, as the game sees them through the write-gather pipe:
 *  - BP, the 256 raster registers of 24 bits each (a command 0x61 carries the address in its top byte): texture
 *    units, TEV stages, the pixel engine, the EFB copy;
 *  - CP, the command processor's: which vertex attributes are sent and in what format (VCD, VAT), where the
 *    attribute arrays are in memory;
 *  - XF, the transform unit's: 4096 words of matrices and lights, then 96 registers from 0x1000 (channels,
 *    texgens, the viewport, the projection).
 * Layouts are the GX SDK's (the decompilation's src/dolphin/gx: GXInit, GXTev, GXTexture, GXTransform ...).
 */

export const XF_SIZE = 0x1060;

export const f32 = (() => {
  const dv = new DataView(new ArrayBuffer(4));
  return (w: number): number => { dv.setUint32(0, w >>> 0); return dv.getFloat32(0); };
})();

/** a field of a register word (unsigned, at most 31 bits wide) */
export const bits = (v: number, start: number, width: number): number => (v >>> start) & ((1 << width) - 1);
export const ubits = bits;

/** what a BP write did beyond setting the register */
export type BpEvent =
  | { kind: "copy"; value: number }
  | { kind: "tlut"; tmem: number; addr: number; count: number }
  | { kind: "preload"; src: number; tmem: number; bytes: number }
  | { kind: "none" };

export class GxRegs {
  bp = new Uint32Array(256);
  cp = new Uint32Array(256);
  xf = new Uint32Array(XF_SIZE);
  bpMask = 0xffffff;
  /** the TEV's color registers (kind 0) and constant colors (kind 1), BP 0xE0 + 2r (red, alpha) and 0xE1 + 2r (blue, green) */
  tevBank: [Uint32Array, Uint32Array] = [new Uint32Array(8), new Uint32Array(8)];
  /** TMEM palettes: the offset the game loaded it to (BP 0x65's low 10 bits) -> its bytes, copied as they were loaded */
  tluts = new Map<number, Uint8Array>();
  /** texture memory (1 MiB): what GXPreLoadEntireTexture put there, and the recording's own at its start */
  tmem = new Uint8Array(1 << 20);
  tmemVersion = 0;

  /** a counter bumped by every XF memory or register write, for caches of derived uniforms */
  xfVersion = 0;
  /** a counter bumped by every BP write (caches of derived state) */
  bpVersion = 0;
  /** a counter bumped by every BP write that changed a register's value or a TEV bank's, and by every palette load (the BP-side
   *  state a draw reads is the same while it holds) */
  bpContent = 0;
  /** the XF ranges loaded (address, count), kept when a reader asks for them by setting this (frontpool.ts); past 64 Ki numbers they are
   *  dropped and xfLogLost set (the reader takes the whole unit again) */
  xfLog: number[] | null = null;
  xfLogLost = false;

  constructor(bp?: ArrayLike<number>, cp?: ArrayLike<number>, xfMem?: ArrayLike<number>, xfRegs?: ArrayLike<number>) {
    if (bp) for (let i = 0; i < 256 && i < bp.length; i++) this.bp[i] = bp[i] & 0xffffff;
    if (cp) for (let i = 0; i < 256 && i < cp.length; i++) this.cp[i] = cp[i] >>> 0;
    if (xfMem) for (let i = 0; i < 0x1000 && i < xfMem.length; i++) this.xf[i] = xfMem[i] >>> 0;
    if (xfRegs) for (let i = 0; i < 0x60 && i < xfRegs.length; i++) this.xf[0x1000 + i] = xfRegs[i] >>> 0;
    for (let r = 0; r < 4; r++) {
      const ra = this.bp[0xe0 + 2 * r], bg = this.bp[0xe1 + 2 * r];
      if (((ra >>> 23) & 1) === ((bg >>> 23) & 1)) {
        const k = (ra >>> 23) & 1;
        this.tevBank[k][2 * r] = ra; this.tevBank[k][2 * r + 1] = bg;
      }
    }
  }

  /** a BP command word (address in the top byte) */
  loadBp(word: number): BpEvent {
    const addr = word >>> 24, val = word & 0xffffff;
    this.bpVersion++;
    if (addr === 0xfe) { this.bpMask = val; return { kind: "none" }; }
    const mask = this.bpMask;
    this.bpMask = 0xffffff;
    if (addr >= 0xe0 && addr <= 0xe7) {
      // TEV color / constant color: the register's kind (bit 23) says which bank, and each bank keeps its own
      const kind = (val >>> 23) & 1;
      const bank = this.tevBank[kind];
      const ob = bank[addr - 0xe0], op = this.bp[addr];
      bank[addr - 0xe0] = ((bank[addr - 0xe0] & ~mask) | (val & mask)) & 0xffffff;
      this.bp[addr] = (this.bp[addr] & ~mask | val & mask) & 0xffffff;
      if (bank[addr - 0xe0] !== ob || this.bp[addr] !== op) this.bpContent++;
      return { kind: "none" };
    }
    const nv = ((this.bp[addr] & ~mask) | (val & mask)) & 0xffffff;
    if (nv !== this.bp[addr] || addr === 0x65) this.bpContent++;
    this.bp[addr] = nv;
    if (addr === 0x65) {
      // LOADTLUT1: a palette from memory (BP 0x64: its address / 32) into TMEM
      return { kind: "tlut", tmem: nv & 0x3ff, addr: (this.bp[0x64] & 0xffffff) << 5, count: ubits(nv, 10, 11) * 32 };
    }
    if (addr === 0x52) return { kind: "copy", value: nv };
    if (addr === 0x60 && (nv & 0x7fff) !== 0) {
      // the preload (GXPreLoadEntireTexture): BP 0x61 the memory address / 32, 0x62 and 0x63 the even and odd TMEM places / 32, this
      // register the size in 32-byte units (bit 15 picks the odd bank's place); the 32-byte unit is TMEM's line
      const odd = (nv >> 15) & 1;
      return { kind: "preload", src: (this.bp[0x61] & 0xffffff) << 5, tmem: (this.bp[odd ? 0x63 : 0x62] & 0x7fff) << 5, bytes: (nv & 0x7fff) * 32 };
    }
    return { kind: "none" };
  }

  loadCp(addr: number, val: number): void { this.cp[addr & 0xff] = val >>> 0; }

  loadXf(addr: number, values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) {
      const a = addr + i;
      if (a < XF_SIZE) this.xf[a] = values[i] >>> 0;
    }
    this.xfVersion++;
    const l = this.xfLog;
    if (l) {
      if (l.length >= 65536) { l.length = 0; this.xfLogLost = true; }
      l.push(addr, values.length);
    }
  }
}
