// View-space lighting (gxlights.ts, the renderer's vertex shader): the lights as HSD_LObjSetup loads them for a
// view, a specular joint's half-way directions (HSD_LObjSetupSpecularInit), and the vertex shader's lit color
// channel - read back through transform feedback in a headless browser - against gx.ts's model of it.

import test from "node:test";
import assertNode from "node:assert/strict";
import { jointInView, lightsInView, newViewLights, specularDirs } from "../src/render3d/gxlights.ts";
import { packLighting } from "../src/render3d/lightset.ts";
import { type GxLight, diffuseChannel } from "../src/render3d/gx.ts";
import { HSD_MtxInverseTranspose, PSVECNormalize, mtxToGL3 } from "../src/render3d/gxmath.ts";
import { MATF, MATI, SHADERS } from "../src/render3d/renderer.ts";
import { browser, runPage } from "./webgl.ts";

const f = Math.fround;
const IDENT = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

test("an infinite light is a point 2^20 out through the view; a spot's axis points toward it", () => {
  const view = Float32Array.from([1, 0, 0, 5, 0, 1, 0, -3, 0, 0, 1, -200]);
  const inf: GxLight = { pos: [0, 0.6, 0.8, 0], axis: [0, 0, 1], color: [1, 1, 1, 1], attn: [1, 0, 0, 1, 0, 0], diffuse: true,
                         specular: true, place: [0, 6, 8] };
  const spot: GxLight = { pos: [10, 20, 30, 1], axis: [0, 0, 1], color: [1, 1, 1, 1], attn: [0, 1, 0, 1, 0, 0], diffuse: true,
                          specular: false, place: [10, 20, 30], interest: [10, 20, 0] };
  const l = packLighting([0, 0, 0], [inf, spot]);
  const v = lightsInView(l, view, [0, 0, 1], newViewLights());
  // (6 and 8 times 2^20, moved by the view's translation: as MTXMultVec makes it)
  assertNode.deepEqual(Array.from(v.pos.subarray(0, 4)), [5, f(f(6 * 1048576) - 3), f(f(8 * 1048576) - 200), 1]);
  // (the spot's light vector is (0, 0, -1): toward the light, (0, 0, 1))
  // (normalized twice by PSVECNormalize: 1 less one unit in the last place)
  const once = PSVECNormalize([0, 0, -30], [0, 0, 0]), twice = PSVECNormalize(once, [0, 0, 0]);
  assertNode.deepEqual(Array.from(v.axis.subarray(4, 7)), [-0, -0, -twice[2]]);
  // (its specular light vector: an infinite light's way, interest - position, normalized: (0, -0.6, -0.8))
  assertNode.ok(Math.abs(v.lvec[1] + 0.6) < 1e-6 && Math.abs(v.lvec[2] + 0.8) < 1e-6, `${Array.from(v.lvec.subarray(0, 4))}`);
  // the color animation's light the same way
  assertNode.equal(v.over[2], f(f(1048576) - 200));
});

test("a joint's half-way direction: between the light's way and the way to the joint, negated", () => {
  const inf: GxLight = { pos: [0, 0, 1, 0], axis: [0, 0, 1], color: [1, 1, 1, 1], attn: [1, 0, 0, 1, 0, 0], diffuse: true,
                         specular: true, place: [0, 0, 1] };
  const l = packLighting([0, 0, 0], [inf]);
  const v = lightsInView(l, IDENT, null, newViewLights());
  // a joint 10 in front of the camera: the way to it (0, 0, -1), the light's (0, 0, -1): half (0, 0, -1), stored (0, 0, 1)
  const j = jointInView(IDENT, 0, 0, -10, [0, 0, 0]);
  assertNode.deepEqual(j, [0, 0, -10]);
  const d = specularDirs(l, v, j, new Float32Array(32));
  // (normalized as PSVECNormalize does it - frsqrte and one Newton step: 1 less one unit in the last place)
  const half = PSVECNormalize([0, 0, -2], [0, 0, 0]);
  assertNode.deepEqual(Array.from(d.subarray(0, 3)), [-0, -0, -half[2]]);
  assertNode.ok(Math.abs(d[2] - 1) < 1e-7);
});

test("the normal matrix of a turn and a uniform scale is the turn over the scale", () => {
  // (a quarter turn about z, scaled by 2)
  const m = Float32Array.from([0, -2, 0, 7, 2, 0, 0, 1, 0, 0, 2, -4]);
  const n = mtxToGL3(HSD_MtxInverseTranspose(m, new Float32Array(12)), new Float32Array(9));
  assertNode.deepEqual(Array.from(n, (x) => x + 0), [0, 0.5, 0, -0.5, 0, 0, 0, 0, 0.5]);
});

