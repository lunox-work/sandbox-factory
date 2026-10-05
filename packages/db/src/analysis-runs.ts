import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  ANALYSIS_TOOLS,
  canonicalJson,
  isFixturesParams,
  isScopeParams,
  isSliceParams,
  readsSource,
  toolOfParams,
  toolVersionOf,
} from "sandbox-factory";
import type {
  AnalysisParams,
  AnalysisStatus,
  AnalysisErrorCode,
  AnalysisTool,
  ArtifactKind,
} from "sandbox-factory";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import {
  analysisRun,
  artifact,
  githubRepo,
  githubConnection,
  organization,
  repoSnapshot,
} from "./schema.js";
import type { AnalysisRunRow } from "./schema.js";

export interface StoredAnalysisRun {
  readonly id: string;
  /** Null for a run that reads no repository: a starter's. */
  readonly snapshotId: string | null;
  readonly repoId: string | null;
  readonly tool: AnalysisTool;
  readonly toolVersion: string;
  readonly params: AnalysisParams;
  readonly status: AnalysisStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly errorCode: AnalysisErrorCode | null;
  readonly errorDetail: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly deadlineAt: string | null;
  readonly createdAt: string;
}
export interface ClaimedAnalysisRun extends StoredAnalysisRun {
  readonly organizationId: string;
  readonly leaseToken: string;
  /** Where the source is fetched from; null with no snapshot. */
  readonly commitSha: string | null;
  readonly repoFullName: string | null;
  readonly externalRepoId: string | null;
  readonly installationId: string | null;
  readonly sizeKb: number | null;
}
export interface NewArtifact {
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly meta: Record<string, unknown> | null;
}
export type EnqueueAnalysisResult =
  | {
      ok: true;
      run: StoredAnalysisRun;
      created: boolean;
      obsoleteLogKey?: string;
    }
  | {
      ok: false;
      reason: "not-found" | "run_limit" | "graph_mismatch" | "slice_mismatch";
    };
export interface AnalysisRunStore {
  /**
   * One run per `(snapshot, tool, version, params)`: an existing run that
   * is not a retryable failure is returned as is. A slice run names the
   * graphify run it reads in `params.graphRunId`, which must be a graphify
   * run on the same snapshot; the worker claims it once that run is over.
   * A scope run reads a graph the same way and waits the same way. A
   * fixtures run names a slice run that must already have succeeded on the
   * same snapshot, so it needs no wait. A sandbox build names a succeeded
   * slice run; the API checks that before enqueueing. A starter reads no
   * snapshot: `snapshotId` is null, and its cache is the organization's.
   */
  enqueue(
    organizationId: string,
    snapshotId: string | null,
    input: {
      tool?: AnalysisTool;
      params: AnalysisParams;
      /** Null for a run nothing but the platform asked for, such as a profile's. */
      requestedBy: string | null;
      maxActive?: number;
    },
  ): Promise<EnqueueAnalysisResult>;
  get(organizationId: string, runId: string): Promise<StoredAnalysisRun | null>;
  list(
    organizationId: string,
    repoId: string,
    limit?: number,
  ): Promise<StoredAnalysisRun[]>;
  /** Privileged worker queue discovery. Ownership is returned with the lease. */
  claimNext(leaseToken: string, now: Date): Promise<ClaimedAnalysisRun | null>;
  heartbeat(
    organizationId: string,
    runId: string,
    leaseToken: string,
    now: Date,
  ): Promise<boolean>;
  finish(
    organizationId: string,
    runId: string,
    leaseToken: string,
    artifacts: readonly NewArtifact[],
    logKey: string,
    now: Date,
  ): Promise<boolean>;
  fail(
    organizationId: string,
    runId: string,
    leaseToken: string,
    code: AnalysisErrorCode,
    logKey: string | null,
    now: Date,
  ): Promise<boolean>;
  release(
    organizationId: string,
    runId: string,
    leaseToken: string,
    now: Date,
  ): Promise<boolean>;
  failExpired(organizationId: string, now: Date): Promise<number>;
  /** Privileged watchdog discovery, followed by owner-scoped updates. */
  organizationsWithExpiredRuns(now: Date): Promise<string[]>;
  /** Privileged queue health, used to launch the trusted worker. */
  queueState(now: Date): Promise<{ queued: boolean; freshWorker: boolean }>;
  logKey(organizationId: string, runId: string): Promise<string | null>;
}
/**
 * `tool` is free text. A row this build does not know (written by a newer
 * deploy, then rolled back) is skipped by reads and never claimed, rather
 * than failing every listing of its repository.
 */
