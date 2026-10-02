import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { NewArtifact, ObjectStore } from "@sandbox-factory/db";
import type { ArtifactFile } from "./tools/adapter.js";
import { AnalysisError } from "./errors.js";

/** Attempt keys prevent a late, fenced worker from overwriting the winner. */
export async function uploadArtifacts(
  store: ObjectStore,
  runId: string,
  lease: string,
  files: readonly ArtifactFile[],
  signal: AbortSignal,
  uploaded: string[],
): Promise<NewArtifact[]> {
  const artifacts: NewArtifact[] = [];
  let total = 0;
  for (const file of files) {
    signal.throwIfAborted();
    if (
      file.path.startsWith("/") ||
      file.path.split("/").some((part) => part === ".." || part === "")
    )
      throw new AnalysisError("upload_failed");
    const { size } = await stat(file.absolutePath);
    total += size;
    if (size > 100 * 1024 * 1024 || total > 200 * 1024 * 1024)
      throw new AnalysisError("too_large");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file.absolutePath)) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    const objectKey = `runs/${runId}/${lease}/${file.path}`;
    // Remember even an uncertain upload, so a known losing attempt is cleaned.
    uploaded.push(objectKey);
    if (store.putStream !== undefined)
      await store.putStream(
        objectKey,
        createReadStream(file.absolutePath),
        size,
        { contentType: file.contentType, signal },
      );
    else
      await store.put(objectKey, await readFile(file.absolutePath), {
        contentType: file.contentType,
        signal,
      });
    artifacts.push({
      kind: file.kind,
      path: file.path,
      objectKey,
      contentType: file.contentType,
      sizeBytes: size,
      sha256: hash.digest("hex"),
      meta: file.meta,
    });
  }
  return artifacts;
}
