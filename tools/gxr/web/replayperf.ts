// Frame times over a whole stream in the GPU backend: every frame drawn, one time per frame (the page thread's time for runFrame; with sync=1 the GPU's work
// is waited for after each frame), the median, the 99th percentile and the worst frames, and the shader variants the stream used.
// Query: dff=<file> workers=N sync=0|1 power=low|high (which GPU the browser picks where there are two) from=<first frame> to=<last> prepare=all|base
import { parseDff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl, scanFeatures } from "../../../src/render3d/gxr/gl.ts";
import { variants } from "./ablations.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const power = ({ low: "low-power", high: "high-performance" } as Record<string, WebGLPowerPreference>)[q.get("power") ?? ""] ?? "default";
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: power })!;
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
await log(`renderer: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown"}`);
if (q.get("profile")) await fetch("/go");
const dff = parseDff(new Uint8Array(await (await fetch("/spec/" + q.get("dff"))).arrayBuffer()));
const from = Number(q.get("from") ?? 0), to = Number(q.get("to") ?? dff.frames.length - 1);
const workers = Number(q.get("workers") ?? 0);
const sync = q.get("sync") === "1";
const ablate = q.get("ablate");
const fo = (q.get("floatops") ?? "auto") as "auto";
const be = new GxGl(gl, ablate ? { mutate: variants[ablate], floatOps: fo } : { floatOps: fo }, { workers, factory: () => new Worker("/frontworker.js", { type: "module" }) });
be.measure = q.get("measure") === "1";
be.timing = q.get("timing") === "1";
let need = 0;
if (q.get("scan") === "1") {
  const s0 = performance.now();
  need = scanFeatures(dff, new Uint8Array(0x1800000), dff.frames);
  await log(`scan: stream needs shader variants ${need} (${(performance.now() - s0).toFixed(0)} ms)`);
}
const t0 = performance.now();
await be.prepare(q.get("prepare") === "all" ? 3 : need);
if (q.get("warm") === "1") be.warm(3).then(() => log(`all variants compiled after ${(performance.now() - t0).toFixed(0)} ms`));
await log(`shaders ready after ${(performance.now() - t0).toFixed(0)} ms (workers ${workers}, isolated ${(globalThis as any).crossOriginIsolated})`);
if (q.get("readback") === "1") be.onPicture = () => {};   // a page that shows the picture through readPicture (ImageData): the read-back waits for the GPU
const gpu = new GxGpu(be, dff, new Uint8Array(0x1800000));
gpu.measure = be.measure;
if (q.get("premem") !== "0") { const m0 = performance.now(); for (let i = 0; i < Math.max(from, 1); i++) { be.drawing = false; be.fastForward = true; gpu.runFrame(dff.frames[i]); } be.prepareMemory(gpu.mem, gpu.regs); await log(`memory uploaded in ${(performance.now() - m0).toFixed(0)} ms (frames before ${Math.max(from, 1)} played)`); }
const times: number[] = [], feats = new Set<number>();
// a page draws one frame per animation frame and so lets the event loop run between frames (worker threads start and deliver only then): yield the same way
const mc = new MessageChannel();
const yieldLoop = () => new Promise<void>((r) => { mc.port1.onmessage = () => r(); mc.port2.postMessage(0); });
for (let i = (q.get("premem") !== "0" ? Math.max(from, 1) : 0); i < dff.frames.length && i <= to; i++) {
  be.drawing = i >= Math.max(from, 1); be.fastForward = false;
  const s = performance.now();
  const b0 = { v: gpu.timers.vertex, c: be.stats.cpuMs, f: be.stats.flushMs, u: be.stats.uploadMs, w: be.poolStats?.waitMs ?? 0, m: be.poolStats?.mergeMs ?? 0, mem: be.stats.memBytes, d: be.draws, t: be.tris };
  gpu.runFrame(dff.frames[i]);
  if (sync) be.finish();
  if (i >= from) times.push(performance.now() - s);
  if (q.get("slow") === "1" && i >= from && performance.now() - s > 25) await log(`slow frame ${i}: ${(performance.now() - s).toFixed(0)} ms = vertex ${(gpu.timers.vertex - b0.v).toFixed(1)}, submit ${(be.stats.cpuMs - b0.c).toFixed(1)}, bin+pass ${(be.stats.flushMs - b0.f).toFixed(1)} (memory upload ${(be.stats.uploadMs - b0.u).toFixed(1)}, ${((be.stats.memBytes - b0.mem) / 1024).toFixed(0)} KiB), pool wait ${((be.poolStats?.waitMs ?? 0) - b0.w).toFixed(1)}, merge ${((be.poolStats?.mergeMs ?? 0) - b0.m).toFixed(1)}; draws ${be.draws - b0.d}, tris ${be.tris - b0.t}`);
  if (q.get("debug") === "1" && be.poolStats && i % 5 === 0) await log(`frame ${i}: workers started ${be.poolStats.workersStarted}, jobs by workers ${be.poolStats.workerJobs}, by main ${be.poolStats.mainJobs}, ${(performance.now() - s).toFixed(1)} ms`);
  feats.add(be.lastFeatures);
  await yieldLoop();
}
be.finish();
const sorted = [...times].sort((a, b) => a - b);
const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const steady = times.slice(5), sortedS = [...steady].sort((a, b) => a - b);
const atS = (p: number) => sortedS[Math.min(sortedS.length - 1, Math.floor(p * sortedS.length))];
await log(`after the first 5 drawn frames (the code is warm): median ${atS(0.5).toFixed(1)} ms, p95 ${atS(0.95).toFixed(1)}, p99 ${atS(0.99).toFixed(1)}, max ${sortedS[sortedS.length - 1].toFixed(1)}, frames over 33 ms: ${steady.filter((t) => t > 33).length}, over 16.7 ms: ${steady.filter((t) => t > 16.7).length} of ${steady.length}`);
const worst = times.map((t, i) => [t, i + from] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, 6);
await log(`${q.get("dff")} frames ${from}..${to} (${times.length}): median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)}, p99 ${at(0.99).toFixed(1)}, max ${sorted[sorted.length - 1].toFixed(1)}; frames over 16.7 ms: ${times.filter((t) => t > 16.7).length}; worst ${worst.map(([t, i]) => `#${i} ${t.toFixed(0)} ms`).join(", ")}; shader variants used ${[...feats].join(",")}; draws that waited for a compile: ${be.compileWaits.count} (${be.compileWaits.ms.toFixed(0)} ms)`);
if (be.measure) { const n = times.length; const ps = be.poolStats; await log(`per frame: vertex decode ${(gpu.timers.vertex / n).toFixed(2)} ms, memory writes ${(gpu.timers.memory / n).toFixed(2)} ms, draw submit ${(be.stats.cpuMs / n).toFixed(2)} ms, bin+upload+pass ${(be.stats.flushMs / n).toFixed(2)} ms, memory upload ${(be.stats.uploadMs / n).toFixed(2)} ms (${(be.stats.memBytes / n / 1024).toFixed(0)} KiB), draws ${be.draws / n}, tris ${(be.tris / n) | 0}, passes ${(be.passes / n).toFixed(1)}${ps ? `, pool jobs ${(ps.jobs / n).toFixed(0)} (main ${(ps.mainJobs / n).toFixed(0)}, workers ${(ps.workerJobs / n).toFixed(0)}, started ${ps.workersStarted}), wait ${(ps.waitMs / n).toFixed(2)} ms, merge ${(ps.mergeMs / n).toFixed(2)} ms` : ""}`); }
if (be.timing) await log(`GPU ms by pass kind over ${times.length} frames: ${JSON.stringify(be.collectTimes(), (_k, v) => typeof v === "number" ? Math.round(v) : v)}; passes ${be.passes}, triangles ${be.tris}, list entries ${be.stats.listEntries}`);
await fetch("/done", { method: "POST", body: "ok" });
