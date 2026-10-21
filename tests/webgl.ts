// A headless browser for the tests that need a GPU's answer (WebGL 2: the renderer's shaders): a page is written
// out with its script, opened in Chromium without a window, and what it put in <pre id="out"> is read back. The
// browser is the one CHROMIUM names, else the one Playwright keeps in /opt/pw-browsers, else one on the PATH;
// without any, `browser()` is null and the tests that need it are skipped.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let found: string | null | undefined;

/** the browser to run pages in, or null */
export function browser(): string | null {
  if (found !== undefined) return found;
  const env = (() => { try { return Deno.env.get("CHROMIUM"); } catch { return undefined; } })();
  const tries = [env, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome",
                 "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  found = tries.find((p) => !!p && existsSync(p)) ?? null;
  return found;
}

/** run `script` in a page (it writes its answer with `done(value)`), and return that value */
export function runPage<T>(script: string): T {
  const exe = browser();
  if (!exe) throw new Error("no browser");
  const dir = mkdtempSync(join(tmpdir(), "webgl-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const done = (v) => { document.getElementById("out").textContent = JSON.stringify(v); };
try { ${script}
} catch (e) { done({ error: String(e && e.stack || e) }); }
</script>`);
    const html = execFileSync(exe, [
      "--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist", `--user-data-dir=${join(dir, "profile")}`, "--virtual-time-budget=20000", "--dump-dom",
      `file://${page}`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28, timeout: 120000 });
    const m = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m || !m[1]) throw new Error("the page gave no answer");
    const text = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const v = JSON.parse(text);
    if (v && typeof v === "object" && "error" in v) throw new Error(v.error);
    return v as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
