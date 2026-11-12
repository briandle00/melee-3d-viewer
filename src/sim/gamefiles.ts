/* Which of the game's files the simulator reads, and reading them (in the
 * worker). The simulator's build writes the exact list beside the module
 * (sim-files.json, BUILD.md "File list"); without it, a picked folder is
 * read the way melee-sim-light's extraction picks its files
 * (tools/data/extract.py: REQUIRED_FILES, and every fighter file).
 */
import type { GameFilesFrom } from "./protocol";
import { failOf, fetchRetry } from "../render3d/net";

const REQUIRED = [
  "PlCo.dat", "PdPm.dat", "ItCo.dat", "ItCo.usd",
  "EfCoData.dat", "EfFxData.dat", "EfCaData.dat", "EfMsData.dat", "EfFeData.dat", "EfPeData.dat", "EfPrData.dat",
  "EfZdData.dat", "EfLgData.dat", "EfMrData.dat", "EfSsData.dat", "EfIcData.dat", "EfPkData.dat", "EfKbData.dat",
  "EfKbCa.dat", "EfKbDk.dat", "EfKbFe.dat", "EfKbFx.dat", "EfKbGn.dat", "EfKbIc.dat", "EfKbKp.dat", "EfKbLg.dat",
  "EfKbMr.dat", "EfKbMs.dat", "EfKbPk.dat", "EfKbSs.dat", "EfKbZd.dat", "EfDkData.dat", "EfGnData.dat",
  "EfYsData.dat", "EfKpData.dat", "EfMtData.dat", "EfNsData.dat", "EfLkData.dat",
  "GrNLa.dat", "GrNBa.dat", "GrIz.dat", "GrPs.dat", "GrSt.dat", "GrOp.dat",
];
// (the Stadium's transformation files, read when there)
const OPTIONAL = ["GrPs1.dat", "GrPs2.dat", "GrPs3.dat", "GrPs4.dat"];
const FIGHTER_PREFIXES = [
  "PlFx", "PlFc", "PlMs", "PlFe", "PlCa", "PlSk", "PlZd", "PlPr", "PlPe", "PlLg", "PlMr", "PlDr", "PlSs", "PlPp",
  "PlNn", "PlPk", "PlPc", "PlKb", "PlDk", "PlGn", "PlYs", "PlKp", "PlMt", "PlGw", "PlNs", "PlLk", "PlCl",
];

// (the graphics build's display pass loads these too: the HUD archive, the screen flash and refraction files, the name tags' font,
// Pokemon Stadium's English text, the coin-get notice, the English item and Captain Falcon result files; and the game's executable,
// whose tables and font the display code reads at run time)
const GX_EXTRA = ["main.dol", "IfAll.usd", "LbBf.dat", "LbRf.dat", "SdIntro.dat", "GrPs.usd", "ItCo.usd", "PlCaRe.usd", "IfCoGet.dat"];
const GX_OPTIONAL = ["IfAll.dat", "IfVsCam.dat", "IfVsCam.usd"];

/** every file the draw path needs that is not among these names (a fighter's files are named by their prefix, "PlFx*.dat"); empty when all are there */
export function gxMissing(have: string[]): string[] {
  const set = new Set(have);
  return [
    ...REQUIRED.filter((n) => !set.has(n)),
    ...FIGHTER_PREFIXES.filter((p) => !have.some((n) => n.startsWith(p) && n.endsWith(".dat"))).map((p) => `${p}*.dat`),
    ...GX_EXTRA.filter((n) => !set.has(n)),
  ];
}

/** the names the graphics build reads: the simulator's, and the display pass's files */
export function gxNames(have: string[]): string[] {
  const set = new Set(have);
  const missing = GX_EXTRA.filter((n) => !set.has(n));
  if (missing.length) throw new Error(`the game's draw path needs ${missing.join(", ")}`);
  return [...profileNames(have), ...GX_EXTRA, ...GX_OPTIONAL.filter((n) => set.has(n))].filter((n, i, a) => a.indexOf(n) === i);
}

