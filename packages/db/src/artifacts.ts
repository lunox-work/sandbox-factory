import { and, eq, asc, type SQL } from "drizzle-orm";
import type { Database } from "./errors.js";
import { artifact, analysisRun, repoSnapshot, githubRepo } from "./schema.js";
import type { ArtifactRow } from "./schema.js";

export type StoredArtifact = Omit<ArtifactRow, "createdAt"> & {
  readonly createdAt: string;
};
export interface ArtifactStore {
  list(organizationId: string, runId: string): Promise<StoredArtifact[]>;
  get(
    organizationId: string,
    artifactId: string,
  ): Promise<StoredArtifact | null>;
}
export function createArtifactStore(db: Database): ArtifactStore {
  // The run's own owner: a starter's run has no repository to go through.
  const joined = () =>
    db
      .select({ artifact })
      .from(artifact)
      .innerJoin(analysisRun, eq(analysisRun.id, artifact.runId));
  const toStored = (row: ArtifactRow): StoredArtifact => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  return {
    async list(owner, runId) {
      const rows = await joined()
        .where(
          and(eq(analysisRun.organizationId, owner), eq(artifact.runId, runId)),
        )
        .orderBy(asc(artifact.path));
      return rows.map((row) => toStored(row.artifact));
    },
    async get(owner, artifactId) {
      const row = (
        await joined().where(
          and(
            eq(analysisRun.organizationId, owner),
            eq(artifact.id, artifactId),
          ),
        )
      )[0];
      return row === undefined ? null : toStored(row.artifact);
    },
  };
}

/** Caller holds the repository lock. Lock descendants before collecting keys,
 * so neither enqueue nor a late finish can leave private objects behind a cascade. */
export async function collectRepositoryObjects(
  db: Database,
  owner: string,
  scope: SQL,
) {
  const predicate = and(eq(githubRepo.organizationId, owner), scope);
  const snapshots = await db
    .select({ id: repoSnapshot.id, treeKey: repoSnapshot.treeKey })
    .from(repoSnapshot)
    .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
    .where(predicate)
    .for("update", { of: repoSnapshot });
  const runs = await db
    .select({ id: analysisRun.id, logKey: analysisRun.logKey })
    .from(analysisRun)
    .innerJoin(repoSnapshot, eq(repoSnapshot.id, analysisRun.snapshotId))
    .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
    .where(predicate)
    .for("update", { of: analysisRun });
  const objects = await db
    .select({ objectKey: artifact.objectKey })
    .from(artifact)
    .innerJoin(analysisRun, eq(analysisRun.id, artifact.runId))
    .innerJoin(repoSnapshot, eq(repoSnapshot.id, analysisRun.snapshotId))
    .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
    .where(predicate);
  const treeKeys = snapshots.map((row) => row.treeKey);
  return {
    treeKeys,
    objectKeys: [
      ...treeKeys,
      ...objects.map((row) => row.objectKey),
      ...runs.flatMap((row) => (row.logKey === null ? [] : [row.logKey])),
    ],
  };
}
