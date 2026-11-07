// Replays the players cannot play, and what they are told (tests/replay-fixture.ts makes the replays). The .slp file:
// a whole one reads; a cut one, an error page in its place or an empty file is refused by the UBJSON reader before
// anything is drawn. The GX player's reading (src/sim/tape.ts readTape): every replay it does not play is refused with
// Unsupported and a reason the page shows (gxpage.ts), never read wrongly: not an event stream, no game start, Slippi
// before 3.0, a stage, PAL, a CPU without a level, three players, four-player teams without Team Attack, an event it does
// not know, no frame start events, not from the match's start, fewer than two whole frames.
//
//   deno test -A --no-check --sloppy-imports tests/replay-errors.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { decode } from "@shelacek/ubjson";
import { parseReplay } from "../src/parser/parser.ts";
import { readTape, Unsupported } from "../src/sim/tape.ts";
import { makeReplay, slpFile, type ReplayOptions } from "./replay-fixture.ts";

const read = (bytes: Uint8Array) => decode(bytes, { useTypedArrays: true }) as { raw: Uint8Array; metadata: Record<string, unknown> };

test("a whole .slp reads: its frames, stage and players", () => {
  const r = parseReplay(read(slpFile(makeReplay())));
  assert.equal(r.frames.length, 4);
  assert.equal(r.settings.stageId, 31);
  assert.deepEqual(r.settings.playerSettings.filter(Boolean).map((p) => p.playerIndex), [0, 1]);
  const t = readTape(read(slpFile(makeReplay())).raw, { playedOn: "dolphin" });
  assert.equal(t.count, 4);
});

test("a cut .slp, an error page or an empty file is refused before anything is drawn", () => {
  const whole = slpFile(makeReplay());
  for (const cut of [10, 100, 400, whole.length - 200, whole.length - 5]) {
    assert.throws(() => read(whole.subarray(0, cut)), /Unexpected EOF|Invalid length/, `cut at ${cut} of ${whole.length}`);
  }
  assert.throws(() => read(new TextEncoder().encode("<html><body>404 Not Found</body></html>")), /Unexpected type/);
  assert.throws(() => parseReplay(read(new Uint8Array(0))));
});

const refused = (opts: ReplayOptions | Uint8Array, reason: RegExp) => {
  const raw = opts instanceof Uint8Array ? opts : makeReplay(opts);
  assert.throws(() => readTape(raw, {}), (e: unknown) => {
    assert.ok(e instanceof Unsupported, `not Unsupported: ${e}`);
    assert.match((e as Error).message, reason);
    return true;
  });
};

test("the GX player says why it does not play a replay", () => {
  refused(new TextEncoder().encode("{\"not\": \"a replay\"}"), /not a replay's event stream/);
  const noStart = makeReplay();
  noStart[noStart[1] + 1] = 0x37;
  refused(noStart, /no game start/);
  refused({ version: [2, 2, 0] }, /older than Slippi 3\.0/);
  refused({ version: [0, 1, 0] }, /older than Slippi 3\.0/);
  refused({ stage: 4 }, /stage 4 is not one the simulator plays/);
  refused({ pal: true }, /PAL game/);
  refused({ cpuPorts: [1], cpuLevel: 0 }, /a CPU without a level/);
  refused({ ports: [0, 1, 2] }, /3 players/);
  refused({ ports: [0, 1, 2, 3], teams: true }, /four-player teams without Team Attack/);
  refused({ unknownEvent: 0x99 }, /unknown event 0x99/);
  refused({ noFrameStart: true }, /without frame start events/);
  refused({ firstFrame: -100 }, /does not start at the match's start/);
  refused({ frames: 1 }, /fewer than two whole frames/);
});

test("what it plays: Slippi 3.0 and later, a CPU with its level, four-player teams with Team Attack", () => {
  assert.equal(readTape(makeReplay({ version: [3, 0, 0] }), {}).count, 4);
  assert.equal(readTape(makeReplay({ cpuPorts: [1], cpuLevel: 9 }), {}).count, 4);
  assert.equal(readTape(makeReplay({ ports: [0, 1, 2, 3], teams: true, friendlyFire: true }), {}).count, 4);
  assert.equal(readTape(makeReplay({ ports: [0, 1, 2, 3] }), {}).count, 4);
});

test("the line-art and 3D players' reader takes replays from before Slippi 3.0", () => {
  const r = parseReplay({ raw: makeReplay({ version: [2, 0, 0] }), metadata: {} });
  assert.equal(r.frames.length, 4);
});
