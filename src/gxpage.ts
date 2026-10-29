/* The replay player that draws with the game's own draw path (gx.html): melee-sim-light's graphics build plays the replay and runs the
 * game's display pass, and the GX renderer (render3d/gxr) draws what it sends. The page's default player stays the default; this
 * one is chosen by opening gx.html (embed.html?renderer=gx goes there).
 *
 * URL parameters: replayUrl, name, frame (game frame, -123 = first), files (the game files folder URL; the names it reads come from
 * sim-files.json beside the module, else the extraction's list), core (the module, default gx/gx-core.js), backend (gl, cpu),
 * speed, playback (slippi, original), pace (60, console), paused=1.
 * Messages in: {type: "load", url, name?, frame?}, {type: "seek", frame}, play, pause, toggle, {type: "gameFiles", files},
 * {type: "speed", speed}, {type: "playback", playback}, {type: "pace", pace}. Out: {type: "loaded", frames, playback, pace},
 * {type: "frame", frame, running}, {type: "renderer", renderer, reason}.
 */
import { decode } from "@shelacek/ubjson";
import { CpuBackend } from "./render3d/gxr/cpu";
import { gxMissing, gxNames, namesToRead, readGameFiles } from "./sim/gamefiles";
import type { GameFilesFrom } from "./sim/protocol";
import { readTape } from "./sim/tape";
import { isPlaybackMode, PLAYBACK_MODES, type GxCoreFactory, type PlaybackMode } from "./render3d/gxpath/core";
import { GxPlayback, isPace, PACES, SPEEDS, type Pace } from "./render3d/gxpath/playback";
import { ControllerOverlay, isOverlayShow, type OverlayShow } from "./render3d/gxpath/overlay";
import { GxScreen } from "./render3d/gxpath/screen";
import { CRT_PRESETS, CURVE_MAX, isCrtPreset, type CrtPreset } from "./render3d/crt";
import { GxSession, type GameFiles, type SessionBackend } from "./render3d/gxpath/session";
import { musicEnabled, sound, soundConfigured, soundState } from "./audio";
import { canExport, ExportCanceled, exportMp4, saveFile, videoName, type ExportOptions, type ExportScale } from "./render3d/gxpath/export";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
const FIRST_FRAME = -123;
const post = (m: object) => { if (window.parent !== window) window.parent.postMessage(m, "*"); };
const logLine = (s: string) => { try { void fetch("/log", { method: "POST", body: s }); } catch { /* no test server */ } };
let lastLogged = "";
const info = (s: string) => { $("info").textContent = s; const first = s.split(String.fromCharCode(10))[0]; if (first.startsWith("step ")) return; if (first !== lastLogged) { lastLogged = first; console.log("gx: " + first); } };

let playback: GxPlayback | null = null;
let glBackend: { present(): void; reset(): void } | null = null;
/** where the first load's time went, ms (the checks read it: window.__gx.loadTimes) */
const loadTimes: Record<string, number> = {};
let session: GxSession | null = null;
let filesFrom: GameFilesFrom | null = q.get("files") ? { kind: "url", base: new URL(q.get("files")!, location.href).href } : null;
const coreUrl = new URL(q.get("core") ?? "gx/gx-core.js", location.href).href;
let gameFiles: GameFiles | null = null;
const screen = new GxScreen($("view"));
const pads = new ControllerOverlay($("view"), () => session?.tape ?? null);
let padShow: OverlayShow = isOverlayShow(q.get("controllers")) ? (q.get("controllers") as OverlayShow) : "off";
let crtPreset: CrtPreset = isCrtPreset(q.get("crt")) ? (q.get("crt") as CrtPreset) : "off";
screen.setCrt(crtPreset);
let retryText: string | null = null;
let playbackMode: PlaybackMode = isPlaybackMode(q.get("playback")) ? (q.get("playback") as PlaybackMode) : "slippi";
let pace: Pace = isPace(q.get("pace")) ? (q.get("pace") as Pace) : "60";
let currentUrl: string | null = null;
let pending: { url: string; frame: number; play: boolean } | null = null;
const note = (s: string) => { $("filesnote").textContent = s; };

