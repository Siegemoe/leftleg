import { describe, expect, it } from "vitest";
import { allDirPaths, buildFileTree, flattenTree, formatBytes } from "./files-model";

describe("buildFileTree", () => {
  it("nests by directory, dirs before files, sorted", () => {
    const tree = buildFileTree([
      { path: "src-tauri/src/lib.rs", size: 10 },
      { path: "package.json", size: 20 },
      { path: "src/api.ts", size: 30 },
      { path: "src/lib/api.ts", size: 40 },
      { path: "src/assets/logo.png", size: 50 },
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(["src", "src-tauri", "package.json"]);
    const src = tree.children[0];
    expect(src.dir).toBe(true);
    expect(src.children.map((c) => c.name)).toEqual(["assets", "lib", "api.ts"]);
    const lib = src.children[1];
    expect(lib.children.map((c) => c.path)).toEqual(["src/lib/api.ts"]);
    expect(lib.children[0].size).toBe(40);
  });

  it("keeps deep single-file chains and tolerates duplicates", () => {
    const tree = buildFileTree([
      { path: "a/b/c/d.txt", size: 1 },
      { path: "a/b/c/d.txt", size: 2 },
    ]);
    const a = tree.children[0];
    const b = a.children[0];
    const c = b.children[0];
    expect(c.children[0]).toMatchObject({ name: "d.txt", size: 2, path: "a/b/c/d.txt" });
    expect(allDirPaths(tree)).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("handles an empty repo", () => {
    expect(buildFileTree([]).children).toEqual([]);
  });
});

describe("flattenTree", () => {
  const paths = [
    { path: "root.txt", size: 1 },
    { path: "src/a.ts", size: 2 },
    { path: "src/deep/b.ts", size: 3 },
  ];
  const tree = buildFileTree(paths);

  it("shows only top-level entries when nothing is expanded", () => {
    expect(flattenTree(tree, new Set()).map((n) => n.path)).toEqual(["src", "root.txt"]);
  });

  it("descends into expanded dirs only", () => {
    const one = flattenTree(tree, new Set(["src"]));
    expect(one.map((n) => n.path)).toEqual(["src", "src/deep", "src/a.ts", "root.txt"]);
    const both = flattenTree(tree, new Set(["src", "src/deep"]));
    expect(both.map((n) => n.path)).toEqual(["src", "src/deep", "src/deep/b.ts", "src/a.ts", "root.txt"]);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2048 * 1024)).toBe("2 MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });
});
