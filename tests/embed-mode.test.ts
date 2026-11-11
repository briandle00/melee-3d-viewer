// The embeddable player's renderer choice (src/embedmode.ts, used by embed.tsx): 3D unless the line art is asked for;
// when 3D cannot run here at all it says why where the picture would be (no game files: the files' reason; no WebGL 2:
// "this browser cannot draw WebGL 2") and never switches to the line art by itself; ?renderer= wins over the page's
// choice, which wins over the setting; and WebGL is not probed when it is not needed (probing makes a context). And a
// replay it cannot show: the player says why where the picture would be (and posts {type: "failed", reason, retry}) instead of
// "Reading replay…" or "No replay loaded" for good, with Try Again where trying again may bring it, asking again by itself
// when there was no answer (render3d/net.ts).
//
//   deno test -A --no-check --sloppy-imports tests/embed-mode.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { askedMode, chooseMode, fetchProblem, LINE_ART_ASKED, NO_WEBGL2, pick3d, problemNote, readProblem, waitingText, type FilesStatus } from "../src/embedmode.ts";
import { FetchFailed } from "../src/render3d/net.ts";

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

test("a replay it cannot show says why: no answer, not there, not given, not read, not one it plays; one that is shown says nothing", () => {
  // (no answer, or the server busy: asked again by itself, Try Again meanwhile)
  assert.deepEqual(fetchProblem(new FetchFailed("network", null, "Failed to fetch")),
                   { text: "The replay could not be loaded: the server did not answer.", retry: "auto" });
  assert.deepEqual(fetchProblem(new FetchFailed("server", 503, "HTTP 503")),
                   { text: "The replay could not be loaded: the server could not send it (HTTP 503).", retry: "auto" });
  // (not there: said as that, asked again only when Try Again is pressed - never "could not be read")
  assert.deepEqual(fetchProblem(new FetchFailed("gone", 404, "HTTP 404")),
                   { text: "The replay is not there anymore: it was moved, renamed or deleted.", retry: "button" });
  assert.deepEqual(fetchProblem(new FetchFailed("refused", 403, "HTTP 403")),
                   { text: "The replay could not be loaded: the server refused it (HTTP 403).", retry: "button" });
  assert.deepEqual(fetchProblem(new Error("out of memory")), { text: "The replay could not be opened: out of memory", retry: "button" });
  // (read and refused: nothing to try again)
  assert.deepEqual(readProblem({ failed: 1, skipped: 0, loaded: 0 }),
                   { text: "The replay could not be read: the file is damaged or not a Slippi replay.", retry: "none" });
  assert.match(readProblem({ failed: 0, skipped: 1, loaded: 0 })!.text, /does not play this replay: it has a CPU player or a stage/);
  assert.equal(readProblem({ failed: 0, skipped: 1, loaded: 0 })!.retry, "none");
  assert.match(readProblem({ failed: 0, skipped: 0, loaded: 0 })!.text, /could not be read/);
  assert.equal(readProblem({ failed: 0, skipped: 0, loaded: 1 }), null);
});

test("under a problem: that it tries again by itself, or that a try is under way; nothing where only Try Again can help", () => {
  const auto = fetchProblem(new FetchFailed("network", null, "x")), gone = fetchProblem(new FetchFailed("gone", 404, "x"));
  assert.equal(problemNote(auto, false), "It tries again by itself every few seconds.");
  assert.equal(problemNote(auto, true), "Trying again…");
  assert.equal(problemNote(gone, false), null);
  assert.equal(problemNote(gone, true), "Trying again…");
});

test("where the picture would be: the problem, else Reading replay while it reads, Loading replay while it is fetched, else No replay loaded", () => {
  assert.equal(waitingText(0, false, null), "No replay loaded");
  assert.equal(waitingText(0, true, null), "Loading replay…");
  assert.equal(waitingText(1, true, null), "Reading replay…");
  // (a replay read and refused, or not fetched: its reason, not "Reading replay…" or "No replay loaded" for good)
  const p = readProblem({ failed: 1, skipped: 0, loaded: 0 })!;
  assert.equal(waitingText(1, false, p), p.text);
  assert.equal(waitingText(0, false, fetchProblem(new FetchFailed("network", null, "x"))), "The replay could not be loaded: the server did not answer.");
});
