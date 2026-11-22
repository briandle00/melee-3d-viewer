/* A faster pass over the simulator module's memory: one 64 KiB page's 64-bit hash, computed by a tiny WebAssembly module of its own
 * (pagehash.wat beside this file, assembled with binaryen's wasm-as --enable-simd) that imports the simulator's memory and reads it 64
 * bytes a step with SIMD - four times the speed of the JavaScript pass (checkpoints.ts pageHashes2: ~50 ms against ~190 ms for 0.7 GiB).
 * Sixteen 32-bit chains, each over every sixteenth word (a word xored in, then a multiply by an odd constant: a change to any one word
 * always changes its chain), folded into 64 bits. Nothing is written to the memory.
 *
 * The simulator's Memory object is the host's to hand over: an instance made with an instantiateWasm option that keeps
 * instance.exports.memory (stored.ts makeStored takes the hasher). Without SIMD (or without the memory) there is none: the JavaScript pass.
 */
const WASM = "AGFzbQEAAAABBgFgAX8BfgIIAQFlAW0CAAADAgEABwUBAWgAAArFAgHCAgICfwV7IABBEHQhASABQYCABGohAv0MxZ0cgZMBAAG5eTeea8rrhSED/Qwt69QnsWdWFjWussItNet/IQT9DIumbISV6dFbbTwbLDkteikhBf0MpB3jaE16KbXpxFYb0GNsniEG/QyTAQABkwEAAZMBAAGTAQABIQcDQCADIAH9AAQA/VEgB/21ASEDIAQgAf0ABBD9USAH/bUBIQQgBSAB/QAEIP1RIAf9tQEhBSAGIAH9AAQw/VEgB/21ASEGIAFBwABqIQEgASACSQ0ACyADIAT9Uf0MFXxKf7l5N55P69QnPa6ywv3VASEDIAUgBv1R/Qz5eTeesWdWFs2MVe3Xr1H//dUBIQUgAyAFQR39zQH9USEDIAMgBf1R/QxT7IUa/rnOxOsRMRO7SdCU/dUBIQMgA/0dACAD/R0BQh+JhQs=";

/** `options` for the module's factory that hand `noted` the memory the instance is made with, when the options make it themselves (their
 *  instantiateWasm: the page's compiled module); without one they are left as they are, and nothing is noted */
export function withMemory(options: Record<string, unknown>, noted: (memory: WebAssembly.Memory) => void): Record<string, unknown> {
  type Inst = (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => object;
  const own = options.instantiateWasm as Inst | undefined;
  if (!own) return options;
  const note = (i: WebAssembly.Instance) => { if (i.exports.memory instanceof WebAssembly.Memory) noted(i.exports.memory); };
  return { ...options, instantiateWasm: ((imports, ok) => own(imports, (i, m) => { note(i); ok(i, m); })) as Inst };
}

/* checkpoints.ts pageHash's own 32-bit numbers by SIMD (pagehash32.wat beside this file, assembled the same way): the same bits as the
 * JavaScript pass, about four times as fast - four pages' chains side by side. Every memory a faster pass is made for (fastPageHasher)
 * gets one, and checkpoints.ts pageHashes, pageHash and PiecedHashes use it for that memory. */
const WASM32 = "AGFzbQEAAAABCwJgAX8Bf2ABewF/AggBAWUBbQIAAAMEAwEAAAYQA38BQQALfwFBAAt/AUEACwcaBQJyMQMAAnIyAwECcjMDAgJoMQABAmg0AAIK0AIDLAAgAP0bACAA/RsBQQd4c0GTg4AIbCAA/RsCIAD9GwNBDXhzQa3W074CbHMLZAICfwJ7IABBEHQhASABQYCABGohAv0MxZ0cgZMBAAG5eTeea8rrhSED/QyTAQABkwEAAZMBAAGTAQABIQQDQCADIAH9AAQA/VEgBP21ASEDIAFBEGohASABIAJJDQALIAMQAAu7AQICfwV7IABBEHQhASABQYCABGohAv0MxZ0cgZMBAAG5eTeea8rrhSEDIAMhBCADIQUgAyEG/QyTAQABkwEAAZMBAAGTAQABIQcDQCADIAH9AAQA/VEgB/21ASEDIAQgAf0ABICABP1RIAf9tQEhBCAFIAH9AASAgAj9USAH/bUBIQUgBiAB/QAEgIAM/VEgB/21ASEGIAFBEGohASABIAJJDQALIAQQACQAIAUQACQBIAYQACQCIAMQAAs=";
const hashers32: { memory: WeakRef<WebAssembly.Memory>; h1: (p: number) => number; h4: (p: number) => number; r: WebAssembly.Global[] }[] = [];

function note32(memory: WebAssembly.Memory): void {
  for (let k = hashers32.length - 1; k >= 0; k--) { const m = hashers32[k].memory.deref(); if (!m) hashers32.splice(k, 1); else if (m === memory) return; }
  try {
    const bytes = Uint8Array.from(atob(WASM32), (c) => c.charCodeAt(0));
    const e = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { m: memory } }).exports;
    hashers32.push({ memory: new WeakRef(memory), h1: e.h1 as (p: number) => number, h4: e.h4 as (p: number) => number, r: [e.r1, e.r2, e.r3] as WebAssembly.Global[] });
  } catch { /* no SIMD here: the JavaScript pass */ }
}

/** pageHash's numbers for the memory whose buffer `buffer` is (null: none made for it): pages [first, first + n) into out[first..] (many),
 *  or one page's (one) */
export function pageHashes32(buffer: ArrayBufferLike): { many(first: number, n: number, out: Uint32Array): void; one(p: number): number } | null {
  const e = hashers32.find((x) => x.memory.deref()?.buffer === buffer);
  if (!e) return null;
  return {
    many(first, n, out) {
      let p = first;
      const end = first + n;
      for (; p + 4 <= end; p += 4) { out[p] = e.h4(p); out[p + 1] = e.r[0].value; out[p + 2] = e.r[1].value; out[p + 3] = e.r[2].value; }
      for (; p < end; p++) out[p] = e.h1(p);
    },
    one: (p) => e.h1(p) >>> 0,
  };
}

/** page p's hash, for the memory given (null: this engine has no SIMD) */
export function fastPageHasher(memory: WebAssembly.Memory): ((p: number) => bigint) | null {
  note32(memory);
  try {
    const bytes = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { m: memory } });
    return inst.exports.h as (p: number) => bigint;
  } catch {
    return null;
  }
}
