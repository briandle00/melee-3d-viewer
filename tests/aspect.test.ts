// The picture keeps the game's 73:60 in any box: the players. GameFrame (src/components/viewer/GameFrame.tsx, src/common/aspect.ts: the
// largest 73:60 rectangle that fits, centered, the rest of the box left as bars) and the GX page's view (src/gx.css
// #view: 73:60 at the most the page's width and height allow, the 640 x 480 picture drawn into it), measured in a real
// browser's layout. Never stretched, never widened: a box of another shape gives bars.
//
//   deno test -A --no-check --sloppy-imports tests/aspect.test.ts      (skipped without a browser: tests/webgl.ts)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FRAME_INNER_SIZE, FRAME_OUTER_STYLE, GAME_ASPECT } from "../src/common/aspect.ts";
import { browser, runPage } from "./webgl.ts";

const skip = browser() ? false : "no browser (tests/webgl.ts)";
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test("GameFrame: the largest 73:60 picture that fits any box, centered, bars for the rest", { skip }, () => {
  assert.equal(GAME_ASPECT, 73 / 60);
  // wide, tall, exact, square, tiny, a phone held up and on its side
  const boxes = [[800, 400], [300, 600], [730, 600], [1000, 1000], [123, 77], [390, 844], [844, 390]];
  const got = runPage<{ w: number; h: number; x: number; y: number; iw: number; ih: number }[]>(`
    const out = [];
    for (const [w, h] of ${JSON.stringify(boxes)}) {
      const outer = document.createElement("div");
      outer.setAttribute("style", ${JSON.stringify(FRAME_OUTER_STYLE)} + "; position: relative; width: " + w + "px; height: " + h + "px");
      const inner = document.createElement("div");
      Object.assign(inner.style, { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" },
                    ${JSON.stringify(FRAME_INNER_SIZE)});
      outer.append(inner);
      document.body.append(outer);
      const o = outer.getBoundingClientRect(), r = inner.getBoundingClientRect();
      out.push({ w, h, x: r.left - o.left, y: r.top - o.top, iw: r.width, ih: r.height });
    }
    done(out);
  `);
  assert.equal(got.length, boxes.length);
  for (const g of got) {
    const at = `box ${g.w} x ${g.h}`;
    near(g.iw / g.ih, GAME_ASPECT, 0.01, `${at}: shape`);
    assert.ok(g.iw <= g.w + 0.5 && g.ih <= g.h + 0.5, `${at}: the picture is bigger than its box (${g.iw} x ${g.ih})`);
    // (as big as fits: it touches two opposite sides)
    assert.ok(Math.abs(g.iw - g.w) <= 0.5 || Math.abs(g.ih - g.h) <= 0.5, `${at}: not as big as fits (${g.iw} x ${g.ih})`);
    near(g.x, (g.w - g.iw) / 2, 0.5, `${at}: left bar`);
    near(g.y, (g.h - g.ih) / 2, 0.5, `${at}: top bar`);
  }
});

const GX_CSS = readFileSync(new URL("../src/gx.css", import.meta.url), "utf8");

for (const [w, h] of [[1280, 720], [800, 1000], [1920, 1080], [500, 400]] as const) {
  test(`GX page in a ${w} x ${h} window: the view is 73:60 and the 640 x 480 picture fills it`, { skip }, () => {
    const g = runPage<{ vw: number; vh: number; cw: number; ch: number; sw: number; sh: number; dx: number; dy: number }>(`
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(GX_CSS)};
      document.head.append(style);
      const app = document.createElement("div");
      app.id = "app";
      app.innerHTML = '<div id="stage"><div id="view"><canvas id="screen" width="640" height="480"></canvas></div></div>';
      document.body.append(app);
      const v = document.getElementById("view").getBoundingClientRect();
      const c = document.getElementById("screen").getBoundingClientRect();
      const s = document.getElementById("stage").getBoundingClientRect();
      done({ vw: v.width, vh: v.height, cw: c.width, ch: c.height, sw: s.width, sh: s.height,
             dx: c.left - v.left, dy: c.top - v.top });
    `, { window: [w, h] });
    const at = `window ${w} x ${h}`;
    assert.ok(g.cw > 0 && g.ch > 0, `${at}: no picture (${JSON.stringify(g)})`);
    near(g.cw / g.ch, GAME_ASPECT, 0.005, `${at}: the picture's shape`);
    near(g.cw, g.vw, 0.5, `${at}: the picture's width`);
    // (the view is the picture: the controller overlays are placed on the view, from its bottom)
    near(g.ch, g.vh, 0.5, `${at}: the view's height is not the picture's`);
    near(g.dx, 0, 0.5, `${at}: the picture's left`);
    near(g.dy, 0, 0.5, `${at}: the picture's top`);
    assert.ok(g.cw <= g.sw + 0.5, `${at}: wider than the page (${g.cw} > ${g.sw})`);
    assert.ok(g.ch <= g.sh + 0.5, `${at}: taller than the stage (${g.ch} > ${g.sh})`);
  });
}