/** the game files from a picked folder (or files): checked for what the draw path needs, then used for the next load (and a waiting one) */
function setGameFiles(list: File[]) {
  const missing = gxMissing(list.map((f) => f.name));
  if (missing.length) {
    note(`These game files are missing from the folder: ${missing.join(", ")}`);
    return;
  }
  filesFrom = { kind: "files", list };
  gameFiles = null;
  note(`Game files found (${list.length} files in the folder). They are read here and never uploaded.`);
  const p = pending ?? (currentUrl ? { url: currentUrl, frame: session ? session.tape.gameFrame(Math.max(0, session.shown)) : FIRST_FRAME, play: false } : null);
  if (p) void loadReplay(p.url, p.frame, p.play).catch(fail);
}

/** every file under a picked folder (its subfolders too: an extracted disc keeps them in files/), by name, the first of a name kept */
async function folderFiles(dir: FileSystemDirectoryHandle, out = new Map<string, File>()): Promise<Map<string, File>> {
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === "file") { if (!out.has(entry.name)) out.set(entry.name, await (entry as FileSystemFileHandle).getFile()); }
    else await folderFiles(entry as FileSystemDirectoryHandle, out);
  }
  return out;
}

/** Playback is fixed from the replay's first frame: a change plays the replay again from the start, back to the frame shown */
function setPlaybackMode(m: PlaybackMode) {
  if (m === playbackMode) return;
  playbackMode = m;
  // (the sound plays the replay the same way: src/audio.ts sound.playback)
  sound.playback(m, Math.max(0, session?.shown ?? 0));
  showButtons();
  if (!currentUrl || !session) return;
  const frame = session.tape.gameFrame(Math.max(0, session.shown)), wasPlaying = playback?.playing ?? false;
  void loadReplay(currentUrl, frame, wasPlaying).catch(fail);
}
function setPace(p: Pace) { pace = p; playback?.setPace(p); showButtons(); }

async function makeBackend(env: ConstructorParameters<typeof CpuBackend>[0]): Promise<SessionBackend> {
  // (one WebGL renderer for the page: a replay loaded again, or played again for another playback setting, reuses its context and shaders)
  if (glBackend) { glBackend.reset(); return glBackend as unknown as SessionBackend; }
  if (q.get("backend") !== "cpu") {
    try {
      const { GxGl } = await import("./render3d/gxr/gl");
      // (no multisampling: the picture is blitted onto the canvas as it is, and a blit into a multisampled canvas is refused - the
      // picture stayed black; the canvas keeps it between frames, for the video export and a paused player)
      const gl = screen.glFlat.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: false });
      if (gl) {
        const b = new GxGl(gl, {}, { workers: Math.max(0, Number(q.get("workers") ?? Math.min(3, Math.max(0, (navigator.hardwareConcurrency || 4) - 2)))) });
        info("preparing the renderer (the first time in this browser this can take a minute)...");
        const t = performance.now();
        await b.prepare();
        loadTimes.shaders = performance.now() - t;
        // (the optional shader variants compile in the background: a draw that needs one waits for it)
        void b.warm();
        glBackend = b;
        screen.setGlMode(true);
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        console.log("gx: GL renderer " + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown"));
        post({ type: "renderer", renderer: "gx-gl", reason: null });
        return b as unknown as SessionBackend;
      }
      post({ type: "renderer", renderer: "gx-cpu", reason: "WebGL 2 is not available" });
    } catch (e) {
      post({ type: "renderer", renderer: "gx-cpu", reason: String((e as Error)?.message ?? e) });
    }
  } else post({ type: "renderer", renderer: "gx-cpu", reason: null });
  return new CpuBackend(env as never) as unknown as SessionBackend;
}

