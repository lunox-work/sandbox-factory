/**
 * The seams index of the abstractions builder: every file of the graph read
 * the way the slice reads an included file, so an entry is what the slice
 * would list for it. A file that is missing, a link, not a regular file or
 * larger than `SEAMS_LIMITS.fileBytes` is not read, and the index says so.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  SEAMS_LIMITS,
  buildSeamsIndex,
  fileSeams,
  seamsFiles,
} from "sandbox-factory";
import type { FileSeams, SeamsIndex, SliceGraph } from "sandbox-factory";

/** Files read at once. */
const READ_CONCURRENCY = 16;

/** One file's text, or null when the slice could not read it whole. */
async function readText(sourceDir: string, path: string) {
  const absolute = resolve(sourceDir, path);
  const rel = relative(sourceDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return null;
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (handle === null) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > SEAMS_LIMITS.fileBytes) return null;
    return (await handle.readFile()).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function readSeamsIndex(input: {
  readonly sourceDir: string;
  readonly graph: SliceGraph;
  readonly snapshotId: string;
  readonly commitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
  readonly signal: AbortSignal;
  /** Hears how many of its files have been read, of how many. */
  readonly progress?: ((done: number, total: number) => void) | undefined;
}): Promise<SeamsIndex> {
  const paths = seamsFiles(input.graph);
  // Each text is reduced to its entry as it is read, so the checkout is
  // never held in memory at once.
  const files: FileSeams[] = [];
  for (let start = 0; start < paths.length; start += READ_CONCURRENCY) {
    input.signal.throwIfAborted();
    const batch = paths.slice(start, start + READ_CONCURRENCY);
    files.push(
      ...(await Promise.all(
        batch.map(async (path) =>
          fileSeams(path, await readText(input.sourceDir, path)),
        ),
      )),
    );
    input.progress?.(files.length, paths.length);
  }
  return buildSeamsIndex({
    files,
    snapshotId: input.snapshotId,
    commitSha: input.commitSha,
    graphRunId: input.graphRunId,
    graphSha256: input.graphSha256,
  });
}
