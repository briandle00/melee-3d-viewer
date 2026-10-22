/* 3D replay viewer: where the game files come from.
 *
 * The game's own files (the .dat/.usd files on the disc, and its executable,
 * Start.dol or main.dol) are read at runtime from a source the page sets:
 *
 *  - by default, fetched from a folder beside the page: `game/`, or the URL
 *    given as ?files=<url> (a folder you fill with the files from your own
 *    copy of the game: see README.md);
 *  - or files the host page hands over ({type: "gameFiles", files: File[]},
 *    embed.tsx; the dev page's folder picker does this).
 *
 * Nothing from the game is bundled, and nothing is written anywhere: the
 * files are held in memory for as long as the page is open. Every failure is
 * an Error the viewer answers by saying why.
 */
import { type Article, Fighter, loadArticle, MotionTable, fighterFiles, sharedFiles } from "./fighter";
import { parseArchive, ptr } from "./hsd";
import { Stage, STADIUM_FORMS, STAGES } from "./stage";
import { type Lettering, parseSisCommon, parseSisFile, type SisCommon } from "./sistext";
import { EffectKit } from "./effects3d";
import { hatFiles, KirbyCopy, KirbyHat, loadHat } from "./kirby";
import { EFFECT_FILES, effectFilesOf } from "./fx/dispatch";
import { HudKit, stageMagnifierColors } from "./hud";
import { bgFlashTables } from "./fx/bgflash";
import type { ColAnimTables } from "./fx/colanim";
import { pageCache, sharedPromise, trim } from "../state/pageCache";
import { decodeTrack, decodeTrackFloats } from "./trackcodec";
import { motionTableFromDol, textFontFromDol } from "./dol";
import { plateFontFromText } from "./plates";
import type { ViewerTrack } from "./track";
import type { GameFilesFrom } from "../sim/protocol";
import { fileRead, mark, timed, timing } from "./startup";
import { cacheGet, cachePut, sha256 } from "./gamecache";
import { replayHead } from "./prefetch";

export interface Status {
  available: boolean; // the files and the action table are there
  enabled: boolean; // 3D is wanted
  use3d: boolean; // both
  reason: string | null; // why not
  look480?: boolean; // the 480p look is on
  crt?: string; // the TV the Console view is shown on (crt.ts): off, trinitron or pvm
  curve?: number; // and its curve (0: flat)
  controller_overlay?: string; // the Controller overlay: "both", "left", "right", "you" or "off" (Controllers.tsx)
}

/** a game file's bytes by its name on the disc ("PlFxNr.dat"); `from` says
 *  where they are, for the simulator's worker (src/sim), which reads them itself */
export type FileSource = ((name: string) => Promise<ArrayBuffer>) & {
  from?: GameFilesFrom;
  /** a string that changes whenever the named file does (its size and a version
   *  or modification stamp), asked without reading the file; null when the
   *  source cannot tell. Only what the browser may keep (gamecache.ts) is
   *  keyed by it, so a source without one is never cached */
  identity?: (name: string) => Promise<string | null>;
};

/** files fetched from a folder at this URL (relative to the page) */
export function folderUrlSource(base: string): FileSource {
  const dir = new URL(base.endsWith("/") ? base : base + "/", location.href);
  const s: FileSource = async (name) => {
    const r = await fetch(new URL(encodeURIComponent(name), dir), { cache: "no-store" });
    if (!r.ok) throw new Error(`${name}: ${r.status === 404 ? "not in the game files folder" : "HTTP " + r.status}`);
    return r.arrayBuffer();
  };
  s.from = { kind: "url", base: dir.href };
  s.identity = async (name) => {
    try {
      const r = await fetch(new URL(encodeURIComponent(name), dir), { method: "HEAD", cache: "no-store" });
      const len = r.headers.get("content-length"), stamp = r.headers.get("etag") ?? r.headers.get("last-modified");
      // (a size alone says too little)
      return r.ok && len && stamp ? `${dir.href}${name}|${len}|${stamp}` : null;
    } catch {
      return null;
    }
  };
  return s;
}

