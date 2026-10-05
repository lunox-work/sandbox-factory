import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { ClaimedAnalysisRun } from "@sandbox-factory/db";
import { command } from "./command.js";
import { AnalysisError, CommandError } from "./errors.js";

export interface FetchSourceOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly signal: AbortSignal;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly execute?: typeof command;
  readonly python?: string;
}
export async function fetchSource(
  run: ClaimedAnalysisRun,
  directory: string,
  options: FetchSourceOptions,
): Promise<string> {
  if ((run.sizeKb ?? 0) * 1024 > options.maxBytes)
    throw new AnalysisError("too_large");
  if (
    run.commitSha === null ||
    run.repoFullName === null ||
    !/^[a-f0-9]{40}$/i.test(run.commitSha) ||
    !/^[\w.-]+\/[\w.-]+$/.test(run.repoFullName)
  )
    throw new AnalysisError("source_unavailable");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  options.signal.throwIfAborted();
  const token = await options.token();
  const redirect = await fetchImpl(
    `https://api.github.com/repos/${run.repoFullName}/tarball/${run.commitSha}`,
    {
      redirect: "manual",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const location = redirect.headers.get("location");
  await redirect.body?.cancel();
  if (redirect.status !== 302 || location === null)
    throw new AnalysisError("source_unavailable");
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.username ||
    url.password
  )
    throw new AnalysisError("source_unavailable");
  // No bearer token is sent to the archive host, including subsequent redirects.
  const archive = await fetchImpl(url, {
    redirect: "error",
    signal: options.signal,
  });
  const body = archive.body;
  if (!archive.ok || body === null)
    throw new AnalysisError("source_unavailable");
  if (Number(archive.headers.get("content-length") ?? 0) > options.maxBytes) {
    await body.cancel();
    throw new AnalysisError("too_large");
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, "source.tar.gz");
  const reader = body.getReader();
  async function* chunks() {
    let bytes = 0;
    try {
      while (true) {
        options.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > options.maxBytes) throw new AnalysisError("too_large");
        yield next.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  await pipeline(Readable.from(chunks()), createWriteStream(path), {
    signal: options.signal,
  });
  const source = join(directory, "source");
  try {
    await (options.execute ?? command)(
      options.python ?? "python3",
      [
        fileURLToPath(new URL("../python/extract_archive.py", import.meta.url)),
        path,
        source,
        String(options.maxFiles),
        String(options.maxBytes * 5),
      ],
      { signal: options.signal },
    );
  } catch (error) {
    if (error instanceof CommandError)
      throw new AnalysisError(
        error.exitCode === 2
          ? "too_large"
          : error.exitCode === 3
            ? "too_many_files"
            : "source_unavailable",
      );
    throw error;
  }
  return source;
}
