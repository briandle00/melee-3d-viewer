/* The embeddable replay player: the Slippi Lab viewer, driven by the page
 * that embeds it (or by its URL), drawing with the game's own models when it
 * can and with Slippi Lab's line art when asked to.
 *
 * Which viewer: the 3D one, read from your own game files (render3d/files.ts:
 * a game/ folder beside the page, ?files=<url>, or files handed over with a
 * {type: "gameFiles"} message). ?renderer=svg or ?renderer=3d in the URL
 * chooses (3D by default). If the 3D viewer cannot run here at all (no game
 * files, no WebGL 2) it says why where the picture would be; if it fails to
 * load or draw something it tries again on its own.
 *
 * URL parameters: replayUrl, name, frame (game frame, -123 = first),
 * trackUrl (the replay's viewer track), files, renderer, zoom, look=480,
 * crt=<off|trinitron|pvm>, renderer=gx (the game's own draw path: gx.html), controllers=<both|left|right|you|opponent|off>,
 * you=<port 1-4>, hudslots=<outer|game>, mini=1, sim=1 (the simulator makes
 * the viewer track in the browser when none is given: src/sim/feed.ts).
 *
 * Messages in (window.postMessage from the parent):
 *   {type: "load", url, name?, frame?, trackUrl?}
 *                                        load a replay; frame is the game
 *                                        frame (-123 = first), paused there;
 *                                        trackUrl its viewer track (the JSON
 *                                        the simulator writes), if any
 *   {type: "gameFiles", files}           read the game files from these File
 *                                        objects (a folder picker's) from now on
 *   {type: "seek", frame}                jump to a game frame
 *   {type: "ghosts", ghosts: [{url, label, color}]}
 *                                        draw these replays over this one,
 *                                        frame for frame (simulated branches)
 *   {type: "range", start, end}          play/seek only between these game
 *                                        frames, looping; start null = all
 *   {type: "play"} / {type: "pause"} / {type: "toggle"}
 *   {type: "renderer", renderer}         draw in 3D ("3d") or the simple
 *                                        line art ("svg") from now on, the
 *                                        replay kept where it is
 *   {type: "look", look480}              the 3D player's 480p look on (true)
 *                                        or off, on the spot
 *   {type: "view", view}                 one view choice, on the spot:
 *                                        "simple", "3d" or "console" (3D
 *                                        with the 480p look)
 *   {type: "crt", crt, curve}            the TV the Console view is shown
 *                                        on, on the spot: "off",
 *                                        "trinitron" or "pvm" (crt.ts),
 *                                        and how much its tube curves (0
 *                                        flat to CURVE_MAX)
 *   {type: "controllers", show, you?}    the Controller overlay, on the spot,
 *                                        in every view: whose controllers
 *                                        ("both", "left", "right", "you",
 *                                        "opponent" or "off"; you: the port,
 *                                        1-4, that is "you") (Controllers.tsx)
 *   {type: "hudslots", slots}            the HUD Slots option, on the spot,
 *                                        in every view: "outer" (two players
 *                                        in slots 1 and 4, the default) or
 *                                        "game" (each in their port's slot)
 *                                        (hudslots.ts; ?hudslots= starts
 *                                        with it)
 *   {type: "sim", on}                    the simulator makes the viewer track
 *                                        in the browser (on), for the replay
 *                                        shown and the ones after, when the
 *                                        page gave none (src/sim/feed.ts)
 *
 * The picture is always the game's own shape (73:60, GameFrame), centered in
 * whatever box the page gives it.
 *
 * Messages out (to the parent):
 *   {type: "frame", frame, running}      whenever the frame changes
 *   {type: "loaded", frames}             after a replay is ready
 *   {type: "failed", reason, retry}      a replay asked for cannot be shown:
 *                                        not fetched, not read, or not one
 *                                        this viewer plays (the player says
 *                                        the same where the picture would be,
 *                                        with Try Again unless retry is
 *                                        "none"; "auto": it asks again by
 *                                        itself every few seconds)
 *   {type: "renderer", renderer, reason} which viewer is drawing ("3d" or
 *                                        "svg") and, when 3D cannot run, why
 *   {type: "track", state}               the viewer track: "ready",
 *                                        "pending" or "none"
 *   {type: "sim", state, until, last, rate, firstFrameMs, firstTrackMs, reason}
 *                                        how the simulator stands, while on
 *                                        (src/sim/feed.ts SimStatus)
 *   {type: "warming"}                    the 3D player is warming up
 *   {type: "viewKey"}                    V pressed on the player: the page
 *                                        may move every player to the next view
 *   {type: "fullKey", how}               F ("screen"), W or Shift+F
 *                                        ("window") or Esc ("leave") pressed
 *                                        on the player: the page may make it
 *                                        Full Screen or Full Window, or leave
 *                                        either (the picture follows its new
 *                                        size: render3d/drawsize.ts; the dev
 *                                        page does this)
 */
