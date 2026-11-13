/* 3D replay viewer: the picture drawn as the game's frame buffer
 * has it, and shown as Slippi's Dolphin shows it.
 *
 * The game draws each frame into a 640 x 480 frame buffer (its render
 * modes' fbWidth and efbHeight: sysdolphin's video code, Melee's
 * gmMainLib render modes), and the video interface shows those 480 lines
 * over the whole picture. Dolphin draws that frame buffer at its internal
 * resolution - native: the game's own 640 x 480; higher: that many times
 * over, the scale counted on its 640 x 528 frame buffer (EFB_WIDTH,
 * EFB_HEIGHT; "Auto" takes the window's) - and stretches the 640 x 480 over
 * the window with linear filtering. At native resolution and 73:60 the
 * picture Slippi's playback Dolphin shows and dumps is 643 x 528: 528 lines,
 * 528 x 73 / 60 across.
 *
 * So the scene is drawn into a frame buffer of the game's 640 x 480 at the
 * scale the canvas has of Dolphin's 640 x 528, never under 1 (pictureSize,
 * bind()), then stretched over
 * the canvas, filtered linearly (present()). Without anti-aliasing, as the
 * game's frame buffer (its render modes' aa off; Dolphin's MSAA off): its
 * edges and the textures' level of detail come out as the game's.
 *
 * The copy's vertical filter is not run here. The game's render modes ask
 * for 8, 8, 10, 12, 10, 8, 8 of 64 with its Deflicker option on (a quarter of
 * the line above and the line below), but Slippi's playback Dolphin, as
 * Slippi sets it up (frame buffer copies to textures, no real XFB), does not
 * apply it: with it (the game's 16, 32, 16 of 64 before the stretch) the
 * player's pictures were further from Dolphin's, SSIM 0.854 against 0.869
 * without. The 480p look (look480.ts)
 * has it, as the console makes the picture.
 */

/** Dolphin's frame buffer, the size its internal resolution is counted on */
export const EFB_W = 640, EFB_H = 528;
/** the game's own frame buffer: the lines it draws and the video shows */
export const GAME_W = 640, GAME_H = 480;

/** the size the scene is drawn at for a canvas of w x h pixels: never under the game's own 640 x 480, as Dolphin
 *  never draws under its native resolution - a smaller canvas has that stretched down over it. Drawn at a canvas's
 *  scale under it (a player 310 lines tall drew 282), the HUD's lettering, made for 480 lines, came out with rows
 *  of its glyphs missing: Slippi's name plates read as cut through */
export function pictureSize(w: number, h: number): [number, number] {
  const s = Math.max(1, Math.min(w / EFB_W, h / EFB_H));
  return [Math.max(1, Math.round(GAME_W * s)), Math.max(1, Math.round(GAME_H * s))];
}

const VS = `#version 300 es
out vec2 vUv;
void main() {
  // one triangle over the whole target
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// the frame buffer over the canvas, filtered linearly (the texture's own sampler)
const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

export interface PictureOptions {
  /** multisampling of the frame buffer (0: none, as the game; the player's own. 4: the edges smoothed, a trial) */
  samples: number;
}

export class GamePicture {
  /** the frame buffer's size (pictureSize) */
  w = 0;
  h = 0;
  private fb: WebGLFramebuffer | null = null;
  private color: WebGLRenderbuffer | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private tex: WebGLTexture | null = null;
  /** with multisampling: the frame buffer resolved, which is what is shown */
  private resolved: WebGLFramebuffer | null = null;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private samples: number;

  constructor(private gl: WebGL2RenderingContext, opts: PictureOptions) {
    const max = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.samples = Math.max(0, Math.min(opts.samples, max || 0));
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, SHOW_FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uSrc"), 0);
    this.prog = p;
    this.vao = gl.createVertexArray()!;
  }

  /** the frame buffer for a canvas of cw x ch pixels (made again when its size changes) */
  resize(cw: number, ch: number) {
    const [w, h] = pictureSize(cw, ch);
    if (w === this.w && h === this.h && this.fb) return;
    this.free();
    const gl = this.gl;
    this.w = w; this.h = h;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    if (this.samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH24_STENCIL8, w, h);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    this.depth = depth;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (this.samples) {
      const color = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      this.color = color;
    } else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("the picture's frame buffer");
    this.fb = fb;
    if (this.samples) {
      const r = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, r);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.resolved = r;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** draw the scene into the frame buffer from here on */
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
  }

  /** the frame buffer's picture as the one copies read (gl.READ_FRAMEBUFFER), until bind() */
  readable() {
    if (!this.samples) return;
    this.resolve();
    this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, this.resolved);
  }

  private resolve() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /** the stretch over the canvas (w x h pixels); leaves the canvas bound, and
   *  GL state the renderer tracks changed (it forgets it) */
  present(w: number, h: number) {
    const gl = this.gl;
    if (this.samples) this.resolve();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(false);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // (off its unit: the next frame draws into it)
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private free() {
    const gl = this.gl;
    if (this.fb) gl.deleteFramebuffer(this.fb);
    if (this.resolved) gl.deleteFramebuffer(this.resolved);
    if (this.color) gl.deleteRenderbuffer(this.color);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fb = this.resolved = this.color = this.depth = this.tex = null;
  }

  dispose() {
    this.free();
    this.gl.deleteProgram(this.prog);
    this.gl.deleteVertexArray(this.vao);
  }
}
