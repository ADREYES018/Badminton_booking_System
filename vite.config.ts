import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Fresh first, then Tailwind: Fresh sets up the client entry that the
  // stylesheet is imported from, and Tailwind compiles what it finds there.
  plugins: [fresh(), tailwindcss()],
  ssr: {
    // ImageScript loads WASM at import time, which Vite's SSR module runner
    // cannot process. It is imported lazily and left for Deno to resolve.
    external: ["imagescript"],
  },
});