import "~/icons.css";
import { render } from "solid-js/web";
import { batch, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Viewer } from "~/components/viewer/Viewer";
import { fileStore, load } from "~/state/fileStore";
import { localLibrary } from "~/state/selectionStore";
import {
  jump,
  setZoom,
  pause,
  replayStore,
  setGhosts,
  setLineArt,
  setRange,
  togglePause,
} from "~/state/replayStore";
import { parseReplay } from "~/parser/parser";
import { decode } from "@shelacek/ubjson";
import { look480, setCrtCurve, setCrtPreset, setLook480, Viewer3D } from "~/render3d/Viewer3D";
import { CURVE_MAX, isCrtPreset } from "~/render3d/crt";
import { Controllers } from "~/components/viewer/Controllers";
import { isOverlayShow, type OverlayShow } from "~/viewer/controllerInputs";
import { isHudSlots, setHudSlotsMode } from "~/common/hudslots";
import { diagLoaded, diagLoading, diagRunning, diagView } from "~/diag";
import { fileListSource, prefetchReplay, setFileSource, setTrackUrl, status } from "~/render3d/files";
import { simAsked, simForReplay } from "~/sim/embed";
import { mark } from "~/render3d/startup";
import { askedMode, chooseMode, fetchProblem, problemNote, readProblem, waitingText, type LoadProblem, type Mode } from "~/embedmode";
import { AGAIN_MS, fetchRetry, whenBack } from "~/render3d/net";
import { precompilePrograms } from "~/render3d/renderer";
import "~/state/fileStore";
import "~/state/replayStore";
import "~/state/selectionStore";

// ?renderer=gx: the replay drawn by the game's own draw path (gx.html, src/gxpage.ts), an option next to the default player
if (new URLSearchParams(location.search).get("renderer") === "gx") location.replace("gx.html" + location.search + location.hash);
// (the 3D player's programs compile while the replay is fetched and read)
const LINE_ART = new URLSearchParams(location.search).get("renderer") === "svg";
if (!LINE_ART) precompilePrograms();

const FIRST_FRAME = -123;
// asks again whether 3D can run (after game files were handed over)
let recheck: () => void = () => {};
// the renderer the page has asked for since this one opened (null: the setting's)
const [asked, setAsked] = createSignal<"3d" | "svg" | null>(null);
// the 480p look: the page asked (a {type: "look"}) or the URL says (?look=)
// since this one opened, so the setting read at the start does not undo it
let lookAsked = new URLSearchParams(location.search).has("look");
// the same for the Console view's TV (a {type: "crt"}, or ?crt=)
let crtAsked = new URLSearchParams(location.search).has("crt");
// (a curve as the page sent it: a number from flat to the most, else flat)
const curveOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(CURVE_MAX, Math.max(0, v)) : 0);
// and the Controller overlay: whose, and your code (a {type: "controllers"}, or ?controllers=)
const shownIn = new URLSearchParams(location.search).get("controllers");
let controllersAsked = shownIn !== null;
const [overlay, setOverlay] = createSignal<OverlayShow>(isOverlayShow(shownIn) ? shownIn : "off");
// (which port is you in the replay shown, 0-3: ?you=<1-4> or the controllers message)
const portOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 4 ? n - 1 : null; };
const [you, setYou] = createSignal<number | null>(portOf(new URLSearchParams(location.search).get("you")));
const MINI = new URLSearchParams(location.search).get("mini") === "1";
// where the replay shown was loaded from
const [source, setSource] = createSignal<string | null>(null);
const toIndex = (frame: number) => Math.max(0, frame - FIRST_FRAME);

function post(message: object) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}

