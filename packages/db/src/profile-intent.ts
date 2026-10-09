import type { Transaction } from "./errors.js";
import { bountyProfile } from "./schema.js";
import { generateId } from "./mapping.js";

/**
 * Persist only after writing the spec, with the snapshots locked by this
 * transaction: one profile for each repository the spec's work touches.
 */
export async function insertProfileIntents(
  tx: Transaction,
  owner: string,
  input: {
    proposalId: string;
    specRevision: number;
    specHash: string;
    snapshotIds: readonly string[];
  },
): Promise<void> {
  const { snapshotIds, ...revision } = input;
  if (snapshotIds.length === 0) return;
  await tx
    .insert(bountyProfile)
    .values(
      snapshotIds.map((snapshotId) => ({
        id: generateId("bpf"),
        organizationId: owner,
        ...revision,
        snapshotId,
      })),
    )
    .onConflictDoNothing({
      target: [
        bountyProfile.proposalId,
        bountyProfile.specRevision,
        bountyProfile.snapshotId,
      ],
    });
}
