/* The picture on the page: the game's 640 x 480 copy to the screen, shown flat on a 2D canvas, or through the CRT pass (render3d/crt.ts) on a
 * WebGL canvas when a TV is chosen. Both are the page's own display: the picture the renderer made (and the pictures the checks read) is the
 * same bytes either way.
 */
import { Crt, CRT_LOOKS, type CrtLook, type CrtPreset } from "../crt";

export class GxScreen {
  readonly flat: HTMLCanvasElement;
  readonly tube: HTMLCanvasElement;
  /** the WebGL renderer draws into this one (present(), no read-back) and it is what shows when no TV is chosen */
  readonly glFlat: HTMLCanvasElement;
  private glMode = false;
  private ctx: CanvasRenderingContext2D;
  private img = new ImageData(640, 480);
  private gl: WebGL2RenderingContext | null = null;
  private crt: Crt | null = null;
  private tex: WebGLTexture | null = null;
  private preset: CrtPreset = "off";
  private curve = 0;
  private last: Uint8Array | null = null;

  constructor(host: HTMLElement) {
    this.flat = document.createElement("canvas");
    this.flat.width = 640;
    this.flat.height = 480;
    this.flat.id = "screen";
    this.glFlat = document.createElement("canvas");
    this.glFlat.width = 640;
    this.glFlat.height = 480;
    this.glFlat.style.display = "none";
    this.tube = document.createElement("canvas");
    this.tube.width = 1280;
    this.tube.height = 960;
    this.tube.style.display = "none";
    for (const c of [this.flat, this.glFlat, this.tube]) Object.assign(c.style, { background: "#000" });
    host.append(this.flat, this.glFlat, this.tube);
    this.ctx = this.flat.getContext("2d")!;
  }

  /** the TV the picture is shown on (off: flat), and how much its tube curves (0 flat to crt.ts CURVE_MAX) */
  setCrt(preset: CrtPreset, curve = this.curve): void {
    this.preset = preset;
    this.curve = curve;
    const on = preset !== "off";
    this.layout();
    if (on && !this.gl) {
      this.gl = this.tube.getContext("webgl2", { preserveDrawingBuffer: true });
      if (!this.gl) { this.preset = "off"; this.layout(); return; }
      this.tex = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    }
    if (on && this.gl) {
      const look: CrtLook = { ...CRT_LOOKS[preset as Exclude<CrtPreset, "off">], curve };
      if (this.crt) this.crt.look = look;
      else this.crt = new Crt(this.gl, look);
    }
    if (this.tvFromGl) this.showGl();
    else if (this.last) this.show(this.last);
  }

  /** the curve the TV is drawn with now */
  get curveNow(): number { return this.curve; }

  /** the renderer is the WebGL one drawing into glFlat (true) or not */
  setGlMode(on: boolean): void { this.glMode = on; this.layout(); }

  /** a TV shown with the WebGL renderer: the TV takes the picture from that renderer's canvas on the graphics card (showGl), no read-back */
  get tvFromGl(): boolean { return this.glMode && this.preset !== "off" && !!this.crt; }

  /** whether the page needs the picture's pixels: only with the CPU renderer (with the WebGL one a TV takes the picture from its canvas, showGl) */
  get needsPixels(): boolean { return !this.glMode; }

  private layout(): void {
    const tube = this.preset !== "off";
    this.tube.style.display = tube ? "" : "none";
    this.glFlat.style.display = !tube && this.glMode ? "" : "none";
    this.flat.style.display = !tube && !this.glMode ? "" : "none";
  }

  /** the TV's picture from glFlat, as the WebGL renderer last presented it (call after its present()) */
  showGl(): void {
    if (!this.tvFromGl || !this.gl) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.glFlat);
    this.crt!.draw(this.tex!, this.tube.width, this.tube.height);
  }

  /** the TV's pass alone on the last picture at w x h, ms a frame (null: no TV shown) - for the checks */
  benchCrt(w: number, h: number, n?: number): number | null {
    return this.preset !== "off" && this.crt && this.tex ? this.crt.bench(this.tex, w, h, n) : null;
  }

  show(rgba: Uint8Array): void {
    this.last = rgba.slice(0, 640 * 480 * 4);
    if (this.preset === "off" || !this.gl || !this.crt) {
      this.img.data.set(this.last);
      this.ctx.putImageData(this.img, 0, 0);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 640, 480, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.last);
    this.crt.draw(this.tex!, this.tube.width, this.tube.height);
  }
}
