import { and, eq, inArray } from "drizzle-orm";
import type { Transaction } from "./errors.js";
import { repoSnapshot, githubRepo } from "./schema.js";
import type { ProposalRepository } from "./schema.js";

/**
 * Keep a surviving owned snapshot still until the write that names it
 * commits. Null for a snapshot that is gone or another organization's.
 */
export async function snapshotForWrite(
  tx: Transaction,
  organizationId: string,
  snapshotId: string | null | undefined,
): Promise<string | null> {
  if (snapshotId == null) return null;
  const [snapshot] = await tx
    .select({ id: repoSnapshot.id })
    .from(repoSnapshot)
    .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
    .where(
      and(
        eq(githubRepo.organizationId, organizationId),
        eq(repoSnapshot.id, snapshotId),
      ),
    )
    .for("key share", { of: repoSnapshot });
  // Repository deletion or pruning during the model call is optional
  // context disappearing, not a reason to discard the completed draft.
  return snapshot?.id ?? null;
}

/**
 * `snapshotForWrite` for each repository a write names: those whose
 * snapshot survives as the owner's, of the repository named, kept still
 * until the write commits, in the order given.
 */
export async function repositoriesForWrite(
  tx: Transaction,
  organizationId: string,
  repositories: readonly ProposalRepository[] | undefined,
): Promise<ProposalRepository[]> {
  if (repositories === undefined || repositories.length === 0) return [];
  const found = await tx
    .select({ id: repoSnapshot.id, repoId: repoSnapshot.repoId })
    .from(repoSnapshot)
    .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
    .where(
      and(
        eq(githubRepo.organizationId, organizationId),
        inArray(
          repoSnapshot.id,
          repositories.map(({ snapshotId }) => snapshotId),
        ),
      ),
    )
    // In one order, so two writes naming the same snapshots wait on each
    // other rather than each holding one the other needs.
    .orderBy(repoSnapshot.id)
    .for("key share", { of: repoSnapshot });
  const repoOf = new Map(found.map(({ id, repoId }) => [id, repoId]));
  return repositories.filter(
    ({ repoId, snapshotId }) => repoOf.get(snapshotId) === repoId,
  );
}