// A seek that arrives while a replay is still loading is kept and applied
// once it is in: otherwise the load, finishing later, puts the frame back to
// where it started and the page is told a frame nobody asked for (a page that
// opens a game and seeks straight away - the mixup explorer - lost its seek).
// A play asked for meanwhile is kept too: it plays once the replay is in.
let loading = false;
// (the same, for what the player says: "Loading replay…")
const [loadingNow, setLoadingNow] = createSignal(false);
let seekAfterLoad: number | null = null;
let playAfterLoad = false;
// the viewer track the page gave for the replay shown (the simulator makes none then)
let givenTrack: string | null = null;

// The replay asked for last, and why it is not shown (null: it is, or it is on its way), said where the picture would be. Its fetch
// is asked again over a few seconds when it gets no answer (render3d/net.ts fetchRetry); when that was not enough the player says so
// with Try Again, and asks again by itself every few seconds and whenever the page may fetch again (back online, shown again). A
// replay the server says is not there (404) is asked again only by Try Again. One failed request left the player on "No replay
// loaded" for good, its Play button running a clock over nothing.
const [problem, setProblem] = createSignal<LoadProblem | null>(null);
// (a try under way while a problem is shown: its note says so)
const [trying, setTrying] = createSignal(false);
let lastAsk: { url: string; name: string; frame?: number; trackUrl?: string | null } | null = null;
let loadSeq = 0;
let loadStop: AbortController | null = null;
let againTimer = 0;
const againLater = () => { clearTimeout(againTimer); againTimer = setTimeout(() => loadAgain(false), AGAIN_MS) as unknown as number; };
function failed(p: LoadProblem) {
  loading = false; setLoadingNow(false);
  playAfterLoad = false;
  pause();
  batch(() => { setTrying(false); setProblem(p); });
  post({ type: "failed", reason: p.text, retry: p.retry });
  clearTimeout(againTimer);
  if (p.retry === "auto") againLater();
}
/** the replay asked for last, asked again (pressed: Try Again; else by itself, only for a failure that may pass and while the page
 *  can be seen) */
function loadAgain(pressed: boolean) {
  const p = problem(), a = lastAsk;
  if (!p || !a || trying()) return;
  if (!pressed && p.retry !== "auto") return;
  if (!pressed && document.visibilityState !== "visible") { againLater(); return; }
  void loadUrl(a.url, a.name, a.frame, a.trackUrl);
}
whenBack(() => loadAgain(false));

async function loadUrl(url: string, name: string, frame?: number, trackUrl?: string | null) {
  const mine = ++loadSeq;
  loadStop?.abort();
  const stop = (loadStop = new AbortController());
  clearTimeout(againTimer);
  // (the same replay asked again keeps its problem on show, saying it is trying, until it is in; another one starts afresh)
  const again = lastAsk !== null && lastAsk.url === url && problem() !== null;
  lastAsk = { url, name, frame, trackUrl };
  loading = true; setLoadingNow(true);
  // (a seek asked while it failed is kept for the try again)
  if (!again) seekAfterLoad = null;
  if (again) setTrying(true);
  else batch(() => { setProblem(null); setTrying(false); });
  setTrackUrl(url, trackUrl ?? null);
  givenTrack = trackUrl ?? null;
  simForReplay(url, givenTrack);
  try {
    await loadReplay(url, name, frame, stop.signal);
  } catch (e) {
    if (mine !== loadSeq) return;
    failed(fetchProblem(e));
  }
}

async function loadReplay(url: string, name: string, frame: number | undefined, signal: AbortSignal) {
  mark("replayRequested");
  diagLoading();
  // (asked again over a few seconds when there is no answer; a replay the server does not have is said as that, not as the bytes of
  // its error page failing to read)
  const res = await fetchRetry(url, undefined, { signal });
  const blob = await res.blob();
  if (signal.aborted) return;
  // (the game's files are asked for now, while the replay is read)
  void blob.slice(0, 2048).arrayBuffer().then((head) => { if (!LINE_ART) prefetchReplay(head); }).catch(() => {});
  const start = frame === undefined ? 0 : toIndex(frame);
  // (the replay before's viewer track goes before this one's frames come in: a simulated run watched in its
  // game's place was drawn for a moment with the game's own track, its fighters in the game's animations)
  if (source() !== url) setSource(null);
  // a start frame > 0 keeps it paused there (Slippi Lab's own behavior)
  await load([new File([blob], name)], start === 0 ? 1 : start);
  if (signal.aborted) return;
  mark("replayParsed");
  const stub = fileStore.stubs[0];
  // (not read, or not one these players play: said, rather than "Reading replay…" for good)
  if (stub === undefined) { failed(readProblem({ failed: fileStore.failed.length, skipped: fileStore.skipped, loaded: 0 })!); return; }
  await localLibrary.select(stub);
  if (signal.aborted) return;
  batch(() => { setProblem(null); setTrying(false); });
  // (once it is in: the 3D viewer finds its viewer track by it)
  setSource(url);
}

