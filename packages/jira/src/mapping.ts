/**
 * Atlassian's shapes to ours. The only place the two vocabularies meet, so a
 * change in Jira's payload is absorbed here rather than spreading into the
 * routes, the MCP tools and the UI.
 *
 * Everything is defensive: each field is optional or nullable upstream (see
 * `jira.ts` in `shared` for why), and a missing one becomes a null or a sane
 * default rather than throwing. A board that renders with "Unassigned" beats
 * one that fails to load because a single issue lacks an assignee.
 */

import type {
  JiraBoardDto,
  JiraBoardResponse,
  JiraIssueDetailDto,
  JiraIssueDto,
  JiraIssueResponse,
  JiraSprintDto,
  JiraSprintResponse,
  JiraStatusCategory,
} from "@sandbox-factory/shared";

import { adfToText } from "./adf.js";
import { stripTrailingSlashes } from "./url.js";

/** The four categories Jira guarantees, whatever a project calls its statuses. */
const STATUS_CATEGORIES = ["new", "indeterminate", "done"] as const;

/**
 * Normalises `statusCategory.key` to our enum.
 *
 * Jira spells the backlog category `new` but has historically also sent
 * `undefined` and `To Do`, so anything unrecognised becomes `unknown` rather
 * than being forced into `new` — a wrong category silently misfiles a task as
 * outstanding or complete.
 */
function toStatusCategory(key: string | undefined): JiraStatusCategory {
  const normalized = key?.toLowerCase();
  return (
    STATUS_CATEGORIES.find((category) => category === normalized) ?? "unknown"
  );
}

export interface IssueMappingOptions {
  /**
   * The site origin, e.g. `https://acme.atlassian.net`. Used to build the
   * browse link. Omitted when unknown, which leaves `url` null rather than
   * emitting a broken relative link.
   */
  siteUrl?: string | undefined;
}

export function toIssueDto(
  issue: JiraIssueResponse,
  { siteUrl }: IssueMappingOptions = {},
): JiraIssueDto {
  const fields = issue.fields ?? {};
  return {
    id: issue.id,
    key: issue.key,
    // An issue always has a summary in practice, but the field is screen-
    // configurable, so it is not guaranteed on the wire.
    summary: fields.summary ?? "(no summary)",
    status: fields.status?.name ?? "Unknown",
    statusCategory: toStatusCategory(fields.status?.statusCategory?.key),
    // `displayName` rather than email: the address needs `read:jira-user` and
    // is redacted outright on sites with strict profile visibility.
    assignee: fields.assignee?.displayName ?? null,
    priority: fields.priority?.name ?? null,
    issueType: fields.issuetype?.name ?? "Task",
    labels: fields.labels ?? [],
    projectKey: fields.project?.key ?? null,
    parentKey: fields.parent?.key ?? null,
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    dueDate: fields.duedate ?? null,
    url:
      siteUrl === undefined
        ? null
        : `${stripTrailingSlashes(siteUrl)}/browse/${issue.key}`,
  };
}

/**
 * One issue in full, for display.
 *
 * Built on `toIssueDto` so the two can never disagree about a shared field,
 * with the description flattened and the display-only fields resolved to
 * strings. Everything Jira may omit lands as null rather than undefined, so
 * the UI tests one thing.
 */
export function toIssueDetailDto(
  issue: JiraIssueResponse,
  options: IssueMappingOptions = {},
): JiraIssueDetailDto {
  const fields = (issue.fields ?? {}) as Record<string, unknown>;
  const named = (value: unknown): string | null => {
    const name = (value as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : null;
  };
  const people = (value: unknown): string | null => {
    const display = (value as { displayName?: unknown } | null)?.displayName;
    return typeof display === "string" ? display : null;
  };
  const seconds = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => named(entry))
          .filter((name): name is string => name !== null)
      : [];

  return {
    ...toIssueDto(issue, options),
    descriptionText: adfToText(fields.description),
    reporter: people(fields.reporter),
    creator: people(fields.creator),
    resolution: named(fields.resolution),
    resolutionDate:
      typeof fields.resolutiondate === "string" ? fields.resolutiondate : null,
    components: names(fields.components),
    fixVersions: names(fields.fixVersions),
    originalEstimateSeconds: seconds(fields.timeoriginalestimate),
    remainingEstimateSeconds: seconds(fields.timeestimate),
    votes: seconds((fields.votes as { votes?: unknown } | null)?.votes),
    watchers: seconds(
      (fields.watches as { watchCount?: unknown } | null)?.watchCount,
    ),
    environment:
      typeof fields.environment === "string" ? fields.environment : null,
  };
}

export function toBoardDto(board: JiraBoardResponse): JiraBoardDto {
  return {
    id: board.id,
    name: board.name,
    type: board.type ?? "unknown",
    projectKey: board.location?.projectKey ?? null,
    projectName:
      board.location?.projectName ?? board.location?.displayName ?? null,
  };
}

export function toSprintDto(sprint: JiraSprintResponse): JiraSprintDto {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state ?? "unknown",
    startDate: sprint.startDate ?? null,
    endDate: sprint.endDate ?? null,
    goal: sprint.goal ?? null,
  };
}

/**
 * The fields to request explicitly on every issue read.
 *
 * Asking for a named set rather than letting Jira return its default is a
 * large win: the default includes every custom field on the project, which on
 * a mature instance is hundreds of keys and megabytes per page. This list is
 * exactly what `toIssueDto` reads.
 */
export const ISSUE_FIELDS: readonly string[] = [
  "summary",
  "status",
  "assignee",
  "priority",
  "issuetype",
  "labels",
  "created",
  "updated",
  "duedate",
  "parent",
  "project",
];

/**
 * The fields a single-ticket detail read asks for.
 *
 * Distinct from `ISSUE_FIELDS`, and deliberately a superset of it: this is the
 * only list in the package besides `SPEC_FIELDS` that names `description`, and
 * it is used by exactly one call, for one ticket, that a person asked for. A
 * board or backlog read still cannot pull ticket text — see `client.ts`.
 */
export const DETAIL_FIELDS: readonly string[] = [
  ...ISSUE_FIELDS,
  "description",
  "reporter",
  "creator",
  "resolution",
  "resolutiondate",
  "components",
  "fixVersions",
  "timeoriginalestimate",
  "timeestimate",
  "votes",
  "watches",
  "environment",
];
