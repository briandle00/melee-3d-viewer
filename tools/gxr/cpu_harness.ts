// Plays the spec harness's windows through the CPU reference (src/render3d/gxr/cpu.ts) and writes the pictures for compare.py.
//   deno run -A tools/cpu_harness.ts <out dir> [window,window...]
import { parseDff } from "../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../src/render3d/gxr/gpu.ts";
import { CpuBackend } from "../../src/render3d/gxr/cpu.ts";

const SPEC = Deno.env.get("GX_SPEC_HARNESS") ?? "spec/harness";
const out = Deno.args[0];
const manifest = JSON.parse(Deno.readTextFileSync(`${SPEC}/manifest.json`));
const only = Deno.args[1] ? Deno.args[1].split(",") : null;
for (const w of manifest.windows) {
  if (only && !only.includes(w.name)) continue;
  const t0 = performance.now();
  const dff = parseDff(Deno.readFileSync(`${SPEC}/${w.recording}`));
  const mem1 = Deno.readFileSync(`${SPEC}/${w.memory}`);
  // deno-lint-ignore prefer-const -- (assigned once, after the backend that reads it through a closure is made)
  let gpu!: GxGpu;
  const be = new CpuBackend(() => ({ mem: gpu.mem.data, tmem: gpu.regs.tmem, tluts: gpu.regs.tluts }));
  gpu = new GxGpu(be, dff, mem1);
  Deno.mkdirSync(`${out}/${w.name}`, { recursive: true });
  be.onPicture = (rgba, k) => {
    const hdr = new Uint8Array(12);
    new DataView(hdr.buffer).setUint32(0, 640, true); new DataView(hdr.buffer).setUint32(4, 480, true); new DataView(hdr.buffer).setUint32(8, 28, true);
    const f = new Uint8Array(12 + rgba.length); f.set(hdr); f.set(rgba, 12);
    Deno.writeFileSync(`${out}/${w.name}/efb_${String(k).padStart(6, "0")}.raw`, f);
  };
  for (let i = 0; i < dff.frames.length; i++) {
    be.drawing = i > 0;
    gpu.runFrame(dff.frames[i]);
  }
  console.log(w.name, "frames", dff.frames.length, "pictures", be.pictures, "tris", be.tris, "events", gpu.events.filter((e) => e.kind === "error").length, `${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