/** files handed over as File objects (a folder picker's), found by their own name */
export function fileListSource(list: File[]): FileSource {
  const byName = new Map<string, File>();
  for (const f of list) byName.set(f.name, f);
  const s: FileSource = async (name) => {
    const f = byName.get(name);
    if (!f) throw new Error(`${name}: not in the game files folder`);
    return f.arrayBuffer();
  };
  s.from = { kind: "files", list };
  s.identity = async (name) => {
    const f = byName.get(name);
    return f ? `file:${f.name}|${f.size}|${f.lastModified}` : null;
  };
  return s;
}

// (made when first used: the module can be imported where there is no page, as the tests do)
let source: FileSource | undefined;
const currentSource = () => source ??= folderUrlSource(new URLSearchParams(location.search).get("files") ?? "game/");
// whether anything was read from the source yet (setFileSource)
let sourceUsed = false;
let statusPromise: Promise<Status> | undefined;

/** read the game files from here on (what was read before is dropped). A
 *  source set before anything was read, as a host page does when it starts,
 *  drops nothing: what the page's other players read stays shared */
export function setFileSource(s: FileSource) {
  source = s;
  statusPromise = undefined;
  if (!sourceUsed) return;
  sourceUsed = false;
  files.clear();
  pageCache<Promise<MotionTable>>("motion").clear();
  pageCache<Promise<ExecutableInfo>>("executable").clear();
  dol = undefined; foxEffectsP = undefined;
  fighters.clear(); kirbyHats.clear(); kirbyCopies.clear(); stages.clear(); fighterFx.clear();
  commonItemsP = undefined; effectKit = undefined; hudKit = undefined;
}

/** whether this page can draw in 3D: a file every game needs and the
 *  executable's action table can be read; asked once per file source */
export function status(): Promise<Status> {
  statusPromise ??= Promise.all([file("PlCo.dat"), motionTable()])
    .then((): Status => ({ available: true, enabled: true, use3d: true, reason: null }))
    .catch((e): Status => ({ available: false, enabled: true, use3d: false, reason: String(e?.message ?? e) }));
  return statusPromise;
}

// (the page's: every player on it fetches a file once - bytes nobody changes)
const files = pageCache<Promise<ArrayBuffer>>("gameFiles");

const discKeys = new WeakMap<FileSource, Promise<string | null>>();
/** this source's disc key: the SHA-256 of its PlCo.dat (another disc, another version of the game's files, another
 *  mod: a different file; every replay reads it); null where it cannot be made */
function discKey(): Promise<string | null> {
  const src = currentSource();
  let p = discKeys.get(src);
  if (!p) {
    p = file("PlCo.dat").then(sha256).catch(() => null);
    discKeys.set(src, p);
  }
  return p;
}

export function file(name: string): Promise<ArrayBuffer> {
  sourceUsed = true;
  const p = sharedPromise(files, name, () => {
    const t0 = timing ? performance.now() : 0;
    const made = currentSource()(name);
    if (timing) made.then((b) => fileRead(name, b.byteLength, "source", t0), () => {});
    // a failure is not kept, so a folder fixed while the page is open works next time
    made.catch(() => { if (files.get(name) === made) files.delete(name); });
    return made;
  });
  // (the page keeps the last few dozen)
  trim(files, 48);
  return p;
}

let dol: Promise<ArrayBuffer> | undefined;

/** the game's executable: Start.dol, else main.dol (whichever name the
 *  disc extraction gave it) */
function executable(): Promise<ArrayBuffer> {
  dol ??= file("Start.dol").catch(() => file("main.dol"));
  dol.catch(() => { dol = undefined; });
  return dol;
}

// replay URL -> its viewer track's URL (setTrackUrl)
const trackUrls = new Map<string, string>();

/** the viewer track (the JSON file the simulator wrote, or its compact form)
 *  for the replay loaded from `replayUrl`; null: none */
export function setTrackUrl(replayUrl: string, trackUrl: string | null) {
  if (trackUrl) trackUrls.set(replayUrl, trackUrl);
  else trackUrls.delete(replayUrl);
}

/** where the game files are read from, for the simulator's worker; null: a source it cannot read */
export function gameFilesFrom(): GameFilesFrom | null {
  return currentSource().from ?? null;
}

