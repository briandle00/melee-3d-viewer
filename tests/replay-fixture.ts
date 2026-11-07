// A small replay made here, for the tests that read replays (tests/sim.test.ts, tests/replay-errors.test.ts): Slippi's
// event stream (the `raw` of a .slp) with its payload sizes, a game start and a few frames, and the .slp file around it
// (UBJSON: raw and metadata). The default is two players on Battlefield, frames -123..-120, frame -121 played twice (a
// rollback: its first pass's values are 99). The options make the cases a reader refuses.

import { encode } from "@shelacek/ubjson";

const SIZES: [number, number][] = [[0x36, 0x1a4], [0x37, 0x42], [0x38, 0x48], [0x3a, 0x8], [0x3f, 0x9]];

export interface ReplayOptions {
  /** the stage's internal id (31: Battlefield) */
  stage?: number;
  /** frame -120 left out (-119 follows -121) */
  withGap?: boolean;
  /** the Slippi version that recorded it (3.18.0) */
  version?: [number, number, number];
  /** the ports that play (0-3; [0, 1]) and their kinds: 0 human, 1 CPU (at cpuLevel) */
  ports?: number[];
  cpuPorts?: number[];
  cpuLevel?: number;
  teams?: boolean;
  friendlyFire?: boolean;
  /** a PAL game */
  pal?: boolean;
  /** the first frame recorded (-123: the match's start) */
  firstFrame?: number;
  /** no frame start events (Slippi before 2.2 wrote none) */
  noFrameStart?: boolean;
  /** an event the payload list does not have, after the game start */
  unknownEvent?: number;
  /** only this many frames from the first */
  frames?: number;
}

export function makeReplay(opts: ReplayOptions = {}): Uint8Array {
  const ports = opts.ports ?? [0, 1];
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(2 + 3 * SIZES.length);
  head[0] = 0x35; head[1] = 1 + 3 * SIZES.length;
  SIZES.forEach(([c, n], i) => { head[2 + 3 * i] = c; head[3 + 3 * i] = n >> 8; head[4 + 3 * i] = n & 0xff; });
  parts.push(head);
  const ev = (cmd: number, fill: (v: DataView) => void) => {
    const n = SIZES.find(([c]) => c === cmd)![1];
    const b = new Uint8Array(n + 1); b[0] = cmd;
    fill(new DataView(b.buffer));
    parts.push(b);
  };
  ev(0x36, (v) => {
    const [a, b, c] = opts.version ?? [3, 18, 0];
    v.setUint8(1, a); v.setUint8(2, b); v.setUint8(3, c);
    if (opts.friendlyFire) v.setUint8(0x6, 1);
    if (opts.teams) v.setUint8(0xd, 1);
    v.setUint16(0x13, opts.stage ?? 31);
    v.setFloat32(0x35, 1);
    for (let i = 0; i < 4; i++) {
      const b = 0x65 + 0x24 * i;
      v.setUint8(b + 1, !ports.includes(i) ? 3 : opts.cpuPorts?.includes(i) ? 1 : 0);
      v.setUint8(b + 2, 4);
      v.setUint8(0x6d + 0x24 * i, 9);
      if (opts.cpuPorts?.includes(i)) v.setUint8(0x74 + 0x24 * i, opts.cpuLevel ?? 9);
    }
    v.setUint32(0x13d, 0xdeadbeef);
    if (opts.pal) v.setUint8(0x1a1, 1);
    v.setUint8(0x1a4, 8);
  });
  if (opts.unknownEvent !== undefined) parts.push(new Uint8Array([opts.unknownEvent, 0, 0, 0]));
  let made = 0;
  const frame = (f: number, mainX: number, x: number) => {
    if (opts.frames !== undefined && made++ >= opts.frames) return;
    if (!opts.noFrameStart) ev(0x3a, (v) => { v.setInt32(1, f); v.setUint32(5, 1000 + f); });
    if (f === -122) ev(0x3f, (v) => { v.setInt32(1, f); v.setUint8(5, 1); v.setFloat32(6, 20); });
    for (const p of ports) {
      ev(0x37, (v) => {
        v.setInt32(1, f); v.setUint8(5, p); v.setUint32(7, 500 + f);
        v.setFloat32(0x19, 0.5); v.setFloat32(0x33, 0.5);
        v.setInt8(0x3b, mainX); v.setInt8(0x40, -3); v.setInt8(0x41, 7); v.setInt8(0x42, -7);
      });
      ev(0x38, (v) => {
        v.setInt32(1, f); v.setUint8(5, p); v.setUint8(7, 1); v.setUint16(8, 14);
        v.setFloat32(0xa, x + p); v.setFloat32(0xe, 0); v.setFloat32(0x12, p ? -1 : 1);
        v.setFloat32(0x16, 0); v.setUint8(0x21, 4);
      });
    }
  };
  const f0 = opts.firstFrame ?? -123;
  frame(f0, 1, 0);
  frame(f0 + 1, 2, 1);
  frame(f0 + 2, 99, 99);  // the first pass, rolled back
  frame(f0 + 2, 3, 2);    // the one that counts
  if (!opts.withGap) frame(f0 + 3, 4, 3);
  else frame(f0 + 4, 4, 3);
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** the .slp file: the event stream and the metadata, in UBJSON as Slippi writes it */
export function slpFile(raw: Uint8Array, metadata: Record<string, unknown> = { startAt: "2026-01-01T00:00:00Z", playedOn: "dolphin" }): Uint8Array {
  return new Uint8Array(encode({ raw, metadata }, { optimizeArrays: true }));
}
