import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), fresh()],
  ssr: {
    // ImageScript loads WASM at import time, which Vite's SSR module runner
    // cannot process. It is imported lazily and left for Deno to resolve.
    external: ["imagescript"],
  },
});
