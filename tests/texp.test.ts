// texp.ts: materials' TEV graphs as MObjMakeTExp makes them and HSD_TExpCompile simplifies them, run through
// gx.ts evalMaterial (each expected byte worked out in its comment), and the fragment shader's program
// interpreter (renderer.ts TEV_PROG_GLSL) against texp.ts runTev, bit for bit, on compiled and random stage
// tables in a headless browser (skipped without one, tests/webgl.ts).

import test from "node:test";
import assertNode from "node:assert/strict";
import { compileMaterial, evalMaterial, RENDER, TEX, tevByte, tevCompare, tevStage } from "../src/render3d/gx.ts";
import type { MObj, TevDesc, TObj } from "../src/render3d/hsd.ts";
import { type TevProgram, packTev, runTev } from "../src/render3d/texp.ts";
import { SHADERS } from "../src/render3d/renderer.ts";
import { browser, runPage } from "./webgl.ts";

const eq = (got: unknown, want: unknown, msg?: string) => assertNode.deepStrictEqual(got, want, msg);

const mobj = (renderMode: number) => ({ renderMode }) as MObj;
const tobj = (flags: number, tev: TevDesc | null = null) => ({ id: 0, src: 4, flags, tev }) as unknown as TObj;
const cmap = (m: number) => m << 16, amap = (m: number) => m << 20;
const DIF = { diffuse: [200, 100, 50], alpha: 255, specular: [0, 0, 0], ras0: [255, 128, 0, 255], ras1: [0, 0, 0, 255] };

test("the diffuse color alone: one stage passing the constant", () => {
  const p = compileMaterial(mobj(RENDER.CONSTANT), []);
  eq(p.tev.stages.length, 1);
  eq(evalMaterial(p, { ...DIF, alpha: 77, texels: [], blend: [] }), [200, 100, 50, 77]);
});

test("a modulated texture, times the lit color: the diffuse, its lerp, the lighting's", () => {
  const p = compileMaterial(mobj(RENDER.DIFFUSE), [tobj(TEX.LIGHTMAP_DIFFUSE | cmap(4) | amap(3))]);
  // (the texture's stage on the diffuse constant, the lighting's: nothing for HSD to merge)
  eq(p.tev.stages.length, 2);
  // modulate: [200, 100, 50] by [128, 255, 0] = [200 * 129 + 128 >> 8, 100, 0] = [101, 100, 0]
  // lit by [255, 128, 0]: 101 * 256 -> 101; 100 * 129 + 128 >> 8 = 50; 0. The alpha: 255 by 255 by 255
  eq(evalMaterial(p, { ...DIF, texels: [[128, 255, 0, 255]], blend: [255] }), [101, 50, 0, 255]);
});

test("SimplifyByMerge: a texture's own subtracting stage taken into the ADD after it rounds and clamps once", () => {
  // the texture's own stage: 0 - konst x texel (GX_TEV_SUB, clamped: 0 on its own); its color map ADD
  const tev: TevDesc = { colorOp: 1, alphaOp: 0, colorBias: 0, alphaBias: 0, colorScale: 0, alphaScale: 0, colorClamp: 1,
                         alphaClamp: 1, colorIn: [15, 0x80, 8, 15], alphaIn: [7, 7, 7, 7], active: 0x40000000 } as TevDesc;
  const p = compileMaterial(mobj(RENDER.CONSTANT), [tobj(TEX.LIGHTMAP_DIFFUSE | cmap(7), tev)]);
  // (merged: one stage, the diffuse - lerp(0, konst, texel), its op flipped to SUB)
  eq(p.tev.stages.length, 1);
  eq(p.tev.stages[p.tev.out].cMode & 15, 1);
  // konst 255 by texel 128 (c' 129): 255 * 129 + 127 = 33022 >> 8 = 128, 200 - 128 = 72; by 64: 16320 + 127 >> 8 = 64,
  // 100 - 64 = 36; by 255 (c' 256): 65407 >> 8 = 255, 50 - 255 clamped to 0. (Unmerged it would be 200, 100, 50.)
  eq(evalMaterial(p, { ...DIF, texels: [[128, 64, 255, 255]], blend: [255], tevColors: [[[255, 255, 255, 255], [0, 0, 0, 0], [0, 0, 0, 0]]] }),
     [72, 36, 0, 255]);
});

