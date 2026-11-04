/* A checking mode of the page (?harness=<window names>), for the pixel checks: each named gate window (a replay's name and a capture frame;
 * its map file gives the tape rows) is played from the first row, and the pictures of the window's five frames are posted as
 * <name>/efb_00000k.raw, k = 1..5 (width, height, 28 as little-endian words, then RGBA rows from the top) to /save/. Frame k is tape row
 * swaps[1] + 122 + k, the way the integration's window recordings number them (a recording of tape frames from swaps[1] + 122 on, frame
 * 0 the warm-up frame before the five); k = 0 is posted empty. The replay is played once from the first row, every row drawn, as in play
 * (a window late in the game sees what the frames before it drew: the screens that show the game's own earlier pictures). Not used in play.
 */
import type { GxSession } from "./session";

/** `dual` (a renderer made with floatOps "dual"): after every pass of a window's rows the pixels whose float arithmetic differed between the
 *  card's and the whole-number functions are counted (bit 31 of the depth word) and reported */
export async function runHarness(s: GxSession, names: string[], replayOf: (win: string) => boolean, dual?: { onFlush: (() => void) | null; readEfb(): { depth: Uint32Array } }): Promise<string> {
  const wins: { win: string; rows: number[] }[] = [];
  for (const win of names) {
    if (!replayOf(win)) continue;
    const map = await (await fetch(`/map/${win}.json`)).json();
    const a = map.swaps[1] + 123;
    wins.push({ win, rows: [a - 1, a, a + 1, a + 2, a + 3, a + 4] });
  }
  wins.sort((x, y) => x.rows[0] - y.rows[0]);
  const want = new Map<number, Uint8Array | null>();
  for (const w of wins) for (const r of w.rows) want.set(r, null);
  await s.start();
  s.setPictures(true);
  let dualPasses = 0, dualPixels = 0;
  if (dual) dual.onFlush = () => {
    if (!want.has(s.index - 1)) return;
    dualPasses++;
    const d = dual.readEfb().depth;
    for (let i = 0; i < d.length; i++) if (d[i] >>> 31) dualPixels++;
  };
  s.onPicture = (rgba, row) => { if (want.has(row)) want.set(row, rgba.slice()); };
  let report = "";
  const post = async (w: { win: string; rows: number[] }) => {
    let n = 0;
    for (let k = 0; k < w.rows.length; k++) {
      const f = new Uint8Array(12 + 640 * 480 * 4);
      const dv = new DataView(f.buffer);
      dv.setUint32(0, 640, true); dv.setUint32(4, 480, true); dv.setUint32(8, 28, true);
      const px = want.get(w.rows[k]);
      if (px && k > 0) { f.set(px, 12); n++; }
      await fetch(`/save/${w.win}/efb_00000${k}.raw`, { method: "POST", body: f });
    }
    report += `${w.win}: rows ${w.rows[1]}..${w.rows[5]} pictures ${n}; `;
  };
  let next = 0;
  while (next < wins.length && s.index < s.frameCount) {
    const t = performance.now();
    while (performance.now() - t < 12 && s.index < s.frameCount) s.step(true);
    while (next < wins.length && s.index > wins[next].rows[5]) await post(wins[next++]);
    await new Promise((r) => setTimeout(r, 0));
  }
  while (next < wins.length) await post(wins[next++]);
  if (dual) { dual.onFlush = null; report += `float dual check: ${dualPasses} passes, ${dualPixels} pixels differ; `; }
  return report + (s.diverged ? `diverged at row ${s.diverged.row} (${s.diverged.lane})` : "held to the end");
}