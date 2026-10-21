// The C references the tests check the TypeScript against (tests/c/*.c): built once with the C compiler there is
// (CC, else cc, gcc or clang), as the SDK's C is built - single precision, nothing contracted that the source does
// not fuse itself - and run with an input file and an output file named on its command line. Without a compiler
// that builds them, `cSkip(name)` says why and the tests that need them are skipped (a message, not a failure).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

let cc: string | null | undefined;

/** the C compiler, or null */
export function compiler(): string | null {
  if (cc !== undefined) return cc;
  const env = (() => { try { return Deno.env.get("CC"); } catch { return undefined; } })();
  cc = null;
  for (const c of [env, "cc", "gcc", "clang"]) {
    if (!c) continue;
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); cc = c; break; } catch { /* the next */ }
  }
  return cc;
}

const WINDOWS = (() => { try { return Deno.build.os === "windows"; } catch { return false; } })();
const built = new Map<string, { exe: string | null; why: string | null }>();
let dir: string | null = null;

/** a reference's source file, as a path the compiler takes on any system (a file URL's path is not one on Windows) */
export function sourceOf(name: string): string {
  return fileURLToPath(new URL(`./c/${name}.c`, import.meta.url));
}

/** build tests/c/<name>.c once: its program, or null with the reason */
function build(name: string): { exe: string | null; why: string | null } {
  let b = built.get(name);
  if (b) return b;
  const c = compiler();
  if (!c) b = { exe: null, why: "no C compiler (set CC, or put cc, gcc or clang on the PATH)" };
  else {
    try {
      dir ??= mkdtempSync(join(tmpdir(), "cref-"));
      const exe = join(dir, WINDOWS ? `${name}.exe` : name);
      execFileSync(c, ["-O1", "-std=c99", "-ffp-contract=off", "-fno-fast-math", "-o", exe, sourceOf(name), "-lm"],
                   { stdio: ["ignore", "ignore", "pipe"] });
      b = existsSync(exe) ? { exe, why: null } : { exe: null, why: `${c} built no program from ${name}.c` };
    } catch (e) {
      const err = (e as { stderr?: Uint8Array }).stderr;
      b = { exe: null, why: `${c} could not build ${name}.c: ${err ? new TextDecoder().decode(err).trim().split("\n")[0] : String(e)}` };
    }
  }
  built.set(name, b);
  return b;
}

/** why the tests needing tests/c/<name>.c are skipped, or false when it builds */
export function cSkip(name: string): string | false {
  const why = build(name).why;
  if (why) console.warn(`skipping the ${name} C reference tests: ${why}`);
  return why ?? false;
}

/** run tests/c/<name>.c on an input file holding `input`, with these arguments before the input and output
 *  files' names; what it wrote to the output file */
export function runCFile(name: string, input: Uint8Array | string, args: string[] = []): Uint8Array {
  const { exe, why } = build(name);
  if (!exe) throw new Error(why ?? "not built");
  const inPath = join(dir!, `${name}.in`), outPath = join(dir!, `${name}.out`);
  writeFileSync(inPath, input);
  execFileSync(exe, [...args, inPath, outPath], { stdio: "inherit" });
  return new Uint8Array(readFileSync(outPath));
}

/** the same, text in and text out */
export function runC(name: string, input: string): string {
  return new TextDecoder().decode(runCFile(name, input));
}

/** the build directory let go of (a test's after) */
export function cleanC() {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  built.clear();
}
