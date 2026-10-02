import type { InstallationTokens } from "@sandbox-factory/github";
import type { ClaimedAnalysisRun } from "@sandbox-factory/db";
import { AnalysisError } from "./errors.js";
/** Source analysis may read exactly one repository, even on a wider installation. */
export function repositoryToken(
  tokens: Pick<InstallationTokens, "provider">,
  run: Pick<ClaimedAnalysisRun, "externalRepoId" | "installationId">,
): () => Promise<string> {
  return async () => {
    const id = Number(run.externalRepoId);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new AnalysisError("source_unavailable");
    return tokens.provider(run.installationId, {
      repositoryIds: [id],
      permissions: { contents: "read", metadata: "read" },
    })();
  };
}
