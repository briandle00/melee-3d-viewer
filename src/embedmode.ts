/* The embeddable player's choices that need no page (embed.tsx; tests/embed-mode.test.ts): which renderer draws and,
 * when 3D cannot run here at all, why.
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
