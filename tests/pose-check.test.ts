// tools/pose_check.py reads a track's compact form (VTB1) as the viewer
// does (trackcodec.ts readTrack): a synthetic "wf" line, whole-number columns
// and a column of exact float words, read by both, the words the same; and
// its own self-test. Skipped without python3.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrack } from "../src/render3d/trackcodec.ts";

const TOOL = fileURLToPath(new URL("../tools/pose_check.py", import.meta.url));
const python = (() => {
  for (const p of ["python3", "python"]) {
    try { execFileSync(p, ["--version"], { stdio: "ignore" }); return p; } catch { /* the next */ }
  }
  return null;
})();
const skip = python ? false : "no python3";

/** a VTB1 buffer of one type, its rows a frame and these columns: whole numbers (kind 0) or float words (kind 4) */
function vtb1(type: string, frames: number[], columns: { kind: 0 | 4; values: number[] }[]): Uint8Array {
  const out: number[] = [];
  const varint = (x: number) => { while (x >= 0x80) { out.push((x % 128) | 0x80); x = Math.floor(x / 128); } out.push(x); };
  const zigzag = (x: number) => varint(x >= 0 ? x * 2 : -x * 2 - 1);
  const text = (s: string) => { const b = new TextEncoder().encode(s); varint(b.length); out.push(...b); };
  out.push(...new TextEncoder().encode("VTB1"));
  text(JSON.stringify({ version: 2 }));
  varint(1); text(type);
  varint(frames.length); for (let i = 0; i < frames.length; i++) varint(0);
  out.push(0); varint(columns.length);
  let last = 0;
  for (const f of frames) { zigzag(f - last); last = f; }
  for (const c of columns) {
    out.push(c.kind);
    let w = 0;
    for (const v of c.values) {
      const u = c.kind === 4 ? new Uint32Array(new Float32Array([v]).buffer)[0] : v;
      zigzag(u - w); w = u;
    }
  }
  return new Uint8Array(out);
}

test("pose_check.py reads the compact form's words as the viewer reads its floats", { skip }, () => {
  const vals = [1, -0.5, Math.fround(0.1), 2.75, 0, 1, 0, -3.5, 0, 0, 1, 100.25];
  const head = [1, 0, 2, 3, 4095].map((v) => ({ kind: 0 as const, values: [v, v] }));
  const words = vals.map((v, k) => ({ kind: 4 as const, values: [v, v * (k + 2)] }));
  const buf = vtb1("wf", [-123, -122], [...head, ...words]);
  const viewer = readTrack(buf).events;
  const dir = mkdtempSync(join(tmpdir(), "pose-check-"));
  try {
    const path = join(dir, "g.track.vtb");
    writeFileSync(path, buf);
    const script = "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport pose_check as p\n" +
      "print(json.dumps(p.read_events(sys.argv[2])))";
    const got = JSON.parse(execFileSync(python!, ["-c", script, join(TOOL, ".."), path], { encoding: "utf8" }));
    assert.equal(got.length, viewer.length);
    got.forEach((e: unknown[], i: number) => {
      const v = viewer[i];
      assert.deepEqual(e.slice(0, 7), v.slice(0, 7));
      for (let k = 7; k < v.length; k++) {
        const want = new Uint32Array(new Float32Array([v[k] as number]).buffer)[0];
        assert.equal(Number(e[k]), want, `line ${i} value ${k - 7}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pose_check.py's self-test", { skip }, () => {
  assert.match(execFileSync(python!, [TOOL, "--self-test"], { encoding: "utf8" }), /self-test passed/);
});
