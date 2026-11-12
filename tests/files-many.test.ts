// A host's way of reading many game files at once (files.ts FileSource.many, manyFiles): the set comes from it in one read where
// the source has one (a host's server answering the whole set and the browser keeping it); a source without one answers null, and
// the player reads each file on its own (file).
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { file, manyFiles, setFileSource, type FileSource } from "../src/render3d/files.ts";

test("a source that reads many at once answers the set from that, one call for the lot", async () => {
  const calls: string[][] = [];
  const s: FileSource = async (name) => new TextEncoder().encode("one " + name).buffer;
  s.many = async (names) => {
    calls.push(names);
    return new Map(names.filter((n) => n !== "PlMsNr.dat").map((n) => [n, new TextEncoder().encode("set " + n)]));
  };
  setFileSource(s);
  const got = await manyFiles(["PlCo.dat", "PlMsNr.dat", "GrNBa.dat"]);
  assert.deepEqual(calls, [["PlCo.dat", "PlMsNr.dat", "GrNBa.dat"]]);
  assert.deepEqual([...got!.keys()], ["PlCo.dat", "GrNBa.dat"]);
  assert.equal(new TextDecoder().decode(got!.get("GrNBa.dat")), "set GrNBa.dat");
  // (one file is still the source's own read)
  assert.equal(new TextDecoder().decode(await file("PlMsNr.dat")), "one PlMsNr.dat");
});

test("a source without it answers null: each file is read on its own", () => {
  setFileSource(async () => new ArrayBuffer(1));
  assert.equal(manyFiles(["PlCo.dat"]), null);
});