/** a viewer track made on the page while the replay plays (src/sim/feed.ts):
 *  `got` with each longer track, `why` while there is none */
export interface LiveTrack {
  subscribe(got: (t: ViewerTrack) => void, why: (reason: string) => void): () => void;
}
const liveTracks = new Map<string, LiveTrack>();
export function setLiveTrack(replayUrl: string, live: LiveTrack | null) {
  if (live) liveTracks.set(replayUrl, live);
  else liveTracks.delete(replayUrl);
}
export function liveTrack(replayUrl: string): LiveTrack | undefined {
  return liveTracks.get(replayUrl);
}

/** whether a viewer track was given for this replay (or is made on the page) */
export function hasTrack(replayUrl: string): boolean {
  return trackUrls.has(replayUrl) || liveTracks.has(replayUrl);
}

/** the viewer track's answer for a replay (track.ts reads it): ready with the
 *  track, none with why, or null when it could not be read */
export async function trackAnswer(replayUrl: string): Promise<unknown | null> {
  const url = trackUrls.get(replayUrl);
  if (!url) return { state: "none", reason: "no viewer track given" };
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const u = new Uint8Array(buf);
    // (the compact form, trackcodec.ts, is gzipped; the simulator's export is JSON)
    if (u[0] === 0x1f && u[1] === 0x8b) return { state: "ready", track: await decodeTrack(buf) };
    const t = JSON.parse(new TextDecoder().decode(u));
    if (t && Array.isArray(t.events)) { decodeTrackFloats(t.events); t.decoded = true; return { state: "ready", track: t }; }
    return t?.state ? t : { state: "none", reason: "not a viewer track" };
  } catch {
    return null;
  }
}

