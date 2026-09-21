/**
 * The Jira wire contract: Atlassian's payloads in, our DTOs out.
 *
 * Two families of schema live here and they are not interchangeable:
 *
 * - `*Response` schemas describe what **Atlassian sends**. They are permissive
 *   on purpose (see below) and are parsed by `packages/jira`.
 * - `*Dto` schemas describe what **we hand on** to the API, the web app and the
 *   extension. Those are strict, because we produce them.
 *
 * **Why the response schemas are so forgiving.** Almost every field on a Jira
 * issue is screen-configurable, which means a project administrator can remove
 * it. A schema that required `summary` would fail a whole page of issues
 * because one project hid the field, and the caller could not tell that from a
 * network error. So the response schemas require only what Jira guarantees —
 * an issue has an `id` and a `key`, a board has an `id` and a `name` — and
 * `mapping.ts` substitutes a default for everything else. A board that renders
 * with "Unassigned" beats one that fails to load.
 *
 * `.loose()` is on the object schemas for the same reason in the other
 * direction: Jira adds fields continuously, and an unknown one must not be an
 * error.
 */

import { z } from "zod";

/**
 * The four status categories Jira guarantees, whatever a project calls its
 * individual statuses, plus our own `unknown`.
 *
 * `unknown` is not a Jira value. Jira spells the backlog category `new`, but
 * has historically also sent `To Do` and nothing at all, and forcing an
 * unrecognised value into `new` or `done` silently misfiles a task as
 * outstanding or complete. So anything unrecognised becomes `unknown` and the
 * caller can see that it does not know.
 */
export const JIRA_STATUS_CATEGORIES = [
  "new",
  "indeterminate",
  "done",
  "unknown",
] as const;

export const jiraStatusCategorySchema = z.enum(JIRA_STATUS_CATEGORIES);

/* -------------------------------------------------------------------------- */
/* What Atlassian sends                                                        */
/* -------------------------------------------------------------------------- */

/** A `{ name }`-shaped lookup value: priority, issue type, project, status. */
const namedSchema = z
  .object({
    name: z.string().optional(),
    key: z.string().optional(),
  })
  .loose();

const statusSchema = z
  .object({
    name: z.string().optional(),
    statusCategory: z
      .object({
        key: z.string().optional(),
        name: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/**
 * The fields block of an issue. Every member is optional: this is the part of
 * the payload a project administrator controls.
 *
 * `assignee` is `displayName` only. The email address needs `read:jira-user`
 * and is redacted outright on sites with strict profile visibility, so reading
 * it would make the integration fail differently on different sites.
 */
const issueFieldsSchema = z
  .object({
    summary: z.string().optional(),
    status: statusSchema.optional(),
    assignee: z
      .object({ displayName: z.string().optional() })
      .loose()
      .nullish(),
    priority: namedSchema.nullish(),
    issuetype: namedSchema.optional(),
    labels: z.array(z.string()).optional(),
    project: namedSchema.optional(),
    parent: z.object({ key: z.string().optional() }).loose().nullish(),
    created: z.string().nullish(),
    updated: z.string().nullish(),
    duedate: z.string().nullish(),
  })
  .loose();

/**
 * One issue. `id` and `key` are the only fields Jira always sends, and `fields`
 * itself is optional because a search can be asked for no fields at all.
 */
export const jiraIssueResponseSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: issueFieldsSchema.optional(),
  })
  .loose();

/**
 * A page of issues.
 *
 * `total` is optional because the two APIs differ: the Agile endpoints report
 * it, and `/rest/api/3/search/jql` does not — it is token-paginated and
 * returns `nextPageToken` instead. `issues` defaults to empty so that a board
 * with nothing on it parses rather than throwing.
 */
export const jiraIssuePageResponseSchema = z
  .object({
    issues: z.array(jiraIssueResponseSchema).default([]),
    total: z.number().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

/**
 * A board. `location` carries the project it belongs to, and is absent on a
 * board built from a filter that spans projects.
 */
export const jiraBoardResponseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    type: z.string().optional(),
    location: z
      .object({
        projectKey: z.string().optional(),
        projectName: z.string().optional(),
        displayName: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/**
 * A page of boards.
 *
 * `isLast` is optional: it is authoritative when present, and some instances
 * omit it, which is why the client also stops on a short page.
 */
export const jiraBoardPageResponseSchema = z
  .object({
    values: z.array(jiraBoardResponseSchema).default([]),
    isLast: z.boolean().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
  })
  .loose();

/** A sprint. Only Scrum boards have these. */
export const jiraSprintResponseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    state: z.string().optional(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    goal: z.string().nullish(),
  })
  .loose();

export const jiraSprintPageResponseSchema = z
  .object({
    values: z.array(jiraSprintResponseSchema).default([]),
    isLast: z.boolean().optional(),
  })
  .loose();

/**
 * Atlassian's token endpoint response.
 *
 * `refresh_token` is optional because Atlassian omits it when the grant did not
 * request `offline_access` — the trap `oauth.ts` exists to avoid. `scope` is
 * optional for the same reason: its absence is not an error, it just means we
 * learn nothing about what was granted.
 */
export const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  })
  .loose();

/**
 * One entry from `/oauth/token/accessible-resources`.
 *
 * `id` is the `cloudId` every REST call embeds; there is no way to derive it
 * from the token. `scopes` decides whether the site is a Jira site at all — a
 * token consented for Confluence lists those sites here too.
 */
export const accessibleResourceSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    name: z.string(),
    avatarUrl: z.string().optional(),
    scopes: z.array(z.string()).default([]),
  })
  .loose();

/* -------------------------------------------------------------------------- */
/* What we hand on                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An issue as the rest of the system sees it. Flat, fully resolved, with a
 * null in place of every field Jira might have omitted — so a consumer never
 * reaches through an optional chain to find out whether a ticket has a
 * priority.
 *
 * Note what is **not** here: the description. Issue text is read through a
 * separate call and never travels in a list, so that reading a board cannot
 * accidentally pull a client's ticket contents into a log or a cache.
 */
export const jiraIssueDtoSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: jiraStatusCategorySchema,
  assignee: z.string().nullable(),
  priority: z.string().nullable(),
  issueType: z.string(),
  labels: z.array(z.string()),
  projectKey: z.string().nullable(),
  parentKey: z.string().nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  dueDate: z.string().nullable(),
  /** A `browse/` link, or null when the site URL is unknown. */
  url: z.string().nullable(),
});

