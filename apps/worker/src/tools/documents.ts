/**
 * The documents adapter: a repository's Markdown documents at one commit,
 * every one a bounty's sync could read (`repositoryDocuments` in core),
 * each kept as a sync keeps it, so a sync, a pin and the brief read them
 * from storage and no request waits on GitHub for them.
 *
 * Reads the source alone; nothing in the repository is executed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTEXT_DOCUMENT_BYTES_MAX,
  CONTEXT_DOCUMENT_CHARS,
  DOCUMENT_SET_SCHEMA_VERSION,
  DOCUMENTS_TOOL_VERSION,
  canonicalJson,
  isDocumentsParams,
  repositoryDocuments,
} from "sandbox-factory";
import type { DocumentSet, GithubContextDocument } from "sandbox-factory";
import { indexRepository } from "../agent/repo-tools.js";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";
import { sourceReader } from "./data-model.js";

export const DOCUMENTS_PATH = "documents.json";

/**
 * One document as a sync keeps it before the shared caps: line endings
 * made `\n`, trimmed, cut to `CONTEXT_DOCUMENT_CHARS`. Null with no text.
 */
export function keptDocument(
  path: string,
  bytes: number,
  text: string,
): GithubContextDocument | null {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (body === "") return null;
  const truncated = body.length > CONTEXT_DOCUMENT_CHARS;
  return {
    path,
    bytes,
    text: truncated ? body.slice(0, CONTEXT_DOCUMENT_CHARS) : body,
    truncated,
  };
}

export function createDocumentsAdapter(): ToolAdapter {
  return {
    name: "documents",
    version: DOCUMENTS_TOOL_VERSION,
    async run(input) {
      if (!isDocumentsParams(input.params))
        throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      const index = await indexRepository(input.sourceDir, input.signal);
      const files = index.paths.map((path) => ({
        path,
        size: index.sizes.get(path) ?? 0,
      }));
      const found = repositoryDocuments(files);
      const read = sourceReader(input.sourceDir);
      const documents: GithubContextDocument[] = [];
      for (const [done, path] of found.paths.entries()) {
        input.signal.throwIfAborted();
        input.advance?.(done, found.paths.length);
        const bytes = index.sizes.get(path) ?? 0;
        if (bytes > CONTEXT_DOCUMENT_BYTES_MAX) continue;
        const text = await read(path);
        const kept = text === null ? null : keptDocument(path, bytes, text);
        if (kept !== null) documents.push(kept);
      }
      input.advance?.(1, 1);
      const set: DocumentSet = {
        schemaVersion: DOCUMENT_SET_SCHEMA_VERSION,
        toolVersion: DOCUMENTS_TOOL_VERSION,
        sourceSnapshotId: snapshot.snapshotId,
        sourceCommitSha: snapshot.commitSha,
        documents,
        omitted: found.omitted,
      };
      await mkdir(input.outDir, { recursive: true });
      const absolutePath = join(input.outDir, DOCUMENTS_PATH);
      await writeFile(absolutePath, canonicalJson(set), "utf8");
      input.log(
        `Documents kept: ${documents.length} of ${found.paths.length + found.omitted} found.`,
      );
      return [
        {
          path: DOCUMENTS_PATH,
          absolutePath,
          kind: "documents",
          contentType: "application/json",
          meta: {
            documents: documents.length,
            omitted: found.omitted,
            chars: documents.reduce(
              (sum, document) => sum + document.text.length,
              0,
            ),
          },
        } satisfies ArtifactFile,
      ];
    },
  };
}
