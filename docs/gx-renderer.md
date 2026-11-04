# The GX renderer

`src/render3d/gxr/` draws a game's GX command stream the way the console's graphics chip does: the same triangles, the same 32-bit float steps, the same
integer pixel arithmetic, so that every pixel equals the reference picture. It is a replay renderer: the stream (the vertex and register writes of a frame,
plus the main-memory writes the game made) goes in, a 640 x 480 picture comes out. It does not change the existing 3D player, which stays the default; nothing
in the app imports this folder until a page asks for it (`embed.html?renderer=gx` in the integration branch).

## How it is built

The pipeline follows the raster spec section by section.

| step | files | what |
|---|---|---|
| stream | `dff.ts`, `gpu.ts`, `state.ts`, `vertex.ts`, `encode.ts` | reads commands, keeps BP, XF and CP registers, decodes vertex arrays to floats, hands each draw to a backend |
| front half | `xform.ts`, `setup.ts`, `front.ts`, `frontpool.ts`, `frontworker.ts` | vertex transform and lighting, texture coordinate generation, culling, clipping, viewport, triangle setup (snapped integer edges, float planes). Every float operation is rounded to binary32 in the spec's order. `front.ts` is the one copy of this code; `frontpool.ts` runs it on worker threads |
| pixel stage | `raster.ts`, `texunit.ts`, `tev.ts` | the CPU reference: coverage by 2 x 2 blocks, planes, texture unit reading raw GX texture memory, indirect stages, TEV, alpha test, fog, depth test, blend |
| copies | `copy.ts` | EFB copies to texture memory in every color and depth format, and the clear after a copy |
| GPU | `gl.ts`, `glsl-pixel.ts`, `glsl-float.ts`, `glsl-copy.ts`, `glutil.ts` | the same pixel stage as a WebGL 2 fragment shader. A queue of triangles is binned into 16 x 16 tiles and drawn in one full-screen pass; every pixel walks its tile's triangles in draw order, so blending and depth order are the hardware's. Floats are `uint` bit patterns: division and the rest are whole-number arithmetic (`glsl-float.ts`); addition and multiplication use the card's own arithmetic once it has passed the start-up check (below), whole numbers otherwise |
| CPU backend | `cpu.ts` | the reference as a backend (slow, used by the tests and as the oracle) |

Backends implement `GxBackend` (`gpu.ts`): `draw`, `copy`, `copyClear`, plus `drawing` (draws skipped), `fastForward` (draws, copies and clears skipped, for
seeking), `reset`, `present`. `GxGl` takes `{ workers, factory }` to run the front half on worker threads; that needs a cross-origin isolated page
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), otherwise it runs the same code on the main thread and gives the same pixels.

### Shader variants and compile time

The pixel shader is large and compiles slowly on some drivers (the browser caches the result, so only the first run on a machine pays: about a minute for the base
program on a discrete GPU with a cold cache). `await gx.prepare(features)` waits for the base program; `scanFeatures(dff, mem, frames)` finds which optional variants a
stream needs (1: the indirect texture unit, 2: exponential fog and fog range adjustment); `gx.warm()` compiles the others in the background, one at a time. A draw that
needs a variant that is not ready waits for it (`gx.compileWaits` counts these; it stays zero when `prepare` was given the stream's features).

### The card's float arithmetic

The spec rounds every float operation to binary32, unfused, with numbers below the smallest normal number treated as zero. `glsl-float.ts` has
whole-number versions of every operation (`f_add`, `f_mul`, `f_div`, ...), and for addition and multiplication also versions on the card's own
float arithmetic (`floatGlsl("fast")`), made to give the same bits on any card: each result passes through an exclusive-or with a uniform the
program never sets (no compiler can fuse a product into a sum across it), operands below the smallest normal number are flushed first, a
sum or product that small gets the spec's result by its own rule (a product rounded to 24 bits before the flush is found from the same product
scaled by 2^24), and every not-a-number is the one pattern. With them the base program compiles in about two thirds of the time.

