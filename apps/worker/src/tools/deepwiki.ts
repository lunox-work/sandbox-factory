/**
 * The deepwiki adapter: a wiki of the repository, written by a self-hosted
 * DeepWiki-Open service over HTTP.
 *
 * The service clones the repository's default branch itself, with the
 * repository-scoped read token the worker sends it, and reads it with its
 * own model; it does not read the worker's snapshot. The summary records
 * the commit the run was asked for so a reader can tell. The service must
 * be a trusted deployment: the token crosses to it. Nothing it returns is
 * logged, and the token appears in no log line or URL.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEEPWIKI_TOOL_VERSION, isDeepwikiParams } from "sandbox-factory";
import { WIKI_IMPORTANCE } from "@sandbox-factory/shared";
import type { DeepwikiSummaryDto } from "@sandbox-factory/shared";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";

/** Pages one run writes before the rest are left in `wiki-structure.json` only. */
export const WIKI_PAGES_MAX = 500;
const LANGUAGE = "en";

export interface DeepwikiOptions {
  readonly baseUrl: string | undefined;
  readonly authCode?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** The repository the run is on; null for a run with none. */
  readonly repository: {
    readonly fullName: string;
    readonly token: () => Promise<string>;
  } | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Importance = (typeof WIKI_IMPORTANCE)[number];
export interface WikiPage {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly filePaths: readonly string[];
  readonly importance: Importance;
  readonly relatedPages: readonly string[];
}
export interface WikiSection {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly string[];
}
/** What the worker keeps of `GET /api/wiki_cache`. */
export interface Wiki {
  readonly title: string;
  readonly description: string;
  readonly pages: readonly WikiPage[];
  readonly sections: readonly WikiSection[];
  readonly provider: string | null;
  readonly model: string | null;
  /** The raw `wiki_structure` and `repo`, kept whole in `wiki-structure.json`. */
  readonly structure: unknown;
  readonly repo: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const importance = (value: unknown): Importance =>
  WIKI_IMPORTANCE.find((level) => level === value) ?? "medium";

/** Reads the cache leniently: a page needs an id; everything else has a default. */
export function parseWiki(value: unknown): Wiki {
  if (!isRecord(value)) throw new AnalysisError("tool_failed");
  const structure = value["wiki_structure"];
  if (!isRecord(structure) || !Array.isArray(structure["pages"]))
    throw new AnalysisError("tool_failed");
  const generated = isRecord(value["generated_pages"])
    ? value["generated_pages"]
    : {};
  const pages: WikiPage[] = [];
  for (const raw of structure["pages"]) {
    if (!isRecord(raw) || typeof raw["id"] !== "string") continue;
    const written = generated[raw["id"]];
    pages.push({
      id: raw["id"],
      title: text(raw["title"], raw["id"]),
      content: text(
        isRecord(written) ? written["content"] : undefined,
        text(raw["content"]),
      ),
      filePaths: strings(raw["filePaths"]),
      importance: importance(raw["importance"]),
      relatedPages: strings(raw["relatedPages"]),
    });
  }
  const sections: WikiSection[] = [];
  if (Array.isArray(structure["sections"]))
    for (const raw of structure["sections"]) {
      if (!isRecord(raw) || typeof raw["id"] !== "string") continue;
      sections.push({
        id: raw["id"],
        title: text(raw["title"], raw["id"]),
        pages: strings(raw["pages"]),
      });
    }
  return {
    title: text(structure["title"]),
    description: text(structure["description"]),
    pages,
    sections,
    provider: typeof value["provider"] === "string" ? value["provider"] : null,
    model: typeof value["model"] === "string" ? value["model"] : null,
    structure,
    repo: value["repo"] ?? null,
  };
}

/** The longest page file name kept whole; a longer one is cut and hashed. */
const PAGE_NAME_MAX = 100;

/**
 * `wiki/<id>.md` paths: one safe, unique file name per page, in page order.
 * A long id is cut and given a short hash of the whole, so no name passes
 * the file system's limit and two long ids that share a start stay apart.
 */
export function pagePaths(pages: readonly WikiPage[]): Map<string, string> {
  const used = new Set<string>();
  const paths = new Map<string, string>();
  for (const page of pages) {
    const safe = page.id.replace(/[^A-Za-z0-9._-]/g, "-") || "page";
    const base =
      safe.length <= PAGE_NAME_MAX
        ? safe
        : `${safe.slice(0, PAGE_NAME_MAX)}-${createHash("sha256").update(page.id).digest("hex").slice(0, 12)}`;
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
    used.add(name);
    paths.set(page.id, `wiki/${name}.md`);
  }
  return paths;
}

/** The task states DeepWiki-Open passes through before it ends. */
const IN_PROGRESS = new Set([
  "pending",
  "indexing",
  "determining_structure",
  "generating",
]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createDeepwikiAdapter(options: DeepwikiOptions): ToolAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.pollIntervalMs ?? 5_000;
  return {
    name: "deepwiki",
    version: DEEPWIKI_TOOL_VERSION,
    async run(input) {
      if (options.baseUrl === undefined)
        throw new AnalysisError("builder_unavailable");
      if (!isDeepwikiParams(input.params))
        throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      const repository = options.repository;
      if (repository === null) throw new AnalysisError("source_unavailable");
      const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository.fullName);
      if (match === null) throw new AnalysisError("source_unavailable");
      const [, owner = "", repo = ""] = match;
      const base = options.baseUrl.replace(/\/+$/, "");
      const repositoryUrl = `https://github.com/${owner}/${repo}`;
      const signal = input.signal;
      // Every response is the service's; a failure is the fixed code only.
      const request = async (
        method: "GET" | "POST" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<Response> => {
        signal.throwIfAborted();
        try {
          return await fetchImpl(`${base}${path}`, {
            method,
            signal,
            // A redirect would send the body, the repository's token in
            // it, wherever the service or a proxy pointed.
            redirect: "error",
            headers: {
              Accept: "application/json",
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new AnalysisError("tool_failed");
        }
      };
      const json = async (response: Response): Promise<unknown> => {
        try {
          return (await response.json()) as unknown;
        } catch {
          throw new AnalysisError("tool_failed");
        }
      };
      const cacheQuery = new URLSearchParams({
        owner,
        repo,
        repo_type: "github",
        language: LANGUAGE,
      });
      input.log("DeepWiki wiki started.");
      // A fresh wiki every run: the service would otherwise hand back its cache.
      const deleteQuery = new URLSearchParams(cacheQuery);
      if (options.authCode !== undefined)
        deleteQuery.set("authorization_code", options.authCode);
      const cleared = await request("DELETE", `/api/wiki_cache?${deleteQuery}`);
      await cleared.body?.cancel();
      if (!cleared.ok && cleared.status !== 404)
        throw new AnalysisError("tool_failed");
      const token = await repository.token();
      const submitted = await request("POST", "/wiki/tasks", {
        repo_url: repositoryUrl,
        type: "github",
        token,
        owner,
        repo,
        language: LANGUAGE,
        comprehensive: true,
        ...(options.provider === undefined
          ? {}
          : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        excluded_dirs: [],
        excluded_files: [],
        included_dirs: [],
        included_files: [],
      });
      if (!submitted.ok) throw new AnalysisError("tool_failed");
      const task = await json(submitted);
      if (!isRecord(task) || typeof task["task_id"] !== "string")
        throw new AnalysisError("tool_failed");
      const taskPath = `/wiki/tasks/${encodeURIComponent(task["task_id"])}`;
      input.log("DeepWiki task submitted.");
      for (;;) {
        const polled = await request("GET", taskPath);
        if (polled.status === 404) {
          await polled.body?.cancel();
          break; // The task is gone; its wiki is in the cache or nowhere.
        }
        if (!polled.ok) throw new AnalysisError("tool_failed");
        const status = await json(polled);
        const state = isRecord(status) ? status["status"] : undefined;
        if (state === "completed") break;
        // Anything but a state the service passes through on its way is an
        // end: polled on, an unknown one would read as a timeout.
        if (typeof state !== "string" || !IN_PROGRESS.has(state))
          throw new AnalysisError("tool_failed");
        await sleep(interval, signal);
      }
      const read = await request("GET", `/api/wiki_cache?${cacheQuery}`);
      if (!read.ok) throw new AnalysisError("tool_failed");
      const cache = await json(read);
      if (cache === null) throw new AnalysisError("tool_failed");
      const wiki = parseWiki(cache);
      input.log("DeepWiki wiki read.");
      // One page per id: the service's own model writes the structure, and
      // two pages under one id would be written to one file.
      const seenIds = new Set<string>();
      const pages = wiki.pages
        .filter((page) => !seenIds.has(page.id) && seenIds.add(page.id))
        .slice(0, WIKI_PAGES_MAX);
      const paths = pagePaths(pages);
      const summary: DeepwikiSummaryDto = {
        schemaVersion: 1,
        toolVersion: DEEPWIKI_TOOL_VERSION,
        title: wiki.title,
        description: wiki.description,
        provider: wiki.provider,
        model: wiki.model,
        repositoryUrl,
        requestedCommitSha: snapshot.commitSha,
        pages: pages.map((page) => ({
          id: page.id,
          title: page.title,
          importance: page.importance,
          filePaths: [...page.filePaths],
          relatedPages: [...page.relatedPages],
          path: paths.get(page.id) ?? "",
        })),
        sections: wiki.sections.map((section) => ({
          id: section.id,
          title: section.title,
          pages: [...section.pages],
        })),
      };
      const meta = summary as unknown as Record<string, unknown>;
      await mkdir(join(input.outDir, "wiki"), { recursive: true });
      const files: ArtifactFile[] = [];
      const write = async (
        path: string,
        content: string,
        kind: ArtifactFile["kind"],
        contentType: string,
        fileMeta: Record<string, unknown> | null,
      ) => {
        const absolutePath = join(input.outDir, path);
        await writeFile(absolutePath, content, "utf8");
        files.push({ path, absolutePath, kind, contentType, meta: fileMeta });
      };
      for (const page of pages)
        await write(
          paths.get(page.id) ?? "",
          `# ${page.title}\n\n${page.content}\n`,
          "wiki_page",
          "text/markdown; charset=utf-8",
          null,
        );
      await write(
        "wiki-structure.json",
        JSON.stringify(
          {
            wiki_structure: wiki.structure,
            repo: wiki.repo,
            provider: wiki.provider,
            model: wiki.model,
          },
          null,
          2,
        ),
        "wiki_structure",
        "application/json",
        meta,
      );
      await write(
        "manifest.json",
        JSON.stringify(summary, null, 2),
        "manifest",
        "application/json",
        meta,
      );
      input.log("DeepWiki wiki completed.");
      return files;
    },
  };
}
