/* what every player on a page shares.
 *
 * A host page may show the player in several places at once (a reel and its
 * stills, a main player and a preview): each is a frame
 * of its own, on the same origin. What one has fetched or read - a replay
 * parsed, a game file's bytes - the others take from here instead of doing
 * it again. Only what nobody changes is kept: bytes and the parsed replay,
 * never a model a player poses. Without a page above it (the player opened
 * on its own) the cache is the player's own. */

type Shared = Record<string, Map<string, unknown>>;
type Host = { __viewerShared?: Shared; __viewerWeak?: Record<string, WeakMap<object, unknown>>; Object: ObjectConstructor; Map: MapConstructor; WeakMap: WeakMapConstructor };

function host(): Host {
  const self = globalThis as unknown as { top?: { location: { origin: string } }; location?: { origin: string } };
  try {
    const top = self.top;
    // (the page above, when it is on this origin; asking a foreign one throws)
    if (top && top !== self && top.location.origin === self.location?.origin) return top as unknown as Host;
  } catch { /* another origin's page: this player's own */ }
  return self as unknown as Host;
}

/* A frame's objects keep its whole realm alive: everything the frame's script reaches - a 3D player's simulator memory (most of a GiB),
 * its parsed replay, its renderer. So what the page above keeps lasts no longer than the frame that made it: the containers are made in
 * the page's own realm (its Object, Map and WeakMap), and when a frame goes (pagehide: its frame removed, or sent to another address) it
 * takes its own entries out of them - every value (and key) made in its realm. A page that made a frame for each game it opened kept
 * every one of them, the simulator's memory with it: about 1 GiB more for each game. */
let leaving = false;
const weakKeys: { m: WeakMap<object, unknown>; key: object }[] = [];
function releaseOnLeave(h: Host): void {
  if (leaving || (h as unknown) === globalThis || typeof addEventListener !== "function") return;
  leaving = true;
  addEventListener("pagehide", (e) => {
    // (a page kept to come back to - the browser's back-forward cache - keeps its frames: nothing is let go)
    if ((e as PageTransitionEvent | undefined)?.persisted) return;
    // (made in this frame: an object whose prototype chain ends in this realm's Object.prototype)
    const mine = (v: unknown) => ((typeof v === "object" && v !== null) || typeof v === "function") && v instanceof Object;
    try {
      for (const m of Object.values(h.__viewerShared ?? {})) for (const [k, v] of [...m]) if (mine(v) || mine(k)) m.delete(k);
      for (const { m, key } of weakKeys) if (mine(m.get(key))) m.delete(key);
      weakKeys.length = 0;
    } catch { /* the page above is gone too */ }
  });
}

/** the page's cache of this name (made on first use) */
export function pageCache<V>(name: string): Map<string, V> {
  const h = host();
  releaseOnLeave(h);
  const all = (h.__viewerShared ??= h.Object.create(null) as Shared);
  return (all[name] ??= new h.Map()) as Map<string, V>;
}

/** the page's weak cache of this name: kept as long as its keys are (a game file's bytes, say) */
export function pageWeak<K extends object, V>(name: string): WeakMap<K, V> {
  const h = host();
  releaseOnLeave(h);
  const all = (h.__viewerWeak ??= h.Object.create(null) as Record<string, WeakMap<object, unknown>>);
  const m = (all[name] ??= new h.WeakMap()) as WeakMap<K, V>;
  if ((h as unknown) === globalThis) return m;
  // (the keys this frame sets are noted, so it can take its own values out when it goes: a weak map cannot be walked)
  return {
    get: (k: K) => m.get(k), has: (k: K) => m.has(k), delete: (k: K) => m.delete(k),
    set(k: K, v: V) { m.set(k, v); weakKeys.push({ m: m as WeakMap<object, unknown>, key: k }); return this; },
    [Symbol.toStringTag]: "WeakMap",
  } as WeakMap<K, V>;
}

/** keep a cache to its last `n` entries (the oldest go) */
export function trim<V>(m: Map<string, V>, n: number) {
  while (m.size > n) m.delete(m.keys().next().value as string);
}

// (the frame a shared promise was started in, and the page it had then: see sharedPromise)
const OWNER = "__viewerOwner";
interface Owner { win: { closed: boolean; document?: unknown }; doc: unknown }
type Owned<V> = Promise<V> & { [OWNER]?: Owner };

/** whether the frame that started a promise is gone: removed, or moved on to
 *  another page (a frame given a new address keeps its window, not its page,
 *  and the old page's fetches never settle either) */
function gone(o: Owner): boolean {
  try {
    return o.win.closed || (o.doc !== undefined && o.win.document !== o.doc);
  } catch {
    return true; // (a frame now on another origin)
  }
}

/** one promise for `key` on the page, made by `make` when there is none.
 *  A fetch belongs to the frame that started it, and when that frame is
 *  removed (a reel, a preview closed) its fetch never settles: a player
 *  that took it would wait forever, its Loading cover up. So a promise from a
 *  frame that is gone is dropped and made again here, and one whose frame
 *  goes while we wait is too. */
export function sharedPromise<V>(m: Map<string, Promise<V>>, key: string, make: () => Promise<V>): Promise<V> {
  const self = globalThis as unknown as { closed: boolean; document?: unknown };
  const have = m.get(key) as Owned<V> | undefined;
  const owner = have?.[OWNER];
  if (have && !(owner && gone(owner))) {
    if (!owner || (owner.win === self && owner.doc === self.document)) return have;
    return new Promise<V>((resolve, reject) => {
      let settled = false;
      have.then((v) => { settled = true; resolve(v); }, (e) => { settled = true; reject(e); });
      const watch = () => {
        if (settled) return;
        if (!gone(owner)) { setTimeout(watch, 500); return; }
        if (m.get(key) === have) m.delete(key);
        sharedPromise(m, key, make).then(resolve, reject);
      };
      setTimeout(watch, 500);
    });
  }
  if (have) m.delete(key);
  const p = make() as Owned<V>;
  p[OWNER] = { win: self, doc: self.document };
  m.set(key, p);
  return p;
}
