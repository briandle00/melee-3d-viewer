import { PIXEL_FS, pixelShader } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { variants as sharedVariants } from "./variants.ts";
const q = new URLSearchParams(location.search);
const v = q.get("v") ?? "full";
const log = (s: string) => fetch("/log", { method: "POST", body: s });
let fs = v === "fast" ? pixelShader({ floatOps: "fast" }) : v === "indirect" ? pixelShader({ indirect: true }) : v === "fogextra" ? pixelShader({ fogExtra: true }) : v === "both" ? pixelShader({ indirect: true, fogExtra: true }) : PIXEL_FS;
const rep = (a: string, b: string) => { if (!fs.includes(a)) throw new Error("no such text: " + a); fs = fs.replace(a, b); };
const cut = (from: string, to: string, body: string) => { const a = fs.indexOf(from), b = fs.indexOf(to); if (a < 0 || b < 0) throw new Error("cut " + from); fs = fs.slice(0, a) + body + fs.slice(b); };
const variants: Record<string, () => void> = {
  indirect: () => {}, fogextra: () => {}, both: () => {}, fast: () => {},
  nativef: () => {
    cut("uint f_add(uint a, uint b) {", "uint f_sub(uint a, uint b)", "uint f_add(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) + uintBitsToFloat(b)); }\n");
    cut("uint f_mul(uint a, uint b) {", "uint f_div(uint a, uint b)", "uint f_mul(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) * uintBitsToFloat(b)); }\n");
    cut("uint f_div(uint a, uint b) {", "// float(n) for", "uint f_div(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) / uintBitsToFloat(b)); }\n");
  },
  full: () => {},
  unroll4: () => rep("  for (int j = 0; j < uK.x; j++) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);", "  genST(n, bx, by, sv[0], tv[0]); genST(n, bx + 1, by, sv[1], tv[1]); genST(n, bx, by + 1, sv[2], tv[2]); genST(n, bx + 1, by + 1, sv[3], tv[3]);"),
  tap1: () => rep("  int ntaps = linear ? 4 : 1;", "  int ntaps = 1;"),
  lev1: () => rep("  int nlev = mixl ? 2 : 1;", "  int nlev = 1;"),

  notex: () => rep("bool texEn = bf(ord, 6, 1) == 1u;", "bool texEn = false;"),
  // texture enabled, but no sampling
  loadmap: () => rep("ivec4 tx = stageSample(mp, texcoord, x, y);", "ivec4 tx = ivec4(int(mp.fmt) + mp.W);"),
  // generators and lod only
  lod: () => rep("  return sampleMap(mp, S24, T24, lod, linear);", "  return ivec4(S24, T24, lod, linear ? 1 : 0);"),
  // no generators: the unit with fixed coordinates
  unit: () => rep("  for (int j = 0; j < uK.x; j++) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);", "  for (int j = 0; j < uK.x; j++) { sv[j] = uint(bx + j); tv[j] = uint(by + j); }"),
  nofetch: () => rep("      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;", "      sum += ivec4(wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt), int(off), 0) * wgt;"),
  nofog: () => { rep("bool texEn = bf(ord, 6, 1) == 1u;", "bool texEn = false;"); rep("  if (fsel != 0u) fogPixel(fsel, z, x, src);", ""); },
};
if (sharedVariants[v]) fs = sharedVariants[v](fs); else variants[v]();
const gl = document.createElement("canvas").getContext("webgl2")!;
const t0 = performance.now();
const vs = gl.createShader(gl.VERTEX_SHADER)!;
gl.shaderSource(vs, `#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`);
gl.compileShader(vs);
const f = gl.createShader(gl.FRAGMENT_SHADER)!;
gl.shaderSource(f, fs);
gl.compileShader(f);
const clean = (s: string | null) => (s ?? "").split("\n").filter((l) => !l.startsWith("WARNING") && !l.includes("warning")).join("|").slice(0, 300);
await log(`${v}: compileShader ${(performance.now() - t0).toFixed(0)} ms ok=${gl.getShaderParameter(f, gl.COMPILE_STATUS)} ${clean(gl.getShaderInfoLog(f))}`);
const dbg = gl.getExtension("WEBGL_debug_shaders");
if (dbg) { const src = dbg.getTranslatedShaderSource(f); await log(`${v}: translated ${src.length} chars, ${src.split("\n").length} lines`); await fetch("/save/translated_" + v + ".hlsl", { method: "POST", body: src }); }
if (q.get("nolink") === "1") { await fetch("/done", { method: "POST", body: "ok" }); throw new Error("stop"); }
const p = gl.createProgram()!;
gl.attachShader(p, vs); gl.attachShader(p, f);
const t1 = performance.now();
gl.linkProgram(p);
const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
await log(`${v}: link ${(performance.now() - t1).toFixed(0)} ms ok=${ok} ${clean(gl.getProgramInfoLog(p))}`);
await fetch("/done", { method: "POST", body: "ok" });
