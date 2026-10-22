// drawlog.ts: the renderer's debug draw log, on made-up meshes and a stand-in renderer: the identity hashes and
// probe inputs a GX command decoder must share with it, a display list's primitives, GX's projection numbers from
// GL's, a mesh's record, and that attaching wraps one renderer and detaching leaves it as it was.

import test from "node:test";
import assertNode from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DrawLog, RENDERER_NAMES, dlPrims, drawLogCommand, geoHash, gxHash, gxProjection, imageId, probes, tlutId, vertexSize,
  gameTexMaps, normalMatrix,
} from "../src/render3d/drawlog.ts";
import { LOBJ, RENDER, compileMaterial } from "../src/render3d/gx.ts";
import { LightSet } from "../src/render3d/lightset.ts";
import type { Archive, MObj, PObj } from "../src/render3d/hsd.ts";
import { perspective } from "../src/render3d/math.ts";

const assert = (ok: unknown, msg = "assertion failed") => assertNode.ok(ok, msg);
const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);


const enc = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

function archiveOf(bytes: Uint8Array): Archive {
  return { data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u8: bytes, reloc: new Set(), publics: new Map() };
}

// a triangle as the decoder's test makes it: position by 16-bit index, color 0 direct RGBA8888
const TRI = "9000030000ffffffff0001ffffffff0002ffffffff";
const POBJ = (dlOff: number, dlSize: number): PObj => ({
  flags: 0, kind: "rigid", dlOff, dlSize, envelopes: [], skinJoint: null,
  attrs: [{ attr: 9, type: 3, cnt: 1, compType: 3, shift: 4, stride: 6, dataOff: 0 },
          { attr: 11, type: 1, cnt: 1, compType: 5, shift: 0, stride: 4, dataOff: 0 }],
});

test("the hashes are the decoder's", () => {
  assertEquals(gxHash(new Uint8Array(0)), "811c9dc59747b28c");
  assertEquals(gxHash(enc("abc")), "1a47e90bacf442a4");
  assertEquals(gxHash(hex(TRI)), "6ad436e3e6c11378");
  assertEquals(geoHash([["tris", 3, "6ad436e3e6c11378"]]), "a015473999b075c8");
});

test("the probe inputs are the decoder's", () => {
  const p = probes();
  assertEquals(p.length, 6);
  assertEquals(p[0].t[0].map((v) => Math.round(v * 255)), [127, 159, 142, 72]);
  assertEquals(p[5].v[1].map((v) => Math.round(v * 255)), [209, 115, 12, 166]);
  assert(p.every((q) => q.t.length === 8 && q.s.length === 2 && q.v.length === 2), "8 texels, 2 light sums, 2 vertex colors");
});

test("a display list's primitives, its padding skipped", () => {
  const dl = new Uint8Array(64);
  dl.set(hex(TRI), 0);
  dl.set(hex(TRI), 21);
  const a = archiveOf(dl), p = POBJ(0, 64);
  assertEquals(vertexSize(p), 6);
  assertEquals(dlPrims(a, p), [["tris", 3, "6ad436e3e6c11378"], ["tris", 3, "6ad436e3e6c11378"]]);
  // a list cut short keeps what is whole
  assertEquals(dlPrims(a, POBJ(0, 30)).length, 1);
});

test("an image's and a palette's identity: their bytes in the file", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const a = archiveOf(bytes);
  // 8 x 8 I8: two blocks of 8 x 4, 64 bytes
  assertEquals(imageId(a, { offset: 0, width: 8, height: 8, format: 1, dataOff: 16 }), gxHash(bytes.subarray(16, 80)));
  assertEquals(imageId(a, { offset: 0, width: 64, height: 64, format: 1, dataOff: 0 }), null);
  // a C4's palette: 16 entries; 12 in the file are loaded as 16
  assertEquals(tlutId(a, { offset: 0, dataOff: 100, format: 2, count: 12 }, 8), gxHash(bytes.subarray(100, 132)));
});

test("GX's projection numbers from a GL perspective", () => {
  const n = 1, f = 1000;
  const m = perspective(new Float32Array(16), Math.PI / 2, 4 / 3, n, f);
  const g = gxProjection(m);
  assertEquals(g[6], "persp");
  assert(Math.abs((g[4] as number) - -n / (f - n)) < 1e-6, `p4 ${g[4]}`);
  assert(Math.abs((g[5] as number) - (-f * n) / (f - n)) < 1e-3, `p5 ${g[5]}`);
  assert(Math.abs((g[2] as number) - 1) < 1e-6, "90 degrees up and down");
});

