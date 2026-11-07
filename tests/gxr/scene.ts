// Test helpers for the GX renderer: a stream of GX commands run through the CPU reference.
import { Dff } from "../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../src/render3d/gxr/gpu.ts";
import { CpuBackend } from "../../src/render3d/gxr/cpu.ts";
import { FifoWriter } from "../../src/render3d/gxr/encode.ts";

export function emptyDff(): Dff {
  return { version: 4, bp: new Uint32Array(256), cp: new Uint32Array(256), xfMem: new Uint32Array(0x1000), xfRegs: new Uint32Array(0x60), texMem: new Uint8Array(0), frames: [] };
}

/** run a command stream (one frame) on a fresh processor; returns it and its CPU backend */
export function runStream(w: FifoWriter | Uint8Array): { gpu: GxGpu; be: CpuBackend } {
  // deno-lint-ignore prefer-const -- (assigned once, after the backend that reads it through a closure is made)
  let gpu!: GxGpu;
  const be = new CpuBackend(() => ({ mem: gpu.mem.data, tmem: gpu.regs.tmem, tluts: gpu.regs.tluts }));
  gpu = new GxGpu(be, emptyDff(), null);
  be.drawing = true;
  gpu.runFrame({ fifo: w instanceof Uint8Array ? w : w.bytes(), updates: [] });
  return { gpu, be };
}

export const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
export const toHex = (b: ArrayLike<number>): string => Array.from(b as ArrayLike<number>, (v) => v.toString(16).padStart(2, "0")).join("");
