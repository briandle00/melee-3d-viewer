// fog.ts: GX's fog as the hardware has it. GXSetFog's packing checked bit for bit against the SDK's C (tests/c/
// fog_ref.c) on random fogs and cameras, the pixel engine's formula on hand-worked cases, and the fragment
// shader's fog (FOG_GLSL) against fogAmount8 / fogBlend8 in a browser, pixel for pixel over the depth range.

import test from "node:test";
import assertNode from "node:assert/strict";
import { FOG_GLSL, NO_FOG, fogAmount8, fogBlend8, gxSetFog, nearFar, fogDecoded } from "../src/render3d/fog.ts";
import { perspective } from "../src/render3d/math.ts";
import { cSkip, runC } from "./cref.ts";
import { browser, runPage } from "./webgl.ts";

const assert = (ok: unknown, msg = "assertion failed") => assertNode.ok(ok, msg);
const assertEquals = (got: unknown, want: unknown) => assertNode.deepStrictEqual(got, want);

const bits = new DataView(new ArrayBuffer(4));
const hex = (x: number) => { bits.setFloat32(0, x); return bits.getUint32(0).toString(16).padStart(8, "0"); };

/** a small LCG, so the cases are the same each run */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

/** random fogs and cameras: the game's kinds of numbers (near 0.1 .. 100, far up to 100000, a fog in front, behind,
 *  backwards) and the edges GXSetFog has its own way with */
function cases(n: number): [number, number, number, number, number, [number, number, number]][] {
  const r = rng(0x5eed);
  const types = [0, 2, 4, 5, 6, 7, 10, 12];
  const out: [number, number, number, number, number, [number, number, number]][] = [
    [2, 0, 0, 1, 100, [1, 2, 3]], [2, 10, 20, 5, 5, [0, 0, 0]], [2, 10, 20, 0, 1000, [255, 255, 255]],
    [4, -50, 300, 1, 1000, [9, 99, 199]], [2, 300, -50, 1, 1000, [0, 0, 0]], [7, 0, 1e-6, 1, 1e5, [0, 0, 0]],
  ];
  for (let i = 0; i < n; i++) {
    const near = Math.fround(10 ** (r() * 3 - 1));
    const far = Math.fround(near + 10 ** (r() * 5));
    const start = Math.fround((r() - 0.2) * far);
    const end = Math.fround(start + (r() - 0.1) * far);
    out.push([types[Math.floor(r() * types.length)], start, end, near, far,
              [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)]]);
  }
  return out;
}

test("GXSetFog's packing is the SDK's, bit for bit", { skip: cSkip("fog_ref") }, () => {
  const cs = cases(20000);
  const input = cs.map(([t, s, e, n, f, c]) => `${t} ${hex(s)} ${hex(e)} ${hex(n)} ${hex(f)} ${c.join(" ")}`).join("\n") + "\n";
  const lines = runC("fog_ref", input).trim().split("\n");
  assertEquals(lines.length, cs.length);
  let bad = 0;
  cs.forEach(([t, s, e, n, f, c], i) => {
    const g = gxSetFog(t, s, e, n, f, c);
    const mine = [g.fog0, g.fog1, g.fog2, g.fog3, g.fogclr].map((v) => v.toString(16).padStart(8, "0")).join(" ");
    if (mine !== lines[i] && bad++ < 5) console.log(`case ${i} ${cs[i]}: ${mine} != ${lines[i]}`);
  });
  assertEquals(bad, 0);
});

test("the registers' fields: A cut to 11 bits of mantissa, B's magnitude and shift, the kind", () => {
  // near 1, far 1000, from 100 to 500: A = 1000 / (999 * 400), B = 1000 / 999 (mantissa 0.5005, exponent 1)
  const g = gxSetFog(2, 100, 500, 1, 1000, [10, 20, 30]);
  assertEquals(g.fog0 >>> 24, 0xee);
  assertEquals(g.fog1 >>> 24, 0xef);
  assertEquals(g.fog2 >>> 24, 0xf0);
  assertEquals(g.fog3 >>> 24, 0xf1);
  assertEquals(g.fogclr, (0xf2 << 24 | 10 << 16 | 20 << 8 | 30) >>> 0);
  assertEquals(g.bShift, 2);
  assertEquals(g.bMag, Math.trunc(Math.fround(Math.fround(8.388638e6) * Math.fround(Math.fround(Math.fround(1000 / 999) * 0.5)))));
  const A = Math.fround(Math.fround(1000) / Math.fround(999 * 400)) / 4;
  assert(Math.abs(g.a - A) <= A * 2 ** -11 && g.a <= A, `A ${g.a} ${A}`);
  assertEquals(g.c, Math.fround(0.25));
  assertEquals([g.fsel, g.proj], [2, 0]);
  // an orthographic kind: its bit is left 0 and the kind's low three bits kept (GX_FOG_ORTHO_LIN 10 -> 2)
  const o = gxSetFog(10, 100, 500, 1, 1000, [0, 0, 0]);
  assertEquals([o.fsel, o.proj], [2, 0]);
  assertEquals(NO_FOG.fsel, 0);
});

/** the 24-bit screen depth of a point at eye depth d under a perspective camera (GX's: 0 at near, 1 at far) */
const depth24 = (d: number, n: number, f: number) => Math.round((f / (f - n)) * (1 - n / d) * 16777215);

