/**
 * How far each of a user's workspaces is set up, counted in one query, so
 * the shell can answer it with the workspace list rather than six reads of
 * its own after it. The same rows the six reads list, counted the way the
 * page counts them (`apps/web/src/features/onboarding/setup.ts`).
 */

import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";

import type { Database } from "./errors.js";
import {
  bounty,
  bountyProposal,
  bountyRun,
  githubConnection,
  githubRepo,
  jiraBoard,
  jiraConnection,
  member,
  organization,
} from "./schema.js";

export interface WorkspaceSetupCounts {
  /** Jira sites that can be read. */
  readonly jiraConnected: number;
  /** Jira sites that need reconnecting. */
  readonly jiraBroken: number;
  /** Registered boards Jira has not lost. */
  readonly jiraBoards: number;
  /** Linked installations GitHub still honours. */
  readonly githubConnected: number;
  /** Registered source repositories GitHub has not lost. */
  readonly githubRepositories: number;
  readonly proposals: number;
  /** Bounties the workspace holds, sized or not. */
  readonly bounties: number;
  /** Members, the caller among them: one for a personal workspace. */
  readonly members: number;
}

export interface WorkspaceSetupStore {
  /** Each of `organizationIds`' counts; the caller has checked membership. */
  forOrganizations(
    organizationIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkspaceSetupCounts>>;
}

export function createWorkspaceSetupStore(db: Database): WorkspaceSetupStore {
  return {
    async forOrganizations(organizationIds) {
      if (organizationIds.length === 0) return new Map();
      const counted = (query: SQL) => sql<number>`(${query})::int`;
      const rows = await db
        .select({
          id: organization.id,
          jiraConnected: counted(
            sql`select count(*) from ${jiraConnection} where ${and(eq(jiraConnection.organizationId, organization.id), eq(jiraConnection.healthy, true))}`,
          ),
          jiraBroken: counted(
            sql`select count(*) from ${jiraConnection} where ${and(eq(jiraConnection.organizationId, organization.id), eq(jiraConnection.healthy, false))}`,
          ),
          jiraBoards: counted(
            sql`select count(*) from ${jiraBoard} where ${and(eq(jiraBoard.organizationId, organization.id), isNull(jiraBoard.missingSince))}`,
          ),
          githubConnected: counted(
            sql`select count(*) from ${githubConnection} where ${and(eq(githubConnection.organizationId, organization.id), eq(githubConnection.healthy, true))}`,
          ),
          githubRepositories: counted(
            sql`select count(*) from ${githubRepo} where ${and(eq(githubRepo.organizationId, organization.id), eq(githubRepo.role, "source"), ne(githubRepo.syncStatus, "gone"))}`,
          ),
          // As the proposal counts are: a proposal with its run and bounty.
          proposals: counted(
            sql`select count(*) from ${bountyProposal} inner join ${bountyRun} on ${eq(bountyRun.id, bountyProposal.runId)} inner join ${bounty} on ${eq(bounty.id, bountyProposal.bountyId)} where ${eq(bountyProposal.organizationId, organization.id)}`,
          ),
          bounties: counted(
            sql`select count(*) from ${bounty} where ${eq(bounty.organizationId, organization.id)}`,
          ),
          members: counted(
            sql`select count(*) from ${member} where ${eq(member.organizationId, organization.id)}`,
          ),
        })
        .from(organization)
        .where(inArray(organization.id, [...organizationIds]));
      return new Map(rows.map(({ id, ...counts }) => [id, counts]));
    },
  };
}
