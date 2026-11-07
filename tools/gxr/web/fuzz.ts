// Random scenes through the CPU reference and the GPU backend: both must produce the same frame buffer (colors and depths).
// Exercises everything the 22 recorded windows do not: all texel formats, filters and wrap modes, TEV scales, biases and compare modes,
// blend factors and logic ops, fog forms, depth functions, the alpha test, the depth texture, the indirect unit.
import { Dff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";
import { CpuBackend } from "../../../src/render3d/gxr/cpu.ts";
import { basicScene } from "../../../src/render3d/gxr/encode.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const be = new GxGl(gl, { debugRegs: q.get("dbgregs") ? (q.get("dbgregs")!.split(",").map(Number) as [number, number]) : undefined }, { workers: Number(q.get("workers") ?? 0), factory: () => new Worker("/frontworker.js", { type: "module" }) });

class Rng {
  s: number;
  constructor(seed: number) { this.s = (seed * 2654435761) >>> 0 || 1; }
  next(): number { this.s ^= this.s << 13; this.s >>>= 0; this.s ^= this.s >>> 17; this.s ^= this.s << 5; this.s >>>= 0; return this.s; }
  int(n: number): number { return this.next() % n; }
  f(): number { return this.next() / 4294967296; }
  pick<T>(a: T[]): T { return a[this.int(a.length)]; }
  chance(p: number): boolean { return this.f() < p; }
}

const emptyDff = (): Dff => ({ version: 4, bp: new Uint32Array(256), cp: new Uint32Array(256), xfMem: new Uint32Array(0x1000), xfRegs: new Uint32Array(0x60), texMem: new Uint8Array(0), frames: [] });
const f32b = (v: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); return [d.getUint8(0), d.getUint8(1), d.getUint8(2), d.getUint8(3)]; };
const TEXBASE = 0x100000, PALSRC = 0x300000;

interface Opts { indirect: boolean; fog: boolean; fmt1: boolean; lines: boolean }

