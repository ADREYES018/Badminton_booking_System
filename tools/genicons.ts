/**
 * Generates the PWA icons from Logos/ICON.svg.
 * Run once; the PNGs are committed. ImageScript rasterizes the SVG, then the
 * mark is composited onto the brand's near-black background.
 */
import { Image } from "imagescript";

const BG = 0x1a1d11ff; // near-black surface, per the design system
const svgSource = await Deno.readTextFile("Logos/ICON.svg");

// The source strokes are #c6eb33; retint to the app's Electric Lime token.
const svg = svgSource.replaceAll("#c6eb33", "#c6f432");

async function render(size: number, padRatio: number, out: string) {
  const inner = Math.round(size * (1 - padRatio * 2));
  const mark = await Image.renderSVG(svg, inner, Image.SVG_MODE_WIDTH);

  const canvas = new Image(size, size);
  canvas.fill(BG);
  canvas.composite(
    mark,
    Math.round((size - mark.width) / 2),
    Math.round((size - mark.height) / 2),
  );

  await Deno.writeFile(out, await canvas.encode(6));
  console.log(`${out}  ${size}x${size}  ${(await Deno.stat(out)).size} bytes`);
}

await render(192, 0.10, "static/icons/icon-192.png");
await render(512, 0.10, "static/icons/icon-512.png");
// Maskable icons need ~20% safe padding so the OS can crop to a circle.
await render(512, 0.22, "static/icons/icon-maskable-512.png");
