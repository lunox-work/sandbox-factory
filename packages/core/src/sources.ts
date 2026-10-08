/**
 * The context a bounty's sources add to it: what its Jira issue says beyond
 * its title and description, and what its repository's own documents say.
 *
 * A source is synced into the bounty when a person asks for it, and each
 * sync that finds something new is a version of that source's context,
 * kept with the source revision it was read at (Jira's `updated`, the
 * repository's commit). The overview holds the latest of each; sizing (the
 * bounty step) and generation (the sandbox step) each record the versions
 * they were made with. A step made with an earlier version than the
 * overview holds is behind on that source, as a step built on an earlier
 * overview is behind on it (`stageDrift`), and a source that has moved past
 * its last sync is ahead of the overview.
 *
 * Context is enrichment, like the sources themselves: a bounty with none is
 * sized and generated from its text alone.
 */

import { inSkippedDirectory } from "./repo/stack.js";
import type { StageDrift } from "./stages.js";

export const CONTEXT_SOURCES = ["jira", "github"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** A linked Jira issue, as a sync reads it. */
export interface JiraIssueLinkContext {
  /** Jira's name for the link, such as "Blocks". */
  readonly type: string;
  /** Which side the synced issue is on. */
  readonly direction: "inward" | "outward";
  readonly key: string | null;
  /** Whether the issue at the other end is done. */
  readonly done: boolean;
}

/**
 * What a Jira issue says about its bounty beyond its title and description:
 * how it is classified, how urgent it is, how large its team judged it and
 * what it depends on. No person is named here, and no comment is read: the
 * fields are counts, dates and names Jira's own screens put on the issue.
 */
export interface JiraContext {
  readonly key: string;
  readonly issueType: string | null;
  readonly status: string | null;
  readonly statusCategory: string | null;
  readonly priority: string | null;
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly fixVersions: readonly string[];
  readonly parentKey: string | null;
  readonly dueDate: string | null;
  /** The site's story points field, when it has one and it is set. */
  readonly storyPoints: number | null;
  readonly originalEstimateSeconds: number | null;
  readonly remainingEstimateSeconds: number | null;
  readonly votes: number | null;
  readonly watchers: number | null;
  readonly subtaskCount: number;
  readonly links: readonly JiraIssueLinkContext[];
  /** Jira's own `updated`: the revision this context was read at. */
  readonly updated: string | null;
}

/** One of a repository's documents, as a sync kept it. */
export interface GithubContextDocument {
  readonly path: string;
  /** The file's size in the repository. */
  readonly bytes: number;
  /** Its text, cut to `CONTEXT_DOCUMENT_CHARS`. */
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * What a repository's own documents say: its README, its docs and the
 * guides it keeps for contributors, read at one commit. Never its code.
 */
export interface GithubContext {
  readonly fullName: string;
  /** The branch the commit was read from. */
  readonly branch: string;
  readonly commitSha: string;
  readonly documents: readonly GithubContextDocument[];
  /** Documents found but left out for the caps. */
  readonly omitted: number;
}

/** The context version each source stands at; null for none. */
export interface ContextVersions {
  readonly jira: number | null;
  readonly github: number | null;
}

export const NO_CONTEXT: ContextVersions = { jira: null, github: null };

/** The most documents one sync keeps. */
export const CONTEXT_DOCUMENTS_MAX = 12;
/** A document larger than this is not read: it is generated, or a dump. */
export const CONTEXT_DOCUMENT_BYTES_MAX = 256 * 1024;
/** The most characters one document keeps. */
export const CONTEXT_DOCUMENT_CHARS = 12_000;
/** The most characters every document together keeps. */
export const CONTEXT_TOTAL_CHARS = 48_000;

const MARKDOWN = /\.(md|mdx|markdown)$/i;

/**
 * Files that are documents but say nothing of what the code does: its
 * history, its licence and its conduct and security policies.
 */
const BOILERPLATE = new Set([
  "changelog",
  "changes",
  "history",
  "license",
  "licence",
  "copying",
  "code_of_conduct",
  "security",
  "notice",
  "authors",
  "contributors",
  "codeowners",
]);

/** Guides kept for whoever works on the repository, by name. */
const GUIDES = new Set([
  "contributing",
  "architecture",
  "design",
  "development",
  "agents",
  "claude",
  "conventions",
  "overview",
]);

/** Directories that hold a repository's documentation. */
const DOC_DIRECTORIES = new Set([
  "docs",
  "doc",
  "documentation",
  "adr",
  "adrs",
]);

function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(MARKDOWN, "").toLowerCase();
}

/**
 * How early a document is read, lower first: the root README, then the
 * root's guides, then the docs directories, then a module's README, then
 * any other.
 */
function tier(path: string): number {
  const segments = path.split("/");
  const name = stem(path);
  const atRoot = segments.length === 1;
  if (atRoot && name === "readme") return 0;
  if (atRoot && GUIDES.has(name)) return 1;
  if (
    segments
      .slice(0, -1)
      .some((part) => DOC_DIRECTORIES.has(part.toLowerCase()))
  )
    return 2;
  if (name === "readme") return 3;
  return 4;
}

/** The words of a bounty's title that a path might name, lowercased. */
export function contextKeywords(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4),
    ),
  ];
}