function buildScene(seed: number, o: Opts): { stream: Uint8Array; mem: Uint8Array; desc: string } {
  const r = new Rng(seed);
  const mem = new Uint8Array(0x1800000);
  for (let i = TEXBASE; i < PALSRC + 0x20000; i++) mem[i] = r.int(256);
  const w = basicScene();
  const desc: string[] = [];
  // vertex format: pos, color 0, tex 0, tex 1
  w.cp(0x50, (1 << 9) | (1 << 13));
  w.cp(0x60, (1 << 0) | (1 << 2));
  w.cp(0x70, 1 | (4 << 1) | (5 << 14) | (1 << 21) | (4 << 22));
  w.cp(0x80, 1 | (4 << 1) | (0 << 4));
  const nGens = 1 + r.int(2);
  w.xf(0x103f, [nGens]);
  for (let n = 0; n < nGens; n++) w.xf(0x1040 + n, [(5 + n) << 7]);
  // the texture maps
  const FMTS = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 14];
  const maps: string[] = [];
  for (let m = 0; m < 2; m++) {
    const fmt = r.pick(FMTS);
    const W = 1 + r.int(70), H = 1 + r.int(70);
    const addr = TEXBASE + m * 0x40000 + r.int(0x1000) * 32;
    const wrapS = r.int(3), wrapT = r.int(3);
    const mag = r.int(2), min = r.pick([0, 1, 2, 4, 5, 6]), diag = r.int(2);
    const bias = r.chance(0.7) ? 0 : (r.int(40) - 20) & 255;
    const minlod = r.chance(0.8) ? 0 : r.int(24), maxlod = r.chance(0.25) ? minlod : r.chance(0.8) ? 255 : minlod + r.int(40);
    w.bp(0x80 + m, wrapS | (wrapT << 2) | (mag << 4) | (min << 5) | (diag << 8) | (bias << 9));
    w.bp(0x84 + m, minlod | (maxlod << 8));
    w.bp(0x88 + m, (W - 1) | ((H - 1) << 10) | (fmt << 20));
    w.bp(0x94 + m, addr >> 5);
    const pf = r.int(3);
    w.bp(0x98 + m, (m * 64) | (pf << 10));
    // the palette: loaded from memory into TMEM offset m * 64
    w.bp(0x64, (PALSRC + m * 0x8000) >> 5);
    w.bp(0x65, (m * 64) | (512 << 10) /* count in 32-byte units: 512 -> 16 KiB */);
    w.bp(0x30 + 2 * m, W - 1); w.bp(0x31 + 2 * m, H - 1);
    maps.push(`map${m} fmt${fmt} ${W}x${H} wrap${wrapS}${wrapT} mag${mag} min${min} diag${diag} bias${bias} lod${minlod}-${maxlod} pf${pf}`);
  }
  desc.push(maps.join("; "));
  // TEV
  const nStages = 1 + r.int(4);
  const bp0 = nGens | (1 << 4) | ((nStages - 1) << 10) | (o.indirect && r.chance(0.7) ? (1 + r.int(2)) << 16 : 0);
  w.bp(0x00, bp0);
  const stageDesc: string[] = [];
  for (let i = 0; i < nStages; i++) {
    const tex = r.chance(0.75);
    const ras = r.pick([0, 0, 0, 1, 5, 6, 7]);
    const ord = (r.int(2)) | (r.int(nGens) << 3) | ((tex ? 1 : 0) << 6) | (ras << 7);
    // ordering words hold two stages
    stageOrd[i] = ord;
    const cbias = r.pick([0, 0, 0, 1, 2, 3]), abias = r.pick([0, 0, 0, 1, 2, 3]);
    const cc = r.int(16) | (r.int(16) << 4) | (r.int(16) << 8) | (r.int(16) << 12) | (cbias << 16) | (r.int(2) << 18) | (r.int(2) << 19) | (r.int(4) << 20) | (r.int(4) << 22);
    const ac = r.int(4) | (r.int(4) << 2) | (r.int(8) << 4) | (r.int(8) << 7) | (r.int(8) << 10) | (r.int(8) << 13) | (abias << 16) | (r.int(2) << 18) | (r.int(2) << 19) | (r.int(4) << 20) | (r.int(4) << 22);
    w.bp(0xc0 + 2 * i, cc); w.bp(0xc1 + 2 * i, ac);
    stageDesc.push(`st${i} ord${ord.toString(16)} c${cc.toString(16)} a${ac.toString(16)}`);
    if (o.indirect) w.bp(0x10 + i, r.chance(0.6) ? (r.int(2)) | (r.int(4) << 2) | (r.int(8) << 4) | (r.int(4) << 7) | (r.int(16) << 9) | (r.int(7) << 13) | (r.int(7) << 16) | (r.int(2) << 20) : 0);
  }
  for (let k = 0; k < Math.ceil(nStages / 2); k++) {
    w.bp(0x28 + k, stageOrd[2 * k] | ((stageOrd[2 * k + 1] ?? 0) << 12));
    w.bp(0xf6 + k, (r.int(32) << 4) | (r.int(32) << 9) | (r.int(32) << 14) | (r.int(32) << 19));
  }
  // swap tables
  for (let t = 0; t < 4; t++) { w.bpMasked(0xf6 + 2 * t, r.chance(0.7) ? (t === 0 ? 0 | (1 << 2) : 0) : (r.int(4) | (r.int(4) << 2)), 0xf); w.bpMasked(0xf7 + 2 * t, r.chance(0.7) ? (2 | (3 << 2)) : (r.int(4) | (r.int(4) << 2)), 0xf); }
  // color registers and constants
  for (let k = 0; k < 4; k++) {
    w.bp(0xe0 + 2 * k, (r.int(1024) - 512 & 0x7ff) | ((r.int(256)) << 12));
    w.bp(0xe1 + 2 * k, (r.int(256)) | (r.int(256) << 12));
    w.bp(0xe0 + 2 * k, (r.int(256)) | (r.int(256) << 12) | (1 << 23));
    w.bp(0xe1 + 2 * k, (r.int(256)) | (r.int(256) << 12) | (1 << 23));
  }
  // indirect matrices and scale
  if (o.indirect) {
    for (let k = 0; k < 9; k++) w.bp(0x06 + k, r.int(1 << 24));
    w.bp(0x25, r.int(1 << 16)); w.bp(0x26, r.int(1 << 16)); w.bp(0x27, r.int(1 << 24));
  }
  // pixel engine
  const atest = (r.pick([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]) << 16) | (r.pick([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]) << 19) | (r.int(4) << 22) | r.int(256) | (r.int(256) << 8);
  w.bp(0xf3, atest);
  const zfunc = r.pick([1, 3, 3, 7, 4, 2, 5, 6, 0]);
  const zEnable = r.chance(0.8) ? 1 : 0, zUpd = r.int(2);
  w.bp(0x40, zEnable | (zfunc << 1) | (zUpd << 4));
  const pixfmt = o.fmt1 && r.chance(0.3) ? 1 : 0;
  const early = r.int(2);
  w.bp(0x43, pixfmt | (early << 6));
  const blendKind = r.pick(["off", "add", "add", "add", "sub", "logic"]);
  let bm = (r.int(2) << 3) | (r.int(2) << 4) | (r.int(2) << 2);
  if (blendKind === "add") bm |= 1 | (r.int(8) << 5) | (r.int(8) << 8);
  else if (blendKind === "sub") bm |= 1 | (1 << 11);
  else if (blendKind === "logic") bm |= 2 | (r.int(16) << 12);
  w.bp(0x41, bm | (1 << 3));
  w.bp(0x42, r.chance(0.2) ? (0x100 | r.int(256)) : 0);
  if (r.chance(0.2)) w.bp(0xf5, r.int(4) | (r.int(3) << 2)), w.bp(0xf4, r.int(1 << 24));
  if (o.fog && r.chance(0.5)) {
    const fl = (v: number) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v); const u = b.getUint32(0); return ((u >>> 31) << 19) | (((u >>> 23) & 255) << 11) | ((u >>> 12) & 0x7ff); };
    const ortho = r.int(2);
    w.bp(0xee, fl(0.05 + r.f() * 0.5)); w.bp(0xef, 1 + r.int(16000000)); w.bp(0xf0, r.int(8));
    w.bp(0xf1, fl(r.f() * 0.5) | (ortho << 20) | (r.pick([2, 4, 5, 6, 7]) << 21));
    w.bp(0xf2, r.int(1 << 24));
    if (r.chance(0.4)) { w.bp(0xe8, 342 + 320 | (1 << 10)); w.bp(0xe9, r.int(1 << 24)); w.bp(0xea, r.int(1 << 24)); w.bp(0xeb, r.int(1 << 24)); w.bp(0xec, r.int(1 << 24)); w.bp(0xed, r.int(1 << 24)); }
  }
  for (const o2 of (q.get("ov") ?? "").split(",").filter(Boolean)) { const [a, v] = o2.split(":"); w.bp(Number(a), Number(v)); }
  const only = q.get("ns");
  if (only) w.bp(0x00, (bp0 & ~(15 << 10)) | ((Number(only) - 1) << 10));
  // triangles
  const nTri = 2 + r.int(4);
  for (let t = 0; t < nTri; t++) {
    const bytes: number[] = [];
    const cx = 80 + r.int(480), cy = 80 + r.int(320), sz = 30 + r.int(300);
    for (let v = 0; v < 3; v++) {
      const px = cx + (r.int(2 * sz) - sz), py = cy + (r.int(2 * sz) - sz), pz = -(50 + r.int(900));
      bytes.push(...f32b(px), ...f32b(py), ...f32b(pz), r.int(256), r.int(256), r.int(256), r.pick([255, r.int(256)]));
      bytes.push(...f32b(r.f() * 1.6 - 0.3), ...f32b(r.f() * 1.6 - 0.3), ...f32b(r.f() * 1.6 - 0.3), ...f32b(r.f() * 1.6 - 0.3));
    }
    w.draw(2, 0, 3, bytes);
  }
  if (o.lines) {
    w.bp(0x22, 1 + r.int(60));
    for (let t = 0; t < 3; t++) {
      const bytes: number[] = [];
      const n = r.chance(0.5) ? 2 : 3;
      for (let v = 0; v < n; v++) {
        bytes.push(...f32b(r.int(900) - 130), ...f32b(r.int(700) - 110), ...f32b(-(50 + r.int(900))), r.int(256), r.int(256), r.int(256), r.pick([255, r.int(256)]));
        bytes.push(...f32b(r.f()), ...f32b(r.f()), ...f32b(r.f()), ...f32b(r.f()));
      }
      w.draw(r.chance(0.5) ? 5 : 6, 0, n, bytes);
    }
  }
  desc.push(`stages ${nStages} gens ${nGens}`, ...stageDesc, `z ${zEnable}/${zfunc}/${zUpd} early ${early} fmt ${pixfmt} blend ${blendKind} ${bm.toString(16)} atest ${atest.toString(16)}`);
  return { stream: w.bytes(), mem, desc: desc.join("\n   ") };
}
const stageOrd: number[] = [];

