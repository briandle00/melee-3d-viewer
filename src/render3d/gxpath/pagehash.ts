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

/** `options` for the module's factory that hand `noted` the memory the instance is made with (the options' own instantiateWasm, when they
 *  have one, still makes it; else the module's file is fetched and instantiated here, from `locateFile`'s address for it) */
export function withMemory(options: Record<string, unknown>, noted: (memory: WebAssembly.Memory) => void): Record<string, unknown> {
  type Inst = (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => object;
  const own = options.instantiateWasm as Inst | undefined;
  const note = (i: WebAssembly.Instance) => { if (i.exports.memory instanceof WebAssembly.Memory) noted(i.exports.memory); };
  const instantiateWasm: Inst = own
    ? (imports, ok) => own(imports, (i, m) => { note(i); ok(i, m); })
    : (imports, ok) => {
        const url = typeof options.locateFile === "function" ? (options.locateFile as (p: string, d: string) => string)("gx-core.wasm", "") : "gx-core.wasm";
        WebAssembly.instantiateStreaming(fetch(url), imports).then((r) => { note(r.instance); ok(r.instance, r.module); })
          .catch((e) => console.warn("simulator:", e));
        return {};
      };
  return { ...options, instantiateWasm };
}

/** page p's hash, for the memory given (null: this engine has no SIMD) */
export function fastPageHasher(memory: WebAssembly.Memory): ((p: number) => bigint) | null {
  try {
    const bytes = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { m: memory } });
    return inst.exports.h as (p: number) => bigint;
  } catch {
    return null;
  }
}
