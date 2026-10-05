/**
 * A build's flat file list as the folders an explorer shows: folders before
 * files, each level by name. Pure, so the page renders what this returns.
 */

export interface FileLeaf {
  kind: "file";
  name: string;
  path: string;
  sizeBytes: number;
}
export interface FolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}
export type TreeNode = FileLeaf | FolderNode;

export function fileTree(
  files: readonly { path: string; sizeBytes: number }[],
): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  for (const file of files) {
    const names = file.path.split("/").filter((name) => name !== "");
    const fileName = names.pop();
    if (fileName === undefined) continue;
    let folder = root;
    for (const name of names) {
      const path = folder.path === "" ? name : `${folder.path}/${name}`;
      let next = folder.children.find(
        (child): child is FolderNode =>
          child.kind === "folder" && child.name === name,
      );
      if (next === undefined) {
        next = { kind: "folder", name, path, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({
      kind: "file",
      name: fileName,
      path: file.path,
      sizeBytes: file.sizeBytes,
    });
  }
  sort(root);
  return root.children;
}

function sort(folder: FolderNode) {
  folder.children.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "folder"
        ? -1
        : 1,
  );
  for (const child of folder.children) if (child.kind === "folder") sort(child);
}

/** The folders a file is in, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function foldersOf(path: string): string[] {
  const names = path.split("/").slice(0, -1);
  return names.map((_, index) => names.slice(0, index + 1).join("/"));
}

/** What opens first: the project's README, else its first file, else any. */
export function firstFile(paths: readonly string[]): string | undefined {
  return (
    paths.find((path) => path === "project/README.md") ??
    paths.find((path) => path.startsWith("project/")) ??
    paths[0]
  );
}

/** A size as people read it: `812 B`, `4.2 KB`, `1.3 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The file a link in the file at `from` opens, among `paths`: resolved from
 * that file's folder, or from the top when it starts with `/`. A folder
 * opens its README, else its first file. Undefined for a link out of the
 * sandbox, to elsewhere on the page, or to nothing in it.
 */
export function linkedFile(
  paths: readonly string[],
  from: string,
  target: string,
): string | undefined {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return undefined;
  let named: string;
  try {
    named = decodeURIComponent(target.split(/[?#]/)[0] ?? "");
  } catch {
    return undefined;
  }
  const names = named.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const name of named.split("/")) {
    if (name === "" || name === ".") continue;
    if (name !== "..") names.push(name);
    else if (names.pop() === undefined) return undefined;
  }
  const path = names.join("/");
  if (path === "") return undefined;
  if (paths.includes(path)) return path;
  const inside = paths.filter((other) => other.startsWith(`${path}/`)).sort();
  return inside.find((other) => other === `${path}/README.md`) ?? inside[0];
}