function runCpu(sc: { stream: Uint8Array; mem: Uint8Array }) {
  // deno-lint-ignore prefer-const -- (assigned once, after the backend that reads it through a closure is made)
  let gpu!: GxGpu;
  const cpu = new CpuBackend(() => ({ mem: gpu.mem.data, tmem: gpu.regs.tmem, tluts: gpu.regs.tluts }));
  gpu = new GxGpu(cpu, emptyDff(), sc.mem);
  cpu.drawing = true;
  gpu.runFrame({ fifo: sc.stream, updates: [] });
  return cpu.efb;
}

function runGpu(sc: { stream: Uint8Array; mem: Uint8Array }) {
  be.reset();
  be.drawing = true;
  const gpu = new GxGpu(be, emptyDff(), sc.mem);
  gpu.runFrame({ fifo: sc.stream, updates: [] });
  be.flush();
  return be.readEfb();
}

(globalThis as any).DBG = (x: number, y: number) => q.get("px") === `${x},${y}`;
const n0 = Number(q.get("from") ?? 1), n = Number(q.get("n") ?? 50);
const opts: Opts = { indirect: q.get("indirect") === "1", fog: q.get("fog") !== "0", fmt1: q.get("fmt1") === "1", lines: q.get("lines") === "1" };
let bad = 0;
for (let seed = n0; seed < n0 + n; seed++) {
  stageOrd.length = 0;
  const sc = buildScene(seed, opts);
  const a = runCpu({ stream: sc.stream, mem: sc.mem });
  const b = runGpu({ stream: sc.stream, mem: sc.mem });
  if (q.get("feat")) await log(`seed ${seed}: features ${be.lastFeatures}, passes ${be.passes}`);
  if (q.get("twice")) {
    const a2 = runCpu({ stream: sc.stream, mem: sc.mem }), b2 = runGpu({ stream: sc.stream, mem: sc.mem });
    let da = 0, db = 0;
    for (let i = 0; i < a.color.length; i++) { if (a.color[i] !== a2.color[i] || a.depth[i] !== a2.depth[i]) da++; if (b.color[i] !== b2.color[i] || b.depth[i] !== b2.depth[i]) db++; }
    if (da || db) await log(`seed ${seed}: rerun differs: cpu ${da} px, gpu ${db} px`);
  }
  if (q.get("px")) { const [px, py] = q.get("px")!.split(",").map(Number); const i = py * 640 + px; await log(`pixel ${px},${py}: cpu ${a.color[i].toString(16)} gpu ${b.color[i].toString(16)}`); }
  let diff = 0, first = -1;
  for (let i = 0; i < a.color.length; i++) if (a.color[i] !== b.color[i] || a.depth[i] !== b.depth[i]) { diff++; if (first < 0) first = i; }
  if (diff) {
    bad++;
    await log(`seed ${seed}: ${diff} pixels differ, first (${first % 640},${(first / 640) | 0}) cpu ${a.color[first].toString(16)}/${a.depth[first]} gpu ${b.color[first].toString(16)}/${b.depth[first]}\n   ${sc.desc}`);
  }
}
await log(`fuzz: ${n - bad}/${n} scenes equal`);
await fetch("/done", { method: "POST", body: bad ? "mismatch" : "ok" });
