/** The game's picture is 73:60 (its camera's shape, the TV's 4:3 with the
 *  console's pixels): 1.2167 across for 1 down. */
export const GAME_ASPECT = 73 / 60;

/** GameFrame's two boxes (components/viewer/GameFrame.tsx): the outer one
 *  fills what the page gives and is the container the inner one is measured
 *  against (cqw, cqh); the inner one is the largest 73:60 rectangle that fits
 *  it, centered (tests/aspect.test.ts checks them in a browser) */
export const FRAME_OUTER_STYLE = "container-type: size";
export const FRAME_INNER_SIZE = {
  width: "min(100cqw, calc(100cqh * 73 / 60))",
  height: "min(100cqh, calc(100cqw * 60 / 73))",
} as const;
