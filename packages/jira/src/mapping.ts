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
  JiraIssueDto,
  JiraIssueResponse,
  JiraSprintDto,
  JiraSprintResponse,
  JiraStatusCategory,
} from "@sandbox-factory/shared";

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
