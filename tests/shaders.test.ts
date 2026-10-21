// The renderer's programs (renderer.ts SHADERS) compiled and linked by a browser's WebGL 2, as a player's would
// be: a shader the driver refuses fails here, not on a page. Skipped without a browser (tests/webgl.ts).

import test from "node:test";
import assertNode from "node:assert/strict";
import { SHADERS } from "../src/render3d/renderer.ts";
import { browser, runPage } from "./webgl.ts";

test("the model and particle programs compile and link", { skip: !browser() && "no browser" }, () => {
  const out = runPage<Record<string, string>>(`
const gl = document.createElement("canvas").getContext("webgl2");
const S = ${JSON.stringify(SHADERS)};
const res = {};
for (const [vs, fs] of [["VS", "FS"], ["PARTICLE_VS", "PARTICLE_FS"]]) {
  const p = gl.createProgram();
  for (const [t, k] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(t);
    gl.shaderSource(s, S[k]);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) res[k] = gl.getShaderInfoLog(s);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) res[vs + " link"] = gl.getProgramInfoLog(p) || "failed";
}
done(res);`);
  assertNode.deepStrictEqual(out, {});
});
