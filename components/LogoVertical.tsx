/**
 * Vertical Smash Club lockup: the shuttlecock above the name. Used on the
 * login and verify screens.
 *
 * The name is real text in the headline face rather than the exported SVG's
 * `<text>`, which positioned every letter individually against a font this app
 * does not ship — see `LogoMark`.
 */

import { cx } from "./ui.tsx";
import { LogoMark } from "./LogoMark.tsx";

export function LogoVertical(props: { class?: string; title?: string }) {
  const title = props.title ?? "Smash Club";
  return (
    <div
      // The caller sets the width; the mark and the name divide it between
      // them, so `w-40` still means a 40-unit-wide lockup.
      class={cx("flex flex-col items-center gap-3", props.class)}
      role="img"
      aria-label={title}
    >
      <LogoMark class="w-[60%] h-auto" />
      <span
        aria-hidden="true"
        class="font-headline font-extrabold uppercase leading-none text-center
               text-[1.1rem] tracking-[0.16em] indent-[0.16em]"
      >
        Smash<br />Club
      </span>
    </div>
  );
}
