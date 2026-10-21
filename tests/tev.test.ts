// gx.ts's integer TEV and lighting: hand-worked stages (each expected byte worked out in its comment), the
// channel's output, HSD_MulColor, a material through HSD_TExpCompile's stages, a particle's color as the game
// draws it, and the fragment shader's TEV (renderer.ts TEV_GLSL) against the TypeScript on many random
// inputs in a headless browser (skipped without one, tests/webgl.ts).

import test from "node:test";
import assertNode from "node:assert/strict";
import {
  ALPHA_MAP_IN, COLOR_MAP_IN, RENDER, TEX, alphaMap, chanColor, colorMap, compileMaterial, evalMaterial, mulColor, overColor, tevByte,
  tevCompare, tevDescStep, tevStage,
} from "../src/render3d/gx.ts";
import { psColorByte } from "../src/render3d/fx/draw.ts";
import type { MObj, TObj } from "../src/render3d/hsd.ts";
import { SHADERS } from "../src/render3d/renderer.ts";
import { browser, runPage } from "./webgl.ts";

const eq = (got: unknown, want: unknown, msg?: string) => assertNode.deepStrictEqual(got, want, msg);

test("a stage's lerp: c widened to 0..256, over 256 with its rounding bias", () => {
  // lerp(0, 200, 255): c' = 256, (200 * 256 + 128) >> 8 = 200 (all of b)
  eq(tevStage(0, 200, 255, 0, 0, 0, 0, true), 200);
  // 200 times 128: c' = 129, (200 * 129 + 128) >> 8 = 25928 >> 8 = 101 (the float product 200 * 128 / 255 is 100.4)
  eq(tevStage(0, 200, 128, 0, 0, 0, 0, true), 101);
  // lerp(100, 200, 64): (100 << 8) + 100 * 64 = 32000, + 128 = 32128 >> 8 = 125
  eq(tevStage(100, 200, 64, 0, 0, 0, 0, true), 125);
  // d - a: the lerp's bias is 127 when it subtracts: (30 << 8) + 127 >> 8 = 30, 100 - 30 = 70
  eq(tevStage(30, 0, 0, 100, 1, 0, 0, true), 70);
  // d plus a half, times 2: (100 + 128) << 1 = 456, clamped to 255 or kept
  eq(tevStage(0, 0, 0, 100, 0, 1, 1, true), 255);
  eq(tevStage(0, 0, 0, 100, 0, 1, 1, false), 456);
  // scale 4 moves into the lerp before its divide: (((0 << 8) + 50 * 129) << 2) + 128 >> 8 = 25928 >> 8 = 101, + (10 << 2) = 141
  eq(tevStage(0, 50, 128, 10, 0, 0, 2, true), 141);
  // halved: no rounding bias, (101 + ((255 * 256) >> 8)) >> 1 = (101 + 255) >> 1 = 178
  eq(tevStage(0, 255, 255, 101, 0, 0, 3, true), 178);
  // minus a half: 100 - 128 = -28, kept unclamped; and the 10-bit floor
  eq(tevStage(0, 0, 0, 100, 0, 2, 0, false), -28);
  eq(tevStage(255, 0, 0, -1000, 1, 0, 0, false), -1024);
  // a, b and c are their registers' low 8 bits (300 & 255 = 44), d its whole value
  eq(tevStage(300, 0, 0, 300, 0, 0, 0, false), 344);
});

test("the compare modes: on bytes, as 8, 16 or 24-bit numbers or per channel", () => {
  // R8_GT (8): 10 > 5 on red, so d + c on every channel
  eq(tevCompare(8, [10, 0, 0, 0], [5, 9, 9, 0], [50, 60, 70, 0], [1, 2, 3, 0], false, true), [51, 62, 73]);
  // GR16_GT (10): green-red 0x0100 = 256 > 0x00ff = 255
  eq(tevCompare(10, [0, 1, 0, 0], [255, 0, 0, 0], [5, 5, 5, 0], [0, 0, 0, 0], false, true), [5, 5, 5]);
  // RGB8_EQ (15): per channel, equal red and blue only
  eq(tevCompare(15, [1, 2, 3, 0], [1, 9, 3, 0], [7, 7, 7, 0], [0, 0, 0, 0], false, true), [7, 0, 7]);
  // A8_GT (14) on an alpha
  eq(tevCompare(14, [0, 0, 0, 200], [0, 0, 0, 100], [0, 0, 0, 30], [0, 0, 0, 20], true, true), [50]);
});

