/**
 * The shuttlecock on its own, without a wordmark.
 *
 * Taken from Logos/BLACK_LOGO_VERTICAL.svg with the exported `<text>` dropped:
 * that text carried per-letter x-positions measured against Delight, a font
 * this app does not ship, so every browser substituted something else and laid
 * the letters out on coordinates that no longer matched their widths. The
 * lockups set their own wordmark in Sora instead.
 *
 * Strokes are `currentColor`, so the mark follows the surrounding text colour:
 * near-black on light surfaces, Electric Lime on dark.
 */

const SHUTTLECOCK =
  `<path d='M1225.36,1193.404c0,0 -35.077,258.626 197.305,258.626c232.382,0 197.305,-258.626 197.305,-258.626' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1226.113,1080.67l-0.753,112.734l394.61,0l0,-112.734l-393.857,0Z' style='fill:none;stroke:currentColor;stroke-width:50px;'/><g><path d='M1423.738,206.796l0,873.874' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1222.585,1080.67l-306.519,-685.984l45.683,-113.471l119.366,48.63' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1423.738,206.796c0,0 -191.448,100.114 -159.891,330.834c31.557,230.72 155.64,291.681 159.891,304.309' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1312.478,311.425l-151.049,-75.156c0,0 -139.461,171.839 -55.999,345.571c83.463,173.732 165.049,260.099 165.049,260.099l62.63,-100.208' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1184.27,729.205l-46.42,134.839' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1260.334,841.939l72.774,238.731' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1222.585,1080.67l201.153,0l-201.153,0Z' style='fill:none;stroke:currentColor;stroke-width:50px;'/></g><g><path d='M1423.738,206.796l0,873.874' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1624.891,1080.67l306.519,-685.984l-45.683,-113.471l-119.366,48.63' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1423.738,206.796c0,0 191.448,100.114 159.891,330.834c-31.557,230.72 -155.64,291.681 -159.891,304.309' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1534.999,311.425l151.049,-75.156c0,0 139.461,171.839 55.999,345.571c-83.463,173.732 -165.049,260.099 -165.049,260.099l-62.63,-100.208' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1663.206,729.205l46.42,134.839' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1587.142,841.939l-72.774,238.731' style='fill:none;stroke:currentColor;stroke-width:50px;'/><path d='M1624.891,1080.67l-201.153,0l201.153,0Z' style='fill:none;stroke:currentColor;stroke-width:50px;'/></g>`;

/**
 * The shuttlecock alone. Decorative by default: the lockups around it carry
 * the name as real text, so announcing it here would repeat them.
 */
export function LogoMark(props: { class?: string; title?: string }) {
  return (
    <svg
      class={props.class}
      // Cropped to the mark itself, so it no longer reserves the vertical
      // space the dropped wordmark used to occupy.
      viewBox="880 180 1090 1290"
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : "true"}
      xmlns="http://www.w3.org/2000/svg"
      // deno-lint-ignore react-no-danger -- inlined build-time SVG from Logos/, no user input
      dangerouslySetInnerHTML={{ __html: SHUTTLECOCK }}
    />
  );
}
