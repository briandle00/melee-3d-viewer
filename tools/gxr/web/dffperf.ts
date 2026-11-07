// Time a bare stream (no initial memory) in the GPU backend: frames [0, from) played without drawing, then frames [from, to] drawn `loops` times.
import { parseDff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false })!;
const dff = parseDff(new Uint8Array(await (await fetch("/spec/" + q.get("dff"))).arrayBuffer()));
const from = Number(q.get("from") ?? 385), to = Number(q.get("to") ?? dff.frames.length - 1), loops = Number(q.get("loops") ?? 5);
if (q.get("profile")) await fetch("/go");
const workers = Number(q.get("workers") ?? 0);
const be = new GxGl(gl, {}, { workers, factory: () => new Worker("/frontworker.js", { type: "module" }) });
await log(`workers ${workers}, crossOriginIsolated ${(globalThis as any).crossOriginIsolated}`);
be.measure = true;
be.timing = q.get("timing") === "1";
await be.prepare();
const gpu = new GxGpu(be, dff, new Uint8Array(0x1800000));
gpu.measure = true;
for (let i = 0; i < from; i++) { be.drawing = false; be.fastForward = true; gpu.runFrame(dff.frames[i]); }
await log(`fast-forwarded`);
be.fastForward = false; be.drawing = true;
const run = () => { for (let i = from; i <= to; i++) gpu.runFrame(dff.frames[i]); };
run(); await log(`first run done`); be.finish();
be.stats.cpuMs = 0; be.stats.flushMs = 0; be.stats.uploadMs = 0; be.stats.memBytes = 0; be.stats.listEntries = 0; gpu.timers.vertex = 0; gpu.timers.memory = 0;
const t0 = performance.now(); const tris0 = be.tris, passes0 = be.passes;
for (let r = 0; r < loops; r++) run();
be.finish();
const n = loops * (to - from + 1);
const per = (performance.now() - t0) / n;
await log(`${q.get("dff")} frames ${from}..${to}: ${per.toFixed(1)} ms per frame; tris/frame ${((be.tris - tris0) / n) | 0}, passes/frame ${((be.passes - passes0) / n).toFixed(1)}, vertex decode ${(gpu.timers.vertex / n).toFixed(2)} ms, memory writes ${(gpu.timers.memory / n).toFixed(2)} ms, front half ${(be.stats.cpuMs / n).toFixed(2)} ms, bin+upload ${(be.stats.flushMs / n).toFixed(2)} ms, list entries ${(be.stats.listEntries / n) | 0}, mem upload ${(be.stats.memBytes / n / 1024) | 0} KiB`);
const ps = be.poolStats; if (ps) await log(`pool: ${JSON.stringify(ps, (_k, v) => typeof v === "number" ? Math.round(v * 10) / 10 : v)} over ${n} frames`);
if (q.get("timing") === "1") await log(JSON.stringify(be.collectTimes()));
await fetch("/done", { method: "POST", body: "ok" });