test("the color and alpha maps as TObjMakeTExp's stages", () => {
  // MODULATE (4): color times texel, [200 * 129, 100 * 256, 50 * 1] with the bias, >> 8: [101, 100, 0]
  eq(colorMap(4, [200, 100, 50], [128, 255, 0, 255], 0), [101, 100, 0]);
  // ALPHA_MASK (1): lerp(color, texel, texel alpha 128): (200 * 256 + (0 - 200) * 129 + 128) >> 8 = 99
  eq(colorMap(1, [200, 0, 0], [0, 0, 0, 128], 0)[0], 99);
  // BLEND (3) by 64: lerp(0, 255, 64) = (255 * 64 + 128) >> 8 = 64
  eq(colorMap(3, [0, 0, 0], [255, 255, 255, 255], 64), [64, 64, 64]);
  // REPLACE (5), ADD (7), SUB (8)
  eq(colorMap(5, [1, 2, 3], [9, 8, 7, 0], 0), [9, 8, 7]);
  eq(colorMap(7, [200, 2, 3], [100, 8, 7, 0], 0), [255, 10, 10]);
  eq(colorMap(8, [200, 2, 3], [100, 8, 7, 0], 0), [100, 0, 0]);
  // the alpha's MODULATE (3): 128 times 128 -> (128 * 129 + 128) >> 8 = 65
  eq(alphaMap(3, 128, 128, 0), 65);
  eq(alphaMap(4, 128, 17, 0), 17);
  eq(COLOR_MAP_IN.length, 9);
  eq(ALPHA_MAP_IN.length, 8);
});

test("a color channel: the material color times the clamped sum, (mat * (acc + (acc >> 7))) >> 8", () => {
  // 100 lit by white: 255 * 100 >> 8 = 99 (25500 / 256 = 99.6)
  eq(chanColor(255, 100), 99);
  // 128 and up count 256 parts: 255 * 129 >> 8 = 128
  eq(chanColor(255, 128), 128);
  eq(chanColor(255, 400), 255);
  eq(chanColor(255, -20), 0);
  // HSD_MulColor divides by 255: 128 * 128 / 255 = 64.25 -> 64; white leaves a color as it is
  eq(mulColor([128, 255, 0, 255], [128, 255, 255, 255]), [64, 255, 0, 255]);
});

test("a material through HSD_TExpCompile's stages: its diffuse color, a modulated texture, times the lit color", () => {
  const p = compileMaterial({ renderMode: RENDER.DIFFUSE } as MObj, [{ src: 4, flags: TEX.LIGHTMAP_DIFFUSE | (4 << 16) | (3 << 20), tev: null } as unknown as TObj]);
  // modulate: [200, 100, 50] by [128, 255, 0] = [101, 100, 0]; alpha 255 by 255 = 255
  // lit by [255, 128, 0]: 101 * 256 -> 101; 100 * 129 = 12900 + 128 >> 8 = 50; 0
  eq(evalMaterial(p, { diffuse: [200, 100, 50], alpha: 255, specular: [0, 0, 0], ras0: [255, 128, 0, 255], ras1: [0, 0, 0, 255],
                       texels: [[128, 255, 0, 255]], blend: [255] }), [101, 50, 0, 255]);
  // a shadow laid on last: 101 * 129 + 128 >> 8 = 51
  eq(evalMaterial(p, { diffuse: [200, 100, 50], alpha: 255, specular: [0, 0, 0], ras0: [255, 128, 0, 255], ras1: [0, 0, 0, 255],
                       texels: [[128, 255, 0, 255]], blend: [255], shadows: [[128, 255, 0, 0]] }), [51, 50, 0, 255]);
  // a color animation's color over it by 64: lerp(53, 255, 64) = (53 * 256 + 202 * 64 + 128) >> 8 = 26624 >> 8 = 104
  eq(overColor([53, 60, 0], [255, 255, 255], 64)[0], 104);
});

