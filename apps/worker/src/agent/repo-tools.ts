/**
 * Read-only tools over a run's extracted source.
 *
 * The agent names paths; the tools answer only for paths in the index the
 * worker built from the extracted archive, so `..`, absolute paths and
 * anything the archive did not contain are refused before a byte is read.
 * Search is a literal, case-insensitive substring match: a model-supplied
 * regular expression would be a denial-of-service waiting to happen. Every
 * answer is capped, so one call cannot fill the context window.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileOf, isTraversed } from "sandbox-factory";
import type { SliceGraph } from "sandbox-factory";
import { z } from "zod";
import { inputText, type AgentTool, type AgentToolResult } from "./loop.js";

export const REPO_TOOL_LIMITS = {
  listPage: 400,
  readLines: 800,
  readChars: 60_000,
  searchText: 200,
  searchMatches: 80,
  searchFileBytes: 512 * 1024,
  searchTotalBytes: 32 * 1024 * 1024,
  snippetChars: 200,
  neighbours: 100,
} as const;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface RepositoryIndex {
  readonly root: string;
  /** Repository-relative path to size in bytes, `/`-separated, sorted. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly paths: readonly string[];
}

export async function indexRepository(
  root: string,
  signal: AbortSignal,
): Promise<RepositoryIndex> {
  const sizes = new Map<string, number>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    signal.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name))
          await walk(join(dir, entry.name), path);
      } else if (entry.isFile())
        sizes.set(path, (await stat(join(dir, entry.name))).size);
    }
  };
  await walk(root, "");
  const paths = [...sizes.keys()].sort(compare);
  return {
    root,
    sizes: new Map(paths.map((p) => [p, sizes.get(p) ?? 0])),
    paths,
  };
}

const error = (content: string): AgentToolResult => ({
  content,
  isError: true,
});
const isText = (bytes: Buffer) => !bytes.subarray(0, 8_192).includes(0);

/** A short picture of the repository for the first prompt. */
export function repositoryOverview(index: RepositoryIndex): string {
  const directories = new Map<string, number>();
  const extensions = new Map<string, number>();
  const manifests: string[] = [];
  for (const path of index.paths) {
    const slash = path.indexOf("/");
    const top = slash === -1 ? "(root)" : path.slice(0, slash);
    directories.set(top, (directories.get(top) ?? 0) + 1);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const extension = dot <= 0 ? "(none)" : name.slice(dot);
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    if (name === "package.json" || name === "tsconfig.json")
      manifests.push(path);
  }
  const ranked = (counts: Map<string, number>, limit: number) =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
      .slice(0, limit)
      .map(([name, count]) => `${name} (${count})`)
      .join(", ");
  return [
    `${index.paths.length} files.`,
    `Top-level: ${ranked(directories, 40)}.`,
    `Extensions: ${ranked(extensions, 15)}.`,
    `Manifests: ${manifests.slice(0, 40).join(", ") || "(none)"}.`,
  ].join("\n");
}

const listInput = z.strictObject({
  prefix: z.string().max(1_000).nullable(),
  cursor: z.string().max(1_000).nullable(),
});
const readInput = z.strictObject({
  path: z.string().min(1).max(1_000),
  startLine: z.number().int().min(1).nullable(),
  endLine: z.number().int().min(1).nullable(),
});
const searchInput = z.strictObject({
  text: z.string().min(2).max(REPO_TOOL_LIMITS.searchText),
  prefix: z.string().max(1_000).nullable(),
});
const pathInput = z.strictObject({ path: z.string().min(1).max(1_000) });

/** Zod issues as one line the model can act on. */
export function invalidInput(issues: z.core.$ZodIssue[]): AgentToolResult {
  return error(
    `Invalid input: ${issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}`,
  );
}

