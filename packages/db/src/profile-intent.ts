import type { ProfileBounty } from "sandbox-factory";
import type { Transaction } from "./errors.js";
import { bountyProfile } from "./schema.js";
import { generateId } from "./mapping.js";

/** Persist only after writing the spec, with a snapshot locked by this transaction. */
export async function insertProfileIntent(
  tx: Transaction,
  owner: string,
  input: {
    proposalId: string;
    specRevision: number;
    specHash: string;
    snapshotId: string;
    bounty: ProfileBounty;
  },
): Promise<void> {
  await tx
    .insert(bountyProfile)
    .values({ id: generateId("bpf"), organizationId: owner, ...input })
    .onConflictDoNothing({
      target: [bountyProfile.proposalId, bountyProfile.specRevision],
    });
}
