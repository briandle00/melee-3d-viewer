// A stage made from its file (src/render3d/stage.ts) leaves the file's bytes as they were: the bytes are the page's, shared with its other
// players, and the GX player's simulator is handed the same ones - Battlefield's materials that take the fighters' shadows were marked in
// them (RENDER_SHADOW), and the simulator then read a stage file the game's disc does not have.
//   MELEE_ASSETS=<folder> deno test -A --no-check --sloppy-imports tests/stage-pristine.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Stage } from "../src/render3d/stage.ts";
import { readGameFile, withGameFiles } from "./game-files.ts";

test("making a stage leaves its file's bytes as they were", withGameFiles, () => {
  for (const [file, id] of [["GrNBa.dat", 31], ["GrIz.dat", 2], ["GrPs.dat", 3]] as const) {
    const buf = readGameFile(file);
    const before = new Uint8Array(buf).slice();
    new Stage(buf, id);
    assert.deepEqual(new Uint8Array(buf), before, file);
  }
});
