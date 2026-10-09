/**
 * A bounty's synced context on the wire: what its Jira issue and the
 * workspace's repositories' documents said when a person last synced each, and where
 * each source stands against that sync now.
 * `/api/v1/orgs/:orgId/bounties/:id/context`.
 */

import { CONTEXT_SOURCES, NO_CONTEXT } from "sandbox-factory";
import { z } from "zod";

export const contextSourceSchema = z.enum(CONTEXT_SOURCES);

/** The context version each source stands at; null for none. */
export const contextVersionsSchema = z.object({
  jira: z.number().int().positive().nullable(),
  github: z.number().int().positive().nullable(),
});

/** Context versions where an older answer may carry none. */
export const contextVersionsDefault = contextVersionsSchema.default({
  ...NO_CONTEXT,
});

export const jiraContextSchema = z.object({
  key: z.string(),
  issueType: z.string().nullable(),
  status: z.string().nullable(),
  statusCategory: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  components: z.array(z.string()),
  fixVersions: z.array(z.string()),
  parentKey: z.string().nullable(),
  dueDate: z.string().nullable(),
  storyPoints: z.number().nullable(),
  originalEstimateSeconds: z.number().nullable(),
  remainingEstimateSeconds: z.number().nullable(),
  votes: z.number().nullable(),
  watchers: z.number().nullable(),
  subtaskCount: z.number().int().nonnegative(),
  links: z.array(
    z.object({
      type: z.string(),
      direction: z.enum(["inward", "outward"]),
      key: z.string().nullable(),
      done: z.boolean(),
    }),
  ),
  updated: z.string().nullable(),
});

/** One repository's documents, read at one commit. */
export const githubRepositoryContextSchema = z.object({
  fullName: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  documents: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      text: z.string(),
      truncated: z.boolean(),
    }),
  ),
  omitted: z.number().int().nonnegative(),
});

/**
 * The workspace's repositories' documents, read together; or, for a
 * version synced while a bounty named one repository, that one's alone.
 */
export const githubContextSchema = z.union([
  z.object({
    repositories: z.array(githubRepositoryContextSchema),
    unread: z.array(z.string()),
  }),
  githubRepositoryContextSchema,
]);

const contextVersionBase = {
  version: z.number().int().positive(),
  /**
   * What the source is called: the issue's key; for GitHub, the one
   * repository's name, or how many the workspace's sync read.
   */
  ref: z.string(),
  /** Where the source stood when it was last read. */
  revision: z.string(),
  syncedBy: z.string().nullable(),
  /** When this version was made. */
  createdAt: z.iso.datetime(),
  /** The last sync that found it still what the source says. */
  checkedAt: z.iso.datetime(),
};

/** One version of a source's context, with what it said. */
export const bountyContextVersionDtoSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("jira"),
    ...contextVersionBase,
    content: jiraContextSchema,
  }),
  z.object({
    source: z.literal("github"),
    ...contextVersionBase,
    content: githubContextSchema,
  }),
]);

/**
 * Where a source stands against the bounty's context:
 *
 * - `unlinked`: the bounty has no such source.
 * - `unsynced`: it has one, and nothing synced from it yet. `latest` may
 *   still hold what an earlier source said.
 * - `current`: the latest sync is what the source says now.
 * - `ahead`: the source has moved past its latest sync.
 * - `unavailable`: the source cannot be read now; `reason` says why.
 */
export const contextSyncStateSchema = z.enum([
  "unlinked",
  "unsynced",
  "current",
  "ahead",
  "unavailable",
]);

export const bountyContextSourceStatusSchema = z.object({
  state: contextSyncStateSchema,
  /** A fixed code for `unavailable`, such as `reconnect`; else null. */
  reason: z.string().nullable(),
  /** The source linked now: its name, and where it is read; null for none. */
  linked: z.object({ ref: z.string(), url: z.url().nullable() }).nullable(),
  /** Where the source stands now, when it was read: `updated`, the head. */
  liveRevision: z.string().nullable(),
  latest: bountyContextVersionDtoSchema.nullable(),
});

export const bountyContextResponseSchema = z.object({
  jira: bountyContextSourceStatusSchema,
  github: bountyContextSourceStatusSchema,
});

export type ContextSourceDto = z.infer<typeof contextSourceSchema>;
export type ContextVersionsDto = z.infer<typeof contextVersionsSchema>;
export type JiraContextDto = z.infer<typeof jiraContextSchema>;
export type GithubRepositoryContextDto = z.infer<
  typeof githubRepositoryContextSchema
>;
export type GithubContextDto = z.infer<typeof githubContextSchema>;
export type BountyContextVersionDto = z.infer<
  typeof bountyContextVersionDtoSchema
>;
export type ContextSyncState = z.infer<typeof contextSyncStateSchema>;
export type BountyContextSourceStatusDto = z.infer<
  typeof bountyContextSourceStatusSchema
>;
export type BountyContextResponse = z.infer<typeof bountyContextResponseSchema>;
