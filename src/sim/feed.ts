/* The viewer track made on the page: melee-sim-light's Wasm build plays the
 * replay in a worker (sim.worker.ts) ahead of playback, and the player gets
 * the track as it grows.
 *
 * Optional, and off unless asked for (README.md, "Viewer tracks in the
 * browser"): the page that embeds the player turns it on (?sim=1, a {type:
 * "sim", on: true} message, or __MELEE_SIM_CONFIG__.auto), and a track the
 * page gives (trackUrl) always comes first. Nothing changes while it is
 * starting: the replay plays at once the way it does with no track, and the
 * player takes the track over (policy.ts) once it reaches well ahead of the
 * frame shown. Going back is free (the track holds every frame it has
 * passed); a jump past where the simulator is shows the frames there the
 * no-track way until it catches up. Where the simulator's game parts from
 * the replay, the track stops, as a host's track does (track.ts until).
 */
import { ViewerTrack, type TrackData, type TrackEvent } from "../render3d/track";
import { decodeTrackFloats } from "../render3d/trackcodec";
import { gameFilesFrom, setLiveTrack, type LiveTrack } from "../render3d/files";
import { replayStore } from "../state/replayStore";
import { shouldPublish } from "./policy";
import type { FromWorker, ToWorker } from "./protocol";
import { fetchRetry } from "../render3d/net";

/** what a host page sets before the viewer loads (all optional) */
export interface SimConfig {
  /** the simulator's ES module (default: sim/melee-sim.mjs beside the page) */
  module?: string;
  /** its .wasm (default: beside the module, same name) */
  wasm?: string;
  /** the list of game files it reads (default: sim-files.json beside the module) */
  files?: string;
  /** run for every replay loaded without a track of its own */
  auto?: boolean;
  /** at most this many plays of a replay (its UCF and arithmetic choices: tape.ts driveOrder); default 3 */
  maxDrives?: number;
}

export const simConfig: SimConfig = (globalThis as { __MELEE_SIM_CONFIG__?: SimConfig }).__MELEE_SIM_CONFIG__ ?? {};

/** how the simulator stands for the replay shown (the page is told: embed.tsx {type: "sim"}) */
export interface SimStatus {
  state: "starting" | "running" | "done" | "failed" | "off";
  /** game frames: how far the track holds, and where the replay ends */
  until?: number; last?: number;
  /** frames a second; ms from the start to the simulator's first frames and to the player's first track;
   *  why it failed or stopped */
  rate?: number; firstFrameMs?: number; firstTrackMs?: number; reason?: string; exact?: boolean;
}

const VERSION = 2;
const FIRST_FRAME = -123;

class SimFeed implements LiveTrack {
  private worker: Worker | null = null;
  private events: TrackEvent[] = [];
  private frontier = FIRST_FRAME;
  private last = FIRST_FRAME;
  private rate = 0;
  private done = false;
  private exact = false;
  private published: number | null = null;
  private snapshot: ViewerTrack | null = null;
  private failure: string | null = null;
  private started = performance.now();
  private firstTrackMs: number | undefined;
  private firstFrameMs: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private subs = new Set<{ got: (t: ViewerTrack) => void; why: (r: string) => void }>();

  constructor(private url: string, private tell: (s: SimStatus) => void) {}

  async start() {
    const base = new URL(simConfig.module ?? "sim/melee-sim.mjs", location.href);
    const wasm = new URL(simConfig.wasm ?? base.href.replace(/\.m?js(\?.*)?$/, ".wasm"), base);
    const list = new URL(simConfig.files ?? "sim-files.json", base);
    const files = gameFilesFrom();
    if (!files) { this.fail("the game files cannot be handed to the simulator"); return; }
    let replay: ArrayBuffer;
    try {
      // (asked again over a few seconds when there is no answer: render3d/net.ts)
      replay = await (await fetchRetry(this.url)).arrayBuffer();
    } catch (e) {
      this.fail(`the replay could not be read: ${e}`);
      return;
    }
    if (this.done) return; // (stopped meanwhile)
    const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    w.onerror = (e) => this.fail(`the simulator stopped: ${e.message || "worker error"}`);
    const msg: ToWorker = {
      type: "start", module: base.href, wasm: wasm.href, filesList: list.href, files, replay,
      maxDrives: simConfig.maxDrives ?? 3, chunkMs: 16,
    };
    w.postMessage(msg, [replay]);
    // (the frame shown moves on its own: checked a few times a second)
    this.timer = setInterval(() => this.consider(true), 250);
    this.tell({ state: "starting" });
  }