test("the vertex shader's lit channel is gx.ts diffuseChannel's, vertex for vertex", { skip: !browser() && "no browser" }, () => {
  // three lights in view space - an infinite one 2^20 out, a point light that fades, a spot - and an ambient
  const lights: GxLight[] = [
    { pos: [f(0.3 * 1048576), f(0.5 * 1048576), f(0.8 * 1048576), 1], axis: [0, 0, 0], color: [0.8, 0.7, 0.6, 1],
      attn: [1, 0, 0, 1, 0, 0], diffuse: true, specular: false },
    { pos: [40, 10, -60, 1], axis: [0, 0, 0], color: [0.5, 0.9, 0.2, 1], attn: [1, 0, 0, 1, 0.01, 0.0005], diffuse: true, specular: false },
    { pos: [-20, 50, -40, 1], axis: [0, 0.6, 0.8], color: [0.3, 0.4, 1, 1], attn: [-2, 3, 0, 1, 0, 0], diffuse: true, specular: false },
  ];
  const amb = [0.25, 0.3, 0.35], matAmb = [0.6, 0.7, 0.8];
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const n = 512, pos: number[] = [], nrm: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.push(f(rnd() * 80 - 40), f(rnd() * 80 - 40), f(-30 - rnd() * 100));
    const a = rnd() * Math.PI * 2, b = Math.acos(rnd() * 2 - 1);
    nrm.push(f(Math.sin(b) * Math.cos(a)), f(Math.sin(b) * Math.sin(a)), f(Math.cos(b)));
  }
  const L = packLighting([0, 0, 0], lights);
  const want = Array.from({ length: n }, (_, i) =>
    diffuseChannel(lights, amb, matAmb, pos.slice(i * 3, i * 3 + 3), nrm.slice(i * 3, i * 3 + 3)));
  const got = runPage<number[]>(`
const gl = document.createElement("canvas").getContext("webgl2");
const S = ${JSON.stringify(SHADERS)};
const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, S.VS));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, "#version 300 es\\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }"));
["aPos", "aNrm", "aUv0", "aUv1", "aClr", "aMtx", "aBin", "aTan"].forEach((a, i) => gl.bindAttribLocation(p, i, a));
gl.transformFeedbackVaryings(p, ["vRas0"], gl.INTERLEAVED_ATTRIBS);
gl.linkProgram(p);
if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
gl.useProgram(p);
const U = (n) => gl.getUniformLocation(p, n);
const I4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
gl.uniformMatrix4fv(U("uMats"), false, I4); gl.uniformMatrix4fv(U("uMV"), false, I4); gl.uniformMatrix4fv(U("uProj"), false, I4);
gl.uniformMatrix4fv(U("uView"), false, I4); gl.uniformMatrix4fv(U("uViewProj"), false, I4);
gl.uniformMatrix3fv(U("uNrm"), false, new Float32Array([1,0,0, 0,1,0, 0,0,1]));
gl.uniform3fv(U("uAmbLight"), ${JSON.stringify(amb)});
gl.uniform1i(U("uNumLights"), ${L.n});
gl.uniform4fv(U("uLPosV"), ${JSON.stringify(Array.from(L.pos))});
gl.uniform4fv(U("uLAxisV"), ${JSON.stringify(Array.from(L.axis))});
gl.uniform4fv(U("uLPos"), ${JSON.stringify(Array.from(L.pos))});
gl.uniform4fv(U("uLCol"), ${JSON.stringify(Array.from(L.color))});
gl.uniform4fv(U("uLA"), ${JSON.stringify(Array.from(L.attnA))});
gl.uniform4fv(U("uLK"), ${JSON.stringify(Array.from(L.attnK))});
gl.uniform1i(U("uOverMode"), 0);
// the material block: its ambient (uMatF[1]), the lit channel (uMatI[0].y = 2), no textures
const blk = new ArrayBuffer((${MATF} + ${MATI}) * 16), F = new Float32Array(blk, 0, ${MATF * 4}), I = new Int32Array(blk, ${MATF * 16}, ${MATI * 4});
F.set([1, 1, 1, 1], 0); F.set([...${JSON.stringify(matAmb)}, 50], 4);
I[1] = 2; for (let k = 4; k < 8; k++) I[k] = -1;
const ubo = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, blk, gl.STATIC_DRAW);
gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, "Mat"), 0); gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
const buf = (data, loc, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
buf(${JSON.stringify(pos)}, 0, 3); buf(${JSON.stringify(nrm)}, 1, 3);
const out = gl.createBuffer(); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, out);
gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, ${n} * 16, gl.STREAM_READ);
gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, out);
gl.enable(gl.RASTERIZER_DISCARD);
gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, ${n}); gl.endTransformFeedback();
const r = new Float32Array(${n} * 4); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, r);
done(Array.from(r));`);
  let exact = 0, worst = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const g = Math.round(got[i * 4 + c] * 255), d = Math.abs(g - want[i][c]);
      worst = Math.max(worst, d);
      if (d === 0) exact++;
    }
  }
  // (the GPU's float against JS's double: a term on a rounding edge may land a level the other way)
  assertNode.ok(worst <= 1, `worst ${worst} levels`);
  assertNode.ok(exact >= n * 3 * 0.98, `exact ${exact} of ${n * 3}`);
});
