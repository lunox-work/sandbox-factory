/**
 * Reading a version's files, one by one or many at once, through the same
 * cache: a file the editor has open is not read again for a search, and the
 * other way round.
 *
 * A build stores the public sandbox. The private sandbox is the same files
 * read back through the inverse of `pseudonym.lunox`, so its files are
 * renamed here, as they are read, and every view of them agrees.
 */

import { queryOptions, useQueries } from "@tanstack/react-query";
import { useCallback } from "react";
import { PRIVATE_TESTS_DIR, renameFile, type AliasRule } from "sandbox-factory";

import { clients, queryKeys, useUserId } from "../../data/query";

export interface FileSource {
  owner: string;
  versionId: string;
  /** Keys the read: a rebuilt version's file at the same path is another. */
  runId: string | null;
  /**
   * The rules files are read back through: the inverse table, for the
   * private sandbox; none, for the public one as stored.
   */
  renames?: readonly AliasRule[];
}

/**
 * Where a stored file sits in the sandbox's repository, which a scoped rule
 * names: `project/src/a.ts` is `src/a.ts`, a hidden test is under
 * `tests/private/`. Undefined for the build's own records, which no table
 * renamed.
 */
export function repositoryPath(path: string): string | undefined {
  if (path.startsWith("project/")) return path.slice("project/".length);
  if (path.startsWith("private/") && /\.test\.tsx?$/.test(path))
    return `${PRIVATE_TESTS_DIR}/${path.slice("private/".length)}`;
  return undefined;
}

export function fileContentQuery(
  userId: string,
  { owner, versionId, runId, renames = [] }: FileSource,
  path: string,
) {
  const repository = repositoryPath(path);
  return queryOptions({
    queryKey: queryKeys.resource(
      userId,
      owner,
      "sandbox-file",
      versionId,
      runId,
      path,
    ),
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxFile(owner, versionId, path, signal),
    // A run's output does not change once written.
    staleTime: Infinity,
    // Renamed after the read, so both sandboxes share one cached copy.
    select:
      renames.length === 0 || repository === undefined
        ? undefined
        : (data) =>
            data.text === null
              ? data
              : {
                  ...data,
                  text: renameFile(
                    { path: repository, text: data.text },
                    renames,
                  ).text,
                },
  });
}

export interface FileTexts {
  /** Each file's text once read; null for one that is not shown as text. */
  texts: ReadonlyMap<string, string | null>;
  /** Files still being read. */
  pending: number;
}

/** The text of each of `paths`, read only while `enabled`. */
export function useFileTexts(
  source: FileSource,
  paths: readonly string[],
  enabled: boolean,
): FileTexts {
  const userId = useUserId();
  // Stable while the paths are, so the combined result is too.
  const combine = useCallback(
    (results: { data?: { text: string | null }; isPending: boolean }[]) => ({
      texts: new Map(
        results.flatMap(({ data }, index) => {
          const path = paths[index];
          return data === undefined || path === undefined
            ? []
            : [[path, data.text] as const];
        }),
      ),
      pending: enabled
        ? results.filter(({ isPending }) => isPending).length
        : 0,
    }),
    [paths, enabled],
  );
  return useQueries({
    queries: paths.map((path) => ({
      ...fileContentQuery(userId, source, path),
      enabled,
    })),
    combine,
  });
}
