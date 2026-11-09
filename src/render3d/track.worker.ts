/* 3D replay viewer: a replay's viewer track read and prepared off the page's thread (files.ts preparedTrackAnswer).
 *
 * The longest game's track takes 3 to 4 s to read (trackcodec.ts readTrack: its millions of pose values through the
 * model the writer shares); read on the page's thread, the page could not draw or answer a click meanwhile. Here
 * the worker fetches the track, reads it and prepares it for the player (prepareTrack: what ViewerTrack keeps), and
 * hands it over in pieces (trackPieces: the pose lines' typed arrays transferred, not copied; the events in runs, so
 * the page takes each in as a short task). Asked {url}; answers as trackAnswer does - a track, or the host's own
 * answer, or null when it could not be read. One track a worker: the page ends it once it has answered.
 */
import { prepareTrack, type PreparedTrack, type TrackPiece, trackAnswerOf, trackPieces } from "./trackcodec";
import type { TrackData } from "./track";

const post = (piece: TrackPiece, transfer: ArrayBuffer[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(piece, transfer);

self.onmessage = async (e: MessageEvent<{ url: string }>) => {
  let track: PreparedTrack | null = null, answer: unknown = null;
  try {
    const r = await fetch(e.data.url, { cache: "no-store" });
    if (r.ok) {
      const a = (await trackAnswerOf(await r.arrayBuffer())) as { state: string; track?: TrackData };
      if (a.state === "ready") track = prepareTrack(a.track!);
      else answer = a;
    }
  } catch {
    track = null;
    answer = null;
  }
  if (!track) return post({ kind: "answer", answer });
  for (const { piece, transfer } of trackPieces(track)) post(piece, transfer);
};