const knownTool = (tool: string): AnalysisTool | undefined =>
  ANALYSIS_TOOLS.find((name) => name === tool);
/** Literal list for the claim query; the names are compile-time constants. */
const KNOWN_TOOLS_SQL = sql.raw(
  ANALYSIS_TOOLS.map((name) => `'${name}'`).join(", "),
);
function toRun(row: AnalysisRunRow, repoId: string | null): StoredAnalysisRun {
  const tool = knownTool(row.tool);
  if (tool === undefined)
    throw new Error(`Unknown analysis tool ${row.tool} on run ${row.id}.`);
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    repoId,
    tool,
    toolVersion: row.toolVersion,
    params: row.params,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
const expired = (now: Date) =>
  and(
    eq(analysisRun.status, "running"),
    or(lte(analysisRun.leaseExpiresAt, now), lte(analysisRun.deadlineAt, now)),
  );
const owned = (owner: string) => eq(analysisRun.organizationId, owner);
const fence = (owner: string, id: string, token: string, now: Date) =>
  and(
    owned(owner),
    eq(analysisRun.id, id),
    eq(analysisRun.status, "running"),
    eq(analysisRun.leaseToken, token),
    gt(analysisRun.leaseExpiresAt, now),
  );

export function createAnalysisRunStore(db: Database): AnalysisRunStore {
  // Left: a run with no snapshot has no repository either.
  const joined = (tx = db) =>
    tx
      .select({ run: analysisRun, repoId: repoSnapshot.repoId })
      .from(analysisRun)
      .leftJoin(repoSnapshot, eq(repoSnapshot.id, analysisRun.snapshotId));
  return {
    async enqueue(owner, snapshotId, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        // Serialize the organization-wide spend cap, across different repositories.
        const principal = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, owner))
          .for("update");
        if (principal.length === 0)
          return { ok: false, reason: "not-found" } as const;
        const tool = input.tool ?? "graphify";
        if (toolOfParams(input.params) !== tool)
          throw new Error("Analysis parameters do not match the tool.");
        // A tool reads a snapshot exactly when it reads source.
        if (readsSource(tool) !== (snapshotId !== null))
          throw new Error("Analysis snapshot does not match the tool.");
        let repoId: string | null = null;
        if (snapshotId !== null) {
          const snapshots = await tx
            .select({ repoId: githubRepo.id })
            .from(repoSnapshot)
            .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
            .where(
              and(
                eq(githubRepo.organizationId, owner),
                eq(repoSnapshot.id, snapshotId),
                ne(githubRepo.syncStatus, "gone"),
              ),
            )
            .for("key share", { of: repoSnapshot });
          const found = snapshots[0]?.repoId;
          if (found === undefined)
            return { ok: false, reason: "not-found" } as const;
          repoId = found;
        }
        if (
          snapshotId !== null &&
          (isSliceParams(input.params) || isScopeParams(input.params))
        ) {
          // The graph a slice or a scope reads must describe the very same commit.
          const graph = await tx
            .select({ id: analysisRun.id })
            .from(analysisRun)
            .where(
              and(
                eq(analysisRun.id, input.params.graphRunId),
                eq(analysisRun.snapshotId, snapshotId),
                eq(analysisRun.tool, "graphify"),
              ),
            )
            .limit(1);
          if (graph.length === 0)
            return { ok: false, reason: "graph_mismatch" } as const;
        }
        if (snapshotId !== null && isFixturesParams(input.params)) {
          // Fixtures are written for a finished slice of the very same commit.
          const slice = await tx
            .select({ id: analysisRun.id })
            .from(analysisRun)
            .where(
              and(
                eq(analysisRun.id, input.params.sliceRunId),
                eq(analysisRun.snapshotId, snapshotId),
                eq(analysisRun.tool, "slice"),
                eq(analysisRun.status, "succeeded"),
              ),
            )
            .limit(1);
          if (slice.length === 0)
            return { ok: false, reason: "slice_mismatch" } as const;
        }
        const toolVersion = toolVersionOf(tool);
        const paramsHash = createHash("sha256")
          .update(canonicalJson(input.params))
          .digest("hex");
        const cache = and(
          owned(owner),
          snapshotId === null
            ? isNull(analysisRun.snapshotId)
            : eq(analysisRun.snapshotId, snapshotId),
          eq(analysisRun.tool, tool),
          eq(analysisRun.toolVersion, toolVersion),
          eq(analysisRun.paramsHash, paramsHash),
        );
        const existing = (
          await tx.select().from(analysisRun).where(cache).limit(1)
        )[0] as AnalysisRunRow | undefined;
        if (
          existing !== undefined &&
          (existing.status !== "failed" ||
            existing.attempt >= existing.maxAttempts)
        )
          return {
            ok: true,
            run: toRun(existing, repoId),
            created: false,
          } as const;
        const maxActive = input.maxActive ?? 3;
        const active = await tx
          .select({ id: analysisRun.id })
          .from(analysisRun)
          .where(
            and(
              owned(owner),
              or(
                eq(analysisRun.status, "queued"),
                eq(analysisRun.status, "running"),
              ),
            ),
          )
          .limit(maxActive);
        if (active.length >= maxActive)
          return { ok: false, reason: "run_limit" } as const;
        const rows =
          existing === undefined
            ? await tx
                .insert(analysisRun)
                .values({
                  id: generateId("arn"),
                  organizationId: owner,
                  snapshotId,
                  tool,
                  toolVersion,
                  params: input.params,
                  paramsHash,
                  requestedBy: input.requestedBy,
                })
                .returning()
            : await tx
                .update(analysisRun)
                .set({
                  status: "queued",
                  attempt: existing.attempt + 1,
                  errorCode: null,
                  errorDetail: null,
                  finishedAt: null,
                  logKey: null,
                })
                .where(and(cache, eq(analysisRun.status, "failed")))
                .returning();
        const row = rows[0] as AnalysisRunRow | undefined;
        if (row === undefined)
          throw new Error("Analysis enqueue did not return a row.");
        return {
          ok: true,
          run: toRun(row, repoId),
          created: true,
          ...(existing?.logKey == null
            ? {}
            : { obsoleteLogKey: existing.logKey }),
        } as const;
      });
    },
    async get(owner, id) {
      const row = (
        await joined().where(and(owned(owner), eq(analysisRun.id, id)))
      )[0];
      return row === undefined || knownTool(row.run.tool) === undefined
        ? null
        : toRun(row.run, row.repoId);
    },
    async list(owner, repoId, limit = 25) {
      const rows = await joined()
        .where(and(owned(owner), eq(repoSnapshot.repoId, repoId)))
        .orderBy(desc(analysisRun.createdAt), desc(analysisRun.id))
        .limit(Math.min(50, Math.max(1, limit)));
      return rows
        .filter((row) => knownTool(row.run.tool) !== undefined)
        .map((row) => toRun(row.run, row.repoId));
    },
    async claimNext(token, now) {
      const rows = await db
        .update(analysisRun)
        .set({
          status: "running",
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          heartbeatAt: now,
          startedAt: now,
          deadlineAt: sql`${now.toISOString()}::timestamptz + ((${analysisRun.params}->>'deadlineMinutes')::int * interval '1 minute')`,
          finishedAt: null,
        })
        .where(
          // A slice or a scope waits for the graphify run it reads to finish
          // either way; the worker then fails it cleanly if that run did not
          // succeed.
          sql`${analysisRun.id} = (select a.id from analysis_run a where a.status = 'queued' and a.tool in (${KNOWN_TOOLS_SQL}) and (a.tool not in ('slice', 'scope') or not exists (select 1 from analysis_run g where g.id = a.params->>'graphRunId' and g.status in ('queued', 'running'))) order by a.created_at, a.id for update of a skip locked limit 1)`,
        )
        .returning();
      const run = rows[0];
      if (run === undefined) return null;
      if (run.snapshotId === null)
        return {
          ...toRun(run, null),
          organizationId: run.organizationId,
          commitSha: null,
          repoFullName: null,
          externalRepoId: null,
          installationId: null,
          sizeKb: null,
          leaseToken: token,
        };
      const context = (
        await db
          .select({
            repoId: githubRepo.id,
            organizationId: githubRepo.organizationId,
            commitSha: repoSnapshot.commitSha,
            repoFullName: githubRepo.fullName,
            externalRepoId: githubRepo.externalId,
            sizeKb: githubRepo.sizeKb,
            installationId: githubConnection.installationId,
          })
          .from(repoSnapshot)
          .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
          .innerJoin(
            githubConnection,
            eq(githubConnection.id, githubRepo.connectionId),
          )
          .where(eq(repoSnapshot.id, run.snapshotId))
      )[0];
      return context === undefined
        ? null
        : { ...toRun(run, context.repoId), ...context, leaseToken: token };
    },
    async heartbeat(owner, id, token, now) {
      const rows = await db
        .update(analysisRun)
        .set({
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        })
        .where(
          and(fence(owner, id, token, now), gt(analysisRun.deadlineAt, now)),
        )
        .returning({ id: analysisRun.id });
      return rows.length > 0;
    },
    async finish(owner, id, token, artifacts, logKey, now) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const rows = await tx
          .update(analysisRun)
          .set({
            status: "succeeded",
            logKey,
            errorCode: null,
            errorDetail: null,
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(fence(owner, id, token, now), gt(analysisRun.deadlineAt, now)),
          )
          .returning({ id: analysisRun.id });
        if (rows.length === 0) return false;
        for (const item of artifacts)
          await tx
            .insert(artifact)
            .values({ id: generateId("art"), runId: id, ...item });
        return true;
      });
    },
    async fail(owner, id, token, code, logKey, now) {
      const rows = await db
        .update(analysisRun)
        .set({
          status: "failed",
          errorCode: code,
          errorDetail: null,
          logKey,
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(fence(owner, id, token, now))
        .returning({ id: analysisRun.id });
      return rows.length > 0;
    },
    async release(owner, id, token, now) {
      const rows = await db
        .update(analysisRun)
        .set({
          status: "queued",
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
        .where(fence(owner, id, token, now))
        .returning({ id: analysisRun.id });
      return rows.length > 0;
    },
    async failExpired(owner, now) {
      const rows = await db
        .update(analysisRun)
        .set({
          status: sql`case when ${analysisRun.attempt} < ${analysisRun.maxAttempts} then 'queued' else 'failed' end`,
          attempt: sql`least(${analysisRun.attempt} + 1, ${analysisRun.maxAttempts})`,
          errorCode: "worker_lost",
          errorDetail: null,
          finishedAt: sql`case when ${analysisRun.attempt} < ${analysisRun.maxAttempts} then null else ${now.toISOString()}::timestamptz end`,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
        .where(and(owned(owner), expired(now)))
        .returning({ id: analysisRun.id });
      return rows.length;
    },
    async organizationsWithExpiredRuns(now) {
      const rows = await db
        .select({ organizationId: analysisRun.organizationId })
        .from(analysisRun)
        .where(expired(now));
      return [...new Set(rows.map((row) => row.organizationId))];
    },
    async queueState(now) {
      const queued = await db
        .select({ id: analysisRun.id })
        .from(analysisRun)
        .where(eq(analysisRun.status, "queued"))
        .limit(1);
      const fresh = await db
        .select({ id: analysisRun.id })
        .from(analysisRun)
        .where(
          and(
            eq(analysisRun.status, "running"),
            gt(analysisRun.heartbeatAt, new Date(now.getTime() - 60_000)),
            gt(analysisRun.deadlineAt, now),
          ),
        )
        .limit(1);
      return { queued: queued.length > 0, freshWorker: fresh.length > 0 };
    },
    async logKey(owner, id) {
      const row = (
        await db
          .select({ logKey: analysisRun.logKey })
          .from(analysisRun)
          .where(and(owned(owner), eq(analysisRun.id, id)))
      )[0];
      return row?.logKey ?? null;
    },
  };
}
