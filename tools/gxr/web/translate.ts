// W15: the translated HLSL (WEBGL_debug_shaders) of pixel shader variants, compiled without linking (ANGLE's translator only; the
// D3D compile happens at link and is timed offline by fxc.py). v=<name,name,...> from variants.ts or the opts below.
import { pixelShader } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { variants } from "./variants.ts";
import { w15 } from "./w15variants.ts";
const q = new URLSearchParams(location.search);
const names = (q.get("v") ?? "fast").split(",");
const gl = document.createElement("canvas").getContext("webgl2")!;
const dbg = gl.getExtension("WEBGL_debug_shaders")!;
for (const n of names) {
  // name: [soft|fast|dual][+indirect][+fog]:[ablation,ablation...]
  const [base, abl] = n.split(":");
  const parts = base.split(".");
  let fs = pixelShader({ floatOps: parts[0] as "soft" | "fast" | "dual", indirect: parts.includes("indirect"), fogExtra: parts.includes("fog") });
  for (const a of abl ? abl.split("~") : []) fs = (w15[a] ?? variants[a])(fs);
  const s = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(s, fs);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) await fetch("/log", { method: "POST", body: n + ": " + gl.getShaderInfoLog(s) });
  await fetch("/save/" + n.replace(/[^\w.~-]/g, "_") + ".hlsl", { method: "POST", body: dbg.getTranslatedShaderSource(s) });
  await fetch("/save/" + n.replace(/[^\w.~-]/g, "_") + ".glsl", { method: "POST", body: fs });
}
await fetch("/done", { method: "POST", body: "ok" });
