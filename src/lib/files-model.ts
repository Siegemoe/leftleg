// Pure helpers for the Files panel: turn the flat tracked-file list from
// `repo_files` into a collapsible tree, and format byte sizes. Kept free of
// Svelte so it tests plain.

export interface RepoFileEntry {
  path: string;
  size: number;
}

export interface FileTreeNode {
  name: string;
  /** Repo-relative path (dirs keep no trailing slash). */
  path: string;
  dir: boolean;
  /** Files only. */
  size?: number;
  children: FileTreeNode[];
}

/** Build a sorted tree from repo-relative paths. Dirs sort before files,
 * both alphabetically; duplicate paths are tolerated (last wins). */
export function buildFileTree(paths: RepoFileEntry[]): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", dir: true, children: [] };
  const dirs = new Map<string, FileTreeNode>([["", root]]);
  const ensureDir = (dirPath: string): FileTreeNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : dirPath.slice(0, slash));
    const node: FileTreeNode = {
      name: slash === -1 ? dirPath : dirPath.slice(slash + 1),
      path: dirPath,
      dir: true,
      children: [],
    };
    parent.children.push(node);
    dirs.set(dirPath, node);
    return node;
  };
  for (const entry of paths) {
    const slash = entry.path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : entry.path.slice(0, slash));
    const node: FileTreeNode = {
      name: entry.path.slice(slash + 1),
      path: entry.path,
      dir: false,
      size: entry.size,
      children: [],
    };
    // Duplicate listing of the same path replaces the earlier entry.
    const existing = parent.children.findIndex((c) => !c.dir && c.path === entry.path);
    if (existing === -1) parent.children.push(node);
    else parent.children[existing] = node;
  }
  const sort = (node: FileTreeNode) => {
    node.children.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name),
    );
    for (const child of node.children) if (child.dir) sort(child);
  };
  sort(root);
  return root;
}

/** Flatten the tree depth-first (dirs first, sorted) — render order. */
export function flattenTree(root: FileTreeNode, expanded: ReadonlySet<string>): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  const walk = (node: FileTreeNode) => {
    for (const child of node.children) {
      out.push(child);
      if (child.dir && expanded.has(child.path)) walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every directory path present in the tree (for expand-all / collapse-all). */
export function allDirPaths(root: FileTreeNode): string[] {
  const out: string[] = [];
  const walk = (node: FileTreeNode) => {
    for (const child of node.children) {
      if (child.dir) {
        out.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** 0 → "0 B"; 1536 → "1.5 KB"; < 1 KB shows exact bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trim(n / 1024)} KB`;
  return `${trim(n / (1024 * 1024))} MB`;
}
const trim = (v: number): string => {
  const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};