/** the effects table (effect-table.json beside the page, optional); null when it is not there */
export async function effectTable(): Promise<{ table?: Record<string, unknown>; byGfx?: Record<string, unknown> } | null> {
  try {
    const r = await fetch(new URL("effect-table.json", location.href));
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** what a player that can be seen does while it warms up (every 2 s): by
 *  default the page that embeds it is told ({type: "warming"}), in case it
 *  wants to hold other work back for a moment */
let warming = () => {
  if (window.parent !== window) window.parent.postMessage({ type: "warming" }, "*");
};

/** tell the host of a player warming up some other way (a host serving the
 *  page itself may want a request instead of the message) */
export function setWarmingHandler(fn: () => void) {
  warming = fn;
}

/** a player that can be seen is warming up (setWarmingHandler says who is told) */
export function tellWarming() {
  warming();
}

export function motionTable(): Promise<MotionTable> {
  const shared = pageCache<Promise<MotionTable>>("motion");
  return sharedPromise(shared, "table", () => {
    const made = executableInfo().then((i) => i.table);
    made.catch(() => { if (shared.get("table") === made) shared.delete("table"); });
    return made;
  });
}

/** what is made from the executable: the action table, and the text font
 *  Pokemon Stadium's screen writes with (null when it cannot be made) */
interface ExecutableInfo { table: MotionTable; font: ArrayBuffer | null }
interface ExecutableRecord extends ExecutableInfo { v: 1; key: string }

/** the executable's identity in the source and a SHA-256 of PlCo.dat (read by every
 *  replay), which together name one disc's executable; null when the source cannot
 *  tell, and then nothing is kept */
async function executableKey(): Promise<string | null> {
  const src = currentSource();
  if (!src.identity) return null;
  const [start, main, disc] = await Promise.all([src.identity("Start.dol"), src.identity("main.dol"), discKey()]);
  const id = start ?? main;
  return id && disc ? `${id}|${disc}` : null;
}

/** The action table and the font, once per page. The browser keeps them (gamecache.ts)
 *  after the first time, so a later open does not read the executable's 4 MB again;
 *  an entry made from another disc, folder or version of the file is not used. */
function executableInfo(): Promise<ExecutableInfo> {
  const shared = pageCache<Promise<ExecutableInfo>>("executable");
  return sharedPromise(shared, "info", () => {
    const made = (async (): Promise<ExecutableInfo> => {
      const key = await executableKey().catch(() => null);
      if (key) {
        const kept = await cacheGet<ExecutableRecord>("executable");
        if (kept && kept.v === 1 && kept.key === key && kept.table && Array.isArray(kept.table.common)) {
          mark("executableFromCache");
          return { table: kept.table, font: kept.font ?? null };
        }
      }
      const buf = await executable();
      const table = timed("dol", "action table", () => motionTableFromDol(buf));
      let font: ArrayBuffer | null = null;
      try { font = timed("dol", "text font", () => textFontFromDol(buf)); } catch { /* the stage's own pages alone */ }
      if (key) void cachePut("executable", { v: 1, key, table, font } satisfies ExecutableRecord);
      return { table, font };
    })();
    made.catch(() => { if (shared.get("info") === made) shared.delete("info"); });
    return made;
  });
}

const fighters = new Map<string, Promise<Fighter>>();

/** one fighter in one costume, loaded once per page */
export function fighter(internalId: number, costume: number): Promise<Fighter> {
  const key = `${internalId}:${costume}`;
  let p = fighters.get(key);
  if (!p) {
    const names = fighterFiles(internalId, costume);
    if (!names) return Promise.reject(new Error(`no model for character ${internalId}`));
    // Nana plays Popo's animations for all but her own few: his files too
    // (the same fetch Popo's model makes, so read once)
    const shares = sharedFiles(internalId);
    const shared = shares
      ? Promise.all([file(shares[0]), file(shares[1])]).then(([pl, aj]) => ({ pl, aj }))
      : Promise.resolve(undefined);
    p = Promise.all([file(names[0]), file(names[1]), file(names[2]), motionTable(), shared])
      .then(([pl, aj, md, mt, sh]) => timed("fighter", key, () => new Fighter(internalId, pl, aj, md, costume, mt, `f${key}`, sh)));
    p.catch(() => fighters.delete(key));
    fighters.set(key, p);
  }
  return p;
}

const kirbyHats = new Map<string, Promise<KirbyHat | null>>();

/** Kirby's hat for a copy in one of his costumes (kirby.ts), loaded once per page */
export function kirbyHat(kind: number, costume: number): Promise<KirbyHat | null> {
  const key = `${kind}:${costume}`;
  let p = kirbyHats.get(key);
  if (!p) {
    const names = hatFiles(kind, costume);
    if (!names) return Promise.resolve(null);
    p = Promise.all([file(names[0]), names[1] ? file(names[1]) : Promise.resolve(null)])
      .then(([d, c]) => loadHat(kind, d, c, `kb${key}`, costume));
    p.catch(() => kirbyHats.delete(key));
    kirbyHats.set(key, p);
  }
  return p;
}

const kirbyCopies = new Map<number, Promise<KirbyCopy | null>>();

/** a copy's data file (kirby.ts: its projectiles), loaded once per page */
/** the common items' articles (ItCo.dat's itPublicData: its +4 a list by
 *  item kind, 0 to 0x2A - a Bob-omb, Mr. Saturn - as it_804D6D24 has it),
 *  once a page: each kind's model in a state, or null when it has none */
export interface CommonItems { article(kind: number, state: number): Article | null }
let commonItemsP: Promise<CommonItems | null> | undefined;
export function commonItems(): Promise<CommonItems | null> {
  commonItemsP ??= file("ItCo.dat").then((buf) => {
    const a = parseArchive(buf);
    const pub = a.publics.get("itPublicData");
    if (pub === undefined) return null;
    const list = ptr(a, pub + 4);
    const made = new Map<string, Article | null>();
    return {
      article(kind: number, state: number) {
        const key = `${kind}:${state}`;
        if (!made.has(key)) {
          const art = list === null || kind < 0 || kind > 0x2a ? null : ptr(a, list + kind * 4);
          made.set(key, art === null ? null : loadArticle(a, art, state, `item:${kind}:${state}`));
        }
        return made.get(key)!;
      },
    };
  }).catch(() => null);
  return commonItemsP;
}

export function kirbyCopy(kind: number): Promise<KirbyCopy | null> {
  let p = kirbyCopies.get(kind);
  if (!p) {
    const names = hatFiles(kind, 0);
    if (!names) return Promise.resolve(null);
    p = file(names[0]).then((d) => KirbyCopy.load(kind, d));
    p.catch(() => kirbyCopies.delete(kind));
    kirbyCopies.set(kind, p);
  }
  return p;
}

let effectKit: Promise<EffectKit> | undefined;

/** The effect art (effects3d.ts), loaded once per page. Each of its files is
 *  optional: one that cannot be read leaves its part out, never an error. */
export function effects(): Promise<EffectKit> {
  effectKit ??= (async () => {
    const kit = new EffectKit();
    const read = async (name: string, use: (b: ArrayBuffer) => void) => {
      try { const b = await file(name); timed("effects", name, () => use(b)); } catch (e) { console.warn(`3D replay viewer: no ${name} effects:`, e); }
    };
    await Promise.all([
      read("EfCoData.dat", (b) => kit.common(b)),
      read("PlCo.dat", (b) => kit.shared(b)),
    ]);
    return kit;
  })();
  return effectKit;
}

const fighterFx = new Map<number, Promise<boolean>>();

/** A fighter's own effect files (EfFxData for Fox and Falco, Kirby's and
 *  his copies'...), into the kit, once per page: the ones read (none when
 *  it has none or they cannot be read: its special moves then just show no
 *  effects of their own). */
export async function fighterEffects(kit: EffectKit, internalId: number): Promise<number[]> {
  // (Fox's and Falco's reflector models are in EfFxData: read for a replay that has one of them)
  const reflector = internalId === FOX || internalId === FALCO ? foxEffects(kit) : undefined;
  const got = await Promise.all(effectFilesOf(internalId).map((n) => effectFile(kit, n).then((ok) => (ok ? n : -1))));
  await reflector;
  return got.filter((n) => n >= 0);
}

const FOX = 1, FALCO = 22;
let foxEffectsP: Promise<void> | undefined;
/** EfFxData's reflector models into the kit, once per page */
function foxEffects(kit: EffectKit): Promise<void> {
  foxEffectsP ??= (async () => {
    try { const b = await file("EfFxData.dat"); timed("effects", "EfFxData reflector", () => kit.fox(b)); }
    catch (e) { console.warn("3D replay viewer: no EfFxData.dat effects:", e); }
  })();
  return foxEffectsP;
}

/** One of the game's effect files by its number (EFFECT_FILES), into the
 *  kit, once per page: whether it is in (a viewer track's pieces name the
 *  ones the game used, whoever's they are). */
export function effectFile(kit: EffectKit, n: number): Promise<boolean> {
  const f = EFFECT_FILES[n];
  if (!f) return Promise.resolve(false);
  if (kit.banks.has(n)) return Promise.resolve(true);
  let p = fighterFx.get(n);
  if (!p) {
    p = file(f.name).then((b) => { timed("effects", f.name, () => kit.fighter(n, f.table, b)); return true; })
      .catch((e) => { console.warn(`3D replay viewer: no ${f.name} effects:`, e); fighterFx.delete(n); return false; });
    fighterFx.set(n, p);
  }
  return p;
}

/** Ask for the files a replay needs now, from the first bytes of the .slp (its
 *  Game Start event): the stage, each player's fighter in their costume, the
 *  HUD and the effects, all at once and in the background. The loaders below
 *  share these reads, so the player finds them under way when the rest of the
 *  replay has been read (a replay's own read takes as long as the files'
 *  first wave, and nothing was asked for before it was done). Anything that
 *  cannot be read is left to the player, which says why when it needs it. */
export function prefetchReplay(head: ArrayBuffer) {
  let h: ReturnType<typeof replayHead>;
  try { h = replayHead(head); } catch { return; }
  if (!h) return;
  const ids = h.players.flatMap((p) => p.internal);
  const quiet = (p: Promise<unknown>) => { p.catch(() => {}); };
  mark("prefetchAsked");
  quiet(stage(h.stageId));
  for (const p of h.players) for (const id of p.internal) quiet(fighter(id, p.costume));
  quiet(hud());
  // (each fighter's own effect file: its bytes now, built once the common ones are)
  for (const id of ids) for (const n of effectFilesOf(id)) { const f = EFFECT_FILES[n]; if (f) quiet(file(f.name)); }
  quiet(effects().then((kit) => Promise.all(ids.map((id) => fighterEffects(kit, id)))));
}

let hudKit: Promise<HudKit> | undefined;

/** The HUD's art, loaded once per page: the English file an American disc
 *  plays (IfAll.usd: its tags read "P1", the Japanese file's "1P"), else the
 *  Japanese one; with the fighters' common numbers it times the player tags
 *  by (PlCo.dat, optional). */
export function hud(): Promise<HudKit> {
  hudKit ??= file("IfAll.usd").catch(() => file("IfAll.dat")).then(async (b) => {
    const kit = timed("hud", "IfAll", () => new HudKit(b));
    try { const pl = await file("PlCo.dat"); timed("hud", "PlCo", () => kit.common(pl)); } catch { /* the game's usual counts */ }
    // the plates' letters: the game's own font, from its executable (the canvas letters without it)
    // (from the executable's information, kept in the browser: the executable is read once for the table, the font and this)
    try { const text = (await executableInfo()).font; if (text) kit.plates = plateFontFromText(text); } catch { /* the canvas letters */ }
    return kit;
  });
  hudKit.catch(() => { hudKit = undefined; });
  return hudKit;
}

/** the screen flash's color animations (LbBf.dat's lbBgFlashColAnimData: fx/bgflash.ts), or null */
let bgFlashP: Promise<ColAnimTables | null> | undefined;
export function bgFlash(): Promise<ColAnimTables | null> {
  bgFlashP ??= file("LbBf.dat").then((b) => bgFlashTables(parseArchive(b)), () => null);
  return bgFlashP;
}

/** a stage's colors for the magnifier's background (its grGroundParam), or null */
export async function magnifierColors(stageId: number): Promise<[number, number, number][] | null> {
  const info = STAGES[stageId];
  if (!info) return null;
  try { return stageMagnifierColors(await file(`${info.file}.dat`)); } catch { return null; }
}

const stages = new Map<number, Promise<Stage>>();

export function stage(stageId: number): Promise<Stage> {
  let p = stages.get(stageId);
  if (!p) {
    const info = STAGES[stageId];
    if (!info) return Promise.reject(new Error(`no 3D model for this stage (${stageId})`));
    p = file(`${info.file}.dat`).then(async (b) => {
      const st = timed("stage", info.file, () => new Stage(b, stageId));
      // Pokemon Stadium: its four forms too, when the files can be read
      if (info.file === "GrPs") {
        // (all four asked for at once, added in order)
        const forms = Object.entries(STADIUM_FORMS).map(([type, name]) => {
          const bytes = file(`${name}.dat`);
          bytes.catch(() => {});
          return { type, name, bytes };
        });
        for (const { type, name, bytes } of forms) {
          try { const fb = await bytes; timed("stage", name, () => st.addForm(Number(type), fb)); } catch { /* the base stage stands */ }
        }
        // its big screen's text (sistext.ts)
        try { st.lettering = await stadiumLettering(b); } catch { /* the browser's lettering */ }
      }
      return st;
    });
    p.catch(() => stages.delete(stageId));
    stages.set(stageId, p);
  }
  return p;
}

/** Pokemon Stadium's screen's text: its pages and font from the English file an
 *  American disc plays (GrPs.usd), else the stage's own (the Japanese text), and
 *  the executable's font and tables (dol.ts) for what
 *  its code writes in; null when the file has no text table */
async function stadiumLettering(base: ArrayBuffer): Promise<Lettering | null> {
  let buf = base;
  try { buf = await file("GrPs.usd"); } catch { /* the stage's own */ }
  const a = parseArchive(buf), at = a.publics.get("SIS_GrPStadiumData");
  if (at === undefined) return null;
  const sis = parseSisFile(a.u8, at, (o) => ptr(a, o));
  if (!sis) return null;
  let common: SisCommon | null = null;
  try {
    const font = (await executableInfo()).font;
    if (font) common = parseSisCommon(font);
  } catch { /* the stage's own pages alone */ }
  return { file: sis, common };
}