/**
 * One issue in full, for a person reading it rather than a run pricing it.
 *
 * **This is the one DTO that carries ticket text**, and it exists only for a
 * single-ticket read that a person asked for by name. `jiraIssueDtoSchema`
 * above still has no description, so a board or backlog read cannot pull a
 * client's ticket contents into a list, a log or a cache. The guarantee is
 * about lists and about storage; showing someone the ticket they clicked on
 * is the point of the integration.
 *
 * Nothing here is persisted. The detail route reads Jira live and returns it.
 *
 * Every field is nullable or defaulted, because Jira's are screen-configurable
 * and a site can omit almost any of them. A field Jira did not send arrives as
 * null and the UI omits its row, rather than rendering an empty label.
 */
export const jiraIssueDetailDtoSchema = jiraIssueDtoSchema.extend({
  /** The description, flattened from ADF to Markdown-ish text. */
  descriptionText: z.string(),
  /** Who filed it, and who the site records as having created the row. */
  reporter: z.string().nullable(),
  creator: z.string().nullable(),
  /** Set only once the ticket is resolved; both null on open work. */
  resolution: z.string().nullable(),
  resolutionDate: z.string().nullable(),
  components: z.array(z.string()).default([]),
  fixVersions: z.array(z.string()).default([]),
  /** Seconds, as Jira counts them. Null when the site does not track time. */
  originalEstimateSeconds: z.number().nullable(),
  remainingEstimateSeconds: z.number().nullable(),
  votes: z.number().nullable(),
  watchers: z.number().nullable(),
  environment: z.string().nullable(),
});

/**
 * A page of issues, with whichever cursor the underlying API paginates by.
 *
 * Both cursors are optional and at most one is ever set: the Agile endpoints
 * count offsets (`nextStartAt`), `/search/jql` hands back an opaque token
 * (`nextPageToken`). Either being absent means there is no more to read.
 */
export const jiraIssuePageDtoSchema = z.object({
  issues: z.array(jiraIssueDtoSchema),
  total: z.number().optional(),
  nextStartAt: z.number().optional(),
  nextPageToken: z.string().optional(),
});

export const jiraBoardDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  /** `scrum`, `kanban`, or `unknown` when Jira did not say. */
  type: z.string(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
});

export const jiraSprintDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  state: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  goal: z.string().nullable(),
});

