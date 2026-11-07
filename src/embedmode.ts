/* The embeddable player's choices that need no page (embed.tsx; tests/embed-mode.test.ts): which renderer draws and,
 * when 3D cannot run here at all, why; and what the player says where the picture would be while there is no replay
 * to show.
 */

/** the page's drawing: 3D (failed: it cannot run here at all, `reason` says why), the line art, or not known yet */
export type Mode = { renderer: "pending" | "3d" | "svg"; reason: string | null; failed: boolean };

/** what render3d/files.ts status() says about the game files */
export interface FilesStatus { available: boolean; enabled: boolean; reason: string | null }

export const NO_WEBGL2 = "this browser cannot draw WebGL 2";
export const LINE_ART_ASKED = "line art asked for";

/** 3D chosen: drawn by the 3D player, whatever happens to it. Only when it cannot run here at all (no game files, no
 *  WebGL 2) does the player say so, plainly, where the picture would be (failed, its reason). `webgl2` is asked only
 *  then (it makes a WebGL context to find out) */
export function pick3d(s: FilesStatus, webgl2: () => boolean): Mode {
  const why = !s.available ? s.reason : webgl2() ? null : NO_WEBGL2;
  return { renderer: "3d", reason: why, failed: why !== null };
}

/** the drawing: ?renderer= (forced) first, then the page's {type: "renderer"} choice (asked), then the setting */
export function chooseMode(s: FilesStatus, forced: string | null, asked: "3d" | "svg" | null, webgl2: () => boolean): Mode {
  const want = forced === "svg" ? false : forced === "3d" ? true : s.enabled;
  return want && asked !== "svg" ? pick3d(s, webgl2) : { renderer: "svg", reason: LINE_ART_ASKED, failed: false };
}

/** the page's 3D / Simple choice, switched on the spot */
export function askedMode(s: FilesStatus, asked: "3d" | "svg", webgl2: () => boolean): Mode {
  return asked === "3d" ? pick3d(s, webgl2) : { renderer: "svg", reason: LINE_ART_ASKED, failed: false };
}

/** how a replay's load ended: its file not found or not read (failed), or read and not one these players play
 *  (skipped: a CPU player, a stage other than the six the line art has, a character the game has no fighter for) */
export interface LoadOutcome { status?: number; failed: number; skipped: number; loaded: number }

/** why a replay that was asked for is not shown, or null when it is */
export function loadProblem(o: LoadOutcome): string | null {
  if (o.status !== undefined && (o.status < 200 || o.status > 299)) return `The replay could not be fetched (HTTP ${o.status}).`;
  if (o.loaded > 0) return null;
  if (o.failed > 0) return "The replay could not be read: the file is damaged or not a Slippi replay.";
  if (o.skipped > 0) return "This viewer does not play this replay: it has a CPU player or a stage other than the six tournament stages.";
  return "The replay could not be read.";
}

/** a load that stopped with an error (the network, the reader) */
export function loadError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return `The replay could not be opened: ${m}`;
}

/** what the player says where the picture would be while there is no replay to show */
export function waitingText(parseProgress: number, problem: string | null): string {
  return problem ?? (parseProgress > 0 ? "Reading replay…" : "No replay loaded");
}