/** the names to read from a folder's file names, the extraction's way; throws naming what is missing */
export function profileNames(have: string[]): string[] {
  const set = new Set(have);
  const missing = REQUIRED.filter((n) => !set.has(n));
  for (const p of FIGHTER_PREFIXES) if (!have.some((n) => n.startsWith(p) && n.endsWith(".dat"))) missing.push(`${p}*.dat`);
  if (missing.length) throw new Error(`the simulator needs ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
  const fighters = have.filter((n) => n.endsWith(".dat") && FIGHTER_PREFIXES.some((p) => n.startsWith(p)));
  return [...REQUIRED, ...OPTIONAL.filter((n) => set.has(n)), ...fighters];
}

/** a game file from a folder by URL, asked again over a few seconds when there is no answer (render3d/net.ts); a failure names the file */
async function urlFile(name: string, url: URL): Promise<Response> {
  return await fetchRetry(url).catch((e) => {
    const f = failOf(e);
    throw new Error(`${name}: ${f.kind === "gone" ? "not in the game files folder" : f.status ? "HTTP " + f.status : f.message}`);
  });
}

/** the names the simulator reads: its build's list, else the extraction's way */
export async function namesToRead(from: GameFilesFrom, list: string | null): Promise<string[]> {
  if (list) {
    // (asked again over a few seconds when there is no answer: render3d/net.ts)
    const r = await fetchRetry(list).catch(() => null);
    if (r) {
      const names = await r.json();
      if (Array.isArray(names) && names.every((n) => typeof n === "string")) return names;
    }
  }
  if (from.kind === "files") return profileNames(from.list.map((f) => f.name));
  throw new Error("the simulator's file list (sim-files.json) could not be read");
}

/** The game's sound files the simulator names (paths under the game files folder, as on the disc: "audio/us/smash2.sem",
 *  "audio/us/mars.ssm", "audio/sp_zako.hps"), read from the folder: by URL each path below its base; a picked folder by the path inside
 *  it (a file's webkitRelativePath after the folder's own name), else by its name when one file has it. Throws naming the first missing. */
export async function readSoundFiles(from: GameFilesFrom, names: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const inFolder = (f: File) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    return rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : f.name;
  };
  const byPath = from.kind === "files" ? new Map(from.list.map((f) => [inFolder(f), f])) : null;
  const one = async (name: string) => {
    if (byPath) {
      const leaf = name.slice(name.lastIndexOf("/") + 1);
      const f = byPath.get(name) ?? (() => {
        const same = from.kind === "files" ? from.list.filter((x) => x.name === leaf && inFolder(x).endsWith(name.slice(name.indexOf("/") + 1))) : [];
        return same.length === 1 ? same[0] : undefined;
      })();
      if (!f) throw new Error(`${name}: not in the game files folder`);
      out.set(name, new Uint8Array(await f.arrayBuffer()));
      return;
    }
    const base = new URL((from as { base: string }).base.replace(/\/?$/, "/"));
    const r = await urlFile(name, new URL(name.split("/").map(encodeURIComponent).join("/"), base));
    out.set(name, new Uint8Array(await r.arrayBuffer()));
  };
  for (let i = 0; i < names.length; i += 4) await Promise.all(names.slice(i, i + 4).map(one));
  return out;
}

/** the files' bytes, by name; throws naming the first one missing */
export async function readGameFiles(from: GameFilesFrom, names: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const byName = from.kind === "files" ? new Map(from.list.map((f) => [f.name, f])) : null;
  const one = async (name: string) => {
    if (byName) {
      const f = byName.get(name);
      if (!f) throw new Error(`${name}: not in the game files folder`);
      out.set(name, new Uint8Array(await f.arrayBuffer()));
      return;
    }
    const base = new URL((from as { base: string }).base.replace(/\/?$/, "/"));
    const r = await urlFile(name, new URL(encodeURIComponent(name), base));
    out.set(name, new Uint8Array(await r.arrayBuffer()));
  };
  // (a few at a time)
  for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map(one));
  return out;
}

/** sim-files-match.json beside a module that loads one match's game data (msl_gxw_load_game_for): which of sim-files.json's files that
 *  load reads, by part - every match's, each fighter's (by external character id: Popo's has Nana's), Kirby's copy of each fighter
 *  (read when Kirby plays against it), each stage's (by stage id). Made by the module's own loads (tools/gx-match-files.ts) */
export interface MatchFileList {
  version: 1;
  /** the module it was made for (the first 16 hex digits of gx-core.wasm's SHA-256) */
  module: string;
  always: string[];
  fighters: Record<string, string[]>;
  kirby: Record<string, string[]>;
  stages: Record<string, string[]>;
}

const KIRBY = 4, ZELDA = 19, SHEIK = 7;

/** the stage and fighters of a native tape's match (render3d/gxpath/tapebridge.ts TapeConfig: stage_id at 4, num_players at 24, each
 *  player's char_id at 41 + 8 p); Zelda's match has Sheik and the other way round (they change into each other during play) */
export function tapeMatch(whole: Uint8Array): { stage: number; chars: number[] } {
  const v = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
  const stage = v.getInt32(4, true), n = Math.min(4, whole[24]);
  const chars: number[] = [];
  for (let p = 0; p < n; p++) {
    const c = whole[41 + 8 * p];
    for (const k of c === ZELDA ? [ZELDA, SHEIK] : c === SHEIK ? [SHEIK, ZELDA] : [c]) if (!chars.includes(k)) chars.push(k);
  }
  return { stage, chars };
}

/** the parts of the list one match reads, each a list of names (the parts a page keeps apart: another match shares most of them);
 *  null when the list does not know one of its fighters or its stage (read every file then) */
export function matchParts(list: MatchFileList, whole: Uint8Array): string[][] | null {
  if (list?.version !== 1) return null;
  const { stage, chars } = tapeMatch(whole);
  const parts = [list.always];
  for (const c of chars) {
    const f = list.fighters[c];
    if (!f) return null;
    parts.push(f);
  }
  if (chars.includes(KIRBY)) {
    for (const c of chars) {
      if (c === KIRBY) continue;
      const k = list.kirby[c];
      if (!k) return null;
      parts.push(k);
    }
  }
  const s = list.stages[stage];
  if (!s) return null;
  parts.push(s);
  return parts.filter((p) => p.length);
}

/** msl-dat-bases.bin: each file's console base as a load of every match's gives it (the module's native_dat.c dat_base_for), in that
 *  load's order: with it in the game files folder a one-match load (GxCore.loadGame with the tape) reads like a whole one; without it
 *  the module reads every match's game data. Made from a whole load's record (datBasesOf), on the player's own files: nothing of it
 *  ships. A page may keep it (the app does) or a folder may hold one beside the module (tools/gx-match-files.ts writes one) */
export const DAT_BASES = "msl-dat-bases.bin";
export async function datBases(moduleUrl: string | URL): Promise<[string, Uint8Array][]> {
  try {
    const r = await fetch(new URL(DAT_BASES, moduleUrl));
    return r.ok ? [[DAT_BASES, new Uint8Array(await r.arrayBuffer())]] : [];
  } catch {
    return [];
  }
}

/** a module's record of the bases its load gave (msl_native_dat_base_*), as msl-dat-bases.bin: "MSLB", the count, the base for a file
 *  not in it (past every one), then per file its key (u64) and base, little-endian. null for a module without the record or with none */
export function datBasesOf(mod: unknown): Uint8Array | null {
  const m = mod as Record<string, ((i?: number) => number) | undefined>;
  if (!m._msl_native_dat_base_count || !m._msl_native_dat_base_at || !m._msl_native_dat_base_key_lo || !m._msl_native_dat_base_key_hi) return null;
  const n = m._msl_native_dat_base_count();
  if (!n) return null;
  const out = new Uint8Array(12 + 12 * n), v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("MSLB"));
  v.setUint32(4, n, true);
  let end = 0;
  for (let i = 0; i < n; i++) {
    const b = m._msl_native_dat_base_at(i) >>> 0;
    v.setUint32(12 + 12 * i, m._msl_native_dat_base_key_lo(i) >>> 0, true);
    v.setUint32(16 + 12 * i, m._msl_native_dat_base_key_hi(i) >>> 0, true);
    v.setUint32(20 + 12 * i, b, true);
    end = Math.max(end, b);
  }
  // (a file the table does not have - another disc's - is placed well past every one it has)
  v.setUint32(8, (end + 0x4000000) >>> 0, true);
  return out;
}