test("linear fog: a quarter, a half, all of it, at the depths the fog says", () => {
  const n = 1, f = 1000;
  const g = gxSetFog(2, 100, 500, n, f, [255, 255, 255]);
  assertEquals(fogAmount8(g, depth24(50, n, f)), 0);
  assertEquals(fogAmount8(g, depth24(600, n, f)), 256);
  for (const [d, want] of [[200, 64], [300, 128], [400, 192]]) {
    const got = fogAmount8(g, depth24(d, n, f));
    assert(Math.abs(got - want) <= 1, `at ${d}: ${got}, not ${want}`);
  }
  // half the fog on black: 255 -> (255 * 128 + 255 * 128) >> 8 = 255, 0 -> 127
  assertEquals(fogBlend8(g, [255, 0, 100], 128), [255, 127, 177]);
  assertEquals(fogBlend8(g, [10, 20, 30], 0), [10, 20, 30]);
  assertEquals(fogBlend8(g, [10, 20, 30], 256), [255, 255, 255]);
  // the exp kinds: 1 - 2^-8f at the fog's end, the reverse ones 2^-8(1-f) at its start
  assertEquals(fogAmount8(gxSetFog(4, 100, 500, n, f, [0, 0, 0]), depth24(600, n, f)), 255);
  assertEquals(fogAmount8(gxSetFog(6, 100, 500, n, f, [0, 0, 0]), depth24(50, n, f)), 1);
});

test("near and far from a GL projection", () => {
  const [n, f] = nearFar(perspective(new Float32Array(16), 1, 1.3, 2.5, 4000));
  assert(Math.abs(n - 2.5) < 1e-4 && Math.abs(f - 4000) < 0.5, `${n} ${f}`);
});

test("the fragment shader's fog is fogAmount8 and fogBlend8, pixel for pixel", { skip: !browser() && "no browser" }, () => {
  const W = 256, H = 64;
  const fogs = [
    gxSetFog(2, 100, 500, 1, 1000, [200, 100, 50]), gxSetFog(2, -20, 3000, 30, 50000, [0, 255, 0]),
    gxSetFog(4, 50, 900, 0.5, 2000, [255, 255, 255]), gxSetFog(5, 50, 900, 0.5, 2000, [1, 2, 3]),
    gxSetFog(6, 10, 200, 1, 300, [90, 90, 90]), gxSetFog(7, 10, 200, 1, 300, [255, 0, 255]),
  ];
  // each pixel its own depth: the depth range in steps, the low end (where most of a scene is) in finer ones
  const zOf = (i: number) => (i < W * H / 2 ? i * 4 : (i - W * H / 2) * 2044 + 3) & 0xffffff;
  const out = runPage<number[][]>(`
const W = ${W}, H = ${H};
const c = document.createElement("canvas"); c.width = W; c.height = H;
const gl = c.getContext("webgl2");
const vs = "#version 300 es\\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
const fs = \`#version 300 es
precision highp float;
precision highp int;
${FOG_GLSL}
out vec4 o;
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y), i = y * ${W} + x;
  int z = (i < ${W * H / 2} ? i * 4 : (i - ${W * H / 2}) * 2044 + 3) & 0xffffff;
  int n = gxFogAmount(z);
  ivec3 col = ivec3(x, (x * 7 + y * 13) & 255, 255 - x);
  ivec3 p = (col * (256 - n) + uFogColor * n) >> 8;
  o = vec4(float(n & 255), float(n >> 8), float(p.r), float(p.g)) / 255.0;
}\`;
const prog = gl.createProgram();
for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
  const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  gl.attachShader(prog, sh);
}
gl.bindAttribLocation(prog, 0, "p");
gl.linkProgram(prog);
gl.useProgram(prog);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
const res = [];
for (const f of ${JSON.stringify(fogs)}) {
  gl.uniform4i(gl.getUniformLocation(prog, "uFogI"), f.fsel, f.bMag, f.bShift, f.proj);
  gl.uniform2f(gl.getUniformLocation(prog, "uFogF"), f.a, f.c);
  gl.uniform3i(gl.getUniformLocation(prog, "uFogColor"), f.color[0], f.color[1], f.color[2]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  res.push(Array.from(px));
}
done(res);`);
  fogs.forEach((g, k) => {
    const px = out[k];
    let bad = 0, off = 0;
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = Math.floor(i / W);
      const n = fogAmount8(g, zOf(i));
      const got = px[i * 4] | (px[i * 4 + 1] << 8);
      const p = fogBlend8(g, [x, (x * 7 + y * 13) & 255, 255 - x], got);
      // (the blend on the shader's own share: the integer rule, exactly)
      if (p[0] !== px[i * 4 + 2] || p[1] !== px[i * 4 + 3]) bad++;
      if (got !== n) off++;
    }
    assertEquals(bad, 0);
    // the share itself: exactly for linear fog (a division, one rounding each side); the exp kinds take the GPU's
    // exp2, which may land a 256th either side on a few pixels
    if (g.fsel === 2) assertEquals(off, 0);
    else assert(off <= W * H / 100, `fog ${k}: ${off} pixels off`);
  });
});

test("the registers read back: A, B, C and the start and end they hold, near the ones handed in", () => {
  for (const [s, e, n, f] of [[5000, 10000, 0.1, 16384], [200, 800, 1, 10000], [5000, 15000, 3, 30000]]) {
    const r = gxSetFog(2, s, e, n, f, [0, 0, 0]);
    const d = fogDecoded(r);
    // (B = far / (far - near) to 24 bits; A and C to 11 bits of mantissa: within a part in 2^11)
    assertNode.ok(Math.abs(d.b - f / (f - n)) < 1e-6, `b ${d.b}`);
    assertNode.ok(Math.abs(d.start - s) <= s * 2 ** -10 + 1e-9 && Math.abs(d.end - e) <= e * 2 ** -10, `${s} ${e}: ${d.start} ${d.end}`);
    assertNode.equal(d.c, r.c);
  }
});
