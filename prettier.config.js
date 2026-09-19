/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-svelte"],
  trailingComma: "all",
  printWidth: 100,
  // Match each file's existing line endings: the committed content is LF, but
  // Windows checkouts materialize CRLF (core.autocrlf), and the default "lf"
  // would fail --check on every file after a fresh checkout.
  endOfLine: "auto",
  overrides: [
    {
      files: "*.svelte",
      options: {
        parser: "svelte",
      },
    },
  ],
};