/**
 * The documents worth reading in a file list, in the order they are read:
 * by tier, a document whose path names a word of the bounty's title ahead
 * of the tier above its own, then shallowest first. Vendored code, fixtures, examples,
 * `.github` and boilerplate are passed over, and so is a file too large to
 * be a document. At most `CONTEXT_DOCUMENTS_MAX`; `omitted` counts the rest.
 */
export function contextDocuments(
  files: readonly { readonly path: string; readonly size: number }[],
  keywords: readonly string[] = [],
): { readonly paths: string[]; readonly omitted: number } {
  const candidates = files.filter(
    ({ path, size }) =>
      MARKDOWN.test(path) &&
      size > 0 &&
      size <= CONTEXT_DOCUMENT_BYTES_MAX &&
      !inSkippedDirectory(path) &&
      !path.split("/").some((part) => part === ".github") &&
      !BOILERPLATE.has(stem(path)),
  );
  // Two places per tier; a match is placed ahead of the tier above it,
  // though never ahead of the root README.
  const rank = (path: string) => {
    const base = tier(path) * 2;
    const lower = path.toLowerCase();
    return base > 0 && keywords.some((word) => lower.includes(word))
      ? Math.max(1, base - 3)
      : base;
  };
  const ordered = candidates
    .map(({ path }) => ({
      path,
      rank: rank(path),
      depth: path.split("/").length,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.depth - b.depth ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .map(({ path }) => path);
  const paths = ordered.slice(0, CONTEXT_DOCUMENTS_MAX);
  return { paths, omitted: ordered.length - paths.length };
}

/**
 * Documents as a sync keeps them: each cut to its own cap, and every one
 * together to the total, in the order given. A document left with no room
 * is dropped and counted as omitted.
 */
export function keptDocuments(
  documents: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly text: string;
  }[],
): { readonly documents: GithubContextDocument[]; readonly omitted: number } {
  const kept: GithubContextDocument[] = [];
  let room = CONTEXT_TOTAL_CHARS;
  let omitted = 0;
  for (const { path, bytes, text } of documents) {
    const body = text.replace(/\r\n?/g, "\n").trim();
    const cap = Math.min(CONTEXT_DOCUMENT_CHARS, room);
    if (body === "" || cap <= 0) {
      omitted += 1;
      continue;
    }
    const truncated = body.length > cap;
    const excerpt = truncated ? body.slice(0, cap) : body;
    kept.push({ path, bytes, text: excerpt, truncated });
    room -= excerpt.length;
  }
  return { documents: kept, omitted };
}

/**
 * Jira's fields as a model reads them: only those set, in a fixed order,
 * so the same context renders the same.
 */
export function jiraContextFields(
  context: JiraContext,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    fields[name] = value;
  };
  set("issueType", context.issueType);
  set("status", context.status);
  set("priority", context.priority);
  set("labels", context.labels);
  set("components", context.components);
  set("fixVersions", context.fixVersions);
  set("dueDate", context.dueDate);
  set("storyPoints", context.storyPoints);
  set(
    "originalEstimateHours",
    context.originalEstimateSeconds === null
      ? null
      : Math.round((context.originalEstimateSeconds / 3600) * 10) / 10,
  );
  set(
    "remainingEstimateHours",
    context.remainingEstimateSeconds === null
      ? null
      : Math.round((context.remainingEstimateSeconds / 3600) * 10) / 10,
  );
  set("votes", context.votes);
  set("watchers", context.watchers);
  set("subtasks", context.subtaskCount === 0 ? null : context.subtaskCount);
  set("hasParent", context.parentKey === null ? null : true);
  set(
    "links",
    context.links.map(({ type, direction, done }) => ({
      type,
      direction,
      done,
    })),
  );
  return fields;
}

/**
 * A bounty's synced context as a model is shown it, under headings of its
 * own after the bounty's text; empty when it has none. Issue keys and
 * repository names are left out, as the bounty's prompts ask the model not
 * to carry names over.
 */
export function renderSourceContext(context: {
  readonly jira: JiraContext | null;
  readonly github: GithubContext | null;
}): string {
  const sections: string[] = [];
  if (context.jira !== null) {
    sections.push(
      `Jira fields:\n${JSON.stringify(jiraContextFields(context.jira))}`,
    );
  }
  if (context.github !== null && context.github.documents.length > 0) {
    sections.push(
      [
        "Repository documents:",
        ...context.github.documents.map(
          ({ path, text, truncated }) =>
            `--- ${path}${truncated ? " (cut short)" : ""} ---\n${text}`,
        ),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * Which sources a step was made with older context than the overview now
 * holds: the version it used, null when it used none, and the overview's.
 * A source the overview holds no context from is behind nowhere.
 */
export function contextDrift(
  current: ContextVersions,
  used: ContextVersions,
): { readonly jira: StageDrift | null; readonly github: StageDrift | null } {
  const of = (source: ContextSource): StageDrift | null => {
    const now = current[source];
    const then = used[source];
    return now !== null && (then === null || then < now)
      ? { uses: then, current: now }
      : null;
  };
  return { jira: of("jira"), github: of("github") };
}
