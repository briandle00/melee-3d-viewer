import type { JSX } from "solid-js";
import { FRAME_INNER_SIZE, FRAME_OUTER_STYLE } from "~/common/aspect";

/**
 * The game's picture at the game's own shape (73:60, common/aspect.ts), always.
 *
 * Whatever the box a page gives the player, the picture inside is the
 * largest 73:60 rectangle that fits, centered; the rest of the box is left to
 * the page behind it. Pages size their boxes 73:60, so there is usually
 * nothing left over - this only makes sure a box of another shape can never
 * widen the view or stretch it. The 3D view and the line art both sit in it.
 */
export function GameFrame(props: { children: JSX.Element; class?: string }) {
  return (
    <div class="relative min-h-0 w-full flex-1" style={FRAME_OUTER_STYLE} data-game-frame>
      <div class={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden ${props.class ?? ""}`}
           style={FRAME_INNER_SIZE}>
        {props.children}
      </div>
    </div>
  );
}
