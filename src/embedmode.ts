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

/** why a replay asked for is not shown, and whether trying again may bring it: "auto" (no answer, the server busy: the player asks
 *  again by itself every few seconds and when the page may fetch again, render3d/net.ts), "button" (the server said it is not there or
 *  not given: asked again only when Try Again is pressed), "none" (it was read and is not one these players show) */
export interface LoadProblem { text: string; retry: "auto" | "button" | "none" }

/** a replay's fetch that failed (render3d/net.ts FetchFailed, or any error the load met) */
export function fetchProblem(e: unknown): LoadProblem {
  const f = e as { kind?: string; status?: number | null; message?: string };
  switch (f?.kind) {
    case "gone":
      return { text: "The replay is not there anymore: it was moved, renamed or deleted.", retry: "button" };
    case "refused":
      return { text: `The replay could not be loaded: the server refused it (HTTP ${f.status}).`, retry: "button" };
    case "server":
      return { text: `The replay could not be loaded: the server could not send it (HTTP ${f.status}).`, retry: "auto" };
    case "network":
      return { text: "The replay could not be loaded: the server did not answer.", retry: "auto" };
  }
  return { text: `The replay could not be opened: ${e instanceof Error ? e.message : String(e)}`, retry: "button" };
}

/** how a replay's read ended: not read (failed), or read and not one these players play (skipped: a CPU player, a stage other than
 *  the six the line art has, a character the game has no fighter for); null when it was read and is shown */
export function readProblem(o: { failed: number; skipped: number; loaded: number }): LoadProblem | null {
  if (o.loaded > 0) return null;
  if (o.failed > 0) return { text: "The replay could not be read: the file is damaged or not a Slippi replay.", retry: "none" };
  if (o.skipped > 0) {
    return { text: "This viewer does not play this replay: it has a CPU player or a stage other than the six tournament stages.", retry: "none" };
  }
  return { text: "The replay could not be read.", retry: "none" };
}

/** the line under a problem: what the player does about it */
export function problemNote(p: LoadProblem, trying: boolean): string | null {
  if (trying) return "Trying again…";
  return p.retry === "auto" ? "It tries again by itself every few seconds." : null;
}

/** what the player says where the picture would be while there is no replay to show (a problem says itself: problemNote) */
export function waitingText(parseProgress: number, loading: boolean, problem: LoadProblem | null): string {
  return problem ? problem.text : parseProgress > 0 ? "Reading replay…" : loading ? "Loading replay…" : "No replay loaded";
}
