/**
 * A repository's tech stack, read beside a snapshot of its head.
 *
 * The one place the platform reads a repository's files outside the worker,
 * and only a few of them: the dependency manifests `stackManifests` picks
 * from the snapshot's tree, by Git object id, with the same narrowed
 * `contents: read` token the tree was read with. Each manifest's text is
 * handed to `detectStack` and dropped; only the names it finds are kept, on
 * the repository row (`GithubRepoStore.recordStack`).
 */

import type { StoredTreeEntry } from "@sandbox-factory/shared";
import {
  detectStack,
  type StackManifest,
  stackManifests,
} from "sandbox-factory";

/** Manifests read at once, so one repository does not burst the rate limit. */
export const STACK_READ_CONCURRENCY = 4;

export interface BlobReader {
  blobText(fullName: string, sha: string): Promise<string>;
}

export async function readStack(
  client: BlobReader,
  fullName: string,
  entries: readonly StoredTreeEntry[],
  languages: Readonly<Record<string, number>>,
): Promise<string[]> {
  const files = entries.filter((entry) => entry.type === "blob");
  const shas = new Map(files.map((entry) => [entry.path, entry.sha]));
  const chosen = stackManifests(files).flatMap((path) => {
    const sha = shas.get(path);
    return sha === undefined ? [] : [{ path, sha }];
  });
  const manifests: StackManifest[] = [];
  for (let start = 0; start < chosen.length; start += STACK_READ_CONCURRENCY) {
    const batch = chosen.slice(start, start + STACK_READ_CONCURRENCY);
    manifests.push(
      ...(await Promise.all(
        batch.map(async ({ path, sha }) => ({
          path,
          text: await client.blobText(fullName, sha),
        })),
      )),
    );
  }
  return detectStack({ languages, files, manifests });
}
