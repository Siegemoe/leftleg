import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()], // lets component tests mount real .svelte components
  // Vitest transforms modules as SSR; force Svelte's client runtime so
  // `mount()` from "svelte" works in component tests.
  resolve: {
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom", // DOMPurify needs a DOM; store tests read svelte stores
    include: ["src/**/*.test.ts"],
    fsModuleCache: true, // cache transforms on disk — transforms were ~56% of suite time
  },
});
