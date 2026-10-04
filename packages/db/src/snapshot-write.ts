import { and, eq } from "drizzle-orm";
import type { Transaction } from "./errors.js";
import { repoSnapshot, githubRepo } from "./schema.js";

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
