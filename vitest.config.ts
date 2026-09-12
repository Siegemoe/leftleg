import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom", // DOMPurify needs a DOM; store tests read svelte stores
    include: ["src/**/*.test.ts"],
  },
});
