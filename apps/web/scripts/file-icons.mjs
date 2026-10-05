#!/usr/bin/env node
/**
 * Writes the file and folder icons the sandbox explorer shows into
 * `src/assets/files/`, one file per icon, from Iconify's copy of
 * vscode-icons: the set Visual Studio Code users most often see beside a
 * file name.
 *
 *     node apps/web/scripts/file-icons.mjs
 *
 * Only the dark variant of each: the explorer is always drawn dark, as the
 * editor's default theme is. Files are named as vscode-icons names them, and
 * `src/features/sandbox/file-types.ts` picks one by a file's name. Run it
 * again after changing the list; it rewrites the folder.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const OUT = new URL("../src/assets/files/", import.meta.url);

/** Folders with an icon of their own; each has a closed and an open one. */
const FOLDERS = [
  "config",
  "dist",
  "docker",
  "docs",
  "github",
  "library",
  "node",
  "private",
  "public",
  "script",
  "src",
  "test",
];

const FILES = [
  "c",
  "cargo",
  "cpp",
  "csharp",
  "css",
  "cucumber",
  "dartlang",
  "docker",
  "dotenv",
  "editorconfig",
  "elixir",
  "eslint",
  "git",
  "go",
  "go-package",
  "html",
  "image",
  "ini",
  "java",
  "jest",
  "js",
  "json",
  "kotlin",
  "license",
  "log",
  "makefile",
  "markdown",
  "node",
  "npm",
  "pdf",
  "php",
  "pip",
  "pnpm",
  "prettier",
  "python",
  "reactjs",
  "reactts",
  "ruby",
  "rust",
  "scala",
  "scss",
  "shell",
  "sql",
  "svg",
  "swift",
  "testjs",
  "testts",
  "text",
  "toml",
  "tsconfig",
  "typescript",
  "vite",
  "vitest",
  "xml",
  "yaml",
  "yarn",
  "zip",
];

const NAMES = [
  "default-file",
  "default-folder",
  "default-folder-opened",
  ...FOLDERS.flatMap((name) => [
    `folder-type-${name}`,
    `folder-type-${name}-opened`,
  ]),
  ...FILES.map((name) => `file-type-${name}`),
];

const url = new URL("https://api.iconify.design/vscode-icons.json");
url.searchParams.set("icons", NAMES.join(","));
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: ${response.status}`);
const set = await response.json();

/** An icon as a standalone SVG, through an alias if it is one. */
function svgDocument(name) {
  const alias = set.aliases?.[name];
  const icon = set.icons?.[alias?.parent ?? name];
  if (icon === undefined) throw new Error(`no icon vscode-icons:${name}`);
  if (icon.rotate || icon.hFlip || icon.vFlip || alias?.rotate) {
    throw new Error(
      `vscode-icons:${name} is transformed, which is not handled`,
    );
  }
  const box = [
    icon.left ?? set.left ?? 0,
    icon.top ?? set.top ?? 0,
    icon.width ?? set.width ?? 16,
    icon.height ?? set.height ?? 16,
  ].join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${icon.body}</svg>\n`;
}

await mkdir(OUT, { recursive: true });
for (const name of await readdir(OUT)) {
  if (name.endsWith(".svg")) await rm(new URL(name, OUT));
}
for (const name of NAMES) {
  await writeFile(new URL(`${name}.svg`, OUT), svgDocument(name));
}
console.log(`${NAMES.length} icons`);
