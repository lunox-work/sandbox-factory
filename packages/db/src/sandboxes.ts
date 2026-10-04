/**
 * Sandboxes and their versions, owner-scoped.
 *
 * Every read joins `sandbox.organization_id`; every write is reached
 * through such a read inside one transaction. The store checks what the
 * schema cannot: the bounty and the source repository belong to the owner,
 * and the repository has `role = source`; a version's slice run succeeded
 * on a snapshot of that very repository; and private provenance stops
 * changing the moment a version is frozen. The schema holds the rest: one
 * sandbox per bounty.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  AcceptanceTest,
  AliasRule,
  ApprovedTaskSnapshot,
  StoredApprovedTaskSnapshot,
  DependencyChoice,
  SandboxStatus,
  ScopeRecord,
  VersionFixtures,
  VersionSourceRecord,
} from "sandbox-factory";
import { isUniqueViolation, type Database } from "./errors.js";
import { generateId } from "./mapping.js";
import {
  analysisRun,
  artifact,
  githubRepo,
  bounty,
  repoSnapshot,
  sandbox,
  sandboxSource,
  sandboxVersion,
  sandboxVersionSource,
} from "./schema.js";
import type {
  SandboxRow,
  SandboxVersionRow,
  SandboxVersionSourceRow,
} from "./schema.js";

export interface StoredSandbox {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly status: SandboxStatus;
  readonly publicRepoId: string | null;
  readonly currentVersionId: string | null;
  /** The bounty this is the sandbox of. */
  readonly bountyId: string;
  /** Null until a repository is linked; no version can be sliced before. */
  readonly sourceRepoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StoredSandboxVersion {
  readonly id: string;
  readonly sandboxId: string;
  readonly version: number;
  readonly title: string;
  readonly specSummary: string;
  readonly complexity: string;
  readonly tags: readonly string[];
  readonly testSummary: readonly { label: string; count: number }[];
  readonly publicBaseCommitSha: string | null;
  readonly readme: string | null;
  readonly languages: Readonly<Record<string, number>> | null;
  readonly frozenAt: string | null;
  readonly createdAt: string;
}
export interface StoredVersionSource extends VersionSourceRecord {
  readonly sourceCommitSha: string;
  readonly approvedTask: StoredApprovedTaskSnapshot;
  readonly dependencyChoices: Readonly<Record<string, DependencyChoice>>;
  readonly acceptanceTests: readonly AcceptanceTest[];
  readonly fixtures: VersionFixtures | null;
  readonly scope: ScopeRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface NewSandboxVersion {
  readonly title: string;
  readonly specSummary: string;
  readonly complexity: string;
  readonly tags: readonly string[];
  readonly testSummary?: readonly { label: string; count: number }[];
  readonly source: {
    readonly sourceSnapshotId: string;
    readonly sliceRunId: string;
    readonly manifestSha256: string;
    readonly contractSha256: string;
    readonly transformConfigSha256: string;
    readonly approvedTaskSha256: string;
    /** Always the current version: a new version is never frozen as an old one. */
    readonly approvedTask: ApprovedTaskSnapshot;
    readonly aliasRules: readonly AliasRule[];
    readonly dependencyChoices: Readonly<Record<string, DependencyChoice>>;
    readonly acceptanceTests: readonly AcceptanceTest[];
    readonly fixtures?: VersionFixtures | null;
    readonly scope: ScopeRecord;
  };
}
/** What may change on a draft. Everything here is private or pre-publication. */
export interface SandboxVersionPatch {
  readonly title?: string;
  readonly specSummary?: string;
  readonly complexity?: string;
  readonly tags?: readonly string[];
  readonly testSummary?: readonly { label: string; count: number }[];
  readonly readme?: string | null;
  readonly aliasRules?: readonly AliasRule[];
  readonly dependencyChoices?: Readonly<Record<string, DependencyChoice>>;
  readonly acceptanceTests?: readonly AcceptanceTest[];
  /** Null drops the version's fixtures. */
  readonly fixtures?: VersionFixtures | null;
  readonly transformConfigSha256?: string;
  readonly scope?: ScopeRecord;
  /**
   * The transform hash the caller merged its change onto. When it no longer
   * matches the locked row, someone else changed the transform in between
   * and the update is refused with `conflict` rather than overwriting it.
   */
  readonly expectedTransformConfigSha256?: string;
}
/** What a succeeded, ready build proves; required at freeze. */
export interface BuildOutput {
  readonly harnessSha256: string;
  readonly toolchainDigest: string;
}
export type CreateSandboxResult =
  | { readonly ok: true; readonly sandbox: StoredSandbox }
  | {
      readonly ok: false;
      readonly reason:
        | "bounty_not_found"
        | "bounty_has_sandbox"
        | "repo_not_found"
        | "repo_role";
    };
export type LinkSourceResult =
  | { readonly ok: true; readonly sandbox: StoredSandbox }
  | {
      readonly ok: false;
      readonly reason:
        "not-found" | "source_linked" | "repo_not_found" | "repo_role";
    };
export interface StoredVersionWithSource {
  readonly version: StoredSandboxVersion;
  readonly source: StoredVersionSource;
}
export type CreateVersionResult =
  | ({ readonly ok: true } & StoredVersionWithSource)
  | {
      readonly ok: false;
      readonly reason: "not-found" | "no_source" | "slice_mismatch";
    };
export type UpdateVersionResult =
  | ({ readonly ok: true } & StoredVersionWithSource)
  | {
      readonly ok: false;
      readonly reason: "not-found" | "frozen" | "conflict";
    };
export interface ReplayContext {
  readonly source: StoredVersionSource;
  readonly snapshot: {
    readonly commitSha: string;
    readonly repoGone: boolean;
  } | null;
  readonly sliceRun: {
    readonly status: string;
    readonly artifactsPresent: boolean;
  } | null;
}

export interface SandboxStore {
  /** The bounty's sandbox; refused when the bounty already has one. */
  create(
    organizationId: string,
    input: { bountyId: string; sourceRepoId: string | null },
  ): Promise<CreateSandboxResult>;
  list(organizationId: string): Promise<StoredSandbox[]>;
  get(organizationId: string, sandboxId: string): Promise<StoredSandbox | null>;
  /**
   * Links the repository a sandbox made without one is cut from. A link
   * stays: the versions sliced from it are bound to that repository, so a
   * different one is refused with `source_linked`, and the same one again
   * is no change.
   */
  linkSource(
    organizationId: string,
    sandboxId: string,
    sourceRepoId: string,
  ): Promise<LinkSourceResult>;
  /**
   * A new draft version from a succeeded slice run on the sandbox's own
   * source repository. The version number is the next one; two drafts can
   * carry different provenance without touching each other.
   */
  createVersion(
    organizationId: string,
    sandboxId: string,
    input: NewSandboxVersion,
    now?: Date,
  ): Promise<CreateVersionResult>;
  listVersions(
    organizationId: string,
    sandboxId: string,
  ): Promise<StoredSandboxVersion[]>;
  getVersion(
    organizationId: string,
    versionId: string,
  ): Promise<StoredVersionWithSource | null>;
  /**
   * Refused with `frozen` once `frozen_at` is set: frozen provenance never
   * changes. A transform change clears every piece of evidence gathered for
   * the old transform.
   */
  updateDraft(
    organizationId: string,
    versionId: string,
    patch: SandboxVersionPatch,
    now?: Date,
  ): Promise<UpdateVersionResult>;
  /**
   * Points the draft at a newly queued build. Refused with `conflict` when
   * the transform is no longer the one the build was queued with: that run
   * carries stale hashes and the worker will reject it. Evidence from any
   * earlier build is cleared, since it described a different run.
   */
  recordBuild(
    organizationId: string,
    versionId: string,
    buildRunId: string,
    expectedTransformConfigSha256: string,
    now?: Date,
  ): Promise<UpdateVersionResult>;
  /**
   * Records what a succeeded build proved. Applies only while the draft
   * still points at that build and is not frozen; `false` otherwise.
   */
  recordBuildOutput(
    organizationId: string,
    versionId: string,
    buildRunId: string,
    output: BuildOutput,
    now?: Date,
  ): Promise<boolean>;
  /** What a replay needs to decide between the original source and `source_unavailable`. */
  replayContext(
    organizationId: string,
    versionId: string,
  ): Promise<ReplayContext | null>;
}

const toSandbox = (
  row: SandboxRow,
  sourceRepoId: string | null,
): StoredSandbox => ({
  id: row.id,
  organizationId: row.organizationId,
  slug: row.slug,
  status: row.status,
  publicRepoId: row.publicRepoId,
  currentVersionId: row.currentVersionId,
  bountyId: row.bountyId,
  sourceRepoId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const toVersion = (row: SandboxVersionRow): StoredSandboxVersion => ({
  id: row.id,
  sandboxId: row.sandboxId,
  version: row.version,
  title: row.title,
  specSummary: row.specSummary,
  complexity: row.complexity,
  tags: row.tags,
  testSummary: row.testSummary,
  publicBaseCommitSha: row.publicBaseCommitSha,
  readme: row.readme,
  languages: row.languages,
  frozenAt: row.frozenAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
const toSource = (
  row: SandboxVersionSourceRow,
  sourceCommitSha: string,
): StoredVersionSource => ({
  sandboxVersionId: row.sandboxVersionId,
  sourceSnapshotId: row.sourceSnapshotId,
  sourceCommitSha,
  sliceRunId: row.sliceRunId,
  manifestSha256: row.manifestSha256,
  contractSha256: row.contractSha256,
  transformConfigSha256: row.transformConfigSha256,
  approvedTaskSha256: row.approvedTaskSha256,
  approvedTask: row.approvedTask,
  aliasRules: row.aliasRules,
  dependencyChoices: row.dependencyChoices,
  acceptanceTests: row.acceptanceTests,
  fixtures: row.fixtures ?? null,
  scope: row.scope,
  harnessSha256: row.harnessSha256,
  toolchainDigest: row.toolchainDigest,
  buildRunId: row.buildRunId,
  roundTripRunId: row.roundTripRunId,
  disclosureRunId: row.disclosureRunId,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Evidence gathered for one transform and one build; cleared when either changes. */
const CLEARED_EVIDENCE = {
  buildRunId: null,
  harnessSha256: null,
  toolchainDigest: null,
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
} as const;

/** Opaque: a listing slug says nothing about the module it was cut from. */
export function sandboxSlug(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Why a repository cannot back the owner's sandbox, or null when it can:
 * it must be the owner's, still connected, and registered as a source.
 */
async function sourceRepoProblem(
  tx: Database,
  owner: string,
  repoId: string,
): Promise<"repo_not_found" | "repo_role" | null> {
  const repo = (
    await tx
      .select({ role: githubRepo.role, syncStatus: githubRepo.syncStatus })
      .from(githubRepo)
      .where(
        and(eq(githubRepo.organizationId, owner), eq(githubRepo.id, repoId)),
      )
      .limit(1)
  )[0];
  if (repo === undefined || repo.syncStatus === "gone") return "repo_not_found";
  return repo.role === "source" ? null : "repo_role";
}

export function createSandboxStore(db: Database): SandboxStore {
  // Left: a sandbox with no repository is still a sandbox.
  const sandboxes = (tx: Database = db) =>
    tx
      .select({ sandbox, sourceRepoId: sandboxSource.sourceRepoId })
      .from(sandbox)
      .leftJoin(sandboxSource, eq(sandboxSource.sandboxId, sandbox.id));
  const versions = (tx: Database = db) =>
    tx
      .select({
        version: sandboxVersion,
        source: sandboxVersionSource,
        commitSha: repoSnapshot.commitSha,
      })
      .from(sandboxVersion)
      .innerJoin(sandbox, eq(sandbox.id, sandboxVersion.sandboxId))
      .innerJoin(
        sandboxVersionSource,
        eq(sandboxVersionSource.sandboxVersionId, sandboxVersion.id),
      )
      .innerJoin(
        repoSnapshot,
        eq(repoSnapshot.id, sandboxVersionSource.sourceSnapshotId),
      );
  /** A version change is a change to its sandbox, for listings that sort by it. */
  const touch = (tx: Database, sandboxId: string, now: Date) =>
    tx.update(sandbox).set({ updatedAt: now }).where(eq(sandbox.id, sandboxId));
  const lockVersion = async (tx: Database, owner: string, versionId: string) =>
    (
      await versions(tx)
        .where(
          and(
            eq(sandbox.organizationId, owner),
            eq(sandboxVersion.id, versionId),
          ),
        )
        .for("update", { of: sandboxVersion })
    )[0];
  return {
    async create(owner, input) {
      try {
        return await db.transaction(async (transaction) => {
          const tx = transaction;
          // Key-share locked, as the foreign key would: a removal of the
          // bounty in flight waits for this, and then sees the sandbox.
          const owned = await tx
            .select({ id: bounty.id })
            .from(bounty)
            .where(
              and(
                eq(bounty.organizationId, owner),
                eq(bounty.id, input.bountyId),
              ),
            )
            .for("key share");
          if (owned[0] === undefined)
            return { ok: false, reason: "bounty_not_found" } as const;
          const taken = await tx
            .select({ id: sandbox.id })
            .from(sandbox)
            .where(eq(sandbox.bountyId, input.bountyId))
            .limit(1);
          if (taken[0] !== undefined)
            return { ok: false, reason: "bounty_has_sandbox" } as const;
          if (input.sourceRepoId !== null) {
            const problem = await sourceRepoProblem(
              tx,
              owner,
              input.sourceRepoId,
            );
            if (problem !== null)
              return { ok: false, reason: problem } as const;
          }
          const rows = await tx
            .insert(sandbox)
            .values({
              id: generateId("sbx"),
              organizationId: owner,
              bountyId: input.bountyId,
              slug: sandboxSlug(),
            })
            .returning();
          const row = rows[0] as SandboxRow | undefined;
          if (row === undefined)
            throw new Error("Sandbox insert returned no row.");
          if (input.sourceRepoId !== null)
            await tx
              .insert(sandboxSource)
              .values({ sandboxId: row.id, sourceRepoId: input.sourceRepoId });
          return {
            ok: true,
            sandbox: toSandbox(row, input.sourceRepoId),
          } as const;
        });
      } catch (error) {
        // Two creates for one bounty: the second meets the first's row.
        if (isUniqueViolation(error))
          return { ok: false, reason: "bounty_has_sandbox" } as const;
        throw error;
      }
    },
    async list(owner) {
      const rows = await sandboxes()
        .where(eq(sandbox.organizationId, owner))
        .orderBy(desc(sandbox.createdAt), desc(sandbox.id));
      return rows.map((row) => toSandbox(row.sandbox, row.sourceRepoId));
    },
    async get(owner, id) {
      const row = (
        await sandboxes().where(
          and(eq(sandbox.organizationId, owner), eq(sandbox.id, id)),
        )
      )[0];
      return row === undefined
        ? null
        : toSandbox(row.sandbox, row.sourceRepoId);
    },
    async linkSource(owner, sandboxId, sourceRepoId) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        // Locked as cutting a version locks it, so no slice is checked
        // against a repository while one is being linked.
        const row = (
          (await tx
            .select()
            .from(sandbox)
            .where(
              and(eq(sandbox.organizationId, owner), eq(sandbox.id, sandboxId)),
            )
            .for("update")) as SandboxRow[]
        )[0];
        if (row === undefined)
          return { ok: false, reason: "not-found" } as const;
        // A statement of its own, after the lock: a link committed while
        // this waited is seen, rather than met as a duplicate key.
        const linked = (
          await tx
            .select({ sourceRepoId: sandboxSource.sourceRepoId })
            .from(sandboxSource)
            .where(eq(sandboxSource.sandboxId, row.id))
            .limit(1)
        )[0];
        if (linked !== undefined)
          return linked.sourceRepoId === sourceRepoId
            ? ({ ok: true, sandbox: toSandbox(row, sourceRepoId) } as const)
            : ({ ok: false, reason: "source_linked" } as const);
        const problem = await sourceRepoProblem(tx, owner, sourceRepoId);
        if (problem !== null) return { ok: false, reason: problem } as const;
        await tx
          .insert(sandboxSource)
          .values({ sandboxId: row.id, sourceRepoId });
        return { ok: true, sandbox: toSandbox(row, sourceRepoId) } as const;
      });
    },
    async createVersion(owner, sandboxId, input, now = new Date()) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const parent = (
          await sandboxes(tx)
            .where(
              and(eq(sandbox.organizationId, owner), eq(sandbox.id, sandboxId)),
            )
            .for("update", { of: sandbox })
        )[0];
        if (parent === undefined)
          return { ok: false, reason: "not-found" } as const;
        // Slicing is the one thing a sandbox needs a repository for.
        const sourceRepoId = parent.sourceRepoId;
        if (sourceRepoId === null)
          return { ok: false, reason: "no_source" } as const;
        // The slice must have succeeded on a snapshot of this sandbox's own
        // source repository, which is the owner's.
        const slice = (
          await tx
            .select({ commitSha: repoSnapshot.commitSha })
            .from(analysisRun)
            .innerJoin(
              repoSnapshot,
              eq(repoSnapshot.id, analysisRun.snapshotId),
            )
            .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
            .where(
              and(
                eq(analysisRun.id, input.source.sliceRunId),
                eq(analysisRun.snapshotId, input.source.sourceSnapshotId),
                eq(analysisRun.tool, "slice"),
                eq(analysisRun.status, "succeeded"),
                eq(githubRepo.id, sourceRepoId),
                eq(githubRepo.organizationId, owner),
              ),
            )
            .limit(1)
        )[0];
        if (slice === undefined)
          return { ok: false, reason: "slice_mismatch" } as const;
        const latest = (
          await tx
            .select({
              version: sql<number>`coalesce(max(${sandboxVersion.version}), 0)`,
            })
            .from(sandboxVersion)
            .where(eq(sandboxVersion.sandboxId, sandboxId))
        )[0];
        const versionRows = await tx
          .insert(sandboxVersion)
          .values({
            id: generateId("sbv"),
            sandboxId,
            version: Number(latest?.version ?? 0) + 1,
            title: input.title,
            specSummary: input.specSummary,
            complexity: input.complexity,
            tags: [...input.tags],
            testSummary: [...(input.testSummary ?? [])],
          })
          .returning();
        const versionRow = versionRows[0] as SandboxVersionRow | undefined;
        if (versionRow === undefined)
          throw new Error("Sandbox version insert returned no row.");
        const sourceRows = await tx
          .insert(sandboxVersionSource)
          .values({
            sandboxVersionId: versionRow.id,
            sourceSnapshotId: input.source.sourceSnapshotId,
            sliceRunId: input.source.sliceRunId,
            manifestSha256: input.source.manifestSha256,
            contractSha256: input.source.contractSha256,
            transformConfigSha256: input.source.transformConfigSha256,
            approvedTaskSha256: input.source.approvedTaskSha256,
            approvedTask: input.source.approvedTask,
            aliasRules: [...input.source.aliasRules],
            dependencyChoices: { ...input.source.dependencyChoices },
            acceptanceTests: [...input.source.acceptanceTests],
            fixtures: input.source.fixtures ?? null,
            scope: input.source.scope,
          })
          .returning();
        const sourceRow = sourceRows[0] as SandboxVersionSourceRow | undefined;
        if (sourceRow === undefined)
          throw new Error("Sandbox version source insert returned no row.");
        await touch(tx, sandboxId, now);
        return {
          ok: true,
          version: toVersion(versionRow),
          source: toSource(sourceRow, slice.commitSha),
        } as const;
      });
    },
    async listVersions(owner, sandboxId) {
      const rows = await db
        .select({ version: sandboxVersion })
        .from(sandboxVersion)
        .innerJoin(sandbox, eq(sandbox.id, sandboxVersion.sandboxId))
        .where(
          and(eq(sandbox.organizationId, owner), eq(sandbox.id, sandboxId)),
        )
        .orderBy(desc(sandboxVersion.version));
      return rows.map((row) => toVersion(row.version));
    },
    async getVersion(owner, versionId) {
      const row = (
        await versions().where(
          and(
            eq(sandbox.organizationId, owner),
            eq(sandboxVersion.id, versionId),
          ),
        )
      )[0];
      return row === undefined
        ? null
        : {
            version: toVersion(row.version),
            source: toSource(row.source, row.commitSha),
          };
    },
    async updateDraft(owner, versionId, patch, now = new Date()) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const current = await lockVersion(tx, owner, versionId);
        if (current === undefined)
          return { ok: false, reason: "not-found" } as const;
        if (current.version.frozenAt !== null)
          return { ok: false, reason: "frozen" } as const;
        if (
          patch.expectedTransformConfigSha256 !== undefined &&
          patch.expectedTransformConfigSha256 !==
            current.source.transformConfigSha256
        )
          return { ok: false, reason: "conflict" } as const;
        const versionSet: Partial<typeof sandboxVersion.$inferInsert> = {};
        if (patch.title !== undefined) versionSet.title = patch.title;
        if (patch.specSummary !== undefined)
          versionSet.specSummary = patch.specSummary;
        if (patch.complexity !== undefined)
          versionSet.complexity = patch.complexity;
        if (patch.tags !== undefined) versionSet.tags = [...patch.tags];
        if (patch.testSummary !== undefined)
          versionSet.testSummary = [...patch.testSummary];
        if (patch.readme !== undefined) versionSet.readme = patch.readme;
        let versionRow = current.version;
        if (Object.keys(versionSet).length > 0) {
          const rows = await tx
            .update(sandboxVersion)
            .set(versionSet)
            .where(
              and(
                eq(sandboxVersion.id, versionId),
                isNull(sandboxVersion.frozenAt),
              ),
            )
            .returning();
          const row = rows[0] as SandboxVersionRow | undefined;
          if (row === undefined)
            return { ok: false, reason: "frozen" } as const;
          versionRow = row;
        }
        const sourceSet: Partial<typeof sandboxVersionSource.$inferInsert> = {};
        if (patch.aliasRules !== undefined)
          sourceSet.aliasRules = [...patch.aliasRules];
        if (patch.dependencyChoices !== undefined)
          sourceSet.dependencyChoices = { ...patch.dependencyChoices };
        if (patch.acceptanceTests !== undefined)
          sourceSet.acceptanceTests = [...patch.acceptanceTests];
        if (patch.fixtures !== undefined) sourceSet.fixtures = patch.fixtures;
        if (patch.transformConfigSha256 !== undefined)
          sourceSet.transformConfigSha256 = patch.transformConfigSha256;
        if (patch.scope !== undefined) sourceSet.scope = patch.scope;
        let sourceRow = current.source;
        if (Object.keys(sourceSet).length > 0) {
          // A changed transform invalidates evidence gathered for the old one.
          const invalidates =
            patch.aliasRules !== undefined ||
            patch.dependencyChoices !== undefined ||
            patch.acceptanceTests !== undefined ||
            patch.fixtures !== undefined ||
            patch.transformConfigSha256 !== undefined;
          const rows = await tx
            .update(sandboxVersionSource)
            .set({
              ...sourceSet,
              ...(invalidates ? CLEARED_EVIDENCE : {}),
              updatedAt: now,
            })
            .where(eq(sandboxVersionSource.sandboxVersionId, versionId))
            .returning();
          const row = rows[0] as SandboxVersionSourceRow | undefined;
          if (row === undefined)
            return { ok: false, reason: "not-found" } as const;
          sourceRow = row;
        }
        if (
          Object.keys(versionSet).length > 0 ||
          Object.keys(sourceSet).length > 0
        )
          await touch(tx, current.version.sandboxId, now);
        return {
          ok: true,
          version: toVersion(versionRow),
          source: toSource(sourceRow, current.commitSha),
        } as const;
      });
    },
    async recordBuild(
      owner,
      versionId,
      buildRunId,
      expected,
      now = new Date(),
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const current = await lockVersion(tx, owner, versionId);
        if (current === undefined)
          return { ok: false, reason: "not-found" } as const;
        if (current.version.frozenAt !== null)
          return { ok: false, reason: "frozen" } as const;
        if (current.source.transformConfigSha256 !== expected)
          return { ok: false, reason: "conflict" } as const;
        const rows = await tx
          .update(sandboxVersionSource)
          .set({ ...CLEARED_EVIDENCE, buildRunId, updatedAt: now })
          .where(eq(sandboxVersionSource.sandboxVersionId, versionId))
          .returning();
        const row = rows[0] as SandboxVersionSourceRow | undefined;
        if (row === undefined)
          return { ok: false, reason: "not-found" } as const;
        await touch(tx, current.version.sandboxId, now);
        return {
          ok: true,
          version: toVersion(current.version),
          source: toSource(row, current.commitSha),
        } as const;
      });
    },
    async recordBuildOutput(
      owner,
      versionId,
      buildRunId,
      output,
      now = new Date(),
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const current = await lockVersion(tx, owner, versionId);
        if (
          current === undefined ||
          current.version.frozenAt !== null ||
          current.source.buildRunId !== buildRunId
        )
          return false;
        await tx
          .update(sandboxVersionSource)
          .set({
            harnessSha256: output.harnessSha256,
            toolchainDigest: output.toolchainDigest,
            updatedAt: now,
          })
          .where(eq(sandboxVersionSource.sandboxVersionId, versionId));
        await touch(tx, current.version.sandboxId, now);
        return true;
      });
    },
    async replayContext(owner, versionId) {
      const row = (
        await db
          .select({ source: sandboxVersionSource })
          .from(sandboxVersionSource)
          .innerJoin(
            sandboxVersion,
            eq(sandboxVersion.id, sandboxVersionSource.sandboxVersionId),
          )
          .innerJoin(sandbox, eq(sandbox.id, sandboxVersion.sandboxId))
          .where(
            and(
              eq(sandbox.organizationId, owner),
              eq(sandboxVersion.id, versionId),
            ),
          )
      )[0];
      if (row === undefined) return null;
      const snapshot = (
        await db
          .select({
            commitSha: repoSnapshot.commitSha,
            syncStatus: githubRepo.syncStatus,
          })
          .from(repoSnapshot)
          .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
          .where(
            and(
              eq(repoSnapshot.id, row.source.sourceSnapshotId),
              eq(githubRepo.organizationId, owner),
            ),
          )
      )[0];
      const run = (
        await db
          .select({
            status: analysisRun.status,
            artifacts: sql<number>`(select count(*) from ${artifact} where ${artifact.runId} = ${analysisRun.id})`,
          })
          .from(analysisRun)
          .where(eq(analysisRun.id, row.source.sliceRunId))
      )[0];
      return {
        source: toSource(row.source, snapshot?.commitSha ?? ""),
        snapshot:
          snapshot === undefined
            ? null
            : {
                commitSha: snapshot.commitSha,
                repoGone: snapshot.syncStatus === "gone",
              },
        sliceRun:
          run === undefined
            ? null
            : {
                status: run.status,
                artifactsPresent: Number(run.artifacts) > 0,
              },
      };
    },
  };
}