`floatcheck.ts` decides, when the renderer starts (`prepare()`, and before any first draw): the card's addition and multiplication, in a small
program, on 64 Ki operand pairs (the pairings where cards and the spec can part, and random numbers) must equal the spec's bit for bit, and a
small scene drawn by the base program must equal the CPU reference in every pixel. Any difference, or a check that cannot run, and the
programs are made with the whole-number versions (`gx.floatOps` says which; `gx.floatCheck` what was found). A draw before the check uses the
whole-number versions. `new GxGl(gl, { floatOps })` forces `"soft"` or `"fast"`; `"dual"` (a check) computes both and marks a pixel where any
addition or multiplication differed (bit 31 of its depth word). `tools/gxr/web/fastfloat.ts` and the harness's `floatops=dual` run them.

### Frame time

- Show the picture with `gx.present(canvas)`; `onPicture` reads the frame buffer back (`readPixels` waits for the GPU and moves 1.2 MB: about 7 ms a frame).
- Let the event loop run between frames (a page draws one frame per animation frame): the worker threads start and deliver only then.
- Before play: `await gx.prepare(scanFeatures(...))`, `gx.prepareMemory(mem, regs)`, then draw two to five frames before showing anything (the first drawn frames include the JavaScript
  engine warming up, 20 to 70 ms; after that a replay with HUD and particles takes a median of 7 ms, p99 under 15 ms on a discrete GPU, 38 ms of GPU time on an integrated one).
- `tools/gxr/web/replayperf.ts` measures a stream's frames (`timing=1` per-pass GPU times, `ablate=` shader parts, `flags=force_low_power_gpu` for an integrated GPU).

## How it is checked

Everything is compared against the spec's own numbers, never against another implementation of this code's guesses.

- **Recorded windows.** 22 windows of real matches (four stages) with the reference pictures from the real renderer: frames 1 to 4 of each must be bit-exact in R, G and B. Both
  backends are at 110 of 110. (`tools/gxr/web/harness.ts`, `tools/gxr/cpu_harness.ts`; the recordings are not in this repository.)
- **Spec vectors.** `tests/gxr-spec-vectors.test.ts` runs the spec's vector files through the CPU reference (set `GX_SPEC_VECTORS` to their folder); `tools/gxr/web/vectors.ts` runs the
  same files through the shader.
- **Shader against reference.** `tools/gxr/web/fuzz.ts` draws random scenes (every texel format, filter, wrap, TEV scale, bias and compare mode, blend factor, logic op, depth function,
  fog form, indirect stage, lines) with both and compares color and depth of every pixel; `fuzzcopy.ts` does the same for EFB copies; `fuzzexp.ts` checks the shader's correctly
  rounded power (fog) against 220-bit integers; `fuzzfn.ts`, `fuzzcoord.ts`, `fuzzind.ts`, `fuzztev.ts` and `softfloat.ts` check the float arithmetic and single functions bit for bit.
- **Stream flows.** `lockstep.ts` plays a stream through both backends together and reports the first pass whose frame buffer differs; `resettest.ts` checks that `reset()` leaves no state behind.
- **Speed.** `dffperf.ts` (frames per second of a stream) and `replayperf.ts` (every frame's time over a whole stream: median, 99th percentile, worst frames).

Run the tests of this folder with the rest: `deno test --no-check --sloppy-imports tests/` (`tests/gxr-cpu.test.ts` needs nothing; it checks the rules on small scenes, the depth copy table,
the exponential fog's power and that worker threads give the words one thread gives). The GPU comparisons need a browser with a GPU:
`GX_GPU_TESTS=1 deno test -A --no-check --sloppy-imports tests/gxr-gpu.test.ts`. The pages run with
`deno run -A tools/gxr/webrun.ts tools/gxr/web/<page>.ts <out dir> key=value ...` (it bundles the page, serves it with the isolation headers and drives a headless Chrome;
`CHROME` names the browser, `GX_SPEC_HARNESS` and `GX_SPEC_VECTORS` the spec folders).

## Rules for changes

A change implements a rule of the spec in general. No special case for a character, object, stage or window, and no constant tuned to a picture. Pixels never change without a
spec change: every change to the GPU path keeps the recorded windows at 110 of 110 and the random-scene comparison equal.