const nullableString = { type: ["string", "null"] };
export function repositoryTools(index: RepositoryIndex): AgentTool[] {
  const inPrefix = (path: string, prefix: string | null) =>
    prefix === null || prefix === "" || path.startsWith(prefix);
  const readText = async (path: string): Promise<string | null> => {
    const bytes = await readFile(join(index.root, path));
    return isText(bytes) ? bytes.toString("utf8") : null;
  };
  return [
    {
      name: "list_files",
      description: `List repository files under a path prefix (such as "src/api/"), ${REPO_TOOL_LIMITS.listPage} at a time, with sizes in bytes. Pass the cursor from the previous page to continue.`,
      inputSchema: {
        properties: { prefix: nullableString, cursor: nullableString },
        required: ["prefix", "cursor"],
        additionalProperties: false,
      },
      describe: (input, result) => {
        if (result.isError === true) return null;
        const prefix = inputText(input, "prefix");
        return prefix === null
          ? "Listed the repository's files"
          : `Listed ${prefix}`;
      },
      async run(raw) {
        const parsed = listInput.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const { prefix, cursor } = parsed.data;
        const matching = index.paths.filter(
          (path) =>
            inPrefix(path, prefix) && (cursor === null || path > cursor),
        );
        const page = matching.slice(0, REPO_TOOL_LIMITS.listPage);
        if (page.length === 0) return { content: "No files." };
        const last = page[page.length - 1] ?? "";
        return {
          content: `${page
            .map((path) => `${path} ${index.sizes.get(path) ?? 0}`)
            .join("\n")}\n${
            matching.length > page.length
              ? `More files follow; cursor: ${last}`
              : "End of list."
          }`,
        };
      },
    },
    {
      name: "read_file",
      description: `Read a repository text file with line numbers, up to ${REPO_TOOL_LIMITS.readLines} lines per call. Give startLine and endLine to read a range of a longer file.`,
      inputSchema: {
        properties: {
          path: { type: "string" },
          startLine: { type: ["integer", "null"] },
          endLine: { type: ["integer", "null"] },
        },
        required: ["path", "startLine", "endLine"],
        additionalProperties: false,
      },
      describe: (input, result) => {
        if (result.isError === true) return null;
        const path = inputText(input, "path");
        return path === null ? null : `Read ${path}`;
      },
      async run(raw) {
        const parsed = readInput.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const { path } = parsed.data;
        if (!index.sizes.has(path))
          return error(`${path} is not a file in this repository.`);
        const text = await readText(path);
        if (text === null) return error(`${path} is not a text file.`);
        const lines = text.split("\n");
        const start = Math.min(parsed.data.startLine ?? 1, lines.length);
        const end = Math.min(
          parsed.data.endLine ?? start + REPO_TOOL_LIMITS.readLines - 1,
          start + REPO_TOOL_LIMITS.readLines - 1,
          lines.length,
        );
        if (end < start) return error("endLine is before startLine.");
        let body = "";
        let shown = start - 1;
        for (let line = start; line <= end; line += 1) {
          const next = `${line}\t${lines[line - 1] ?? ""}\n`;
          if (body.length + next.length > REPO_TOOL_LIMITS.readChars) break;
          body += next;
          shown = line;
        }
        return {
          content: `${path} lines ${start}-${shown} of ${lines.length}\n${body}`,
        };
      },
    },
    {
      name: "search",
      description: `Find lines containing a literal text, case-insensitively, in repository text files under an optional path prefix. Returns up to ${REPO_TOOL_LIMITS.searchMatches} matches as path:line: text.`,
      inputSchema: {
        properties: { text: { type: "string" }, prefix: nullableString },
        required: ["text", "prefix"],
        additionalProperties: false,
      },
      describe: (input, result) => {
        if (result.isError === true) return null;
        const text = inputText(input, "text");
        return text === null ? null : `Searched for “${text}”`;
      },
      async run(raw, signal) {
        const parsed = searchInput.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const needle = parsed.data.text.toLowerCase();
        const matches: string[] = [];
        let scanned = 0;
        let truncated = false;
        for (const path of index.paths) {
          if (!inPrefix(path, parsed.data.prefix)) continue;
          const size = index.sizes.get(path) ?? 0;
          if (size > REPO_TOOL_LIMITS.searchFileBytes) continue;
          if (scanned + size > REPO_TOOL_LIMITS.searchTotalBytes) {
            truncated = true;
            break;
          }
          signal.throwIfAborted();
          scanned += size;
          const text = await readText(path);
          if (text === null || !text.toLowerCase().includes(needle)) continue;
          const lines = text.split("\n");
          for (const [number, line] of lines.entries()) {
            if (!line.toLowerCase().includes(needle)) continue;
            matches.push(
              `${path}:${number + 1}: ${line.trim().slice(0, REPO_TOOL_LIMITS.snippetChars)}`,
            );
            if (matches.length >= REPO_TOOL_LIMITS.searchMatches) break;
          }
          if (matches.length >= REPO_TOOL_LIMITS.searchMatches) {
            truncated = true;
            break;
          }
        }
        if (matches.length === 0)
          return {
            content: truncated
              ? "No matches in the files searched."
              : "No matches.",
          };
        return {
          content: `${matches.join("\n")}${truncated ? "\n(More matches may exist; narrow the prefix.)" : ""}`,
        };
      },
    },
  ];
}

/** Imports and importers of one file, from the graphify graph. */
export function graphNeighboursTool(graph: SliceGraph): AgentTool {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    name: "graph_neighbours",
    description:
      "List the files and packages a repository file depends on, and the files that depend on it, from the structure analysis.",
    inputSchema: {
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    describe: (input, result) => {
      if (result.isError === true) return null;
      const path = inputText(input, "path");
      return path === null ? null : `Followed the imports of ${path}`;
    },
    async run(raw) {
      const parsed = pathInput.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      const { path } = parsed.data;
      const uses = new Set<string>();
      const usedBy = new Set<string>();
      let known = false;
      for (const node of graph.nodes) if (fileOf(node) === path) known = true;
      if (!known)
        return error(`${path} is not a file in the structure analysis.`);
      for (const link of graph.links) {
        if (!isTraversed(link.relation)) continue;
        const source = nodes.get(link.source);
        const target = nodes.get(link.target);
        if (source === undefined || target === undefined) continue;
        const from = fileOf(source);
        const to = fileOf(target) ?? `package ${target.label}`;
        if (from === path && to !== path) uses.add(to);
        if (to === path && from !== null && from !== path) usedBy.add(from);
      }
      const list = (items: Set<string>) =>
        items.size === 0
          ? "(none)"
          : [...items]
              .sort(compare)
              .slice(0, REPO_TOOL_LIMITS.neighbours)
              .join("\n") +
            (items.size > REPO_TOOL_LIMITS.neighbours
              ? `\n(${items.size - REPO_TOOL_LIMITS.neighbours} more)`
              : "");
      return {
        content: `${path} uses:\n${list(uses)}\n\n${path} is used by:\n${list(usedBy)}`,
      };
    },
  };
}