test("the renderer still has every field and method the log reads", () => {
  const src = readFileSync(new URL("../src/render3d/renderer.ts", import.meta.url), "utf8");
  for (const name of RENDERER_NAMES) {
    assert(new RegExp(`\\n\\s+(private |readonly |public )*${name}\\s*[(:=]`).test(src), `renderer.ts has no ${name}`);
  }
});

/** a renderer as far as the log reads one: its draw methods count draws */
function standIn() {
  const ident = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const view = ident.slice();
  view[14] = -10;                                     // the camera 10 back
  const proj = perspective(new Float32Array(16), Math.PI / 2, 1, 1, 1000);
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
    vp[c * 4 + r] = s;
  }
  const r = {
    gl: { FUNC_REVERSE_SUBTRACT: 0x800b },
    draws: 0, cs: { cull: 0, blend: 1, src: 0x302, dst: 1, eq: 0x8006, dmask: 0, dfunc: 0x203, cmask: 1 },
    camView: view, camVP: vp, camProj: proj, camGx: null, shiftView: view, shiftVP: vp, shifted: false, mirrored: false, lighting: null,
    overlayVP: null, viewProj: vp,
    // (what the renderer uploads for a draw: view times each of its matrices)
    mvBuf: new Float32Array(160),
    cullOn: true,
    staticsOf(s: { mobj: MObj }) {
      const I = new Int32Array(32), F = new Float32Array(128);
      I[3] = 4 | (7 << 3);
      F[20] = 0;
      return { p: compileMaterial(s.mobj, []), I, F };
    },
    begin() {},
    setFog() {},
    drawOne(d: { mats: Float32Array; nMats: number }) {
      for (let k = 0; k < d.nMats; k++) for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let q = 0; q < 4; q++) s += view[q * 4 + r] * d.mats[k * 16 + c * 4 + q];
        this.mvBuf[k * 16 + c * 4 + r] = s;
      }
      this.draws++;
    },
    drawGeometry() { this.draws++; },
    drawParticles() {},
    drawTrail() {},
    drawSphere() {},
  };
  return r;
}

const MOBJ: MObj = { renderMode: 1, tobjs: [], ambient: [0, 0, 0, 1], diffuse: [1, 1, 1, 1], specular: [0, 0, 0, 1], alpha: 1,
                     shininess: 50, pe: null };

test("a mesh's record: its primitives, matrices, pixel engine and probe", () => {
  const r = standIn();
  const before = { ...r };
  const dl = new Uint8Array(32);
  dl.set(hex(TRI), 0);
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]);
  const d = {
    key: "stage:3:0", archive: archiveOf(dl), pobj: { ...POBJ(0, 32), flags: 0x8000 }, jobj: { index: 3 }, mats: world, nMats: 1,
    translucent: false, group: { tag: "stage" },
    state: { mobj: MOBJ, diffuse: new Float32Array([0.5, 0.25, 1, 1]), ambient: new Float32Array([0, 0, 0, 1]),
             specular: new Float32Array([0, 0, 0, 1]), alpha: 1, tex: [], override: null, skip: null, mirror: null },
  };
  // deno-lint-ignore no-explicit-any
  const any = r as any;
  const out = drawLogCommand(any, { start: true, label: 7 });
  assertEquals(out, { attached: true, frames: 0 });
  any.begin();
  any.drawOne(d, null, null);
  any.drawOne(d, { color: [1, 1, 1], alpha: 0.5 }, null);
  const frames = drawLogCommand(any, { take: true, stop: true }) as { frame: number; draws: Record<string, unknown>[] }[];
  assertEquals(frames.length, 1);
  assertEquals(frames[0].frame, 7);
  // (the frame's picture is cleared first: the game's erase quad)
  const [c, m, g] = frames[0].draws;
  assertEquals(c, { kind: "clear", w: 640, h: 480, z: { test: false, func: "always", write: false },
                    blend: { on: false, src: null, dst: null, sub: false, logic: null }, i: 0 });
  assertEquals(m.kind, "mesh");
  assertEquals(g.kind, "ghost");
  assertEquals(m.prims, [["tris", 3, "6ad436e3e6c11378"]]);
  assertEquals(m.geo, "a015473999b075c8");
  assertEquals(m.mtx, { "0": [[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, -10]] });
  assertEquals(m.cull, "back");
  assertEquals(m.z, { test: true, func: "lequal", write: false });
  assertEquals(m.blend, { on: true, src: "srcalpha", dst: "one", sub: false, logic: null });
  assertEquals(m.alpha_test, ["greater", 0, "and", "always", 0]);
  assertEquals((m.proj as unknown[])[6], "persp");
  // a constant material with no textures shades as its own color, whatever the inputs
  assertEquals(m.probe, probes().map(() => [128, 64, 255, 255]));
  // detached: the stand-in's own methods back, nothing on the instance
  for (const k of ["begin", "drawOne", "setFog"]) assert(any[k] === (before as Record<string, unknown>)[k], `${k} is the renderer's own again`);
});

