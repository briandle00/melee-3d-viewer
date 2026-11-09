// Samus's grapple glow (Prop.poseTiedChild, cns.ts): the grapple item's glow joint, tied by lb_8000C2F8's place and
// orientation constraints to her ThrowN. Its matrix is made from the turn the orientation constraint wrote back into
// it the frame before (JObjUpdateFunc's HSD_MtxGetRotation), which sets each axis's length; the constraint then
// keeps those lengths along ThrowN's axes. Checked against the game's own memory (tests/fixtures/
// samus-grapple-glow-memory.json: bot-samus_mewtwo, game frame 5022). Reads your game files (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readGameFile, withGameFiles } from "./game-files.ts";

const SAMUS = 13;
const bits = (h: string) => new Float32Array(new Uint32Array([parseInt(h, 16)]).buffer)[0];
/** a 3 x 4 row-major's bits as GL's column-major 4 x 4 */
const gl = (m: string[]) => {
  const v = m.map(bits), out = new Float32Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = v[r * 4 + c];
  out[15] = 1;
  return out;
};

test("game files: the grapple's glow stands on ThrowN at the lengths of the turn the frame before left it, bit for bit", withGameFiles, async () => {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/samus-grapple-glow-memory.json", import.meta.url), "utf8"));
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const { resolvePositionOrientation } = await import("../src/render3d/cns.ts");
  const files = fighterFiles(SAMUS, 0)!;
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const f = new Fighter(SAMUS, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, motion, "test");
  const worlds = fx.parts.map((p: { mtx: string[] }) => gl(p.mtx));
  const model = {
    world: (j: number) => worlds[j] ?? null,
    parent: (j: number) => fx.parts[j].parent,
    flags: (j: number) => parseInt(fx.parts[j].flags, 16),
  };
  const resolve = (m: Float32Array) => { resolvePositionOrientation(m, model, fx.tiedTo); };
  const glow = f.articleAnimated(3, null, null)!;
  assert.ok(glow);
  const place = gl(fx.itemRoot.mtx);
  const rotZ = bits(fx.glow.rotate[2]);
  const want = Array.from(gl(fx.glow.mtx));
  // (made from the turn the frame before left: the game's matrix, every bit)
  glow.poseTiedChild(place, 1, resolve, rotZ, fx.glow.turnBefore.map(bits));
  assert.deepEqual(Array.from(glow.skeleton.world.slice(0, 16)), want);
  // (made from no turn but its z - what it was - the axes' lengths are a few ulps off)
  glow.poseTiedChild(place, 1, resolve, rotZ);
  assert.notDeepEqual(Array.from(glow.skeleton.world.slice(0, 16)), want);
});