test("a texture's own stage: its konst picked, scaled by two, then replacing the color and alpha", () => {
  // texel 100 + konst red 20, times 2 (GX_CS_SCALE_2): (100 << 1) + ((20 << 8 << 1) + 128 >> 8) = 200 + 40 = 240
  const tev: TevDesc = { colorOp: 0, alphaOp: 0, colorBias: 0, alphaBias: 0, colorScale: 1, alphaScale: 0, colorClamp: 1,
                         alphaClamp: 1, colorIn: [0x81, 15, 15, 8], alphaIn: [7, 7, 7, 4], active: 0xc0000000 | 0 } as TevDesc;
  const p = compileMaterial(mobj(RENDER.CONSTANT), [tobj(TEX.LIGHTMAP_DIFFUSE | cmap(5) | amap(4), tev)]);
  eq(evalMaterial(p, { ...DIF, texels: [[100, 100, 100, 77]], blend: [255], tevColors: [[[20, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]] }),
     [240, 240, 240, 77]);
});

test("the specular term: its constant times its channel, added to the lit color", () => {
  const p = compileMaterial(mobj(RENDER.DIFFUSE | RENDER.SPECULAR), [tobj(TEX.LIGHTMAP_DIFFUSE | cmap(4) | amap(3))]);
  // the lit color [101, 50, 0] as above; [10, 20, 30] by 128 ([5, 10, 15]) added
  eq(evalMaterial(p, { ...DIF, specular: [10, 20, 30], ras1: [128, 128, 128, 255], texels: [[128, 255, 0, 255]], blend: [255] }),
     [106, 60, 15, 255]);
});

test("a scalar constant is (int)(255 * f), the product a float's", () => {
  // (0.5: 127.5 -> 127)
  eq(tevByte(0.5), 127);
  // a byte kept as the float nearest k / 255 is k again
  for (let k = 0; k < 256; k++) eq(tevByte(Math.fround(k / 255)), k, `byte ${k}`);
});

// ---------------------------------------------------------------- the shader's program against this

const W = 64, BAND = 8;
const hash = (x: number) => {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};
// a seeded stream for the tables and constants
let seed = 0x2468ace;
const rnd = (m: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % m; };

/** a random stage table: every input kind, part and mode, each stage reading only earlier ones */
function randomProgram(): TevProgram {
  const n = 1 + rnd(16);
  const stages = Array.from({ length: n }, (_, k) => {
    const input = () => {
      const kind = rnd(6), part = rnd(5);
      const idx = kind === 1 ? rnd(256) : kind === 4 ? [0, 1, 2, 3, 4, 5, 6, 8 + rnd(12)][rnd(8)] : kind === 5 ? (k ? rnd(k) : 0) : 0;
      return kind === 5 && !k ? 0 : kind | (part << 3) | (idx << 6);
    };
    const md = () => { const ops = [0, 1, 0, 1, 8 + rnd(8)]; return ops[rnd(5)] | (rnd(3) << 4) | (rnd(4) << 6) | (rnd(2) << 8) | (rnd(4) ? 512 : 0); };
    return { c: [input(), input(), input(), input()], a: [input(), input(), input(), input()], cMode: md(), aMode: md(),
             tex: rnd(5) - 1, chan: rnd(3) - 1 };
  });
  return { stages, out: rnd(n) };
}

test("the fragment shader's TEV program is runTev's, bit for bit", { skip: !browser() && "no browser" }, () => {
  const { MATF, MATI } = SHADERS;
  const lit = compileMaterial(mobj(RENDER.DIFFUSE | RENDER.SPECULAR), [tobj(TEX.LIGHTMAP_DIFFUSE | cmap(4) | amap(3)),
    tobj(TEX.LIGHTMAP_SPECULAR | cmap(3) | amap(2)), tobj(TEX.LIGHTMAP_EXT | cmap(7) | amap(6))]).tev;
  const progs: TevProgram[] = [lit, ...Array.from({ length: 31 }, randomProgram)];
  // each program's block: its table, and random constants (bytes / 255)
  const blocks = progs.map((p) => {
    const bytes = new Uint8Array((MATF + MATI) * 16);
    const F = new Float32Array(bytes.buffer, 0, MATF * 4), I = new Int32Array(bytes.buffer, MATF * 16, MATI * 4);
    for (let i = 0; i < MATF * 4; i++) F[i] = rnd(256) / 255;
    const n = packTev(p, I, 12, 16);
    I[8] = n; I[9] = p.out;
    return { bytes, F };
  });
  const fs = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
${SHADERS.MAT_DECL}
${SHADERS.TEV_GLSL}
${SHADERS.TEV_PROG_GLSL}
uint hsh(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
ivec4 b4(uint i, uint k) { uint h = hsh(i * 8u + k); return ivec4(h & 255u, (h >> 8) & 255u, (h >> 16) & 255u, h >> 24); }
uniform int uBand;
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  uint i = uint((uBand * ${BAND} + y % ${BAND}) * ${W} + x);
  for (int s = 0; s < 4; s++) tevTx[s] = b4(i, uint(s));
  tevRas[0] = b4(i, 4u); tevRas[1] = b4(i, 5u);
  outColor = vec4(tevProgram() & 255) / 255.0;
}`;
  const px = runPage<number[]>(`
const W = ${W}, H = ${BAND * progs.length};
const blocks = ${JSON.stringify(blocks.map((b) => Array.from(b.bytes)))};
const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
const gl = cv.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, "#version 300 es\\nvoid main() { vec2 q = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(q, 0.0, 1.0); }"));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, ${JSON.stringify(fs)}));
gl.linkProgram(p);
if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, "Mat"), 0);
const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
gl.useProgram(p);
const ubo = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
blocks.forEach((b, k) => {
  gl.bufferData(gl.UNIFORM_BUFFER, new Uint8Array(b), gl.DYNAMIC_DRAW);
  gl.uniform1i(gl.getUniformLocation(p, "uBand"), k);
  gl.viewport(0, k * ${BAND}, W, ${BAND}); gl.drawArrays(gl.TRIANGLES, 0, 3);
});
const out = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
done(Array.from(out));`);
  eq(px.length, W * BAND * progs.length * 4);
  const byte = (v: number) => Math.floor(Math.min(Math.max(v, 0), 1) * 255 + 0.5);
  let bad = 0, first = "";
  progs.forEach((p, k) => {
    const F = blocks[k].F;
    const vec = (o: number) => [byte(F[o]), byte(F[o + 1]), byte(F[o + 2]), byte(F[o + 3])];
    const cnst = (id: number): number[] => {
      if (id === 0) return [...vec(0).slice(0, 3), 255];
      if (id === 1) { const a = byte(F[22]); return [a, a, a, a]; }
      if (id === 2) return [...vec(8).slice(0, 3), 255];
      if (id < 8) { const b = byte(F[12 + id - 3]); return [b, b, b, b]; }
      return vec(72 + (id - 8) * 4);
    };
    for (let y = 0; y < BAND; y++) for (let x = 0; x < W; x++) {
      const i = (k * BAND + y) * W + x;
      const b4 = (q: number) => { const h = hash((i * 8 + q) >>> 0); return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24]; };
      const want = runTev(p, { texel: (s) => b4(s), ras: (c) => b4(4 + c), cnst }, { stage: tevStage, compare: tevCompare }).map((v) => v & 255);
      const o = i * 4, got = px.slice(o, o + 4);
      if (want.some((v, q) => v !== got[q]) && !bad++) first = `program ${k} (${x}, ${y}): shader ${got}, TypeScript ${want}`;
    }
  });
  eq(bad, 0, `pixels that differ: ${bad}, first ${first}`);
});
