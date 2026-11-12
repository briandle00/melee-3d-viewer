/* Checkpoints made once and kept (on a disk, in the browser's storage: the host's choice), so a match far in a game opens near where it is
 * sought instead of playing the game from its first row.
 *
 * A stored set is made by playing the whole tape in an instance of the module with nothing drawn (makeStored: a worker, or a page nobody
 * looks at): every `every` rows a whole checkpoint (the pages that differ from the state after the first row, checkpoints.ts), and every
 * `dense` rows the list of those pages only (a few hundred bytes). The manifest holds the lists and the first row's page hashes.
 *
 * A player of the same module, the same game files and the same tape (the host keys a set by all three, and by the options the match was
 * opened with: playback, HUD layout, sound) opens the match, takes the manifest's hashes as its baseline (no pass over the memory: the state
 * after the first row is the same bytes in every instance), writes a stored checkpoint's pages in and steps on from there; and as it passes
 * a row with a list it keeps a checkpoint of exactly those pages (checkpoints.ts keepPages: a copy of a few MiB, no pass), so going back to
 * anything it has passed is a rewind to one at most `dense` rows before.
 *
 * Encoding (both deflate-raw, CompressionStream): a checkpoint is "GXCK", version, row, n, n page numbers, n pages of PAGE bytes; a
 * manifest is "GXCM", version, the id's length and bytes (UTF-8), rows, every, dense, the baseline's page count and hashes, the stored
 * rows' count and rows, the lists' count and each list's row, length and pages - little-endian 32-bit words.
 */
import { GxCore } from "./core";
import { nativeRow } from "./tapebridge";
import { PAGE, pageHashes, pageHashes2, type Checkpoint, type CheckpointMemory } from "./checkpoints";

export const STORED_VERSION = 1;
const CK = 0x4b435847, CM = 0x4d435847;

export interface StoredManifest {
  /** what the set was made for (the host's key: module, game files, tape, options); a set read back for another id is not used */
  id: string;
  /** the tape's rows */
  rows: number;
  /** rows between whole checkpoints, and between page lists */
  every: number;
  dense: number;
  /** the state after the first row: its page hashes (checkpoints.ts pageHashes) */
  base: Uint32Array;
  /** the rows with a whole checkpoint */
  stored: number[];
  /** each listed row's pages that differ from the first row's state */
  lists: Map<number, Uint32Array>;
}

async function squeeze(bytes: Uint8Array, way: "compress" | "decompress"): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(way === "compress" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** a checkpoint as stored */
export async function encodeCheckpoint(c: Checkpoint): Promise<Uint8Array> {
  const pages = [...c.pages.keys()].sort((a, b) => a - b), head = 4 + pages.length;
  const out = new Uint8Array(head * 4 + pages.length * PAGE), w = new DataView(out.buffer);
  w.setUint32(0, CK, true); w.setUint32(4, STORED_VERSION, true); w.setUint32(8, c.row, true); w.setUint32(12, pages.length, true);
  pages.forEach((p, i) => {
    w.setUint32(16 + 4 * i, p, true);
    const b = c.pages.get(p)!;
    if (b.length !== PAGE) throw new Error(`page ${p} is ${b.length} bytes, not ${PAGE}`);
    out.set(b, head * 4 + i * PAGE);
  });
  return squeeze(out, "compress");
}

/** a stored checkpoint read back (throws on anything that is not one of this version) */
export async function decodeCheckpoint(bytes: Uint8Array): Promise<Checkpoint> {
  const raw = await squeeze(bytes, "decompress"), r = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 16 || r.getUint32(0, true) !== CK || r.getUint32(4, true) !== STORED_VERSION) throw new Error("not a stored checkpoint of this version");
  const row = r.getUint32(8, true), n = r.getUint32(12, true), head = 4 + n;
  if (raw.length !== head * 4 + n * PAGE) throw new Error("a stored checkpoint of the wrong size");
  const pages = new Map<number, Uint8Array>();
  for (let i = 0; i < n; i++) pages.set(r.getUint32(16 + 4 * i, true), raw.subarray(head * 4 + i * PAGE, head * 4 + (i + 1) * PAGE));
  return { row, pages };
}

