/* 3D replay viewer: the 3D players on one page, and who goes first.
 *
 * A page can hold several players (a reel and one that takes its stills; a
 * main player and a preview). They share one main thread: two playing at full rate, or one
 * loading while another plays, make both stutter. So each says here whether
 * it can be seen and whether it is playing, and asks:
 *   - whether to draw at all: not while it cannot be seen (off the screen,
 *     in a part of the page that is hidden, or the tab in the background);
 *   - at what rate: the one playing that is seen biggest draws every frame,
 *     any other playing one every other frame;
 *   - whether to load now: a player that cannot be seen loads while none
 *     that can is playing or getting to its first picture, so its reading,
 *     decoding and stepping does not land in the middle of someone's playing,
 *     or of the wait for the picture someone just asked to see.
 * A player behind a modal dialog of the page (not in it) cannot be seen: the
 * dialog covers it (coveredByDialog).
 * The register is the page's (pageCache): the players are frames of one
 * origin and read each other's entries. */
import { pageCache } from "../state/pageCache";

interface Entry { seen: boolean; playing: boolean; first: boolean; area: number; at: number; beat: number }

// (a player that has not said anything for this long is gone: its frame went without a word)
const QUIET_MS = 2000;
const clock = () => performance.timeOrigin + performance.now();

let next = 0;

export class PagePlayer {
  private readonly id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}:${next++}`;
  private readonly all = pageCache<Entry>("players3d");
  private readonly me: Entry = { seen: false, playing: false, first: false, area: 0, at: clock(), beat: clock() };

  constructor() { this.all.set(this.id, this.me); }

  /** what it is now: seen (and how big, in pixels), playing, and getting to the first picture of what it shows (first) */
  set(seen: boolean, area: number, playing: boolean, first = false) {
    this.me.seen = seen;
    this.me.area = seen ? area : 0;
    if (playing && !this.me.playing) this.me.at = clock();
    this.me.playing = playing;
    this.me.first = first;
    this.me.beat = clock();
  }

  /** whether another player that can be seen is getting to its first picture: what someone just asked to see (a clip opened in a
   *  dialog, a game opened). The page's thread is its: a visible player waited seconds on Loading while a hidden player taking
   *  stills held its turn and stepped to a late frame of its own between its pieces */
  othersFirst(): boolean {
    const now = clock();
    for (const [id, e] of this.all) if (id !== this.id && e.seen && e.first && now - e.beat < QUIET_MS) return true;
    return false;
  }

  /** whether another player that can be seen is playing */
  othersPlaying(): boolean {
    const now = clock();
    for (const [id, e] of this.all) if (id !== this.id && e.seen && e.playing && now - e.beat < QUIET_MS) return true;
    return false;
  }

  /** whether it draws every frame: it is the playing player seen biggest
   *  (the one started last, of two the same size), or none other is playing */
  first(): boolean {
    if (!this.me.playing) return true;
    const now = clock();
    for (const [id, e] of this.all) {
      if (id === this.id || !e.seen || !e.playing || now - e.beat >= QUIET_MS) continue;
      if (e.area > this.me.area || (e.area === this.me.area && e.at > this.me.at)) return false;
    }
    return true;
  }

  /** whether to load now: when it can be seen, or while no player that can be is playing or getting to its first picture */
  mayLoad(): boolean {
    return this.me.seen || (!this.othersPlaying() && !this.othersFirst());
  }

  /** gone from the page */
  remove() { this.all.delete(this.id); }
}

/** whether this page (a player's frame) is behind a modal dialog of the page that holds it: the dialog covers it and the page behind it
 *  is inert. A frame inside the dialog is not covered. */
export function coveredByDialog(): boolean {
  try {
    const frame = (globalThis as { frameElement?: Element | null }).frameElement;
    if (!frame) return false;
    for (const d of frame.ownerDocument.querySelectorAll("dialog")) if (d.matches(":modal") && !d.contains(frame)) return true;
  } catch { /* another origin's page: nothing known */ }
  return false;
}
