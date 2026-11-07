// The GX renderer's shader against its CPU reference, in a real browser with a GPU: random scenes (every texel format, filter, wrap, TEV setting, blend,
// depth function, fog form, indirect stage), random EFB copies of every format, and the shader's power function against exact integers. They take a few minutes
// (the pixel shader compiles for a while on first use) and need a GPU, so they run only with GX_GPU_TESTS=1 (and CHROME naming the browser when it is not
// at the usual place): `GX_GPU_TESTS=1 deno test -A --no-check --sloppy-imports tests/gxr-gpu.test.ts`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./tmpdir.ts";

const on = (() => { try { return Deno.env.get("GX_GPU_TESTS") === "1"; } catch { return false; } })();

function page(name: string, args: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "gxr-"));
  try {
    const r = new Deno.Command("deno", {
      args: ["run", "-A", "--no-lock", "--sloppy-imports", "tools/gxr/webrun.ts", `tools/gxr/web/${name}.ts`, join(dir, "out"), ...args, "timeout=1500000"],
      env: { GX_OUT: dir }, stdout: "piped", stderr: "piped",
    }).outputSync();
    const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    assert.ok(r.success, text.slice(-2000));
  } finally {
    removeDir(dir);
  }
}

const t = on ? test : (name: string, fn: () => void) => test(name, { skip: "GX_GPU_TESTS is not set" }, fn);

t("the shader equals the CPU reference on random scenes", () => page("fuzz", ["n=40", "lines=1", "workers=2"]));
t("the shader equals the CPU reference on random scenes with the indirect unit", () => page("fuzz", ["n=20", "indirect=1", "fmt1=1"]));
t("the shader's EFB copies equal the CPU reference's", () => page("fuzzcopy", ["n=300"]));
t("the shader's 2^x is the correctly rounded power", () => page("fuzzexp", ["n=262144"]));
