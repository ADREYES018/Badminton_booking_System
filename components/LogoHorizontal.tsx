/**
 * Horizontal Smash Club lockup: the shuttlecock beside the name. Default mark
 * for headers and nav.
 *
 * The name is real text in the headline face rather than the exported SVG's
 * `<text>`, which positioned every letter individually against a font this app
 * does not ship — see `LogoMark`. This file keeps its own copy of the mark
 * because the horizontal export draws it at a different scale and stroke
 * weight than the vertical one.
 */

import { cx } from "./ui.tsx";

const SHUTTLECOCK =
  `<path d='M569.726,876c0,0 -23.803,175.5 133.889,175.5c157.691,0 133.889,-175.5 133.889,-175.5' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M570.237,799.5l-0.511,76.5l267.777,0l0,-76.5l-267.266,0Z' style='fill:none;stroke:currentColor;stroke-width:33px;'/><g><path d='M704.343,206.5l0,593' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M567.843,799.5l-208,-465.5l31,-77l81,33' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M704.343,206.5c0,0 -129.914,67.936 -108.5,224.5c21.414,156.564 105.615,197.931 108.5,206.5' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M628.843,277.5l-102.5,-51c0,0 -94.637,116.608 -38,234.5c56.637,117.892 112,176.5 112,176.5l42.5,-68' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M541.843,561l-31.5,91.5' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M593.459,637.5l49.384,162' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M567.843,799.5l136.5,0l-136.5,0Z' style='fill:none;stroke:currentColor;stroke-width:33px;'/></g><g><path d='M704.343,206.5l0,593' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M840.843,799.5l208,-465.5l-31,-77l-81,33' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M704.343,206.5c0,0 129.914,67.936 108.5,224.5c-21.414,156.564 -105.615,197.931 -108.5,206.5' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M779.843,277.5l102.5,-51c0,0 94.637,116.608 38,234.5c-56.637,117.892 -112,176.5 -112,176.5l-42.5,-68' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M866.843,561l31.5,91.5' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M815.227,637.5l-49.384,162' style='fill:none;stroke:currentColor;stroke-width:33px;'/><path d='M840.843,799.5l-136.5,0l136.5,0Z' style='fill:none;stroke:currentColor;stroke-width:33px;'/></g>`;

export function LogoHorizontal(props: { class?: string; title?: string }) {
  const title = props.title ?? "Smash Club";
  return (
    <div
      class={cx("inline-flex items-center gap-2.5", props.class)}
      role="img"
      aria-label={title}
    >
      <svg
        viewBox="340 190 730 880"
        class="h-full w-auto"
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        // deno-lint-ignore react-no-danger -- inlined build-time SVG from Logos/, no user input
        dangerouslySetInnerHTML={{ __html: SHUTTLECOCK }}
      />
      <span
        aria-hidden="true"
        class="font-headline font-extrabold uppercase leading-[1.05]
               text-[15px] tracking-[0.14em] indent-[0.14em]"
      >
        Smash<br />Club
      </span>
    </div>
  );
}
