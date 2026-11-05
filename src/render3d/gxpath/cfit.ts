/* Playback "original" of a recording without raw C-stick bytes (Slippi before 3.17): the raw bytes the original game had are the
 * simulator's to decide, against the recorded positions (melee-sim-light replay_drive.drive_fitted). The module holds the planner
 * (msl_gxw_cfit_*, tools/replay/cstick_fit.c: the same candidates, order and limits as the python); the page only runs the drives it
 * asks for, the simulator alone over the whole tape with playback "original", plain or resynced (the recording's near-miss positions put
 * back, msl_gxw_set_recorded) as the planner says, and reports each drive's first difference from the recording (framediff.ts,
 * replay_drive.py frame_diff) and, for the first, whether it is only such a near miss (positions_near_only). Nothing of the rule is here.
 */
import type { DriveOptions, Tape } from "../../sim/tape";
import { GxCore, type GxCoreFactory } from "./core";
import { frameDiffs, positionsNearOnly } from "./framediff";
import { nativeRow, nativeTape } from "./tapebridge";

export type RawC = ([Int16Array, Int16Array] | null)[];

export interface FitOptions {
  factory: GxCoreFactory;
  coreOptions?: Record<string, unknown>;
  files: { names: string[]; files: Map<string, Uint8Array> | Iterable<[string, Uint8Array]> };
  tape: Tape;
  drive: DriveOptions;
  onProgress?: (text: string) => void;
  /** a pause to the event loop between slices of a drive (the page stays alive) */
  pause?: () => Promise<void>;
}

/** the fitted raw C-stick bytes per slot, and how many drives and kept trials it took; null when the recording has raw bytes */
export async function fitCstick(o: FitOptions): Promise<{ rawC: RawC; drives: number; flips: number } | null> {
  const { tape } = o;
  if (!tape.rawCAbsent) return null;
  const make: GxCoreFactory = (opt) => o.factory({ ...opt, ...o.coreOptions });
  const files = o.files.files instanceof Map ? o.files.files : new Map(o.files.files);
  const planner = await GxCore.create(make, []);
  const m = planner.mod, count = tape.count, lanes = tape.numPlayers;
  if (m._msl_gxw_cfit_new(lanes, count) !== 0) throw new Error("msl_gxw_cfit_new: no memory");
  for (let s = 0; s < lanes; s++) {
    const { x, y } = tape.cstick(s);
    const px = m._malloc(count * 4), py = m._malloc(count * 4);
    try {
      new Float32Array(m.HEAPU8.buffer, px, count).set(x);
      new Float32Array(m.HEAPU8.buffer, py, count).set(y);
      m._msl_gxw_cfit_lane(s, px, py);
    } finally { m._free(px); m._free(py); }
  }
  const load = (): RawC => Array.from({ length: lanes }, (_, s) => {
    const raw = (axis: number) => { const p = m._msl_gxw_cfit_raw(s, axis); return new Int16Array(m.HEAPU8.buffer.slice(p, p + count * 2)); };
    return [raw(0), raw(1)] as [Int16Array, Int16Array];
  });
  const pause = o.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let drives = 0;
  const recorded = resyncRecord(tape);
  // one whole drive, the simulator alone, playback original (resynced: the recording's positions put back where near): the first row whose
  // output is not the recording's (-1 none), and whether that row differs only by such near misses
  // The game files are read once for the drives (that is nearly all of an open's time; a drive's steps take a few seconds): each drive puts
  // the module back to its state right after the files loaded (GxCore.rewind, byte for byte) and opens its tape there, as a fresh
  // instance would. A module that cannot be rewound is replaced by a fresh one.
  let opened: GxCore | null = null;
  const openedFor = async (whole: Uint8Array): Promise<GxCore> => {
    if (!opened?.rewind()) {
      opened?.destroy();
      opened = await GxCore.create(make, files);
      opened.loadGame([...files.keys()]);
    }
    opened.openMatch(whole, [...files.keys()], "original");
    return opened;
  };
  const drive = async (rawC: RawC, resynced: boolean): Promise<{ first: number; near: boolean }> => {
    drives++;
    o.onProgress?.(`working out the C-stick of this replay (simulation ${drives})`);
    const whole = nativeTape(tape, o.drive, rawC);
    const core = await openedFor(whole);
    {
      core.setDisplay(false); // (only the gameplay rows matter)
      if (resynced) core.setRecorded(recorded);
      let t0 = performance.now();
      for (let i = 0; i < count; i++) {
        core.step(nativeRow(whole, i));
        const diffs = frameDiffs(core.outRow(), tape.recorded(i));
        if (diffs.length) return { first: i, near: positionsNearOnly(diffs) };
        if (performance.now() - t0 > 12) { await pause(); t0 = performance.now(); }
      }
      return { first: -1, near: false };
    }
  };
  // (replay_drive.drive_fitted's flow, as the planner's API states it: tools/replay/gx_wasm_api.c, msl_gxw_cfit_*)
  const plain = await drive(load(), false);
  let n = m._msl_gxw_cfit_next(plain.first, plain.first >= 0 && plain.near ? 1 : 0);
  if (n === 2 && plain.near) {
    const first2 = (await drive(load(), true)).first;
    n = m._msl_gxw_cfit_next(first2, 0);
  }
  while (n) {
    const moved = (await drive(load(), n === 2)).first;
    m._msl_gxw_cfit_result(moved);
    n = m._msl_gxw_cfit_next(m._msl_gxw_cfit_first(), 0);
  }
  const rawC = load();
  // (in resync mode drive_fitted judges the plain drive with the settled bytes at the end; the tape is the same either way)
  if (m._msl_gxw_cfit_mode()) await drive(rawC, false);
  const flips = m._msl_gxw_cfit_flips();
  planner.destroy();
  (opened as GxCore | null)?.destroy();
  opened = null;
  return { rawC, drives, flips };
}

/** replay_drive.py recorded_positions: per tape frame a uint16 item count, 4 ports' fighter x, y and 4 followers' x, y (NaN for none), then
 *  each recorded item's x, y, velocity x, y, as float32 (little-endian) */
export function resyncRecord(tape: Tape): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; i < tape.count; i++) {
    const r = tape.recorded(i), items = r.items ?? [];
    const b = new Uint8Array(2 + 64 + 16 * items.length), v = new DataView(b.buffer);
    v.setUint16(0, items.length, true);
    for (let lane = 0; lane < 4; lane++) {
      const p = r.players[lane];
      v.setFloat32(2 + 8 * lane, p?.leader ? p.leader.x : NaN, true); v.setFloat32(6 + 8 * lane, p?.leader ? p.leader.y : NaN, true);
      const f = p && p.hasFollower ? p.follower : null;
      v.setFloat32(34 + 8 * lane, f ? f.x : NaN, true); v.setFloat32(38 + 8 * lane, f ? f.y : NaN, true);
    }
    items.forEach((it, k) => {
      const o = 66 + 16 * k;
      v.setFloat32(o, it.x, true); v.setFloat32(o + 4, it.y, true); v.setFloat32(o + 8, it.velX, true); v.setFloat32(o + 12, it.velY, true);
    });
    parts.push(b); size += b.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}