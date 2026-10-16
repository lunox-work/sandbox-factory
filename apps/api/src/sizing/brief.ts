/**
 * What the `brief` and `documents` builders wrote of one snapshot, read
 * back for the price and a bounty's sync: the newest succeeded run's
 * artifact, verified against its hash. Null when the snapshot has none,
 * as one built before these builders were, so the caller falls back: to
 * the outline for a brief, to GitHub for documents.
 */

import { createHash } from "node:crypto";
import type {
  AnalysisRunStore,
  ArtifactStore,
  ObjectStore,
} from "@sandbox-factory/db";
import { documentSetSchema } from "@sandbox-factory/shared";
import type {
  ArtifactKind,
  ContextBuilder,
  DocumentSet,
} from "sandbox-factory";

export interface BriefSource {
  readonly runs: Pick<AnalysisRunStore, "latestSucceeded">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly objects: Pick<ObjectStore, "get">;
}

async function readBuilt(
  source: BriefSource,
  organizationId: string,
  snapshotId: string,
  tool: ContextBuilder,
  kind: ArtifactKind,
): Promise<string | null> {
  const run = await source.runs.latestSucceeded(
    organizationId,
    snapshotId,
    tool,
  );
  if (run === null) return null;
  const artifact = (await source.artifacts.list(organizationId, run.id)).find(
    (item) => item.kind === kind,
  );
  if (artifact === undefined) return null;
  const bytes = await source.objects.get(artifact.objectKey);
  if (
    bytes === undefined ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  )
    return null;
  return Buffer.from(bytes).toString("utf8");
}

export function readBrief(
  source: BriefSource,
  organizationId: string,
  snapshotId: string,
): Promise<string | null> {
  return readBuilt(source, organizationId, snapshotId, "brief", "brief_md");
}

export async function readDocumentSet(
  source: BriefSource,
  organizationId: string,
  snapshotId: string,
): Promise<DocumentSet | null> {
  const text = await readBuilt(
    source,
    organizationId,
    snapshotId,
    "documents",
    "documents",
  );
  if (text === null) return null;
  try {
    const parsed = documentSetSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as DocumentSet) : null;
  } catch {
    return null;
  }
}
