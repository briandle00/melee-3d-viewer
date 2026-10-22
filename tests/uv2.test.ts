// A mesh's third texture coordinate set (GX_VA_TEX2: Dream Land's birds)
// is decoded, and a texture whose coordinates come from it (its TObj's src
// GX_TG_TEX2) samples there, as HSD_TObjSetupTextureCoordGen has GX make
// them from that set.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { decodePObj, type Archive, type MObj, type PObj, type TObj } from "../src/render3d/hsd.ts";
import { RENDER, TEX, TexGen, compileMaterial } from "../src/render3d/gx.ts";

test("a mesh's third texture coordinate set, and a texture taken from it", () => {
  // one triangle, every attribute direct floats: position, then tex0, tex1, tex2
  const dl = new DataView(new ArrayBuffer(3 + 3 * 36 + 1));
  dl.setUint8(0, 0x90); dl.setUint16(1, 3);
  let o = 3;
  for (let v = 0; v < 3; v++) {
    for (const x of [v, 0, 0, 0.1 * v, 0, 0.2 * v, 0, 0.3 * v, 0.5]) { dl.setFloat32(o, x); o += 4; }
  }
  const attr = (a: number, cnt: number) => ({ attr: a, type: 1, cnt, compType: 4, shift: 0, stride: 0, dataOff: 0 });
  const p = { flags: 0, kind: "rigid", attrs: [attr(9, 1), attr(13, 1), attr(14, 1), attr(15, 1)], dlOff: 0, dlSize: dl.byteLength,
              envelopes: [], skinJoint: null } as PObj;
  const m = decodePObj({ data: dl } as unknown as Archive, p);
  assert.deepEqual([...m.uv2!].map((x) => Math.round(x * 10) / 10), [0, 0.5, 0.3, 0.5, 0.6, 0.5]);
  assert.deepEqual([...m.uv1].map((x) => Math.round(x * 10) / 10), [0, 0, 0.2, 0, 0.4, 0]);
  // (a mesh without one has none: the same list read as position, tex0 and tex1, a vertex 28 bytes)
  assert.equal(decodePObj({ data: dl } as unknown as Archive, { ...p, attrs: p.attrs.slice(0, 3) }).uv2, undefined);
  const tex = (src: number) => ({ src, flags: TEX.LIGHTMAP_DIFFUSE | (4 << 16) | (3 << 20), tev: null } as unknown as TObj);
  const prog = compileMaterial({ renderMode: RENDER.DIFFUSE } as MObj, [tex(4), tex(5), tex(6)]);
  assert.deepEqual(prog.texGen, [TexGen.UV0, TexGen.UV1, TexGen.UV2]);
});