test("a texture's own stage, in bytes: its konst picked, scaled by two", () => {
  // texel 100 + konst red 20, times 2 (GX_CS_SCALE_2): (100 << 1) + ((20 << 8 << 1) + 128 >> 8) = 200 + 40 = 240
  const desc = { colorOp: 0, alphaOp: 0, colorBias: 0, alphaBias: 0, colorScale: 1, alphaScale: 0, colorClamp: 1, alphaClamp: 1,
                 colorIn: [0x81, 15, 15, 8], alphaIn: [7, 7, 7, 4], active: 0xc0000000 | 0 };
  eq(tevDescStep(desc, [20, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [100, 100, 100, 77]), [240, 240, 240, 77]);
  // a scalar constant cut to a byte (HSD_TExpSetReg): 255 * 0.5 = 127.5 -> 127
  eq(tevByte(0.5), 127);
});

test("a particle's color part-way to its target as getColorPrimEnv draws it", () => {
  // from 255 toward 0, 1 frame of 3 left: share 65536 / 3 = 21845, (255 * 21845) >> 16 = 84 (the exact third is 85)
  eq(psColorByte(255, 0, 1, 3), 84);
  // from 0 toward 255, 2 of 3 left: share 43690, ((255 << 16) - 255 * 43690) >> 16 = 85
  eq(psColorByte(0, 255, 2, 3), 85);
  eq(psColorByte(17, 99, 5, 0), 17);
});

// ---------------------------------------------------------------- the shader's TEV against this

const N = 256, ROWS = 64;
/** the inputs of case i (both sides make them from this hash) */
const hash = (x: number) => {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};
const draw = (i: number, k: number) => hash((i * 16 + k) >>> 0);

/** what the TypeScript makes of case (x, y): four bytes, as the page's pixel */
function expected(x: number, y: number): number[] {
  const i = y * N + x;
  const r = (k: number, m: number) => draw(i, k) % m;
  const s10 = (k: number) => r(k, 2048) - 1024;
  const kind = y >> 4;
  if (kind === 0) {
    const v = tevStage(s10(0), s10(1), s10(2), s10(3), r(4, 2), r(5, 3), r(6, 4), r(7, 2) === 1);
    return [(v + 1024) & 255, (v + 1024) >> 8, 0, 255];
  }
  if (kind === 1) {
    const op = r(0, 9), c = [r(1, 256), r(2, 256), r(3, 256)], t = [r(4, 256), r(5, 256), r(6, 256), r(7, 256)];
    const out = colorMap(op, c, t, r(8, 256));
    return [out[0], out[1], out[2], alphaMap(r(9, 8), r(10, 256), t[3], r(8, 256))];
  }
  const A = [r(0, 256), r(1, 256), r(2, 256), r(3, 256)], B = [r(4, 4) ? A[0] : r(5, 256), r(6, 4) ? A[1] : r(7, 256), r(8, 256), r(9, 256)];
  const C = [r(10, 256), r(11, 256), r(12, 256), r(13, 256)], D = [r(14, 256), r(15, 256), 7, 9];
  const op = 8 + (draw(i, 16) % 8);
  const c = tevCompare(op, A, B, C, D, false, true), a = tevCompare(op, A, B, C, D, true, true);
  return [c[0], c[1], c[2], a[0]];
}

test("the fragment shader's TEV is the TypeScript's, bit for bit", { skip: !browser() && "no browser" }, () => {
  const fs = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
${SHADERS.TEV_GLSL}
uint hsh(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
int r(uint i, uint k, uint m) { return int(hsh(i * 16u + k) % m); }
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  uint i = uint(y * ${N} + x);
  int kind = y >> 4;
  ivec4 o;
  if (kind == 0) {
    ivec4 v = tev4(ivec4(r(i, 0u, 2048u) - 1024), ivec4(r(i, 1u, 2048u) - 1024), ivec4(r(i, 2u, 2048u) - 1024), ivec4(r(i, 3u, 2048u) - 1024),
                   ivec4(r(i, 4u, 2u)), r(i, 5u, 3u), r(i, 6u, 4u), r(i, 7u, 2u) == 1);
    o = ivec4((v.x + 1024) & 255, (v.x + 1024) >> 8, 0, 255);
  } else if (kind == 1) {
    ivec4 t = ivec4(r(i, 4u, 256u), r(i, 5u, 256u), r(i, 6u, 256u), r(i, 7u, 256u));
    ivec3 c = colorMap(r(i, 0u, 9u), ivec3(r(i, 1u, 256u), r(i, 2u, 256u), r(i, 3u, 256u)), t, r(i, 8u, 256u));
    o = ivec4(c, alphaMap(r(i, 9u, 8u), r(i, 10u, 256u), t.a, r(i, 8u, 256u)));
  } else {
    ivec4 A = ivec4(r(i, 0u, 256u), r(i, 1u, 256u), r(i, 2u, 256u), r(i, 3u, 256u));
    ivec4 B = ivec4(r(i, 4u, 4u) != 0 ? A.x : r(i, 5u, 256u), r(i, 6u, 4u) != 0 ? A.y : r(i, 7u, 256u), r(i, 8u, 256u), r(i, 9u, 256u));
    ivec4 C = ivec4(r(i, 10u, 256u), r(i, 11u, 256u), r(i, 12u, 256u), r(i, 13u, 256u));
    ivec4 D = ivec4(r(i, 14u, 256u), r(i, 15u, 256u), 7, 9);
    int op = 8 + int(hsh(i * 16u + 16u) % 8u);
    o = ivec4(tevCmp(op, A, B, C, D, false, true).rgb, tevCmp(op, A, B, C, D, true, true).a);
  }
  outColor = vec4(o) / 255.0;
}`;
  const px = runPage<number[]>(`
const W = ${N}, H = ${ROWS};
const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
const gl = cv.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, "#version 300 es\\nvoid main() { vec2 q = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(q, 0.0, 1.0); }"));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, ${JSON.stringify(fs)}));
gl.linkProgram(p);
if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
gl.viewport(0, 0, W, H); gl.useProgram(p); gl.drawArrays(gl.TRIANGLES, 0, 3);
const out = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
done(Array.from(out));`);
  eq(px.length, N * ROWS * 4);
  let bad = 0, first = "";
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < N; x++) {
    const want = expected(x, y), o = (y * N + x) * 4, got = px.slice(o, o + 4);
    if (want.some((v, k) => v !== got[k])) { if (!bad++) first = `(${x}, ${y}): shader ${got}, TypeScript ${want}`; }
  }
  eq(bad, 0, `cases that differ: ${bad}, first ${first}`);
});
