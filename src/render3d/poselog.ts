/* The 3D replay viewer: a log of every joint's world matrix as the viewer
 * drew it, frame by frame, to set beside the simulator's (its viewer track's
 * "wf", "wi" and "ws", written when its debug flag is on) joint for joint and
 * bit for bit (tools/pose_check.py compares the two).
 *
 * Debug only, and off unless asked for: until the viewer's debug handle
 * starts it (or the page's address has ?poselog), the viewer holds no log and
 * each of its hooks is a test of a null. A frame is logged once, the first
 * time it is drawn, and only after the last one logged (a frame drawn again,
 * or one before, is not: each line's values go on from the line before);
 * another replay starts the log over.
 *
 * Its lines are the track's, JSON arrays, each only as it changes:
 *   [frame, "wf", port, sub, character, (part, mask, v0..v11)...]
 *       a fighter's joints by part (ftParts: the model's joint by
 *       partToModelJoint, a part the model leaves out not written)
 *   [frame, "wi", spawn_id, (joint, mask, v0..v11)...]
 *       an item's joints by preorder index in its model's tree, the "jp"
 *       numbering, joint 0 its root
 *   [frame, "ws", part, (joint, mask, v0..v11)...]
 *       a stage part's joints, the "sp" numbering: the part by its number as
 *       "gjoint" has it (a copy's plus 1000 for each made before it), joint 0
 *       the part's place (the scale joint the game puts above the file's
 *       root, Ground_801C14D0's), the file's root 1
 * the twelve values a joint's world matrix's rows 0-2 of its 3x4, row by row
 * (m[0][0], m[0][1], m[0][2], m[0][3], m[1][0] ... m[2][3]), each the exact
 * bits of its float32 as "0x" and eight hex digits; mask bit k: value k
 * follows; an owner's first line has every value, and one drawn with nothing
 * changed has a line of its head alone (so the log says which owners each
 * frame drew: one not drawn, a fighter KO'd, has none). And two of its own:
 *   [frame, "wn"]                  the frame was drawn (and logged): the one
 *       a line's values hold for, until the next of the same owner
 *   [frame, "wk", spawn_id, type]  an item's kind, as it is first logged
 * The frame is the game's (the replay's index - 123), as the track's are.
 *
 * The matrices are the ones the draws make: a fighter's as its skeleton was
 * posed for its main pass (a screen or star KO's place in them; not its
 * hitlag shake, which the game adds to the camera's view for the draw,
 * ftDrawCommon_8008051C, not to its joints), an item's as drawArticle posed
 * its model, a stage part's as the stage was posed for the frame.
 */
import type { Skeleton } from "./skeleton";
import { partSkips, partToModelJoint } from "./parts";

/** one owner's joints this frame: the twelve words of each, by joint */
type Joints = Map<number, Uint32Array>;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const hex = (w: number) => "0x" + (w >>> 0).toString(16).padStart(8, "0");

export class PoseLog {
  lines: string[] = [];
  /** each owner's joints as last written, by its line's head ("wf", 1, 0, 2 ...) */
  private last = new Map<string, Joints>();
  /** the frame being logged: its owners' joints as drawn, flushed when the next frame starts or the log is taken */
  private cur = new Map<string, Joints>();
  private frame: number | null = null;
  /** the last frame logged, and of which replay */
  private lastFrame = -Infinity;
  private game: unknown = null;
  private kinds = new Set<number>();

  /** a frame starts being drawn: whether it is logged (not one drawn already, nor one before it) */
  begin(frame: number, game: unknown): boolean {
    this.flush();
    if (game !== this.game) { this.game = game; this.reset(); }
    if (frame <= this.lastFrame) return false;
    this.frame = this.lastFrame = frame;
    this.lines.push(JSON.stringify([frame, "wn"]));
    return true;
  }