let ghostRequest = 0;
// parsed runs, kept by url: turning one off and on again mid-loop should not
// fetch and parse it a second time
const ghostCache = new Map<string, ReturnType<typeof parseReplay>>();
async function loadGhosts(list: { url: string; label?: string; color?: string }[]) {
  const mine = ++ghostRequest;
  // (each asked again over a few seconds when there is no answer; one that still cannot be had or read is left out, the others drawn)
  const ghosts = await Promise.all(
    list.map(async (g) => {
      let replayData = ghostCache.get(g.url);
      if (replayData === undefined) {
        try {
          const buf = await (await fetchRetry(g.url)).arrayBuffer();
          replayData = parseReplay(decode(buf, { useTypedArrays: true }));
        } catch (e) {
          console.warn("replay drawn over this one: left out:", g.url, e);
          return null;
        }
        ghostCache.set(g.url, replayData);
      }
      return {
        replayData,
        label: g.label ?? "",
        color: g.color ?? "#7c3aed",
      };
    })
  );
  if (mine === ghostRequest) setGhosts(ghosts.filter((g): g is NonNullable<typeof g> => g !== null));
}

window.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") return;
  switch (m.type) {
    case "load":
      void loadUrl(m.url, m.name ?? "replay.slp", m.frame, typeof m.trackUrl === "string" ? m.trackUrl : null);
      break;
    case "gameFiles":
      if (Array.isArray(m.files)) { setFileSource(fileListSource(m.files.filter((f: unknown) => f instanceof File))); recheck(); }
      break;
    case "seek":
      if (loading || problem()) seekAfterLoad = toIndex(m.frame);
      else jump(toIndex(m.frame));
      break;
    case "ghosts":
      void loadGhosts(m.ghosts ?? []);
      break;
    case "range":
      setRange(m.start === null || m.start === undefined ? undefined
               : [toIndex(m.start), toIndex(m.end)]);
      break;
    // (no replay in, or another on its way: nothing plays - a clock running over nothing said a replay was playing - and a play
    // asked while one loads waits for it)
    case "play":
      if (!playable()) playAfterLoad = loading;
      else if (!replayStore.running) togglePause();
      break;
    case "pause":
      playAfterLoad = false;
      pause();
      break;
    case "toggle":
      if (!playable()) playAfterLoad = loading && !playAfterLoad;
      else togglePause();
      break;
    case "renderer":
      if (m.renderer === "3d" || m.renderer === "svg") setAsked(m.renderer);
      break;
    case "look":
      lookAsked = true;
      setLook480(m.look480 === true);
      break;
    case "view":
      // one view choice: simple, 3d or console (3D with the 480p look)
      if (m.view === "simple" || m.view === "3d" || m.view === "console") {
        setAsked(m.view === "simple" ? "svg" : "3d");
        lookAsked = true;
        setLook480(m.view === "console");
      }
      break;
    case "crt":
      if (isCrtPreset(m.crt)) { crtAsked = true; setCrtPreset(m.crt); setCrtCurve(curveOf(m.curve)); }
      break;
    case "controllers":
      controllersAsked = true;
      setOverlay(isOverlayShow(m.show) ? m.show : "off");
      if (m.you !== undefined) setYou(portOf(m.you));
      break;
    case "hudslots":
      setHudSlotsMode(isHudSlots(m.slots) ? m.slots : "outer");
      break;
    case "sim":
      // (the player asks for its track again: the replay's source handed over anew)
      simAsked(m.on === true, source(), givenTrack, () => {
        const u = source();
        setSource(null);
        setTimeout(() => setSource(u), 0);
      });
      break;
  }
});

/** whether a replay is in to play: loaded, and not another one on its way or failed */
function playable(): boolean {
  return !!replayStore.replayData && !loading && problem() === null;
}

// V on a player with the keyboard's focus: the page is told, and may cycle
// the view. Only the key alone, never while typing in a field.
function viewKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.altKey || e.metaKey || (e.key !== "v" && e.key !== "V")) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  post({ type: "viewKey" });
}
document.addEventListener("keydown", viewKey);

