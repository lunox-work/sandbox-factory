/**
 * What a Jira issue adds to its bounty beyond its title and description,
 * for a person's sync: how it is classified and prioritized, how large its
 * team judged it, and what it depends on.
 *
 * Like the detail read, one issue at a time, by name. Unlike it, no person
 * is read: no assignee, reporter or creator, and no comment. The fields are
 * names, counts and dates. The description is not read here either; the
 * bounty's text is read with `issueSpec`, as everywhere.
 */

import type {
  JiraContextDto,
  JiraIssueResponse,
} from "@sandbox-factory/shared";

import { ISSUE_FIELDS } from "./mapping.js";

/**
 * The fields a context read asks for, besides the site's story points
 * fields: `ISSUE_FIELDS` without the assignee, and the estimates,
 * components, releases, links and demand the detail and selection reads
 * have.
 */
export const CONTEXT_FIELDS: readonly string[] = [
  ...ISSUE_FIELDS.filter((field) => field !== "assignee"),
  "components",
  "fixVersions",
  "timeoriginalestimate",
  "timeestimate",
  "votes",
  "watches",
  "issuelinks",
];

/** One of a site's fields, as `/rest/api/3/field` lists it. */
export interface JiraFieldDefinition {
  readonly id: string;
  readonly name: string;
  readonly schemaType: string | null;
}

/**
 * The fields a site keeps story points in, by id. They are custom fields,
 * named by the site: "Story Points" on a company-managed project, "Story
 * point estimate" on a team-managed one. Only number fields count.
 */
export function storyPointFields(
  fields: readonly JiraFieldDefinition[],
): string[] {
  return fields
    .filter(
      ({ name, schemaType }) =>
        /^story points?( estimate)?$/i.test(name.trim()) &&
        (schemaType === null || schemaType === "number"),
    )
    .map(({ id }) => id);
}

/** Reads `/rest/api/3/field`'s answer leniently: what is not a field is skipped. */
export function toFieldDefinitions(payload: unknown): JiraFieldDefinition[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name, schema } = entry as {
      id?: unknown;
      name?: unknown;
      schema?: { type?: unknown } | null;
    };
    if (typeof id !== "string" || typeof name !== "string") return [];
    const schemaType = typeof schema?.type === "string" ? schema.type : null;
    return [{ id, name, schemaType }];
  });
}

const DONE = "done";

/** The issue's context, from a read that asked for `CONTEXT_FIELDS`. */
export function toJiraContext(
  issue: JiraIssueResponse,
  pointFields: readonly string[] = [],
): JiraContextDto {
  const fields = (issue.fields ?? {}) as Record<string, unknown> &
    NonNullable<JiraIssueResponse["fields"]>;
  const named = (value: unknown): string | null => {
    const name = (value as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" ? name : null;
  };
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => named(entry))
          .filter((name): name is string => name !== null)
      : [];
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const storyPoints =
    pointFields
      .map((id) => number(fields[id]))
      .find((value): value is number => value !== null) ?? null;
  return {
    key: issue.key,
    issueType: named(fields.issuetype),
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.key?.toLowerCase() ?? null,
    priority: named(fields.priority),
    labels: [...(fields.labels ?? [])],
    components: names(fields.components),
    fixVersions: names(fields.fixVersions),
    parentKey: fields.parent?.key ?? null,
    dueDate: fields.duedate ?? null,
    storyPoints,
    originalEstimateSeconds: number(fields.timeoriginalestimate),
    remainingEstimateSeconds: number(fields.timeestimate),
    votes: number(fields.votes?.votes),
    watchers: number(fields.watches?.watchCount),
    subtaskCount: Array.isArray(fields.subtasks) ? fields.subtasks.length : 0,
    links: (fields.issuelinks ?? []).flatMap((link) => {
      const other = link.outwardIssue ?? link.inwardIssue;
      if (other === undefined) return [];
      return [
        {
          type: link.type?.name ?? "",
          direction:
            link.outwardIssue !== undefined
              ? ("outward" as const)
              : ("inward" as const),
          key: other.key ?? null,
          done:
            other.fields?.status?.statusCategory?.key?.toLowerCase() === DONE,
        },
      ];
    }),
    updated: fields.updated ?? null,
  };
}