  /** a fighter's joints, by part: the skeleton's world (column-major 4 x 4s) as posed for its draw */
  fighter(port: number, sub: number, char: number, world: Float32Array) {
    if (this.frame === null) return;
    const skips = partSkips(char), n = world.length >> 4, parts = n + skips.length;
    const j = this.owner(JSON.stringify(["wf", port, sub, char]).slice(1, -1));
    for (let p = 0; p < parts; p++) {
      const m = partToModelJoint(char, p, skips);
      if (m >= 0 && m < n) put(j, p, world, m * 16);
    }
  }

  /** an item's joints, by preorder index (its skeleton's own: the "jp" numbering), joint 0 its root */
  item(spawnId: number, type: number, sk: Skeleton) {
    if (this.frame === null) return;
    if (!this.kinds.has(spawnId)) { this.kinds.add(spawnId); this.lines.push(JSON.stringify([this.frame, "wk", spawnId, type])); }
    const j = this.owner(`"wi",${spawnId}`);
    for (let k = 0; k < sk.n; k++) put(j, k, sk.world, k * 16);
  }

  /** a stage part's joints: 0 its place, the file's root 1 (the "sp" numbering: its skeleton's joint j - 1) */
  stagePart(part: number, place: Float32Array, sk: Skeleton) {
    if (this.frame === null) return;
    const j = this.owner(`"ws",${part}`);
    put(j, 0, place, 0);
    for (let k = 0; k < sk.n; k++) put(j, k + 1, sk.world, k * 16);
  }

  /** the lines logged since the last take (the frame being drawn's with them) */
  take(): string[] {
    this.flush();
    const out = this.lines;
    this.lines = [];
    return out;
  }

  /** the log from nothing: every owner's next line has all its values */
  reset() {
    this.flush();
    this.last.clear();
    this.kinds.clear();
    this.lastFrame = -Infinity;
  }

  private owner(head: string): Joints {
    let j = this.cur.get(head);
    if (!j) this.cur.set(head, (j = new Map()));
    return j;
  }

  /** the frame's lines: each owner's joints whose words changed since its last line */
  private flush() {
    if (this.frame === null) return;
    const frame = this.frame;
    this.frame = null;
    for (const [head, joints] of this.cur) {
      let was = this.last.get(head);
      if (!was) this.last.set(head, (was = new Map()));
      let line = "";
      for (const [k, v] of joints) {
        const old = was.get(k);
        let mask = 0, vals = "";
        for (let i = 0; i < 12; i++) {
          if (old && old[i] === v[i]) continue;
          mask |= 1 << i;
          vals += `,"${hex(v[i])}"`;
        }
        if (!mask) continue;
        line += `,${k},${mask}${vals}`;
        was.set(k, v);
      }
      // (one drawn with nothing changed: its head alone, so the log says which owners each frame drew)
      this.lines.push(`[${frame},${head}${line}]`);
    }
    this.cur.clear();
  }
}

/** a joint's rows 0-2 of a column-major 4 x 4 at `o`, row by row, as its float32 words */
function put(j: Joints, k: number, m: Float32Array, o: number) {
  const v = new Uint32Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { f32[0] = m[o + c * 4 + r]; v[r * 4 + c] = u32[0]; }
  j.set(k, v);
}

/** the debug handle's command, as the draw log's (drawLogCommand): { start } makes the log (again: from
 *  nothing), { take } hands over its lines since the last take (JSON text lines, one a string: a harness
 *  writes them joined by newlines, as <game>.poselog.jsonl), { stop } drops it; else what it holds. From a
 *  headless browser:
 *    __viewer3d.poseLog({ start: true })   (or the page opened with ?poselog)
 *    ... the frames drawn ...
 *    __viewer3d.poseLog({ take: true })    -> string[]
 *    __viewer3d.poseLog({ stop: true }) */
export function poseLogCommand(get: () => PoseLog | null, set: (log: PoseLog | null) => void,
                               cmd: { start?: boolean; take?: boolean; stop?: boolean }) {
  if (cmd.start) { const log = new PoseLog(); set(log); }
  const log = get();
  const out = cmd.take && log ? log.take() : null;
  if (cmd.stop) set(null);
  return out ?? { on: !!get(), lines: get()?.lines.length ?? 0 };
}
