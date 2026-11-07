// The card's own float addition and multiplication (glsl-float.ts FAST_ADD_MUL) against the whole-number ones, bit for bit:
// 1. the whole-number GLSL (f_add, f_mul as the pixel shader has them) against floatcheck.ts softAdd / softMul (the JavaScript the start-up check
//    compares with), on `rounds` x 64 Ki operand pairs (edge pairings and random numbers, a new seed each round);
// 2. the fast GLSL against softAdd / softMul on the same pairs (floatcheck.ts checkOps with each seed), with a product followed by a sum and the reverse;
// 3. the start-up pixel check's scene through the soft and the fast pixel program against the CPU reference;
// 4. a renderer with floatOps auto: what its start-up check found.
// Query: rounds=N (default 64)
import { SOFT_FLOAT_GLSL } from "../../../src/render3d/gxr/glsl-float.ts";
import { checkOperands, checkPixels, softAdd, softMul } from "../../../src/render3d/gxr/floatcheck.ts";
import { compile, FULLSCREEN_VS, intTexture, uploadRows } from "../../../src/render3d/gxr/glutil.ts";
import { floatGlsl } from "../../../src/render3d/gxr/glsl-float.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const rounds = Number(q.get("rounds") ?? 64);
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
await log(`renderer: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown"}`);
const fsOf = (body: string) => `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn;
out uvec4 o;
${body}
void main() {
  uvec2 v = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0).rg;
  o = uvec4(f_add(v.x, v.y), f_mul(v.x, v.y), f_add(f_mul(v.x, v.y), v.x), f_mul(f_add(v.x, v.y), v.y));
}`;
const W = 256, H = 256;
const progs = { soft: compile(gl, FULLSCREEN_VS, fsOf(SOFT_FLOAT_GLSL)), fast: compile(gl, FULLSCREEN_VS, fsOf(floatGlsl("fast"))) };
const input = intTexture(gl, "RG32UI", W, H), output = intTexture(gl, "RGBA32UI", W, H);
const fbo = gl.createFramebuffer()!;
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.tex, 0);
const run = (p: WebGLProgram, ops: Uint32Array): Uint32Array => {
  uploadRows(gl, input, 0, 0, W, H, ops);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, W, H);
  gl.useProgram(p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input.tex);
  gl.uniform1i(gl.getUniformLocation(p, "uIn"), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const r = new Uint32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, r);
  return r;
};
const bad = { soft: 0, fast: 0 }, shown = { soft: 0, fast: 0 };
let n = 0;
for (let k = 0; k < rounds; k++) {
  const ops = checkOperands(W * H, (0x6a5d39e1 + k * 0x9e3779b9) >>> 0);
  for (const which of ["soft", "fast"] as const) {
    const r = run(progs[which], ops);
    for (let i = 0; i < W * H; i++) {
      const a = ops[2 * i], b = ops[2 * i + 1], s = softAdd(a, b), p = softMul(a, b);
      const want = [s, p, softAdd(p, a), softMul(s, b)];
      for (let j = 0; j < 4; j++) if (r[4 * i + j] !== want[j]) {
        bad[which]++;
        if (shown[which]++ < 12) await log(`${which} op ${["add", "mul", "mul-add", "add-mul"][j]} a ${a.toString(16)} b ${b.toString(16)}: gpu ${r[4 * i + j].toString(16)} want ${want[j].toString(16)}`);
      }
    }
  }
  n += W * H * 4;
}
await log(`operations: ${n} per program; whole-number GLSL vs softAdd/softMul differ ${bad.soft}; fast GLSL differ ${bad.fast}`);
let pix = "";
for (const mode of ["soft", "fast"] as const) {
  const be = new GxGl(gl, { floatOps: mode }, {});
  await be.prepare();
  pix += `${mode} ${checkPixels(be)} pixels differ; `;
  be.dispose();
}
await log(`check scene vs CPU reference: ${pix}`);
// negative controls: the pixel check must see a product one unit off in the last place, and a product fused into the following sum
{
  const off = new GxGl(gl, { floatOps: "fast", mutate: (s) => { if (!s.includes("  uint r = f_fence(fa * fb);\n")) throw new Error("control: no product line"); return s; } }, {});
  void off; const off1 = new GxGl(gl, { floatOps: "fast", mutate: (s) => s.replace("  uint r = f_fence(fa * fb);\n", "  uint r = f_fence(fa * fb) + 1u;\n") }, {});
  await off1.prepare();
  const fused = new GxGl(gl, { floatOps: "fast", mutate: (s) => s.replace("uint r = f_fence(uintBitsToFloat(A) + uintBitsToFloat(B));", "uint r = floatBitsToUint(uintBitsToFloat(A) + uintBitsToFloat(B));").replace("  uint r = f_fence(fa * fb);\n", "  uint r = floatBitsToUint(fa * fb);\n") }, {});
  await fused.prepare();
  await log(`negative controls (must differ): product one unit high ${checkPixels(off1)} pixels; fences removed ${checkPixels(fused)} pixels (a compiler that does not fuse shows 0 here)`);
  const be = new GxGl(gl, { floatOps: "soft" }, {});
  await be.prepare();
  checkPixels(be);
  const sc = (await import("../../../src/render3d/gxr/floatcheck.ts")).checkScene();
  const { GxGpu } = await import("../../../src/render3d/gxr/gpu.ts");
  be.reset(); be.drawing = true;
  new GxGpu(be, sc.init, sc.mem.slice()).runFrame({ fifo: sc.stream, updates: [] });
  be.flush();
  const e = be.readEfb();
  let lit = 0;
  const depths = new Set<number>(), colors = new Set<number>();
  for (let i = 0; i < e.color.length; i++) if (e.color[i] !== 0 || e.depth[i] !== 0) { lit++; depths.add(e.depth[i]); colors.add(e.color[i]); }
  await log(`check scene: ${lit} pixels drawn, ${colors.size} colors, ${depths.size} depths, ${be.tris} triangles`);
}
const auto = new GxGl(gl, {}, {});
const t0 = performance.now();
await auto.prepare();
await log(`auto: floatOps ${auto.floatOps}, check ${JSON.stringify(auto.floatCheck)}, prepare ${(performance.now() - t0).toFixed(0)} ms`);
await fetch("/done", { method: "POST", body: bad.soft || bad.fast ? "mismatch" : "ok" });
