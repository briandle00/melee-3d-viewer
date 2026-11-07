// One command before publishing: `deno task check` (package.json's "check"). It checks that node_modules matches
// package.json, then runs the type check, the lint and the tests, and says in a few lines what passed. Every step runs
// even when one before failed; the exit code is 1 when any failed. `--build` also makes the static build (dist/).
//
//   deno task check            node_modules, tsc, lint, tests
//   deno task check --build    and vite build
//
// The tests that need more than Deno skip themselves when it is not there (see README.md "Tests"): a C compiler for the
// C references, a Chromium-based browser for the shader and layout checks, your game files (MELEE_ASSETS), the raster
// spec's vectors (GX_SPEC_VECTORS), a GPU run (GX_GPU_TESTS=1).
//
// The lint: Deno's recommended rules without the ones that do not fit this project: no-sloppy-imports (Vite resolves
// extensionless and ~/ imports; the project is written that way), no-window, no-window-prefix and no-process-global
// (browser code, not Deno code), no-explicit-any (the parser and the WebAssembly glue), require-await (async kept for the
// callers' shape). src/render3d/ is the renderer, kept equal to the game's draws by the exactness gate: there, unused
// names and let-for-const are left as they are (a change is only made with the gate) and only the rules that find real
// mistakes run.

const deno = Deno.execPath();
const LINT_EXCLUDE = ["no-sloppy-imports", "no-window", "no-window-prefix", "no-process-global", "no-explicit-any", "require-await"];
const RENDER3D_ALSO = ["no-unused-vars", "prefer-const", "no-empty", "no-this-alias"];
const build = Deno.args.includes("--build");

interface Step { name: string; ok: boolean; ms: number; say: string }
const steps: Step[] = [];

async function run(name: string, args: string[], summarize: (out: string, code: number) => string, env?: Record<string, string>): Promise<void> {
  const t0 = performance.now();
  const r = await new Deno.Command(deno, { args, stdout: "piped", stderr: "piped", env: { NO_COLOR: "1", ...env } }).output();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  const ok = r.code === 0;
  steps.push({ name, ok, ms: performance.now() - t0, say: summarize(out, r.code) });
  if (!ok) console.log(`---- ${name} ----\n${out.trim().split("\n").slice(-60).join("\n")}\n`);
}

function nodeModules(): void {
  const t0 = performance.now();
  const pkg = JSON.parse(Deno.readTextFileSync("package.json"));
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }) as [string, string][]) {
    let have: string;
    try { have = JSON.parse(Deno.readTextFileSync(`node_modules/${name}/package.json`)).version; } catch { missing.push(name); continue; }
    // (the major version a caret range asks for)
    const want = /^\^(\d+)\./.exec(range)?.[1];
    if (want && want !== "0" && have.split(".")[0] !== want) wrong.push(`${name} ${have} (package.json: ${range})`);
  }
  const ok = missing.length === 0 && wrong.length === 0;
  steps.push({
    name: "node_modules", ok, ms: performance.now() - t0,
    say: ok ? "matches package.json" : `run \`deno install --allow-scripts\`: ${[...missing.map((m) => `${m} missing`), ...wrong].join(", ")}`,
  });
}

nodeModules();
await run("tsc", ["run", "-A", "node_modules/typescript/bin/tsc", "--noEmit"], (out) => {
  const n = out.split("\n").filter((l) => /error TS\d+/.test(l)).length;
  return n === 0 ? "no errors" : `${n} errors`;
});
const lintSay = (out: string) => /Found \d+ problems?/.exec(out)?.[0] ?? (/Checked \d+ files?/.exec(out)?.[0] ?? "done");
await run("lint", ["lint", `--rules-exclude=${LINT_EXCLUDE.join(",")}`, "--ignore=src/render3d", "src", "tests", "scripts", "tools", "vite.config.ts"], lintSay);
await run("lint render3d", ["lint", `--rules-exclude=${[...LINT_EXCLUDE, ...RENDER3D_ALSO].join(",")}`, "src/render3d"], lintSay);
await run("tests", ["test", "--no-check", "--sloppy-imports", "-A", "tests/"], (out) => {
  const m = /(ok|FAILED) \| (\d+) passed(?: \(\d+ steps\))? \| (\d+) failed(?: \| (\d+) ignored)?/.exec(out);
  return m ? `${m[2]} passed, ${m[3]} failed, ${m[4] ?? 0} skipped` : "no summary";
});
if (build) await run("build", ["run", "-A", "node_modules/vite/bin/vite.js", "build"], (_out, code) => (code === 0 ? "dist/ made" : "failed"));

for (const s of steps) console.log(`${s.ok ? "ok  " : "FAIL"}  ${s.name.padEnd(14)} ${s.say}  (${(s.ms / 1000).toFixed(1)} s)`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `check: ${failed} of ${steps.length} failed` : `check: all ${steps.length} passed`);
Deno.exit(failed ? 1 : 0);
