import { SOFT_FLOAT_GLSL } from "../../../src/render3d/gxr/glsl-float.ts";
import { compile, FULLSCREEN_VS, intTexture, uploadRows } from "../../../src/render3d/gxr/glutil.ts";

const log = (s: string) => fetch("/log", { method: "POST", body: s });
const fs = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn;
out uvec4 o;
${SOFT_FLOAT_GLSL}
void main() {
  uvec4 v = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0);
  uint a = v.x, b = v.y, r = 0u;
  switch (v.z) {
    case 0u: r = f_add(a, b); break;
    case 1u: r = f_sub(a, b); break;
    case 2u: r = f_mul(a, b); break;
    case 3u: r = f_div(a, b); break;
    case 4u: r = f_from_int(int(a)); break;
    case 5u: r = uint(f_trunc(a)); break;
    case 6u: r = f_lt(a, b) ? 1u : 0u; break;
    case 7u: r = f_eq(a, b) ? 1u : 0u; break;
  }
  o = uvec4(r, 0u, 0u, 0u);
}`;
const W = 1024, H = 1024;
const gl = document.createElement("canvas").getContext("webgl2")!;
gl.getExtension("EXT_color_buffer_float");
const prog = compile(gl, FULLSCREEN_VS, fs);
{ const sh = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(sh, fs); gl.compileShader(sh); const dbg = gl.getExtension("WEBGL_debug_shaders"); if (dbg) await fetch("/save/translated_sf.hlsl", { method: "POST", body: dbg.getTranslatedShaderSource(sh) }); }
const input = intTexture(gl, "RGBA32UI", W, H), output = intTexture(gl, "RGBA32UI", W, H);
const fbo = gl.createFramebuffer()!;
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.tex, 0);

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = (x: number) => { f32[0] = x; return u32[0]; };
const fromBits = (b: number) => { u32[0] = b; return f32[0]; };
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const rndFloat = (): number => {
  const k = rnd();
  const sign = rnd() < 0.5 ? 1 : 0;
  let exp: number, man: number;
  if (k < 0.1) { exp = 120 + Math.floor(rnd() * 16); man = Math.floor(rnd() * 8); }
  else if (k < 0.2) { exp = 127 + Math.floor(rnd() * 3) - 1; man = Math.floor(rnd() * 0x800000); }
  else if (k < 0.25) { exp = 1 + Math.floor(rnd() * 254); man = 0; }
  else { exp = 100 + Math.floor(rnd() * 60); man = Math.floor(rnd() * 0x800000); }
  return fromBits(((sign << 31) | (exp << 23) | man) >>> 0);
};
const specials = [0, -0, 1, -1, 0.5, 2, 3, 1e-30, 1e30, 3.4e38, -3.4e38, Infinity, -Infinity, NaN, 16777215, 16777216, 0.1, 342, 0.495, 8388608, 8388609];

const N = W * H;
const data = new Uint32Array(N * 4);
const ops: number[] = [];
for (let i = 0; i < N; i++) {
  const op = i % 8;
  let a = rndFloat(), b = rndFloat();
  if (rnd() < 0.05) a = specials[Math.floor(rnd() * specials.length)];
  if (rnd() < 0.05) b = specials[Math.floor(rnd() * specials.length)];
  a = Math.fround(a); b = Math.fround(b);
  let ia = bitsOf(a);
  const ib = bitsOf(b);
  if (op === 4) { ia = (Math.floor(rnd() * 33554432) - 16777216) | 0; }
  data[i * 4] = ia >>> 0; data[i * 4 + 1] = ib; data[i * 4 + 2] = op;
  ops.push(op);
}
uploadRows(gl, input, 0, 0, W, H, data);
gl.viewport(0, 0, W, H);
gl.useProgram(prog);
gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input.tex);
gl.uniform1i(gl.getUniformLocation(prog, "uIn"), 0); gl.uniform4i(gl.getUniformLocation(prog, "uK"), 4, 25, 3, 2);
gl.drawArrays(gl.TRIANGLES, 0, 3);
const out = new Uint32Array(N * 4);
gl.readPixels(0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);

const isDenorm = (b: number) => ((b >>> 23) & 255) === 0 && (b & 0x7fffff) !== 0;
const bad: Record<number, number> = {}, tested: Record<number, number> = {};
let shown = 0;
for (let i = 0; i < N; i++) {
  const op = ops[i];
  const ia = data[i * 4], ib = data[i * 4 + 1];
  const a = fromBits(ia), b = fromBits(ib);
  let want: number;
  switch (op) {
    case 0: want = bitsOf(Math.fround(a + b)); break;
    case 1: want = bitsOf(Math.fround(a - b)); break;
    case 2: want = bitsOf(Math.fround(a * b)); break;
    case 3: want = bitsOf(Math.fround(a / b)); break;
    case 4: want = bitsOf(Math.fround(ia | 0)); break;
    case 5: want = (Number.isNaN(a) || Math.abs(a) >= 2147483648) ? 0x80000000 : (Math.trunc(a) | 0) >>> 0; break;
    case 6: want = a < b ? 1 : 0; break;
    default: want = a === b ? 1 : 0;
  }
  if ((op < 4) && (isDenorm(ia) || isDenorm(ib) || isDenorm(want))) continue;
  if (op === 5 && isDenorm(ia)) continue;
  tested[op] = (tested[op] ?? 0) + 1;
  const got = out[i * 4];
  const nanW = op < 4 && Number.isNaN(fromBits(want)), nanG = op < 4 && Number.isNaN(fromBits(got));
  if (nanW && nanG) continue;
  if (got !== want >>> 0) {
    bad[op] = (bad[op] ?? 0) + 1;
    if (shown++ < 12) await log(`op ${op} a=${ia.toString(16)} (${a}) b=${ib.toString(16)} (${b}) want ${(want >>> 0).toString(16)} got ${got.toString(16)}`);
  }
}
await log(`tested ${JSON.stringify(tested)} bad ${JSON.stringify(bad)}`);
await fetch("/done", { method: "POST", body: Object.keys(bad).length === 0 ? "ok" : "mismatch" });