test("a lit material's probe: its alpha the light sum's through the alpha channel when a light has LOBJ_ALPHA", () => {
  const probeAlpha = (flags: number) => {
    const r = standIn();
    // deno-lint-ignore no-explicit-any
    const any = r as any;
    any.lighting = new LightSet([{ desc: 1, kind: "infinite", flags: LOBJ.INFINITE | LOBJ.DIFFUSE | flags,
      color: [1, 1, 1, 1], position: [0, 0, 1], interest: null, raw: null, spot: null, dist: null, anim: null }]).at(0);
    const dl = new Uint8Array(32);
    dl.set(hex(TRI), 0);
    const d = {
      key: "f0:0:0:0", archive: archiveOf(dl), pobj: POBJ(0, 32), jobj: { index: 0 }, mats: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      nMats: 1, translucent: false, group: null,
      state: { mobj: { ...MOBJ, renderMode: RENDER.DIFFUSE }, diffuse: new Float32Array([1, 1, 1, 1]), ambient: new Float32Array([0, 0, 0, 1]),
               specular: new Float32Array([0, 0, 0, 1]), alpha: 1, tex: [], override: null, skip: null, mirror: null },
    };
    drawLogCommand(any, { start: true });
    any.begin();
    any.drawOne(d, null, null);
    const frames = drawLogCommand(any, { take: true, stop: true }) as { draws: Record<string, unknown>[] }[];
    return (frames[0].draws[1].probe as number[][])[0][3];
  };
  // (probe 0's light sum alpha 49: (255 * (49 + 0)) >> 8 = 48, HSD_State_80405A38_90 with ambient alpha 0)
  assertEquals(probeAlpha(LOBJ.ALPHA), 48);
  // (no light in HSD_LObjGetLightMaskAlpha: the unlit channel, HSD_State_80405A38_C0)
  assertEquals(probeAlpha(0), 255);
});

test("nothing is logged without start, and particles keep their batches", () => {
  const r = standIn();
  // deno-lint-ignore no-explicit-any
  const any = r as any;
  const log = new DrawLog(any);
  assert(!log.attached, "not attached until asked");
  any.begin();
  assertEquals(log.frames.length, 0);
  log.attach();
  any.begin();
  const data = new Float32Array(17 * 4);
  for (let v = 0; v < 4; v++) { data[v * 17] = v & 1 ? 1 : -1; data[v * 17 + 1] = v & 2 ? 1 : -1; }
  any.drawParticles(data, [{ sprite: null, additive: true, near: false, zwrite: false, nozcomp: false, first: 0, count: 1 }]);
  const [, p] = log.take()[0].draws;
  log.detach();
  assertEquals(p.kind, "particles");
  assertEquals((p.blend as { dst: string }).dst, "one");
  assertEquals(p.quads, 1);
  const b = p.bbox as number[];
  assert(b[0] < 320 && b[2] > 320 && b[1] < 240 && b[3] > 240, `around the middle: ${b}`);
  // each quad's four corners, in vertex order, inside the batch's box
  const corners = p.corners as [number, number][][];
  assertEquals(corners.length, 1);
  assertEquals(corners[0].length, 4);
  for (const [x, y] of corners[0]) assert(x >= b[0] - 0.1 && x <= b[2] + 0.1 && y >= b[1] - 0.1 && y <= b[3] + 0.1, `corner ${x}, ${y}`);
});