export async function encodeManifest(m: StoredManifest): Promise<Uint8Array> {
  const id = new TextEncoder().encode(m.id), words: number[] = [CM, STORED_VERSION, id.length];
  const idWords = Math.ceil(id.length / 4);
  const tail: number[] = [m.rows, m.every, m.dense, m.base.length, ...m.base, m.stored.length, ...m.stored, m.lists.size];
  for (const [row, pages] of [...m.lists].sort((a, b) => a[0] - b[0])) tail.push(row, pages.length, ...pages);
  const out = new Uint8Array((words.length + idWords + tail.length) * 4), w = new DataView(out.buffer);
  words.forEach((v, i) => w.setUint32(4 * i, v, true));
  out.set(id, 4 * words.length);
  const at = 4 * (words.length + idWords);
  tail.forEach((v, i) => w.setUint32(at + 4 * i, v >>> 0, true));
  return squeeze(out, "compress");
}

export async function decodeManifest(bytes: Uint8Array): Promise<StoredManifest> {
  const raw = await squeeze(bytes, "decompress"), r = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 12 || r.getUint32(0, true) !== CM || r.getUint32(4, true) !== STORED_VERSION) throw new Error("not a stored manifest of this version");
  const idLen = r.getUint32(8, true);
  const id = new TextDecoder().decode(raw.subarray(12, 12 + idLen));
  let at = 12 + 4 * Math.ceil(idLen / 4);
  const next = () => { const v = r.getUint32(at, true); at += 4; return v; };
  const words = (n: number) => { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = next(); return o; };
  const rows = next(), every = next(), dense = next();
  const base = words(next());
  const stored = [...words(next())];
  const lists = new Map<number, Uint32Array>();
  for (let k = next(); k > 0; k--) { const row = next(); lists.set(row, words(next())); }
  if (at !== raw.length) throw new Error("a stored manifest of the wrong size");
  return { id, rows, every, dense, base, stored, lists };
}

export interface MakeOptions {
  id: string;
  /** rows between whole checkpoints (a multiple of dense), and between page lists */
  every: number;
  dense: number;
  /** each whole checkpoint as it is made (its pages are copies) */
  onCheckpoint: (c: Checkpoint) => void | Promise<void>;
  /** progress: the row reached */
  onProgress?: (row: number) => void;
  /** asked between pieces: true stops the making (resolves null) */
  stop?: () => boolean;
  /** awaited between pieces of about sliceMs (the host's pause: let other work in, wait while a player is busy) */
  pause?: () => Promise<void>;
  sliceMs?: number;
}

/** The module's memory as the maker reads it (the graphics build: its heap top) */
type Mem = CheckpointMemory;

/**
 * A stored set for the match open in `core`, its first row (row 0) stepped and nothing after it: the rest of the tape played with nothing
 * drawn, a whole checkpoint every `every` rows and a page list every `dense` rows (each a pass over the module's memory). Resolves the
 * manifest, or null when stopped.
 */
export async function makeStored(core: GxCore, whole: Uint8Array, count: number, o: MakeOptions): Promise<StoredManifest | null> {
  if (o.every % o.dense !== 0) throw new Error("every must be a multiple of dense");
  const m = core.mod as unknown as Mem;
  const base = pageHashes(m), base2 = pageHashes2(m);
  const lists = new Map<number, Uint32Array>(), stored: number[] = [];
  const slice = o.sliceMs ?? 50;
  let t = performance.now();
  for (let row = 1; row < count; row++) {
    if (row % o.dense === 0) {
      const now = pageHashes2(m), differ: number[] = [];
      for (let p = 0; p < now.length / 2; p++) {
        if (2 * p >= base2.length || now[2 * p] !== base2[2 * p] || now[2 * p + 1] !== base2[2 * p + 1]) differ.push(p);
      }
      lists.set(row, Uint32Array.from(differ));
      if (row % o.every === 0) {
        const pages = new Map<number, Uint8Array>();
        for (const p of differ) pages.set(p, m.HEAPU8.slice(p * PAGE, (p + 1) * PAGE));
        stored.push(row);
        await o.onCheckpoint({ row, pages });
      }
    }
    core.step(nativeRow(whole, row));
    if (performance.now() - t > slice) {
      o.onProgress?.(row + 1);
      if (o.stop?.()) return null;
      await o.pause?.();
      if (o.stop?.()) return null;
      t = performance.now();
    }
  }
  o.onProgress?.(count);
  return { id: o.id, rows: count, every: o.every, dense: o.dense, base, stored, lists };
}
