// The embeddable player's renderer choice (src/embedmode.ts, used by embed.tsx): 3D unless the line art is asked for;
// when 3D cannot run here at all it says why where the picture would be (no game files: the files' reason; no WebGL 2:
// "this browser cannot draw WebGL 2") and never switches to the line art by itself; ?renderer= wins over the page's
// choice, which wins over the setting; and WebGL is not probed when it is not needed (probing makes a context). And a
// replay it cannot show: the player says why where the picture would be (and posts {type: "failed", reason}) instead of
// "Reading replay…" for good.
//
//   deno test -A --no-check --sloppy-imports tests/embed-mode.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { askedMode, chooseMode, LINE_ART_ASKED, loadError, loadProblem, NO_WEBGL2, pick3d, waitingText, type FilesStatus } from "../src/embedmode.ts";

const ready: FilesStatus = { available: true, enabled: true, reason: null };
const noFiles: FilesStatus = { available: false, enabled: true, reason: "PlCo.dat could not be read" };
const off: FilesStatus = { available: true, enabled: false, reason: null };
const yes = () => true, no = () => false;
const svg = { renderer: "svg", reason: LINE_ART_ASKED, failed: false };

test("3D with files and WebGL 2 draws, with nothing to say", () => {
  assert.deepEqual(pick3d(ready, yes), { renderer: "3d", reason: null, failed: false });
  assert.deepEqual(chooseMode(ready, null, null, yes), { renderer: "3d", reason: null, failed: false });
});

test("no WebGL 2: the player says this browser cannot draw it, and stays 3D (no switch to the line art)", () => {
  assert.equal(NO_WEBGL2, "this browser cannot draw WebGL 2");
  assert.deepEqual(chooseMode(ready, null, null, no), { renderer: "3d", reason: NO_WEBGL2, failed: true });
  assert.deepEqual(askedMode(ready, "3d", no), { renderer: "3d", reason: NO_WEBGL2, failed: true });
});

test("no game files: the files' own reason, first (WebGL is not probed)", () => {
  let probed = 0;
  const m = chooseMode(noFiles, null, null, () => { probed++; return false; });
  assert.deepEqual(m, { renderer: "3d", reason: "PlCo.dat could not be read", failed: true });
  assert.equal(probed, 0);
});

test("the line art: forced by ?renderer=svg, asked by the page, or the setting off; WebGL is not probed", () => {
  let probed = 0;
  const probe = () => { probed++; return true; };
  assert.deepEqual(chooseMode(ready, "svg", null, probe), svg);
  assert.deepEqual(chooseMode(ready, null, "svg", probe), svg);
  assert.deepEqual(chooseMode(off, null, null, probe), svg);
  assert.deepEqual(askedMode(ready, "svg", probe), svg);
  assert.equal(probed, 0);
});

test("?renderer=3d wins over the setting; the page's svg choice wins over both", () => {
  assert.equal(chooseMode(off, "3d", null, yes).renderer, "3d");
  assert.equal(chooseMode(off, "3d", "svg", yes).renderer, "svg");
  assert.equal(chooseMode(ready, null, "3d", yes).renderer, "3d");
});

test("a replay it cannot show says why: not fetched, not read, not one it plays; one that is shown says nothing", () => {
  assert.equal(loadProblem({ status: 404, failed: 0, skipped: 0, loaded: 0 }), "The replay could not be fetched (HTTP 404).");
  assert.match(loadProblem({ failed: 1, skipped: 0, loaded: 0 })!, /could not be read: the file is damaged or not a Slippi replay/);
  assert.match(loadProblem({ failed: 0, skipped: 1, loaded: 0 })!, /does not play this replay: it has a CPU player or a stage/);
  assert.match(loadProblem({ failed: 0, skipped: 0, loaded: 0 })!, /could not be read/);
  assert.equal(loadProblem({ status: 200, failed: 0, skipped: 0, loaded: 1 }), null);
  assert.equal(loadError(new TypeError("Failed to fetch")), "The replay could not be opened: Failed to fetch");
});

test("where the picture would be: the problem, else Reading replay while it reads, else No replay loaded", () => {
  assert.equal(waitingText(0, null), "No replay loaded");
  assert.equal(waitingText(1, null), "Reading replay…");
  // (a replay read and refused: its reason, not "Reading replay…" for good)
  assert.equal(waitingText(1, "The replay could not be read."), "The replay could not be read.");
});
