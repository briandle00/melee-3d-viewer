// W15: the browser's own compile + link time of fragment shaders saved by translate.ts (.glsl), served from /spec/ (GX_SPEC_HARNESS = their
// folder). v=<name,name,...>: compiled one after another (or all at once with together=1), each waited for the way the renderer does
// (KHR_parallel_shader_compile's completion status, polled), then the link status read. Use a fresh browser profile (GX_OUT) for cold times.
import { FULLSCREEN_VS } from "../../../src/render3d/gxr/glutil.ts";
const q = new URLSearchParams(location.search);
const names = (q.get("v") ?? "fast").split(",");
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2")!;
const ext = gl.getExtension("KHR_parallel_shader_compile");
const srcs = await Promise.all(names.map(async (n) => await (await fetch("/spec/" + n + ".glsl")).text()));
const start = (fs: string) => {
  const mk = (t: number, s: string) => { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, FULLSCREEN_VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  return p;
};
const wait = async (p: WebGLProgram) => { while (ext && !gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) await new Promise((r) => setTimeout(r, 5)); return gl.getProgramParameter(p, gl.LINK_STATUS); };
const T0 = performance.now();
if (q.get("together") === "1") {
  const ps = srcs.map(start);
  await Promise.all(ps.map(async (p, i) => { const ok = await wait(p); await log(`${names[i]}: ready at ${(performance.now() - T0).toFixed(0)} ms ok=${ok}`); }));
} else {
  for (let i = 0; i < srcs.length; i++) {
    const t0 = performance.now();
    const ok = await wait(start(srcs[i]));
    await log(`${names[i]}: ${(performance.now() - t0).toFixed(0)} ms ok=${ok}`);
  }
}
await log(`all: ${(performance.now() - T0).toFixed(0)} ms parallel=${!!ext}`);
await fetch("/done", { method: "POST", body: "ok" });
