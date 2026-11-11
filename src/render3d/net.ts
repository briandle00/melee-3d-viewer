/* Fetches that get through a moment's trouble, and say what it was when they do not.
 *
 * A page's server answers almost always. When it does not - a network blip, a server still starting or busy, a browser short of
 * sockets for a moment - one failed request must not leave a player on an empty picture for good. fetchRetry asks again a few times
 * over a few seconds (RETRY_MS), sooner when the browser says it is back online. An answer that is the server's own word on the file
 * (404: not there; another 4xx: not given) is not asked again: it would answer the same. What it could not get is a FetchFailed, its
 * kind saying why:
 *
 *   network   no answer at all (the request failed: the server is down or out of reach, the browser is offline)
 *   server    an answer saying the server could not serve it now (408, 425, 429, 5xx): worth asking again
 *   gone      404 or 410: the file is not there (moved, renamed or deleted)
 *   refused   any other 4xx: the server will not give it
 *
 * whenBack(fn) calls fn when the page may be able to fetch again: the browser back online, or the page shown again after it was
 * hidden. A player whose load still failed after the quick tries asks again then, and every AGAIN_MS while it can be seen.
 */

export type FailKind = "network" | "server" | "gone" | "refused";

export class FetchFailed extends Error {
  constructor(readonly kind: FailKind, readonly status: number | null, message: string) {
    super(message);
    this.name = "FetchFailed";
  }
}

/** the waits between the tries of one fetchRetry, ms: five more tries over about 7 s */
export const RETRY_MS: readonly number[] = [250, 500, 1000, 2000, 3000];
/** after the quick tries failed: asked again this often while the page can be seen (and at once when it may work again: whenBack) */
export const AGAIN_MS = 5000;

/** what an HTTP status says (null: no answer at all) */
export function failKind(status: number | null): FailKind {
  if (status === null) return "network";
  if (status === 404 || status === 410) return "gone";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "server";
  return "refused";
}

/** whether asking again may help */
export const worthRetry = (kind: FailKind): boolean => kind === "network" || kind === "server";

/** a failure as a FetchFailed (an abort is passed on as it is: the caller asked for it) */
export function failOf(e: unknown): FetchFailed {
  if (e instanceof FetchFailed) return e;
  return new FetchFailed("network", null, e instanceof Error ? e.message : String(e));
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

// (the page's, or a worker's: both are told when the browser is back online)
const scope = globalThis as unknown as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };

/** wait `ms`, or less: the browser back online ends it at once; an abort rejects */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, bad) => {
    if (signal?.aborted) { bad(signal.reason ?? new DOMException("aborted", "AbortError")); return; }
    const done = () => {
      clearTimeout(t);
      scope.removeEventListener?.("online", done);
      signal?.removeEventListener("abort", stop);
      ok();
    };
    const stop = () => {
      clearTimeout(t);
      scope.removeEventListener?.("online", done);
      bad(signal!.reason ?? new DOMException("aborted", "AbortError"));
    };
    const t = setTimeout(done, ms);
    scope.addEventListener?.("online", done);
    signal?.addEventListener("abort", stop);
  });
}

/** fetch, asked again over a few seconds while the failure is one that may pass (no answer, the server busy); an ok answer, else a
 *  FetchFailed. `delays`: the waits between tries (RETRY_MS); onRetry is told before each new try */
export async function fetchRetry(url: string | URL, init?: RequestInit,
                                 o: { delays?: readonly number[]; signal?: AbortSignal; onRetry?: (n: number, why: FetchFailed) => void } = {}): Promise<Response> {
  const delays = o.delays ?? RETRY_MS;
  for (let n = 0; ; n++) {
    let why: FetchFailed;
    try {
      const r = await fetch(url, o.signal ? { ...init, signal: o.signal } : init);
      if (r.ok) return r;
      why = new FetchFailed(failKind(r.status), r.status, `HTTP ${r.status}`);
      // (the body is not wanted: let the connection go)
      void r.body?.cancel().catch(() => {});
    } catch (e) {
      if (isAbort(e) || o.signal?.aborted) throw e;
      why = failOf(e);
    }
    if (!worthRetry(why.kind) || n >= delays.length) throw why;
    o.onRetry?.(n + 1, why);
    await pause(delays[n], o.signal);
  }
}

/** fn called whenever the page may fetch again: back online, or shown again; returns the way to stop it */
export function whenBack(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const shown = () => { if (document.visibilityState === "visible") fn(); };
  window.addEventListener("online", fn);
  document.addEventListener("visibilitychange", shown);
  return () => {
    window.removeEventListener("online", fn);
    document.removeEventListener("visibilitychange", shown);
  };
}