  stop() {
    this.done = true;
    clearInterval(this.timer);
    if (this.worker) { this.worker.postMessage({ type: "stop" } as ToWorker); this.worker.terminate(); this.worker = null; }
    this.subs.clear();
  }

  subscribe(got: (t: ViewerTrack) => void, why: (r: string) => void): () => void {
    const sub = { got, why };
    this.subs.add(sub);
    queueMicrotask(() => {
      if (!this.subs.has(sub)) return;
      if (this.snapshot) got(this.snapshot);
      else why(this.failure ? `simulator: ${this.failure}` : "simulating");
    });
    return () => { this.subs.delete(sub); };
  }

  private fail(reason: string) {
    this.failure = reason;
    clearInterval(this.timer);
    this.worker?.terminate();
    this.worker = null;
    // (a track already handed over stays: it holds as far as it went)
    for (const s of this.subs) s.why(`simulator: ${reason}`);
    this.tell({ state: "failed", reason, until: this.published ?? undefined });
  }

  private receive(m: FromWorker) {
    switch (m.type) {
      case "tape":
        this.last = m.firstFrame + m.frames - 1;
        break;
      case "restart":
        this.events = [];
        this.frontier = FIRST_FRAME;
        break;
      case "chunk":
        if (m.text) {
          const got = JSON.parse("[" + m.text + "]") as TrackEvent[];
          decodeTrackFloats(got);
          for (const e of got) this.events.push(e);
        }
        this.frontier = m.until;
        this.rate = m.rate;
        this.firstFrameMs ??= performance.now() - this.started;
        this.consider(false);
        break;
      case "done":
        this.done = true;
        this.exact = m.exact;
        clearInterval(this.timer);
        this.consider(false);
        this.worker?.terminate();
        this.worker = null;
        this.tell({ state: "done", until: m.until, last: this.last, exact: m.exact, rate: this.rate,
                    firstFrameMs: this.firstFrameMs, firstTrackMs: this.firstTrackMs, reason: m.exact ? undefined : "the simulator's game parted from the replay" });
        break;
      case "error":
        this.fail(m.reason);
        break;
      case "diverged": case "status":
        break;
    }
  }

  /** hand the player a longer track when it is time (policy.ts); `say`: tell the page how it stands
   *  (a few times a second, not every chunk) */
  private consider(say: boolean) {
    const playhead = replayStore.frame + FIRST_FRAME;
    const state = { published: this.published, frontier: this.frontier, playhead, done: this.done, rate: this.rate,
                    remaining: Math.max(0, this.last + 1 - this.frontier) };
    if (say && !this.done && !this.failure) {
      this.tell({ state: "running", until: this.frontier, last: this.last, rate: this.rate,
                  firstFrameMs: this.firstFrameMs, firstTrackMs: this.firstTrackMs });
    }
    if (!shouldPublish(state)) return;
    const whole = this.done && this.exact;
    const data: TrackData = {
      version: VERSION, events: this.events, seconds: (performance.now() - this.started) / 1000,
      exact: whole, diverged_at: whole ? null : this.frontier, decoded: true,
    };
    this.snapshot = new ViewerTrack(data);
    this.published = this.frontier;
    this.firstTrackMs ??= performance.now() - this.started;
    for (const s of this.subs) s.got(this.snapshot);
  }
}

let current: { url: string; feed: SimFeed } | null = null;

/** make the track for the replay loaded from `url` on the page (the one before stops) */
export function startSim(url: string, tell: (s: SimStatus) => void) {
  stopSim();
  const feed = new SimFeed(url, tell);
  current = { url, feed };
  setLiveTrack(url, feed);
  void feed.start();
}

/** stop making a track (the replay changed, a track was given, or the page turned it off) */
export function stopSim() {
  if (!current) return;
  setLiveTrack(current.url, null);
  current.feed.stop();
  current = null;
}
