/**
 * A repository's context as built: each builder's succeeded run at the
 * repository's one context commit, with what it wrote. The repository page
 * reads it beside its builders; elsewhere, as on the settings list's rows
 * and a bounty's, `RepositoryContextDialog` reads it on its own and shows
 * it in the viewer.
 */

import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { useState } from "react";
import { CONTEXT_BUILDERS } from "sandbox-factory";

import { clients } from "../../data/query";
import { ContextViewer, type ContextBuild } from "./ContextViewer";
import { errorMessage, shortSha } from "./labels";
import { useAnalysisResources, useRunArtifacts } from "./queries";

/** Each builder's succeeded run on `contextId`, and what it wrote. */
export function useContextBuilds(
  owner: string,
  contextId: string,
  contextRuns: readonly AnalysisRunDto[],
): { builds: ContextBuild[]; retry: () => void } {
  const built = CONTEXT_BUILDERS.flatMap((builder) => {
    const run = contextRuns.find(
      (each) =>
        each.snapshotId === contextId &&
        each.tool === builder &&
        each.status === "succeeded",
    );
    return run === undefined ? [] : [{ builder, run }];
  });
  const artifacts = useRunArtifacts(
    owner,
    built.map(({ run }) => run.id),
  );
  return {
    builds: built.map((build) => ({
      ...build,
      artifacts: artifacts.artifacts.get(build.run.id),
      failed: artifacts.failed.has(build.run.id),
    })),
    retry: artifacts.retry,
  };
}

/**
 * Opens a signed URL in a new tab. The tab is opened before the URL is
 * asked for, inside the click, or the browser would block it as a pop-up.
 * Resolves to what to say when it could not, or null.
 */
export async function openSigned(
  read: () => Promise<string>,
): Promise<string | null> {
  const tab = window.open("about:blank", "_blank");
  if (tab !== null) tab.opener = null;
  try {
    const url = await read();
    if (tab === null) return "Allow pop-ups to open this file, then try again.";
    tab.location.href = url;
    return null;
  } catch (cause) {
    tab?.close();
    return errorMessage(cause, "Could not open that file. Try again.");
  }
}

/**
 * The context viewer for one repository at one snapshot, away from its
 * page: reads that snapshot's builds itself. Mount it only while open, so
 * a list of repositories reads nothing until one is asked for.
 */
export function RepositoryContextDialog({
  owner,
  repoId,
  fullName,
  snapshotId: contextId,
  onClose,
}: {
  owner: string;
  repoId: string;
  fullName: string;
  /** The repository's context, or the commit a bounty reads it at. */
  snapshotId: string;
  onClose: () => void;
}) {
  const resources = useAnalysisResources(owner, repoId, {
    snapshotId: contextId,
  });
  const context = resources.snapshots.data?.find((s) => s.id === contextId);
  const { builds, retry } = useContextBuilds(
    owner,
    contextId,
    resources.snapshotRuns,
  );
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <ContextViewer
      owner={owner}
      commit={
        context === undefined
          ? fullName
          : `${fullName} @ ${shortSha(context.commitSha)}`
      }
      builds={builds}
      onRetry={retry}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenRaw={(artifactId) => {
        void openSigned(() =>
          clients.analysis.artifactUrl(owner, artifactId),
        ).then(setOpenError);
      }}
      notice={
        openError === null
          ? null
          : { text: openError, onDismiss: () => setOpenError(null) }
      }
    />
  );
}
