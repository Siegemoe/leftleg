import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";

// The updater compares the EMBEDDED tauri.conf.json version against the
// release feed — that is the real build identity. Display it, not package
// json's copy, so the two can never drift apart again. Nightly flavor
// builds inject LEFTLEG_BUILD_VERSION (their full prerelease identity,
// e.g. 0.7.2-nightly.7) so what the UI displays matches what their
// updater feed carries; stable builds fall through to tauri.conf.json.
const tauriConf = JSON.parse(readFileSync("./src-tauri/tauri.conf.json", "utf8")) as {
  version: string;
};
const appVersion = process.env.LEFTLEG_BUILD_VERSION || tauriConf.version;

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    // build version surfaced in the status bar (StatusBar.svelte)
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // cargo's target dir changes constantly during builds — don't watch it
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    // Vite 8 (rolldown) no longer bundles esbuild; the default oxc minifier
    // replaces the old minify: "esbuild" setting.
    sourcemap: true,
  },
});
