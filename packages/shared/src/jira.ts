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

import {
  CATEGORIES,
  SCENARIO_WEIGHTS,
  STEP_SETTING_LIMITS,
} from "sandbox-factory";
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
 * A sprint as an issue names it: the one it sits in now (`sprint`) or one
 * that closed around it (`closedSprints`). Only the Agile endpoints send
 * these, and only for boards that have sprints.
 */
const issueSprintSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    state: z.string().optional(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  })
  .loose();

/** The ticket at the other end of a link: its key and whether it is open. */
const linkedIssueSchema = z
  .object({
    key: z.string().optional(),
    fields: z.object({ status: statusSchema.optional() }).loose().optional(),
  })
  .loose();

/**
 * One link. Exactly one of `outwardIssue` and `inwardIssue` is present, and
 * which one says the direction: `outwardIssue` is the ticket this one acts
 * on ("blocks"), `inwardIssue` the ticket acting on this one ("is blocked
 * by").
 */
const issueLinkSchema = z
  .object({
    type: z.object({ name: z.string().optional() }).loose().optional(),
    outwardIssue: linkedIssueSchema.optional(),
    inwardIssue: linkedIssueSchema.optional(),
  })
  .loose();

const fixVersionSchema = z
  .object({
    name: z.string().optional(),
    releaseDate: z.string().nullish(),
    released: z.boolean().optional(),
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
    // Only counted, never read: whether a ticket is split into sub-tasks.
    subtasks: z.array(z.unknown()).nullish().catch(undefined),
    created: z.string().nullish(),
    updated: z.string().nullish(),
    duedate: z.string().nullish(),
    /*
      What selection reads, and only when it asks for them. Each falls back
      to absent on a shape it does not recognise rather than failing: these
      decide whether a ticket is offered, and one site's odd `votes` field
      must not cost a whole page of tickets.
    */
    sprint: issueSprintSchema.nullish().catch(undefined),
    closedSprints: z.array(issueSprintSchema).nullish().catch(undefined),
    votes: z
      .object({ votes: z.number().optional() })
      .loose()
      .nullish()
      .catch(undefined),
    watches: z
      .object({ watchCount: z.number().optional() })
      .loose()
      .nullish()
      .catch(undefined),
    issuelinks: z.array(issueLinkSchema).nullish().catch(undefined),
    fixVersions: z.array(fixVersionSchema).nullish().catch(undefined),
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
  /**
   * How many sub-tasks the ticket is split into. A ticket with any is
   * priced through its sub-tasks, never itself. Optional so a response
   * from before it was read still parses; absent reads as none.
   */
  subtaskCount: z.number().int().nonnegative().optional(),
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
 * An issue with what selection needs to decide whether to offer it: its
 * sprint history, how many people follow it, what it is linked to, and the
 * releases it is slated for.
 *
 * A superset of `jiraIssueDtoSchema`, and like it, **no description and no
 * comments**: every field here is a count, a date or a name. It is read only
 * by the run that classifies a board, so ordinary lists do not pay for it.
 */
export const jiraIssueSignalsDtoSchema = jiraIssueDtoSchema.extend({
  /** The sprint it sits in now. Null on a board without sprints. */
  sprint: z.object({ name: z.string(), state: z.string() }).nullable(),
  /** Sprints that closed with the ticket unfinished in them. */
  closedSprints: z.array(
    z.object({
      name: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    }),
  ),
  votes: z.number().nullable(),
  watchers: z.number().nullable(),
  links: z.array(
    z.object({
      /** The link type's name: `Blocks`, `Duplicate`, `Relates`. */
      type: z.string(),
      /** `outward` is this ticket acting on the other one. */
      direction: z.enum(["inward", "outward"]),
      key: z.string().nullable(),
      statusCategory: jiraStatusCategorySchema,
    }),
  ),
  /** Fix versions. Named apart from the detail DTO's list of bare names. */
  releases: z.array(
    z.object({
      name: z.string(),
      releaseDate: z.string().nullable(),
      released: z.boolean(),
    }),
  ),
});

export const jiraIssueSignalsPageDtoSchema = z.object({
  issues: z.array(jiraIssueSignalsDtoSchema),
  total: z.number().optional(),
  nextStartAt: z.number().optional(),
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
  scopes: z.array(z.string()),
});

/* -------------------------------------------------------------------------- */
/* Which backlog tickets a run takes                                          */
/* -------------------------------------------------------------------------- */

/** A category threshold: whole, non-negative, and no more than a century. */
const thresholdSchema = z.number().int().min(0).max(36_500);

/**
 * Per-category settings, built from the category registry.
 *
 * Generated rather than written out, so a category or threshold added to the
 * registry is settable with no change here. Two variants, because the same
 * shape is read in two situations:
 *
 * - **Stored** settings are read with unknown keys *dropped*. A board
 *   configured against last month's categories must keep working when one is
 *   renamed or retired, so a stale id or threshold is ignored, not an error.
 * - An **update** from a client is *strict*: a misspelt category or threshold
 *   is refused, because silently ignoring it would look like it was saved.
 *   `null` clears an override back to the registry's default.
 */
function categoriesSchema(mode: "stored" | "update") {
  const strict = mode === "update";
  const shape = <T extends z.ZodRawShape>(fields: T) =>
    strict ? z.strictObject(fields) : z.object(fields);
  return shape(
    Object.fromEntries(
      CATEGORIES.map((category) => [
        category.id,
        shape({
          enabled: z.boolean().optional(),
          thresholds: shape(
            Object.fromEntries(
              Object.keys(category.defaults).map((name) => [
                name,
                strict
                  ? thresholdSchema.nullable().optional()
                  : thresholdSchema.optional().catch(undefined),
              ]),
            ),
          ).optional(),
        }).optional(),
      ]),
    ),
  );
}

/**
 * An optional setting that reads a stored `null` as absent.
 *
 * An update clears a setting by sending `null`, and the store removes the
 * key. Rows written before it did hold the null itself, and a plain
 * `.optional()` would refuse them, failing the board's every read.
 */
function clearable<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

/** The most tickets the oldest-first fallback may take in one run. */
const FALLBACK_OLDEST_MAX = 100;

/**
 * The selection settings stored on a board.
 *
 * A run takes **every** open ticket that fits at least one category in the
 * registry (`sandbox-factory`'s `CATEGORIES`), not a fixed number of the
 * oldest. These settings are the levers around that: which tickets are
 * candidates at all (`issueTypes`, the age window, `unassignedOnly`), how
 * each category is tuned (`categories`), and an optional ceiling on what one
 * run may spend (`ticketCap`).
 *
 * Every field has a default, and the whole object defaults to `{}`, so a
 * board registered before a field existed keeps working. That is why this is
 * `jsonb` with a schema rather than columns: the settings are expected to
 * grow, and each addition would otherwise be a migration.
 *
 * **`maxTickets` and `excludeAssigned` are gone, under new names on
 * purpose.** Boards registered while a run took the ten oldest tickets have
 * `maxTickets: 10` and `excludeAssigned: true` written into their rows,
 * because registration stores resolved defaults. Reusing those names would
 * leave every such board capped at ten. Unknown keys are dropped on parse,
 * so the old values are simply never read.
 */
export const boardSelectionSchema = z.object({
  /**
   * A ceiling on tickets per run, for a client who wants to bound what one
   * run costs in model calls. Absent, which is the default, means every
   * ticket that matches.
   */
  ticketCap: clearable(z.number().int().min(1).max(5_000)),
  /**
   * Consider only tickets nobody is assigned to. Off by default: the
   * categories that need an unowned ticket say so themselves, and the ones
   * that do not (a ticket carried through four sprints usually has an
   * owner) would otherwise never match.
   */
  unassignedOnly: z.boolean().default(false),
  /**
   * Issue types to consider. Empty means "anything that is not an epic",
   * which the JQL excludes structurally: an epic is a container for work
   * rather than work. Sub-tasks are considered; a ticket split into
   * sub-tasks is not, whatever its type, since its sub-tasks are the work.
   */
  issueTypes: z.array(z.string()).default([]),
  /** Ignore tickets newer than this; 0 considers everything. */
  minAgeDays: z.number().int().min(0).default(0),
  /** Ignore tickets older than this. Undefined considers everything. */
  maxAgeDays: clearable(z.number().int().min(1)),
  /**
   * Below this many characters of summary plus description, a ticket is
   * `unsized` without calling the model. A one-line title cannot carry a
   * bounty, and pricing it anyway is how a dispute starts.
   */
  minSpecChars: z.number().int().min(0).default(0),
  /**
   * When nothing on the board fits a category, or everything that does
   * already has a proposal, a run sizes this many of the oldest open
   * tickets instead, rather than nothing. 0 turns the fallback off. The
   * name is new on purpose: `maxTickets`, which older boards still hold,
   * is never read.
   */
  fallbackOldest: z.number().int().min(0).max(FALLBACK_OLDEST_MAX).default(10),
  /** Per-category overrides, by category id. Empty means every default. */
  categories: categoriesSchema("stored").default({}),
});

/* -------------------------------------------------------------------------- */
/* How a board prices what a run sizes                                        */
/* -------------------------------------------------------------------------- */

const pointsPerStepSchema = z
  .number()
  .int()
  .min(STEP_SETTING_LIMITS.minPointsPerStep)
  .max(STEP_SETTING_LIMITS.maxPoints);
const weightPointsSchema = z
  .number()
  .int()
  .min(STEP_SETTING_LIMITS.minWeightPoints)
  .max(STEP_SETTING_LIMITS.maxPoints);

/**
 * A board's overrides of the scenario step (`pricing/step` in core): the
 * points per half step, and what each weight counts for.
 *
 * Read as `categoriesSchema` reads categories. **Stored**, an unknown or
 * out-of-range key is dropped, so a board saved against an older rubric
 * keeps pricing. An **update** is strict, so a misspelt weight is refused
 * rather than silently not saved, and `null` clears an override back to
 * the default.
 */
function stepSchema(mode: "stored" | "update") {
  const strict = mode === "update";
  const shape = <T extends z.ZodRawShape>(fields: T) =>
    strict ? z.strictObject(fields) : z.object(fields);
  const setting = <T extends z.ZodType>(schema: T) =>
    strict ? schema.nullable().optional() : schema.optional().catch(undefined);
  const weightPoints = shape(
    Object.fromEntries(
      SCENARIO_WEIGHTS.map((weight) => [weight, setting(weightPointsSchema)]),
    ),
  ).optional();
  return shape({
    pointsPerStep: setting(pointsPerStepSchema),
    weightPoints: strict ? weightPoints : weightPoints.catch(undefined),
  });
}

/**
 * The pricing settings stored on a board. Every field has a default, as
 * the selection's do, and the whole object defaults to `{}`.
 */
export const boardPricingSchema = z.object({
  /** The scenario step. Empty means every default. */
  step: stepSchema("stored").default({}).catch({}),
});

/** A pricing update, merged setting by setting like a selection update. */
export const boardPricingUpdateSchema = z.object({
  step: stepSchema("update").optional(),
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
  /** Defaulted, so a response from before board pricing still parses. */
  pricing: boardPricingSchema.default({ step: {} }),
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
 * `.partial()`, so parsing `{ ticketCap: 5 }` through that would return every
 * other field at its default — and an edit to one setting would silently reset
 * the rest. Written out so "absent" means "leave it alone".
 */
export const boardSelectionUpdateSchema = z.object({
  /** Null removes the ceiling; undefined leaves it as it is. */
  ticketCap: z.number().int().min(1).max(5_000).nullable().optional(),
  unassignedOnly: z.boolean().optional(),
  issueTypes: z.array(z.string()).optional(),
  minAgeDays: z.number().int().min(0).optional(),
  /** Null clears the bound; undefined leaves it as it is. */
  maxAgeDays: z.number().int().min(1).nullable().optional(),
  minSpecChars: z.number().int().min(0).optional(),
  fallbackOldest: z.number().int().min(0).max(FALLBACK_OLDEST_MAX).optional(),
  /**
   * Merged category by category and threshold by threshold, so tuning one
   * number leaves every other category as it was. See `categoriesSchema`.
   */
  categories: categoriesSchema("update").optional(),
});

/**
 * Body for editing a board: its selection settings, its pricing settings,
 * or both. At least one, so an empty body is refused rather than read as a
 * save that changed nothing.
 *
 * Nothing else is a board's to set. Whether approvals post back to Jira is
 * the site's grant, asked for when the site is connected, not a switch here.
 */
export const updateBoardSchema = z
  .object({
    selection: boardSelectionUpdateSchema.optional(),
    pricing: boardPricingUpdateSchema.optional(),
  })
  .refine(
    (body) => body.selection !== undefined || body.pricing !== undefined,
    { message: "Provide selection or pricing settings." },
  );

export type BoardSelection = z.infer<typeof boardSelectionSchema>;
export type BoardSelectionUpdate = z.infer<typeof boardSelectionUpdateSchema>;
export type BoardPricing = z.infer<typeof boardPricingSchema>;
export type BoardPricingUpdate = z.infer<typeof boardPricingUpdateSchema>;
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
export type JiraIssueSignalsDto = z.infer<typeof jiraIssueSignalsDtoSchema>;
export type JiraIssueSignalsPageDto = z.infer<
  typeof jiraIssueSignalsPageDtoSchema
>;
export type JiraIssuePageDto = z.infer<typeof jiraIssuePageDtoSchema>;
export type JiraBoardDto = z.infer<typeof jiraBoardDtoSchema>;
export type JiraSprintDto = z.infer<typeof jiraSprintDtoSchema>;
export type JiraSiteDto = z.infer<typeof jiraSiteDtoSchema>;
