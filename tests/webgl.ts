// A headless browser for the tests that need a GPU's answer (WebGL 2: the renderer's shaders): a page is written
// out with its script, opened in Chromium without a window, and what it put in <pre id="out"> is read back. The
// browser is the one CHROMIUM names, else the one Playwright keeps in /opt/pw-browsers, else Chromium or Chrome where
// Linux, Windows or macOS installs it (Edge on Windows: the same engine); without any, `browser()` is null and the tests
// that need it are skipped.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { removeDir } from "./tmpdir.ts";

let found: string | null | undefined;

/** the browser to run pages in, or null */
export function browser(): string | null {
  if (found !== undefined) return found;
  const env = (() => { try { return Deno.env.get("CHROMIUM"); } catch { return undefined; } })();
  const tries = [env, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome",
                 "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
                 "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
                 "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
                 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  found = tries.find((p) => !!p && existsSync(p)) ?? null;
  return found;
}

/** run `script` in a page (it writes its answer with `done(value)`), and return that value; `window` is the browser
 *  window's size in CSS pixels (the page's viewport), Chrome's default without it */
export function runPage<T>(script: string, opts: { window?: [number, number] } = {}): T {
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
      ...(opts.window ? [`--window-size=${opts.window[0]},${opts.window[1]}`, "--force-device-scale-factor=1"] : []),
      `file://${page}`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28, timeout: 120000 });
    const m = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m || !m[1]) throw new Error("the page gave no answer");
    const text = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const v = JSON.parse(text);
    if (v && typeof v === "object" && "error" in v) throw new Error(v.error);
    return v as T;
  } finally {
    removeDir(dir);
  }
}
