import { parseDff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
const canvas = document.createElement("canvas");
const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: false })!;
const manifest = await (await fetch("/spec/manifest.json")).json();
const only = q.get("windows")?.split(",");
const t0 = performance.now();
if (q.get("profile")) await fetch("/go");
// floatops=soft|fast|dual|auto (default auto, as the renderer starts); dual: the pixels whose float arithmetic differed are counted after every pass
const fo = q.get("floatops") ?? "auto";
// (dualcontrol=1: the dual check's own control, the card's product made one unit high: the check must report pixels)
const ctl = q.get("dualcontrol") === "1" ? { mutate: (s: string) => s.replace("  uint r = f_fence(fa * fb);\n", "  uint r = f_fence(fa * fb) + 1u;\n") } : {};
const be = new GxGl(gl, { floatOps: fo as "auto", ...ctl }, { workers: Number(q.get("workers") ?? 0), factory: () => new Worker("/frontworker.js", { type: "module" }) });
be.timing = q.get("timing") === "1";
be.measure = q.get("nomeasure") !== "1";
await be.prepare();
await log(`compiled in ${(performance.now() - t0).toFixed(0)} ms; floatOps ${be.floatOps}, check ${JSON.stringify(be.floatCheck)}`);
let dualPasses = 0, dualPixels = 0;
if (fo === "dual") be.onFlush = () => { dualPasses++; const d = be.readEfb().depth; for (let i = 0; i < d.length; i++) if (d[i] >>> 31) dualPixels++; };
let failed = false;
for (const w of manifest.windows) {
  if (only && !only.includes(w.name)) continue;
  try {
    const dff = parseDff(await get("/spec/" + w.recording));
    const mem1 = await get("/spec/" + w.memory);
    be.reset();
    const gpu = new GxGpu(be, dff, mem1);
    gpu.measure = be.measure;
    const pic = q.get("pic") !== "0";
    if (pic) be.onPicture = (rgba, k) => {
      const f = new Uint8Array(12 + rgba.length);
      const dv = new DataView(f.buffer);
      dv.setUint32(0, 640, true); dv.setUint32(4, 480, true); dv.setUint32(8, 28, true);
      f.set(rgba, 12);
      fetch(`/save/${w.name}/efb_${String(k).padStart(6, "0")}.raw`, { method: "POST", body: f });
    };
    const t1 = performance.now();
    if (q.get("loops")) {
      // throughput: the drawn frames over and over without reading pictures back; one wait at the end
      const n = Number(q.get("loops"));
      for (let i = 0; i < dff.frames.length; i++) { be.drawing = i > 0; gpu.runFrame(dff.frames[i]); }
      be.finish();
      be.stats.cpuMs = 0; be.stats.flushMs = 0; be.stats.uploadMs = 0; be.stats.memBytes = 0; be.stats.listEntries = 0;
      const heap0 = (performance as any).memory?.usedJSHeapSize ?? 0;
      const l0 = performance.now();
      for (let r = 0; r < n; r++) for (let i = 1; i < dff.frames.length; i++) { be.drawing = true; gpu.runFrame(dff.frames[i]); }
      be.finish();
      await log(`   js heap ${(heap0 / 1048576).toFixed(0)} -> ${(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576).toFixed(0)} MiB, states ${(be as any).stateCount}`);
      const per = (performance.now() - l0) / (n * (dff.frames.length - 1));
      await log(`   list entries per frame ${(be.stats.listEntries / (n * 4 + 4)).toFixed(0)} (per pixel ${(be.stats.listEntries / (n * 4 + 4) * 256 / (640 * 528)).toFixed(1)})`);
      await log(`   uploads: ${(be.stats.uploadMs / (n * 4 + 4)).toFixed(2)} ms and ${(be.stats.memBytes / (n * 4 + 4) / 1024).toFixed(0)} KiB per frame, bin+upload ${(be.stats.flushMs / (n * 4 + 4)).toFixed(2)} ms, front half ${(be.stats.cpuMs / (n * 4 + 4)).toFixed(2)} ms`);
      await log(`${w.name}: ${per.toFixed(1)} ms per frame over ${n * (dff.frames.length - 1)} frames (${(1000 / per).toFixed(0)} fps), tris/frame ${(be.tris / (n + 1) / 4) | 0}`);
      continue;
    }
    const frameMs: number[] = [];
    let cpuAcc = 0, flushAcc = 0, gpuAcc = 0, vtxAcc = 0, memAcc = 0; const gpuTimes: Record<string, number> = {};
    for (let i = 0; i < dff.frames.length; i++) {
      be.drawing = i > 0;
      be.stats.cpuMs = 0; be.stats.flushMs = 0; gpu.timers.vertex = 0; gpu.timers.memory = 0;
      const f0 = performance.now();
      gpu.runFrame(dff.frames[i]);
      const g0 = performance.now(); be.finish(); gpuAcc += i > 0 ? performance.now() - g0 : 0;
      frameMs.push(performance.now() - f0);
      if (i > 0) { cpuAcc += be.stats.cpuMs; flushAcc += be.stats.flushMs; vtxAcc += gpu.timers.vertex; memAcc += gpu.timers.memory; }
      const gt = be.collectTimes(); if (i > 0) for (const k in gt) gpuTimes[k] = (gpuTimes[k] ?? 0) + gt[k] / 4;
    }
    if (q.get("presenttest")) {
      const pic = be.readPicture(0);
      be.present(640, 480);
      const px = new Uint8Array(640 * 480 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let bad = 0;
      for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) for (let c = 0; c < 3; c++) if (px[((479 - y) * 640 + x) * 4 + c] !== pic[(y * 640 + x) * 4 + c]) bad++;
      await log(`present: ${bad} differing values of ${640 * 480 * 3}`);
    }
    await log(`${w.name}: ${(performance.now() - t1).toFixed(0)} ms, frames ${frameMs.map((x) => x.toFixed(0)).join("/")} ms, tris ${be.tris}, passes ${be.passes}, per drawn frame: vertex decode ${(vtxAcc / 4).toFixed(1)} ms, memory writes ${(memAcc / 4).toFixed(1)} ms, front half ${(cpuAcc / 4).toFixed(1)} ms, bin+upload ${(flushAcc / 4).toFixed(1)} ms, gpu wait ${(gpuAcc / 4).toFixed(1)} ms, gpu passes ${JSON.stringify(gpuTimes, (_k, v) => typeof v === "number" ? Math.round(v * 10) / 10 : v)}`);
  } catch (e) {
    failed = true;
    await log(`${w.name}: ERROR ${(e as Error).stack}`);
    break;
  }
}
if (fo === "dual") await log(`float dual check: ${dualPasses} passes, ${dualPixels} pixels differ`);
await fetch("/done", { method: "POST", body: failed ? "error" : fo === "dual" && dualPixels ? "dual mismatch" : "ok" });
