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
import { useCallback, useEffect, useState } from "react";
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
function repositoryPath(path: string): string | undefined {
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

/** How many files are read at once for a search. */
const READ_CONCURRENCY = 6;

/**
 * The text of each of `paths`, read only while `enabled`, a few at a time:
 * a version can hold hundreds of files of up to a megabyte each, and asked
 * for all at once they held the connection and the page.
 */
export function useFileTexts(
  source: FileSource,
  paths: readonly string[],
  enabled: boolean,
): FileTexts {
  const userId = useUserId();
  // How far down the list reads may go: a batch further each time the
  // batch before it has settled.
  const [reach, setReach] = useState(READ_CONCURRENCY);
  // Stable while the paths are, so the combined result is too.
  const combine = useCallback(
    (
      results: {
        data?: { text: string | null };
        isPending: boolean;
        isFetched: boolean;
        isError: boolean;
      }[],
    ) => ({
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
      settled: results.filter(
        ({ isFetched, isError, data }) =>
          isFetched || isError || data !== undefined,
      ).length,
    }),
    [paths, enabled],
  );
  const { texts, pending, settled } = useQueries({
    queries: paths.map((path, index) => ({
      ...fileContentQuery(userId, source, path),
      enabled: enabled && index < reach,
    })),
    combine,
  });
  useEffect(() => {
    if (enabled && settled >= reach && reach < paths.length)
      setReach(reach + READ_CONCURRENCY);
  }, [enabled, settled, reach, paths.length]);
  return { texts, pending };
}
