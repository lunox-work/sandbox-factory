import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { NewArtifact, ObjectStore } from "@sandbox-factory/db";
import type { ArtifactFile } from "./tools/adapter.js";
import { AnalysisError } from "./errors.js";

/** Files uploaded at once: a graph's artifacts number in the dozens. */
const UPLOAD_CONCURRENCY = 8;

/**
 * Attempt keys prevent a late, fenced worker from overwriting the winner.
 * Uploaded a few at a time, in the files' order; after a failure no other
 * starts, and the ones in flight finish before it is thrown, so every key
 * that may have been written is in `uploaded` for the cleanup.
 */
export async function uploadArtifacts(
  store: ObjectStore,
  runId: string,
  lease: string,
  files: readonly ArtifactFile[],
  signal: AbortSignal,
  uploaded: string[],
): Promise<NewArtifact[]> {
  const artifacts = new Array<NewArtifact>(files.length);
  let total = 0;
  let next = 0;
  let failure: { error: unknown } | undefined;
  const one = async (file: ArtifactFile): Promise<NewArtifact> => {
    signal.throwIfAborted();
    if (
      file.path.startsWith("/") ||
      file.path.split("/").some((part) => part === ".." || part === "")
    )
      throw new AnalysisError("upload_failed");
    // One handle for the size check, the hash and the upload, so all three
    // read the same file even if the path is replaced in between.
    const handle = await open(file.absolutePath, "r");
    try {
      const { size } = await handle.stat();
      total += size;
      if (size > 100 * 1024 * 1024 || total > 200 * 1024 * 1024)
        throw new AnalysisError("too_large");
      // Positional reads of the measured bytes; the handle outlives each pass.
      const read = () =>
        handle.createReadStream(
          size > 0
            ? { start: 0, end: size - 1, autoClose: false }
            : { start: 0, autoClose: false },
        );
      const hash = createHash("sha256");
      for await (const chunk of read()) {
        signal.throwIfAborted();
        hash.update(chunk);
      }
      const objectKey = `runs/${runId}/${lease}/${file.path}`;
      // Remember even an uncertain upload, so a known losing attempt is cleaned.
      uploaded.push(objectKey);
      if (store.putStream !== undefined)
        await store.putStream(objectKey, read(), size, {
          contentType: file.contentType,
          signal,
        });
      else {
        const body = Buffer.alloc(size);
        const { bytesRead } = await handle.read(body, 0, size, 0);
        await store.put(objectKey, body.subarray(0, bytesRead), {
          contentType: file.contentType,
          signal,
        });
      }
      return {
        kind: file.kind,
        path: file.path,
        objectKey,
        contentType: file.contentType,
        sizeBytes: size,
        sha256: hash.digest("hex"),
        meta: file.meta,
      };
    } finally {
      await handle.close();
    }
  };
  const worker = async () => {
    while (failure === undefined) {
      const index = next++;
      const file = files[index];
      if (file === undefined) return;
      try {
        artifacts[index] = await one(file);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker),
  );
  if (failure !== undefined) throw failure.error;
  return artifacts;
}
