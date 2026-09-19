import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "src-tauri/gen/**",
      "src-tauri/target/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: ["**/*.ts", "**/*.svelte"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        __APP_VERSION__: "readonly",
      },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Start typed linting at the non-test TypeScript boundary. Svelte and test
    // callbacks have legitimate framework-specific promise patterns; expand
    // this scope only after the initial baseline is clean.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/lib/test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: [".svelte"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Leftleg renders only DOMPurify-sanitized HTML. A blanket ban would
      // reject the intentionally guarded rendering boundary.
      "svelte/no-at-html-tags": "off",
      // Introduce these structural migrations as visible warnings first.
      "svelte/prefer-svelte-reactivity": "warn",
      "svelte/require-each-key": "warn",
    },
  },
  {
    files: ["**/*.js"],
    ...ts.configs.disableTypeChecked,
  },
  {
    // The installable Pi companion intentionally lives outside the GUI
    // tsconfig and resolves Pi's types from the user's global installation.
    files: ["companion/**/*.ts"],
    ...ts.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: false,
        projectService: false,
      },
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["src/lib/thinking.ts"],
    rules: {
      // This module intentionally recognizes terminal control sequences.
      "no-control-regex": "off",
    },
  },
);
