/**
 * The context a bounty's sources add to it: what its Jira issue says beyond
 * its title and description, and what the documents of the workspace's
 * repositories say. A bounty names no repository: the work may touch any
 * the workspace has connected, so their documents are read together.
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
 * What one repository's own documents say: its README, its docs and the
 * guides it keeps for contributors, read at one commit. Never its code.
 */
export interface GithubRepositoryContext {
  readonly fullName: string;
  /** The branch the commit was read from. */
  readonly branch: string;
  readonly commitSha: string;
  readonly documents: readonly GithubContextDocument[];
  /** Documents found but left out for the caps. */
  readonly omitted: number;
}

/**
 * What the workspace's repositories' documents say, read together under
 * one set of caps: one entry per repository read, by full name.
 */
export interface GithubWorkspaceContext {
  readonly repositories: readonly GithubRepositoryContext[];
  /** Connected repositories left unread: no snapshot yet, or unreachable. */
  readonly unread: readonly string[];
}

/**
 * A GitHub context version's content: the workspace's repositories, or,
 * for a version synced while a bounty named one repository, that one's.
 * Stored versions and frozen tasks keep the shape they were written in.
 */
export type GithubContext = GithubWorkspaceContext | GithubRepositoryContext;

/** The repositories a GitHub context read, whichever shape it was kept in. */
export function githubRepositories(
  content: GithubContext,
): readonly GithubRepositoryContext[] {
  return "repositories" in content ? content.repositories : [content];
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

/** A file a document may be read from. */
interface DocumentFile {
  readonly path: string;
  readonly size: number;
}

/**
 * The documents worth reading in a file list, each with the rank it is
 * read in (lower first) and its depth: by tier, a document whose path names a
 * word of the bounty's title ahead of the tier above its own. Vendored
 * code, fixtures, examples, `.github` and boilerplate are passed over, and
 * so is a file too large to be a document.
 */
function rankedDocuments(
  files: readonly DocumentFile[],
  keywords: readonly string[],
): { readonly path: string; readonly rank: number; readonly depth: number }[] {
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
  return candidates.map(({ path }) => ({
    path,
    rank: rank(path),
    depth: path.split("/").length,
  }));
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The documents worth reading in a file list, in the order they are read:
 * by rank (`rankedDocuments`), then shallowest first. At most
 * `CONTEXT_DOCUMENTS_MAX`; `omitted` counts the rest.
 */
export function contextDocuments(
  files: readonly DocumentFile[],
  keywords: readonly string[] = [],
): { readonly paths: string[]; readonly omitted: number } {
  const ordered = rankedDocuments(files, keywords)
    .sort(
      (a, b) => a.rank - b.rank || a.depth - b.depth || byPath(a.path, b.path),
    )
    .map(({ path }) => path);
  const paths = ordered.slice(0, CONTEXT_DOCUMENTS_MAX);
  return { paths, omitted: ordered.length - paths.length };
}

/**
 * The documents worth reading across several repositories' file lists,
 * under one cap: ranked as `contextDocuments` ranks one repository's, so
 * every repository's README comes before any repository's guides, and a
 * rank's documents taken shallowest first, then in the repositories' order.
 * `omitted` counts, per repository, what the cap left out.
 */
export function contextDocumentsAcross(
  repositories: readonly { readonly files: readonly DocumentFile[] }[],
  keywords: readonly string[] = [],
): {
  readonly chosen: { readonly repository: number; readonly path: string }[];
  readonly omitted: number[];
} {
  const ordered = repositories
    .flatMap(({ files }, repository) =>
      rankedDocuments(files, keywords).map((ranked) => ({
        ...ranked,
        repository,
      })),
    )
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.depth - b.depth ||
        a.repository - b.repository ||
        byPath(a.path, b.path),
    );
  const omitted = repositories.map(() => 0);
  for (const { repository } of ordered.slice(CONTEXT_DOCUMENTS_MAX)) {
    omitted[repository] = (omitted[repository] ?? 0) + 1;
  }
  return {
    chosen: ordered
      .slice(0, CONTEXT_DOCUMENTS_MAX)
      .map(({ repository, path }) => ({ repository, path })),
    omitted,
  };
}

/**
 * Documents as a sync keeps them: each cut to its own cap, and every one
 * together to the total, in the order given. Answered in the order given,
 * with null for a document left with no room, or with no text.
 */
export function keptDocumentsAligned(
  documents: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly text: string;
  }[],
): (GithubContextDocument | null)[] {
  let room = CONTEXT_TOTAL_CHARS;
  return documents.map(({ path, bytes, text }) => {
    const body = text.replace(/\r\n?/g, "\n").trim();
    const cap = Math.min(CONTEXT_DOCUMENT_CHARS, room);
    if (body === "" || cap <= 0) return null;
    const truncated = body.length > cap;
    const excerpt = truncated ? body.slice(0, cap) : body;
    room -= excerpt.length;
    return { path, bytes, text: excerpt, truncated };
  });
}

/**
 * Documents as a sync keeps them (`keptDocumentsAligned`), with those
 * dropped counted as omitted.
 */
export function keptDocuments(
  documents: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly text: string;
  }[],
): { readonly documents: GithubContextDocument[]; readonly omitted: number } {
  const aligned = keptDocumentsAligned(documents);
  const kept = aligned.filter(
    (document): document is GithubContextDocument => document !== null,
  );
  return { documents: kept, omitted: aligned.length - kept.length };
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
 * to carry names over. `labels` are the outlined repositories', by full
 * name: a repository's documents are headed by its label, so the model
 * reads them as that outline's. One with no label (its repository since
 * renamed or disconnected) is headed as another repository, never by a
 * label an outline holds. With no labels, several are headed by their
 * place in the context, and one is not headed.
 */
export function renderSourceContext(
  context: {
    readonly jira: JiraContext | null;
    readonly github: GithubContext | null;
  },
  labels: ReadonlyMap<string, string> = new Map(),
): string {
  const sections: string[] = [];
  if (context.jira !== null) {
    sections.push(
      `Jira fields:\n${JSON.stringify(jiraContextFields(context.jira))}`,
    );
  }
  const repositories =
    context.github === null
      ? []
      : githubRepositories(context.github).filter(
          ({ documents }) => documents.length > 0,
        );
  const documents = (repository: GithubRepositoryContext) =>
    repository.documents.map(
      ({ path, text, truncated }) =>
        `--- ${path}${truncated ? " (cut short)" : ""} ---\n${text}`,
    );
  const [only] = repositories;
  if (repositories.length === 1 && only !== undefined && labels.size === 0) {
    sections.push(["Repository documents:", ...documents(only)].join("\n\n"));
  } else if (repositories.length > 0) {
    let unlabeled = 0;
    const heading = (repository: GithubRepositoryContext, index: number) =>
      labels.get(repository.fullName) ??
      (labels.size === 0
        ? repositoryLabel(index)
        : `Other repository ${(unlabeled += 1)}`);
    sections.push(
      [
        "Repository documents:",
        ...repositories.flatMap((repository, index) => [
          `=== ${heading(repository, index)} ===`,
          ...documents(repository),
        ]),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * The name a model is shown a repository by, in place of its own: its
 * place in the list it is shown in, so a model can say which it means
 * without a repository's name reaching what it writes.
 */
export function repositoryLabel(index: number): string {
  return `Repository ${index + 1}`;
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
