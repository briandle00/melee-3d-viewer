// Times the CPU front half (vertex transform, assembly, culling/clipping, setup) alone over a recording's drawn frames.
import { parseDff } from "../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../src/render3d/gxr/gpu.ts";
import { planeCount, setupCtx, setupTriInto, TS } from "../../src/render3d/gxr/setup.ts";
import { assemble, cullClipInto, poly, polyState, Pool, transformVertices, xfDraw, V_STRIDE } from "../../src/render3d/gxr/xform.ts";
import { bits } from "../../src/render3d/gxr/state.ts";

const SPEC = Deno.env.get("GX_SPEC_HARNESS") ?? "spec/harness";
const name = Deno.args[0] ?? "bot-tp_samus_mewtwo-1957";
const dff = parseDff(Deno.readFileSync(`${SPEC}/windows/${name}.dff`));
const mem1 = Deno.readFileSync(`${SPEC}/windows/${name}.dff.mem1`);
const pool = new Pool();
const t = { used: 0, xf: 0, asm: 0, clip: 0, setup: 0, tris: 0, verts: 0 };
let frame = 0;
const dst = new Float32Array(1 << 20);
const trip: number[] = [];
let need = new Uint8Array(4096);
const be: any = {
  draw(regs: any, _mem: any, vd: any, _a: any, _b: any, _c: any, prims: any[]) {
    if (frame === 0) return;
    pool.clear();
    const t0 = performance.now();
    const x = xfDraw(regs, vd);
    trip.length = 0;
    for (const p of prims) assemble(p.type, p.count, p.base, trip);
    if (need.length < vd.n) need = new Uint8Array(vd.n * 2);
    need.fill(0, 0, vd.n);
    for (let i = 0; i < trip.length; i++) need[trip[i]] = 1;
    for (let i = 0; i < vd.n; i++) t.used += need[i];
    const t1 = performance.now(); t.asm += t1 - t0;
    const base = transformVertices(x, regs, vd, pool, need);
    t.verts += vd.n;
    const t2 = performance.now(); t.xf += t2 - t1;
    const sc = setupCtx(regs.bp);
    const cull = bits(regs.bp[0], 14, 2);
    const mark = pool.n;
    const np = planeCount(sc);
    for (let i = 0; i + 2 < trip.length; i += 3) {
      pool.n = mark;
      if (!cullClipInto(pool, cull, base + trip[i] * V_STRIDE, base + trip[i + 1] * V_STRIDE, base + trip[i + 2] * V_STRIDE)) continue;
      for (let k = 1; k + 1 < polyState.n; k++) { if (setupTriInto(pool, x, sc, poly[0], poly[k], poly[k + 1], dst, 0)) t.tris++; }
    }
    t.setup += performance.now() - t2;
    void np; void TS;
  },
  copy(regs: any) { return { toXfb: !!(regs.bp[0x52] >> 14 & 1), rect: [], clear: false }; },
  copyClear() {},
};
const gpu = new GxGpu(be, dff, mem1);
for (let rep = 0; rep < 3; rep++) {
  for (const k in t) (t as any)[k] = 0;
  const w0 = performance.now();
  for (let i = 0; i < dff.frames.length; i++) { frame = i; gpu.runFrame(dff.frames[i]); }
  const tot = performance.now() - w0;
  console.log(`rep ${rep}: total ${tot.toFixed(0)} ms for 4 drawn frames; verts ${t.verts} used ${t.used} tris ${t.tris}; assemble ${t.asm.toFixed(1)} transform ${t.xf.toFixed(1)} clip+setup ${t.setup.toFixed(1)} ms`);
}