async function loadReplay(url: string, frame: number, play = q.get("paused") !== "1" && frame === FIRST_FRAME) {
  playback?.pause();
  session?.close();
  const t0 = performance.now(), mark = (k: string) => { loadTimes[k] = performance.now() - t0; };
  info("reading the replay...");
  const res = await fetch(url);
  // (a replay the server does not have is said as that, not as the bytes of its error page failing to decode)
  if (!res.ok) throw new Error(`the replay could not be read: HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // (another replay: sound off, and the next start opens this one; the same one played again in another Playback keeps it)
  if (url !== currentUrl) { sound.load(new Blob([bytes as unknown as BlobPart])); sound.playback(playbackMode); }
  const parsed = decode(bytes, { useTypedArrays: true }) as { raw: Uint8Array; metadata?: { playedOn?: string } };
  // (a replay from before Slippi 3.17 records the C-stick only after the game processed it: the simulator plays it as Slippi's playback
  // does, or, for Original, works out the raw bytes the console had from the recorded positions: session.ts, cfit.ts)
  const tape = readTape(parsed.raw, parsed.metadata, { stadiumTransformations: true });
  mark("replay");
  if (!filesFrom) {
    // (the replay waits for the game files: the folder picker loads it once they are there)
    pending = { url, frame, play };
    note("Choose the folder of game files extracted from your copy of the game to play this replay.");
    info("waiting for the game files");
    return;
  }
  pending = null;
  if (!gameFiles) {
    info("reading the game files...");
    // (a picked folder: the names the draw path reads, from what is in it; a folder by URL: the module's own list beside it)
    const names = filesFrom.kind === "files" ? gxNames(filesFrom.list.map((f) => f.name)) : await namesToRead(filesFrom, new URL("sim-files.json", coreUrl).href);
    gameFiles = { names, files: await readGameFiles(filesFrom, names) };
  }
  mark("gameFiles");
  info("starting the simulator...");
  const factory = (await import(/* @vite-ignore */ coreUrl)).default as GxCoreFactory;
  session = new GxSession({
    factory, coreOptions: { locateFile: (p: string) => new URL(p, coreUrl).href }, files: gameFiles, tape,
    makeBackend, playback: playbackMode, onProgress: (text) => { if (text) info(text + "..."); },
  });
  session.setPictures(true);
  await session.warmup();
  mark("warmedUp");
  session.setPictures(screen.needsPixels);
  playback = new GxPlayback(session, {
    onPicture: (rgba) => screen.show(rgba),
    onShown: () => { if (glBackend && !screen.needsPixels) glBackend.present(); },
    onState: update,
    onError: fail,
    onRetry: (text) => { retryText = text; update(); },
  });
  // with sound on, the picture shows the frame being heard (src/audio.ts sound.frame); every seek and step goes to the sound too
  playback.follow = () => sound.frame();
  wireSound(playback);
  playback.setSpeed(Number(q.get("speed") ?? 1) || 1);
  playback.setPace(pace);
  currentUrl = url;
  post({ type: "loaded", frames: tape.count, playback: playbackMode, pace });
  (window as unknown as { __gx: object }).__gx = { session, playback };
  await playback.seek(Math.max(0, frame - FIRST_FRAME));
  mark("firstFrame");
  (window as unknown as { __gx: { loadTimes?: object } }).__gx.loadTimes = { ...loadTimes };
  logLine("load " + JSON.stringify(loadTimes));
  if (q.get("bench")) void bench(session);
  if (q.get("harness")) {
    const names = q.get("harness")!.split(",");
    const { runHarness } = await import("./render3d/gxpath/harness");
    const msg = await runHarness(session, names, (w) => replayUrl !== null && w.startsWith(replayUrl.split("/").pop()!.replace(/\.slp$/, "") + "-"));
    await fetch("/done", { method: "POST", body: "ok " + msg });
    return;
  }
  if (play) playback.play();
  pads.set(padShow, you);
  update();
}

let you: number | null = null;
function update() {
  const p = playback, s = session;
  if (!p || !s) return;
  $("play").textContent = p.playing ? "Pause" : p.ended ? "Replay" : "Play";
  $("play").setAttribute("aria-pressed", String(p.playing));
  const row = Math.max(0, s.shown);
  $("seekfill").style.width = `${(100 * row) / Math.max(1, s.frameCount - 1)}%`;
  const gf = s.tape.gameFrame(row);
  pads.update(row);
  $("where").textContent = `frame ${gf} (${row + 1} / ${s.frameCount})`;
  document.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === p.speed)));
  const T = s.totals, n = Math.max(1, T.frames);
  info(
    `step ${s.times.step.toFixed(2)} ms  hand-off ${s.times.handoff.toFixed(2)} ms  render ${s.times.render.toFixed(2)} ms` +
    `  (means ${(T.step / n).toFixed(2)} / ${(T.handoff / n).toFixed(2)} / ${(T.render / n).toFixed(2)})` +
    `\nstream ${(T.streamBytes / n / 1024).toFixed(0)} KiB a frame, memory sent ${(T.regionBytes / 1048576).toFixed(1)} MiB, simulator heap ${(s.memoryBytes / 1048576).toFixed(0)} MiB` +
    (retryText ? `\n${retryText}` : s.diverged ? `\nthe game parts from the replay at frame ${s.diverged.frame} (${s.diverged.lane})` : "") +
    (s.drivesTried.length > 1 ? `\nsettings tried: ${s.drivesTried.map((d) => `${d.index + 1} held to row ${d.row}`).join(", ")}; playing ${s.driveIndex + 1}` : ""),
  );
  post({ type: "frame", frame: gf, running: p.playing });
  // playing or paused, the frame and the speed (1 = the game's 60), told to the sound
  sound.transport(p.playing, row, p.speed * (pace === "console" ? 60000 / 1001 : 60) / 60);
  showSound();
}

// ---- Sound (src/audio.ts): only with a host's configuration; a seek, a step, play, pause and speed go to its player, and while it plays
// the picture follows what is heard. Its errors turn it off; play goes on with the page's own clock.
function wireSound(p: GxPlayback) {
  const seek = p.seek.bind(p), forward = p.stepForward.bind(p);
  p.seek = (row: number) => { sound.seek(Math.max(0, Math.min(row, (session?.frameCount ?? 1) - 1))); return seek(row); };
  p.stepForward = () => { forward(); sound.seek(Math.max(0, session?.shown ?? 0)); };
}
function showSound() {
  if (!soundConfigured) return;
  const st = soundState();
  $("sound").hidden = false;
  $("music").hidden = st !== "on";
  $("sound").textContent = `Sound: ${st === "on" ? "On" : st === "loading" ? "Starting" : st === "error" ? "Off (it stopped)" : "Off"}`;
  $("sound").setAttribute("aria-pressed", String(st === "on"));
  $("music").textContent = `Music: ${musicEnabled() ? "On" : "Off"}`;
}
$("sound").onclick = () => {
  if (!session || !playback) return;
  if (soundState() === "on" || soundState() === "loading") { sound.disable(); showSound(); return; }
  const row = Math.max(0, session.shown);
  sound.seek(row);
  sound.transport(playback.playing, row, playback.speed * (pace === "console" ? 60000 / 1001 : 60) / 60);
  void sound.enable().then(showSound, showSound);
  showSound();
};
$("music").onclick = () => { sound.music(!musicEnabled()); showSound(); };
if (soundConfigured) setInterval(showSound, 500);

function fail(e: unknown) {
  const text = String((e as Error)?.stack ?? e);
  info("error: " + text);
  logLine("error: " + text);
}

const label = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const showButtons = () => {
  $("crt").textContent = `TV: ${label(crtPreset)}`;
  $("pads").textContent = `Controllers: ${label(padShow)}`;
  $("playback").textContent = `Playback: ${label(playbackMode)}`;
  $("pace").textContent = `Speed: ${pace === "console" ? "Console (59.94)" : "60"}`;
};
showButtons();
$("crt").onclick = () => { crtPreset = CRT_PRESETS[(CRT_PRESETS.indexOf(crtPreset) + 1) % CRT_PRESETS.length]; screen.setCrt(crtPreset, crtPreset === "off" ? 0 : undefined); session?.setPictures(screen.needsPixels); showButtons(); };
const PAD_CHOICES: OverlayShow[] = ["off", "both", "left", "right"];
$("pads").onclick = () => { padShow = PAD_CHOICES[(PAD_CHOICES.indexOf(padShow) + 1) % PAD_CHOICES.length]; pads.set(padShow, you); if (session) pads.update(Math.max(0, session.shown)); showButtons(); };
$("playback").onclick = () => setPlaybackMode(PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(playbackMode) + 1) % PLAYBACK_MODES.length]);
$("pace").onclick = () => setPace(PACES[(PACES.indexOf(pace) + 1) % PACES.length]);
$("pickfolder").onclick = async () => {
  const pick = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!pick) { $<HTMLInputElement>("pickfiles").click(); return; }
  try {
    note("Reading the folder...");
    setGameFiles([...(await folderFiles(await pick({ mode: "read" }))).values()]);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") { note(""); return; }
    $<HTMLInputElement>("pickfiles").click(); // (a browser that refuses the folder picker here: the file input instead)
  }
};
$<HTMLInputElement>("pickfiles").onchange = (e) => {
  const list = [...((e.target as HTMLInputElement).files ?? [])];
  const byName = new Map<string, File>();
  for (const f of list) if (!byName.has(f.name)) byName.set(f.name, f);
  if (byName.size) setGameFiles([...byName.values()]);
};
if (filesFrom) note("Game files from the given folder address.");
$("play").onclick = () => playback?.toggle();
$("fwd").onclick = () => playback?.stepForward();
$("back").onclick = () => { void playback?.stepBack(); };
$("seek").onclick = (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (session && playback) void playback.seek(Math.round(((e.clientX - r.left) / r.width) * (session.frameCount - 1)));
};
for (const s of SPEEDS) {
  const b = document.createElement("button");
  b.textContent = `${s}x`;
  b.dataset.speed = String(s);
  b.onclick = () => playback?.setSpeed(s);
  $("speeds").append(b);
}
document.addEventListener("keydown", (e) => {
  if (e.key === " ") { playback?.toggle(); e.preventDefault(); }
  else if (e.key === "ArrowRight") playback?.stepForward();
  else if (e.key === "ArrowLeft") void playback?.stepBack();
});
window.addEventListener("message", (e) => {
  const m = e.data as { type?: string; [k: string]: unknown };
  if (!m || typeof m.type !== "string") return;
  switch (m.type) {
    case "load": void loadReplay(String(m.url), typeof m.frame === "number" ? m.frame : FIRST_FRAME).catch(fail); break;
    case "gameFiles": setGameFiles(m.files as File[]); break;
    case "seek": if (playback && typeof m.frame === "number") void playback.seek(m.frame - FIRST_FRAME); break;
    case "play": playback?.play(); break;
    case "pause": playback?.pause(); break;
    case "toggle": playback?.toggle(); break;
    case "crt":
      if (isCrtPreset(m.crt)) { crtPreset = m.crt; const c = Number(m.curve); screen.setCrt(crtPreset, Number.isFinite(c) ? Math.min(CURVE_MAX, Math.max(0, c)) : undefined); session?.setPictures(screen.needsPixels); showButtons(); }
      break;
    case "controllers":
      if (isOverlayShow(m.show)) { padShow = m.show; const n = Number(m.you); you = Number.isInteger(n) && n >= 1 && n <= 4 ? n - 1 : null; pads.set(padShow, you); if (session) pads.update(Math.max(0, session.shown)); showButtons(); }
      break;
    case "hudslots":
      // (the HUD is the game's own, in the slots the game puts it: only the game's layout exists here)
      post({ type: "hudslots", slots: "game", note: "the HUD is drawn by the game, in its own slots" });
      break;
    case "speed": if (typeof m.speed === "number") playback?.setSpeed(m.speed); break;
    case "playback": if (isPlaybackMode(m.playback)) setPlaybackMode(m.playback); break;
    case "pace": if (isPace(m.pace)) setPace(m.pace); break;
  }
});
const replayUrl = q.get("replayUrl");
if (replayUrl) void loadReplay(replayUrl, Number(q.get("frame") ?? FIRST_FRAME)).catch(fail);
else info("waiting for a replay: replayUrl=<url> or a {type: \"load\"} message");

/** ?bench=1 (a measuring run, for the checks): every row of the replay stepped and drawn as fast as the page can, the per-row times posted to /bench;
 *  with hash=1 also each row's stream hash as the native recorder prints it (streamhash.ts) */
async function bench(s: GxSession) {
  const total: number[] = [], render: number[] = [], step: number[] = [], hashes: string[] = [];
  const frameHash = q.get("hash") ? (await import("./render3d/gxpath/streamhash")).frameHash : null;
  s.setPictures(false);
  await s.start();
  const t0 = performance.now();
  while (s.index < s.frameCount) {
    const t = performance.now();
    while (performance.now() - t < 1 && s.index < s.frameCount) {
      const a = performance.now();
      s.step(true);
      if (glBackend) glBackend.present();
      total.push(performance.now() - a);
      if (frameHash) hashes.push(frameHash(s.core_!));
      step.push(s.times.step);
      render.push(s.times.render);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  const body = JSON.stringify({ rows: total.length, seconds: (performance.now() - t0) / 1000, isolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true, total, step, render, wasmHeap: s.memoryBytes, jsHeap: heap, diverged: s.diverged, playback: s.playback, hashes, loadTimes, pool: (s as unknown as { backend?: { poolStats?: unknown } }).backend?.poolStats ?? null });
  await fetch("/bench", { method: "POST", body });
}

// ---- Export Video: the whole game or a stretch of game frames, drawn offscreen frame by frame (export.ts) ----

/** rows drawn before a stretch's first row (after the fast-forward): the screens that show the game's own earlier pictures are filled */
const EXPORT_LEAD = 30;
let exporting: AbortController | null = null;
const exportName = () => (q.get("name") ?? currentUrl?.split("/").pop()?.split("?")[0] ?? "replay");

/** the match at row `row`, its picture on the renderer's canvas: from the start when it is behind, the rows before played through
 *  without drawing (fast-forward), the last EXPORT_LEAD drawn */
async function seekForExport(row: number): Promise<void> {
  const s = session!;
  if (s.needsRestart(row)) await s.start();
  while (!s.seekStep(row, 50, EXPORT_LEAD)) await new Promise((r) => setTimeout(r, 0));
  glBackend?.present();
}

/** a video of rows from..to as the player draws them now (Playback, Speed, TV); the bytes and what it took */
async function makeVideo(from: number, to: number, scale: ExportScale, extra: Partial<ExportOptions> = {}) {
  const s = session!, p = playback!;
  const back = Math.max(0, s.shown), wasPlaying = p.playing;
  p.pause();
  const pics = s.setPictures.bind(s);
  // (the CPU renderer's picture comes as pixels: shown on the flat canvas, which is then the source)
  if (!glBackend) { pics(true); s.onPicture = (rgba) => screen.show(rgba); }
  const source = glBackend ? screen.glFlat : screen.flat;
  try {
    return await exportMp4({
      from, to, scale, fps: pace === "console" ? 60000 / 1001 : 60,
      tv: crtPreset === "off" ? undefined : { preset: crtPreset, curve: screen.curveNow },
      source,
      seek: seekForExport,
      next: () => { const before = s.shown; s.step(true); glBackend?.present(); return s.shown !== before; },
      ...extra,
    });
  } finally {
    // (back to where the player was)
    s.setPictures(screen.needsPixels);
    await p.seek(back);
    if (wasPlaying) p.play();
  }
}

const exportState = (t: string) => { $("exportstate").textContent = t; };
$("export").onclick = () => {
  const box = $("exportbox"), open = box.hidden;
  box.hidden = !open;
  $("export").setAttribute("aria-expanded", String(open));
  if (open && session) {
    // (a stretch from the frame shown, ten seconds long, unless one was typed)
    const gf = session.tape.gameFrame(Math.max(0, session.shown));
    if (!$<HTMLInputElement>("exportfrom").value) $<HTMLInputElement>("exportfrom").value = String(gf);
    if (!$<HTMLInputElement>("exportto").value) $<HTMLInputElement>("exportto").value = String(Math.min(gf + 599, session.tape.gameFrame(session.frameCount - 1)));
  }
  if (!canExport()) { exportState("This browser cannot make videos (it has no WebCodecs)."); $<HTMLButtonElement>("exportstart").disabled = true; }
};
$("exportstart").onclick = async () => {
  if (!session || !playback || exporting) return;
  const whole = document.querySelector<HTMLInputElement>('input[name="what"]:checked')!.value === "game";
  const scale = Number(document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value) as ExportScale;
  const last = session.frameCount - 1;
  let from = 0, to = last;
  if (!whole) {
    from = Number($<HTMLInputElement>("exportfrom").value) - FIRST_FRAME;
    to = Number($<HTMLInputElement>("exportto").value) - FIRST_FRAME;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > last || to < from) {
      exportState(`Give two game frames from ${FIRST_FRAME} to ${session.tape.gameFrame(last)}, the first not after the second.`);
      return;
    }
  }
  exporting = new AbortController();
  $<HTMLButtonElement>("exportstart").disabled = true;
  $("exportcancel").hidden = false;
  const t0 = performance.now();
  try {
    exportState("Getting to the first frame...");
    const r = await makeVideo(from, to, scale, {
      signal: exporting.signal,
      onProgress: (done, total) => exportState(`Frame ${done} of ${total}...`),
    });
    saveFile(r.file, videoName(exportName(), whole ? undefined : session.tape.gameFrame(from), whole ? undefined : session.tape.gameFrame(to)));
    exportState(`Saved: ${r.frames} frames, ${r.width} x ${r.height}, ${(r.file.size / 1048576).toFixed(1)} MB, in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  } catch (e) {
    exportState(e instanceof ExportCanceled ? "Canceled." : `The video could not be made: ${String((e as Error)?.message ?? e)}`);
  } finally {
    exporting = null;
    $<HTMLButtonElement>("exportstart").disabled = false;
    $("exportcancel").hidden = true;
  }
};
$("exportcancel").onclick = () => exporting?.abort();
// (for the checks: a video made the page's way, with the checks' hooks)
(window as unknown as { __gxExport: object }).__gxExport = {
  makeVideo, seekForExport, get screen() { return screen; }, get glBackend() { return glBackend; },
  /** the checks (exportcheck.ts) on rows from..to at a size, with the page's settings */
  async check(from: number, to: number, scale: ExportScale, sample?: number, bitrate?: number) {
    if (!session || !(from >= 0 && to >= from && to < session.frameCount)) throw new Error(`rows ${from}-${to} are not all in the replay (${session?.frameCount} rows)`);
    const { checkExport } = await import("./render3d/gxpath/exportcheck");
    const s = session!, b = glBackend as unknown as { picture(): Uint8Array | null };
    return await checkExport({
      reference: async (last, onRow) => {
        playback!.pause();
        await s.start();
        let t = performance.now();
        while (s.index <= last) {
          const row = s.index;
          if (!s.step(true)) break;
          const pic = s.shown === row ? b.picture() : null;
          if (pic) onRow(row, pic);
          if (performance.now() - t > 50) { await new Promise((r) => setTimeout(r, 0)); t = performance.now(); }
        }
      },
      make: (hooks) => makeVideo(from, to, scale, { ...hooks, bitrate }),
    }, { from, to, scale, fps: pace === "console" ? 60000 / 1001 : 60, sample });
  },
};