/** A Jira site the connection can reach. */
export const jiraSiteDtoSchema = z.object({
  cloudId: z.string(),
  url: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Which backlog tickets a run takes                                          */
/* -------------------------------------------------------------------------- */

/**
 * The selection settings stored on a board.
 *
 * "The oldest tickets still in the backlog" selects for the worst-specified
 * work on a board: a ticket that has sat for two years is often a one-liner, a
 * duplicate, or something the team quietly decided not to do. These settings
 * are the levers for that — `maxAgeDays` excludes the truly abandoned, and
 * `minSpecChars` marks a ticket `unsized` without spending a model call on it.
 *
 * Every field has a default, and the whole object defaults to `{}`, so a board
 * registered before a field existed keeps working. That is why this is `jsonb`
 * with a schema rather than columns: the settings are expected to grow, and
 * each addition would otherwise be a migration.
 */
export const boardSelectionSchema = z.object({
  /** Tickets per run. Also the ceiling on what one run costs in model calls. */
  maxTickets: z.number().int().min(1).max(50).default(10),
  /**
   * Skip tickets someone is already assigned to. A bounty on a ticket with an
   * owner is a conflict, not an opportunity.
   */
  excludeAssigned: z.boolean().default(true),
  /**
   * Issue types to consider. Empty means "anything that is not an epic or a
   * sub-task", which the JQL excludes structurally: an epic is a container for
   * work rather than work, and a sub-task is priced with its parent.
   */
  issueTypes: z.array(z.string()).default([]),
  /** Ignore tickets newer than this; 0 considers everything. */
  minAgeDays: z.number().int().min(0).default(0),
  /**
   * Ignore tickets older than this. Undefined considers everything, which is
   * the setting most likely to need changing after a first real run.
   */
  maxAgeDays: z.number().int().min(1).optional(),
  /**
   * Below this many characters of summary plus description, a ticket is
   * `unsized` without calling the model. A one-line title cannot carry a
   * bounty, and pricing it anyway is how a dispute starts.
   */
  minSpecChars: z.number().int().min(0).default(0),
});

/** A board as the UI lists it. */
export const jiraBoardSummarySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  name: z.string(),
  boardType: z.string(),
  projectKey: z.string().nullable(),
  selection: boardSelectionSchema,
  writebackEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** Body for registering a board. The rest is read from Jira. */
export const registerBoardSchema = z.object({
  connectionId: z.string().min(1),
  /** Jira's board id, as a string because every external id here is one. */
  externalId: z.string().min(1),
  selection: boardSelectionSchema.optional(),
});

/**
 * A selection update: every field genuinely optional.
 *
 * **Not `boardSelectionSchema.partial()`.** A `.default()` survives
 * `.partial()`, so parsing `{ maxTickets: 5 }` through that would return every
 * other field at its default — and an edit to one setting would silently reset
 * the rest. Written out so "absent" means "leave it alone".
 */
export const boardSelectionUpdateSchema = z.object({
  maxTickets: z.number().int().min(1).max(50).optional(),
  excludeAssigned: z.boolean().optional(),
  issueTypes: z.array(z.string()).optional(),
  minAgeDays: z.number().int().min(0).optional(),
  /** Null clears the bound; undefined leaves it as it is. */
  maxAgeDays: z.number().int().min(1).nullable().optional(),
  minSpecChars: z.number().int().min(0).optional(),
});

/** Body for editing a board. Both halves optional; an empty body is refused. */
export const updateBoardSchema = z
  .object({
    selection: boardSelectionUpdateSchema.optional(),
    writebackEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.selection !== undefined || body.writebackEnabled !== undefined,
    { message: "Provide selection settings, a write-back flag, or both." },
  );

export type BoardSelection = z.infer<typeof boardSelectionSchema>;
export type BoardSelectionUpdate = z.infer<typeof boardSelectionUpdateSchema>;
export type JiraBoardSummaryDto = z.infer<typeof jiraBoardSummarySchema>;
export type RegisterBoardInput = z.infer<typeof registerBoardSchema>;
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;

export type JiraIssueDetailDto = z.infer<typeof jiraIssueDetailDtoSchema>;

export type JiraStatusCategory = z.infer<typeof jiraStatusCategorySchema>;

export type JiraIssueResponse = z.infer<typeof jiraIssueResponseSchema>;
export type JiraIssuePageResponse = z.infer<typeof jiraIssuePageResponseSchema>;
export type JiraBoardResponse = z.infer<typeof jiraBoardResponseSchema>;
export type JiraBoardPageResponse = z.infer<typeof jiraBoardPageResponseSchema>;
export type JiraSprintResponse = z.infer<typeof jiraSprintResponseSchema>;
export type JiraSprintPageResponse = z.infer<
  typeof jiraSprintPageResponseSchema
>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type AccessibleResource = z.infer<typeof accessibleResourceSchema>;

export type JiraIssueDto = z.infer<typeof jiraIssueDtoSchema>;
export type JiraIssuePageDto = z.infer<typeof jiraIssuePageDtoSchema>;
export type JiraBoardDto = z.infer<typeof jiraBoardDtoSchema>;
export type JiraSprintDto = z.infer<typeof jiraSprintDtoSchema>;
export type JiraSiteDto = z.infer<typeof jiraSiteDtoSchema>;