test("numbers are written as the float32s uploaded, or to 6 digits when asked", () => {
  const r = standIn();
  // deno-lint-ignore no-explicit-any
  const any = r as any;
  const dl = new Uint8Array(32);
  dl.set(hex(TRI), 0);
  // a matrix the 6-digit rounding would change: a turn of a tenth of a radian, moved by a third
  const c = Math.fround(Math.cos(0.1)), s = Math.fround(Math.sin(0.1)), t = Math.fround(1 / 3);
  const world = new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, t, 0, 0, 1]);
  const d = {
    key: "stage:0:0", archive: archiveOf(dl), pobj: POBJ(0, 32), jobj: { index: 0 }, mats: world, nMats: 1, translucent: false, group: null,
    state: { mobj: MOBJ, diffuse: new Float32Array([1, 1, 1, 1]), ambient: new Float32Array([0, 0, 0, 1]),
             specular: new Float32Array([0, 0, 0, 1]), alpha: 1, tex: [], override: null, skip: null, mirror: null },
  };
  drawLogCommand(any, { start: true });
  any.begin();
  any.drawOne(d, null, null);
  drawLogCommand(any, { exact: false });
  any.begin();
  any.drawOne(d, null, null);
  const frames = drawLogCommand(any, { take: true, stop: true }) as { draws: Record<string, unknown>[] }[];
  const exact = frames[0].draws[1].mtx as Record<string, number[][]>, rounded = frames[1].draws[1].mtx as Record<string, number[][]>;
  // (the modelview as uploaded: the stand-in's view is 10 back)
  assertEquals(exact["0"][0], [c, -s, 0, t]);
  assert(exact["0"][0].every((v) => Math.fround(v) === v), "every number a float32");
  assertEquals(rounded["0"][0], [0.995004, -0.0998334, 0, 0.333333]);
  // the projection as uploaded: GL's -1 / (near - far) halves, kept as float32s
  const proj = frames[0].draws[1].proj as number[];
  assert(proj.slice(0, 6).every((v) => Math.fround(v) === v), `projection as float32s: ${proj}`);
});

test("while the log is on nothing is culled (GX culls no mesh), and the renderer's culling comes back after", () => {
  const r = standIn();
  // deno-lint-ignore no-explicit-any
  const any = r as any;
  const log = new DrawLog(any);
  log.attach();
  assertEquals(any.cullOn, false);
  log.detach();
  assertEquals(any.cullOn, true);
});

test("the draw log numbers texture maps as HSD_TObjAssignResources does: the bump map after the plain ones", () => {
  const BUMP = 1 << 24;
  // (Link's sword: a UV texture, the bump map, a reflection)
  assertNode.deepEqual(gameTexMaps([0x10, 0x10 | BUMP, 0x11]), [0, 2, 1]);
  // a toon texture last; of two bump maps the last is kept
  assertNode.deepEqual(gameTexMaps([4, BUMP, 0, BUMP]), [2, -1, 0, 1]);
  // at most 8 plain ones, 6 with a bump map
  assertNode.deepEqual(gameTexMaps([0, 0, 0, 0, 0, 0, 0, BUMP]), [0, 1, 2, 3, 4, 5, -1, 6]);
});

test("normalMatrix: the modelview's 3 x 3 inverse transposed", () => {
  // (a turn about z by 90 degrees, scaled 0.6: the normal matrix is the turn over 0.6)
  const m = new Float32Array([0, 0.6, 0, 0, -0.6, 0, 0, 0, 0, 0, 0.6, 0, 5, 6, 7, 1]);
  const n = normalMatrix(m);
  const want = [0, -1 / 0.6, 0, 1 / 0.6, 0, 0, 0, 0, 1 / 0.6];
  n.forEach((v, i) => assertNode.ok(Math.abs(v - want[i]) < 1e-6, `${i}: ${v} vs ${want[i]}`));
});

test("a UV set's texture matrix row is logged as the game's effective one: its third column's constant in the fourth", async () => {
  const { uvRow } = await import("../src/render3d/drawlog.ts");
  // (a texture turned out of its plane, as Fountain of Dreams' water: s from the row's third column)
  assertEquals(uvRow([7.2e-5, 0, 0.9989, 0.0001], 0), [7.2e-5, 0, 0, 0.9989 + 0.0001]);
  assertEquals(uvRow([1, 0, 0, 0.5], 1), [1, 0, 0, 0.5]);
  // (the others' rows as they are)
  assertEquals(uvRow([1, 2, 3, 4], 4), [1, 2, 3, 4]);
});