// F, W (or Shift+F) and Esc on a player with the keyboard's focus: the page
// is told, and may make it Full Screen or Full Window, or leave either (the
// player itself cannot fill the page's window). Embedded only: the keys are
// the page's then, never Slippi Lab's own F (Controls.tsx), which only hides
// its panels in its own app.
function fullKey(e: KeyboardEvent) {
  if (window.parent === window || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  const k = e.key;
  const how = k === "Escape" ? "leave" : k === "w" || k === "W" || k === "F" ? "window" : k === "f" ? "screen" : null;
  if (how === null) return;
  if (how !== "leave") { e.preventDefault(); e.stopPropagation(); }
  post({ type: "fullKey", how });
}
document.addEventListener("keydown", fullKey);

/** whether this browser can draw WebGL 2 at all */
function webgl2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

function Embed() {
  createEffect(
    on(
      () => [replayStore.frame, replayStore.running] as const,
      ([frame, running]) =>
        post({ type: "frame", frame: frame + FIRST_FRAME, running })
    )
  );
  // diagnostics (diag.ts): frame times are measured only while it plays
  createEffect(on(() => replayStore.running, (running) => diagRunning(running)));
  createEffect(
    on(
      () => replayStore.replayData,
      (data) => {
        if (!data) return;
        loading = false; setLoadingNow(false);
        diagLoaded(
          data.settings.playerSettings.filter((p) => p).map((p) => p!.externalCharacterId),
          data.settings.stageId ?? null
        );
        post({ type: "loaded", frames: data.frames.length });
        if (seekAfterLoad !== null) {
          jump(seekAfterLoad);
          seekAfterLoad = null;
        }
        if (playAfterLoad) {
          playAfterLoad = false;
          if (!replayStore.running) togglePause();
        }
      }
    )
  );

  const params = new URLSearchParams(location.search);
  const zoom = Number(params.get("zoom"));
  if (zoom > 0) setZoom(zoom);
  const url = params.get("replayUrl");
  if (url !== null) {
    const frame = params.get("frame");
    void loadUrl(url, params.get("name") ?? "replay.slp",
                 frame === null ? undefined : Number(frame), params.get("trackUrl"));
  }

  const [mode, setMode] = createSignal<Mode>({ renderer: "pending", reason: null, failed: false });
  const forced = params.get("renderer");
  const [st, setSt] = createSignal<Awaited<ReturnType<typeof status>>>();
  // (3D chosen: drawn by the 3D player whatever happens to it, saying why only when it cannot run here at all: embedmode.ts)
  const check = () => status().then((s) => {
    setMode(chooseMode(s, forced, asked(), webgl2));
    if (!lookAsked) setLook480(s.look480 === true);
    if (!crtAsked && isCrtPreset(s.crt)) { setCrtPreset(s.crt); setCrtCurve(curveOf(s.curve)); }
    if (!controllersAsked) setOverlay(isOverlayShow(s.controller_overlay) ? s.controller_overlay : "off");
    setSt(s);
  });
  recheck = () => { void check(); };
  void check();
  // the page's 3D / Simple choice, switched on the spot: the replay, the
  // frame and the ghosts stay; only the drawing changes
  createEffect(() => {
    const a = asked(), s = st();
    if (a === null || !s) return;
    setMode(askedMode(s, a, webgl2));
  });
  // The 3D player never gives up and never switches to the line art itself.
  // One that fails, stalls or loses its picture is tried again: before its
  // first frame, in its place, its Loading cover up; after it, behind the
  // last picture it drew, with a quiet "Reconnecting…" in the corner, the
  // replay playing on - the new try takes over at the frame it has reached.
  // Again 2.5 s after a failure, at once after a stall or a lost picture,
  // and at once when the tab is shown again
  const RETRY_MS = 2500;
  let tries = 1;
  const [shownTry, setShownTry] = createSignal(1);
  const [nextTry, setNextTry] = createSignal<number | null>(null);
  const [reconnecting, setReconnecting] = createSignal(false);
  const drew = new Set<number>();
  let retryTimer = 0, retryDue = false;
  const tryAgain = (ms: number) => {
    clearTimeout(retryTimer);
    retryDue = true;
    retryTimer = setTimeout(() => {
      retryDue = false;
      tries++;
      if (drew.has(shownTry())) setNextTry(tries);
      else setShownTry(tries);
    }, ms) as unknown as number;
  };
  const failed3d = (id: number, reason: string, ms: number) => {
    console.warn("3D replay viewer: trying again:", reason);
    if (id === nextTry()) { tryAgain(RETRY_MS); return; }
    if (id !== shownTry()) return;
    if (drew.has(id)) setReconnecting(true);
    tryAgain(ms);
  };
  const ready3d = (id: number) => {
    drew.add(id);
    if (id === nextTry()) batch(() => { setShownTry(id); setNextTry(null); setReconnecting(false); });
  };
  const shown = () => { if (retryDue && document.visibilityState === "visible") tryAgain(0); };
  document.addEventListener("visibilitychange", shown);
  onCleanup(() => { document.removeEventListener("visibilitychange", shown); clearTimeout(retryTimer); });
  // which view is drawing, for diagnostics: each view's frame times apart
  createEffect(() => {
    const m = mode();
    if (m.renderer !== "pending") diagView(m.renderer === "svg" ? "simple" : look480() ? "console" : "3d", MINI);
  });
  createEffect(on(mode, (m) => {
    if (m.renderer !== "pending") post({ type: "renderer", renderer: m.renderer, reason: m.reason });
    // the line art's own per-frame work only while it is the one drawing
    setLineArt(m.renderer === "svg");
  }));

  return (
    <>
      <div class="flex h-screen flex-col overflow-hidden bg-white" data-renderer={mode().renderer}>
        <Show
          when={replayStore.replayData && mode().renderer !== "pending" && problem() === null}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-slate-500"
                 data-load-state={problem() ? "failed" : "waiting"}>
              <p data-load-text>{waitingText(fileStore.parseProgress, loadingNow(), problem())}</p>
              <Show when={problem()}>
                {(p) => <>
                  <Show when={problemNote(p(), trying())}>
                    <p class="text-sm text-slate-400" data-load-note>{problemNote(p(), trying())}</p>
                  </Show>
                  <Show when={p().retry !== "none"}>
                    <button type="button" data-load-retry disabled={trying()} onClick={() => loadAgain(true)}
                            class="mt-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                      Try Again
                    </button>
                  </Show>
                </>}
              </Show>
            </div>
          }
        >
          <div class="relative flex min-h-0 flex-1 flex-col">
            <Show when={mode().renderer === "3d"}>
              <Show when={!mode().failed} fallback={
                <div class="flex min-h-0 flex-1 items-center justify-center bg-slate-900 px-6 text-center text-sm text-slate-300"
                     data-3d-unavailable>
                  3D can't run here: {mode().reason}
                </div>
              }>
                {/* the try on screen, and one loading unseen behind it */}
                <For each={nextTry() === null ? [shownTry()] : [shownTry(), nextTry()!]}>
                  {(id) => (
                    <div class={id === shownTry() ? "flex min-h-0 flex-1 flex-col"
                                                  : "pointer-events-none absolute inset-0 flex flex-col opacity-0"}
                         data-3d-try={id}>
                      <Viewer3D onFail={(r) => failed3d(id, r, RETRY_MS)} onStall={(r) => failed3d(id, r, 0)}
                                onLost={(r) => failed3d(id, r, 0)} onReady={() => ready3d(id)}
                                quiet={id !== shownTry()} source={source()}
                                corner={<>
                                  <Show when={overlay() !== "off" && id === shownTry()}><Controllers show={overlay()} you={you()} /></Show>
                                  {/* (in the picture's own corner, over its last frame) */}
                                  <Show when={reconnecting() && id === shownTry()}>
                                    <div class="pointer-events-none absolute right-1.5 top-1.5 z-20 flex items-center gap-1.5 rounded-md bg-slate-900/75 px-2 py-1 text-[11px] font-medium text-slate-200"
                                         data-reconnecting>
                                      <span class="h-2.5 w-2.5 animate-spin rounded-full border border-slate-500 border-t-slate-200" />
                                      Reconnecting…
                                    </div>
                                  </Show>
                                </>} />
                    </div>
                  )}
                </For>
              </Show>
            </Show>
            <Show when={mode().renderer === "svg"}>
              <Viewer mini={MINI} corner={<Show when={overlay() !== "off"}><Controllers show={overlay()} you={you()} /></Show>} />
            </Show>
          </div>
        </Show>
      </div>
      {/* no toasts over the game: the 3D player's own Loading says it, and
          the line art's "Reading replay" */}
    </>
  );
}

const root = document.querySelector("#root");
if (root !== null) render(Embed, root);
