// public/gx/sim-files-match.json: which of the module's game files one match's load reads (msl_gxw_load_game_for), by part, made by
// the module's own loads with every file there and each file it opens noted (src/sim/gamefiles.ts MatchFileList, matchParts):
//   always        what every load reads (the files read by the loads of each fighter alone, in common)
//   fighters[c]   what fighter c's own load reads beyond those (its stage is Final Destination: every fighter's preload match is there)
//   kirby[c]      what Kirby against c reads beyond Kirby's and c's own loads (his copy of c)
//   stages[s]     what stage s adds to a fighter's load
// Then every part's union is checked against what a load of the match reads, for a spread of matches (every fighter on every stage
// with a partner, Kirby against every fighter, three- and four-player ones): a load that read a file its parts do not name fails.
//   deno run -A --sloppy-imports tools/gx-match-files.ts <game files folder> [<module dir>, default public/gx] [--keep-bases]
// (--keep-bases: msl-dat-bases.bin written beside the module too, for a local build that serves it; never commit it)
import { GxCore, type GxCoreFactory } from "../src/render3d/gxpath/core.ts";
import { DATA_ROOT } from "../src/sim/engine.ts";
import { DAT_BASES, datBasesOf, matchParts, type MatchFileList } from "../src/sim/gamefiles.ts";
import { TAPE_CONFIG_SIZE, TAPE_FRAME_SIZE } from "../src/render3d/gxpath/tapebridge.ts";

const pos = Deno.args.filter((a) => !a.startsWith("--"));
const root = (pos[0] ?? "").replace(/\\/g, "/").replace(/\/?$/, "/");
const dir = pos[1] ? new URL("file:///" + pos[1].replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/")) : new URL("../public/gx/", import.meta.url);
if (!pos[0]) throw new Error("usage: gx-match-files.ts <game files folder> [<module dir>]");
const factory = (await import(new URL("gx-core.js", dir).href)).default as GxCoreFactory;
const names = JSON.parse(await Deno.readTextFile(new URL("sim-files.json", dir))) as string[];
const files = new Map(names.map((n) => [n, Deno.readFileSync(root + n)]));

// msl-dat-bases.bin: the console base a load of every match's gives each file (native_dat.c dat_base_for), in its order - for the loads
// below, and kept beside the module in this folder only (never committed: it is made from the game's files)
{
  const core = await GxCore.create(factory, files);
  if (!core.loadGame(names)) throw new Error("the whole load failed");
  const out = datBasesOf(core.mod);
  if (!out) throw new Error("this module gives no console bases: an older build?");
  core.destroy();
  files.set(DAT_BASES, out);
  if (Deno.args.includes("--keep-bases")) await Deno.writeFile(new URL(DAT_BASES, dir), out);
  console.log(`${DAT_BASES}: ${(out.length - 12) / 12} bases`);
}

// the fighters (external character ids: Nana comes with Popo, 10) and stages the simulator plays (src/sim/tape.ts SIM_STAGES)
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
const STAGES = [2, 3, 8, 28, 31, 32];
const FD = 32, KIRBY = 4, ZELDA = 19, SHEIK = 7;

/** a tape of one blank row for a match of these fighters on this stage: all a load reads of it is the config's stage and fighters */
function tapeOf(stage: number, chars: number[]): Uint8Array {
  const t = new Uint8Array(TAPE_CONFIG_SIZE + TAPE_FRAME_SIZE), v = new DataView(t.buffer);
  v.setUint32(0, 0x314c534d, true);
  v.setInt32(4, stage, true);
  v.setInt32(8, -123, true);
  v.setFloat32(20, 1, true);
  t[24] = chars.length;
  t[27] = 4;
  chars.forEach((c, p) => { t[41 + 8 * p] = c; t[41 + 8 * p + 4] = 9; });
  v.setUint32(73, 1, true);
  return t;
}

/** the files a one-match load of these opens (every file in its file system) */
async function reads(stage: number, chars: number[]): Promise<Set<string>> {
  const core = await GxCore.create(factory, files);
  const fs = core.mod.FS as unknown as { open: (...a: unknown[]) => unknown };
  const open = fs.open, got = new Set<string>();
  fs.open = (...a: unknown[]) => {
    const p = String(a[0]);
    if (p.startsWith(DATA_ROOT + "/") && p !== `${DATA_ROOT}/${DAT_BASES}`) got.add(p.slice(DATA_ROOT.length + 1));
    return open.apply(fs, a);
  };
  if (!core.loadGame([...files.keys()], tapeOf(stage, chars))) throw new Error(`no load for stage ${stage} fighters ${chars}: an older module?`);
  core.destroy();
  return got;
}
const minus = (a: Set<string>, ...b: Set<string>[]) => [...a].filter((n) => !b.some((s) => s.has(n))).sort();

const t0 = performance.now();
const own = new Map<number, Set<string>>();
for (const c of CHARS) own.set(c, await reads(FD, [c, c]));
const always = new Set([...own.get(CHARS[0])!].filter((n) => CHARS.every((c) => own.get(c)!.has(n))));
// (the module the list is for: a page keeps the bases it records under this - another module may load in another order)
const wasm = new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(new URL("gx-core.wasm", dir))));
const module = Array.from(wasm.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
const list: MatchFileList = { version: 1, module, always: [...always].sort(), fighters: {}, kirby: {}, stages: {} };
for (const c of CHARS) list.fighters[c] = minus(own.get(c)!, always);
for (const c of CHARS) if (c !== KIRBY) list.kirby[c] = minus(await reads(FD, [KIRBY, c]), own.get(KIRBY)!, own.get(c)!);
for (const s of STAGES) list.stages[s] = s === FD ? [] : minus(await reads(s, [1, 1]), own.get(1)!);
console.log(`list made in ${Math.round(performance.now() - t0)} ms`);

// the check: matches whose load reads only files their parts name
const checks: [number, number[]][] = [];
CHARS.forEach((c, i) => STAGES.forEach((s, j) => checks.push([s, [c, CHARS[(i + j + 1) % CHARS.length]]])));
for (const c of CHARS) if (c !== KIRBY) checks.push([STAGES[c % STAGES.length], [KIRBY, c]]);
checks.push([3, [ZELDA, 10, KIRBY]], [31, [SHEIK, KIRBY, 10, 24]], [28, [KIRBY, KIRBY]], [2, [10, 10, 10, 10]]);
let bad = 0;
for (const [s, chars] of checks) {
  const parts = matchParts(list, tapeOf(s, chars));
  const named = new Set((parts ?? []).flat());
  const extra = parts ? [...await reads(s, chars)].filter((n) => !named.has(n)) : ["(no parts)"];
  if (extra.length) { bad++; console.log(`stage ${s} fighters ${chars}: read ${extra.join(" ")} beyond its parts`); }
}
const sizes = (ns: string[]) => ns.reduce((a, n) => a + files.get(n)!.length, 0) / 1048576;
console.log(`${checks.length} matches checked, ${bad} read beyond their parts; always ${list.always.length} files ${sizes(list.always).toFixed(1)} MiB; ` +
            `fighters ${Object.values(list.fighters).map((f) => sizes(f).toFixed(1)).join(" ")} MiB`);
if (bad) Deno.exit(1);
await Deno.writeTextFile(new URL("sim-files-match.json", dir), JSON.stringify(list, null, 1).replace(/\n {2,}"/g, ' "').replace(/\n\s*\]/g, "]") + "\n");
console.log("wrote", new URL("sim-files-match.json", dir).pathname);
