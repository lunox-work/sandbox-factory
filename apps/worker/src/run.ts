import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnalysisRunStore,
  ArtifactStore,
  ClaimedAnalysisRun,
  ObjectStore,
  SandboxStore,
} from "@sandbox-factory/db";
import { sourceArchiveKey } from "@sandbox-factory/db";
import { readsSource } from "sandbox-factory";
import { fetchSource } from "./fetch-source.js";
import type { SourceCache } from "./source-cache.js";
import { progressRecorder } from "./progress.js";
import { timingRecorder } from "./timing.js";
import { AnalysisError } from "./errors.js";
import { uploadArtifacts } from "./upload.js";
import type {
  AgentTask,
  ArtifactFile,
  ToolAdapter,
  ToolInputs,
  ToolRunInput,
} from "./tools/adapter.js";

export interface RunOptions {
  readonly runs: AnalysisRunStore;
  /** Earlier runs' artifacts, read owner-scoped for tools that build on them. */
  readonly artifacts?: Pick<ArtifactStore, "list">;
  /** Sandbox versions, owner-scoped, for the build and starter adapters. */
  readonly sandboxes?: Pick<
    SandboxStore,
    "getVersion" | "recordBuildOutput" | "recordStarterOutput"
  >;
  /** Proposal specs, owner-scoped, for the agent adapters. */
  readonly tasks?: {
    get(
      organizationId: string,
      proposalId: string,
      specRevision: number,
    ): Promise<AgentTask | null>;
  };
  readonly objects: ObjectStore;
  readonly tool: ToolAdapter;
  readonly source: Omit<
    Parameters<typeof fetchSource>[2],
    "signal" | "archive"
  >;
  readonly fetchSource?: typeof fetchSource;
  /**
   * Extracted source kept between runs. Absent, each run fetches its own
   * into its temporary directory, which goes with it.
   */
  readonly sourceCache?: SourceCache;
  readonly now?: () => Date;
  readonly shutdown?: AbortSignal;
  readonly heartbeatMs?: number;
  /** A monotonic clock in milliseconds, for the run's timing. */
  readonly clock?: () => number;
}
export async function executeRun(
  run: ClaimedAnalysisRun,
  options: RunOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const abort = new AbortController();
  const directory = await mkdtemp(join(tmpdir(), "source-analysis-"));
  const uploaded: string[] = [];
  const lines: string[] = ["Source analysis claimed."];
  const logKey = `logs/${run.id}/${run.leaseToken}.log`;
  const timing = timingRecorder(options.clock);
  let committed = false;
  let failed = false;
  let commitUncertain = false;
  let heartbeat: Promise<void> | undefined;
  let logRetained = false;
  let stage: "source" | "tool" = "source";
  let releaseSource = () => {};
  /** The previews being shown, one after another; see `preview`. */
  let previewing: Promise<void> = Promise.resolve();
  /** Every key a preview uploaded, removed once the run has committed. */
  const previewKeys = new Set<string>();
  const shutdown = () => abort.abort(new AnalysisError("cancelled"));
  // Object keys are not owner-scoped; only those an owner-scoped listing
  // returned may be read.
  const listedKeys = new Set<string>();
  const inputs: ToolInputs = {
    getRun: (id) => options.runs.get(run.organizationId, id),
    latestSucceeded: (snapshotId, tool) =>
      options.runs.latestSucceeded(run.organizationId, snapshotId, tool),
    listArtifacts: async (id) => {
      if (options.artifacts === undefined) return [];
      const listed = await options.artifacts.list(run.organizationId, id);
      for (const artifact of listed) listedKeys.add(artifact.objectKey);
      return listed;
    },
    readArtifact: (key) =>
      listedKeys.has(key)
        ? options.objects.get(key)
        : Promise.resolve(undefined),
    getVersion: (id) =>
      options.sandboxes === undefined
        ? Promise.resolve(null)
        : options.sandboxes.getVersion(run.organizationId, id),
    getTask: (proposalId, specRevision) =>
      options.tasks === undefined
        ? Promise.resolve(null)
        : options.tasks.get(run.organizationId, proposalId, specRevision),
    recordBuildOutput: (versionId, buildRunId, output) =>
      options.sandboxes === undefined
        ? Promise.resolve(false)
        : options.sandboxes.recordBuildOutput(
            run.organizationId,
            versionId,
            buildRunId,
            output,
            now(),
          ),
    recordStarterOutput: (versionId, starterRunId, output) =>
      options.sandboxes === undefined
        ? Promise.resolve(false)
        : options.sandboxes.recordStarterOutput(
            run.organizationId,
            versionId,
            starterRunId,
            output,
            now(),
          ),
  };
  options.shutdown?.addEventListener("abort", shutdown, { once: true });
  if (options.shutdown?.aborted) shutdown();
  const deadline = setTimeout(
    () => abort.abort(new AnalysisError("tool_timeout")),
    Math.max(0, Date.parse(run.deadlineAt ?? "") - now().getTime()),
  );
  const timer = setInterval(() => {
    if (heartbeat !== undefined) return;
    heartbeat = options.runs
      .heartbeat(run.organizationId, run.id, run.leaseToken, now())
      .then((live) => {
        if (!live) abort.abort(new AnalysisError("worker_lost"));
      })
      .catch(() => abort.abort(new AnalysisError("worker_lost")))
      .finally(() => {
        heartbeat = undefined;
      });
  }, options.heartbeatMs ?? 15_000);
  try {
    if (
      run.tool !== options.tool.name ||
      run.toolVersion !== options.tool.version
    )
      throw new AnalysisError("tool_failed");
    // A tool that reads no source is given an empty directory, and no
    // repository is fetched or even named.
    let source: string;
    let snapshot: ToolRunInput["run"] = null;
    if (readsSource(run.tool)) {
      if (run.snapshotId === null || run.commitSha === null)
        throw new AnalysisError("source_unavailable");
      snapshot = { snapshotId: run.snapshotId, commitSha: run.commitSha };
      const archiveKey =
        run.repoId === null
          ? null
          : sourceArchiveKey(run.repoId, run.commitSha);
      const fetchInto = (into: string) =>
        (options.fetchSource ?? fetchSource)(run, into, {
          ...options.source,
          signal: abort.signal,
          onStage: timing.stage,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(archiveKey === null
            ? {}
            : { archive: archiveOf(options.objects, archiveKey) }),
        });
      const cache = options.sourceCache;
      if (cache === undefined || run.repoId === null) {
        source = await fetchInto(directory);
        lines.push("Source archive fetched and validated.");
      } else {
        const checkout = await cache.checkout(
          `${run.repoId}@${run.commitSha}`,
          async (into) => {
            const extracted = await fetchInto(into);
            // The tree is what is kept; the archive is in the bucket.
            await rm(join(into, "source.tar.gz"), { force: true });
            return extracted;
          },
        );
        releaseSource = checkout.release;
        source = checkout.path;
        lines.push(
          checkout.hit
            ? "Source read from the worker's cache."
            : "Source archive fetched and validated.",
        );
      }
    } else {
      source = join(directory, "empty");
      await mkdir(source);
    }
    stage = "tool";
    /*
      What a build has generated, shown before its baseline: uploaded under
      the attempt's own `preview/`, so a failed attempt's cleanup takes it
      with the rest, and recorded on the run. One at a time, in order.
    */
    const preview = (files: readonly ArtifactFile[]) => {
      previewing = previewing.then(async () => {
        try {
          const shown = await uploadArtifacts(
            options.objects,
            run.id,
            `${run.leaseToken}/preview`,
            files,
            abort.signal,
            uploaded,
          );
          for (const { objectKey } of shown) previewKeys.add(objectKey);
          await options.runs.recordPreview(
            run.organizationId,
            run.id,
            run.leaseToken,
            {
              at: now().toISOString(),
              files: shown.map(
                ({ path, objectKey, contentType, sizeBytes, sha256 }) => ({
                  path,
                  objectKey,
                  contentType,
                  sizeBytes,
                  sha256,
                }),
              ),
            },
            now(),
          );
        } catch {
          lines.push("A preview of the generated files could not be shown.");
        }
      });
    };
    const progress = progressRecorder(
      (value) =>
        options.runs.recordProgress(
          run.organizationId,
          run.id,
          run.leaseToken,
          value,
          now(),
        ),
      now,
    );
    const files = await timing.time("tool", () =>
      options.tool.run({
        runId: run.id,
        sourceDir: source,
        outDir: join(directory, "out"),
        params: run.params,
        run: snapshot,
        inputs,
        signal: abort.signal,
        log: (line) => {
          if (lines.length < 100) lines.push(line);
        },
        step: progress.step,
        preview,
        timing,
      }),
    );
    // The last steps land before the run says it is done, and the last
    // preview, which the run's end clears.
    await progress.settled();
    await previewing;
    let artifacts;
    try {
      artifacts = await timing.time("upload", () =>
        uploadArtifacts(
          options.objects,
          run.id,
          run.leaseToken,
          files,
          abort.signal,
          uploaded,
        ),
      );
    } catch (error) {
      if (error instanceof AnalysisError || abort.signal.aborted) throw error;
      throw new AnalysisError("upload_failed");
    }
    abort.signal.throwIfAborted();
    lines.push("Analysis artifacts uploaded.");
    await options.objects.put(logKey, Buffer.from(lines.join("\n")), {
      contentType: "text/plain; charset=utf-8",
    });
    // A transport error may follow a successful DB commit. Preserve objects
    // until an owner-scoped read confirms whether the attempt became visible.
    commitUncertain = true;
    committed = await timing.time("commit", () =>
      options.runs.finish(
        run.organizationId,
        run.id,
        run.leaseToken,
        artifacts,
        logKey,
        now(),
      ),
    );
    commitUncertain = false;
    logRetained = committed;
    if (committed && options.tool.committed !== undefined)
      await options.tool
        .committed({ runId: run.id, files, inputs })
        .catch((error: unknown) =>
          console.error(`Run ${run.id}: after-commit step failed.`, error),
        );
  } catch (error) {
    const failure = abort.signal.aborted ? abort.signal.reason : error;
    const code =
      failure instanceof AnalysisError
        ? failure.code
        : stage === "source"
          ? "source_unavailable"
          : "tool_failed";
    if (commitUncertain) {
      try {
        const stored = await options.runs.get(run.organizationId, run.id);
        committed =
          stored?.status === "succeeded" &&
          (await options.runs.logKey(run.organizationId, run.id)) === logKey;
        commitUncertain = false;
      } catch {
        /* Preserve uncertain committed bytes. */
      }
    }
    if (committed || commitUncertain) logRetained = true;
    else {
      lines.push(`Analysis stopped: ${code}.`);
      let savedLog: string | null = null;
      try {
        await options.objects.put(logKey, Buffer.from(lines.join("\n")), {
          contentType: "text/plain; charset=utf-8",
        });
        savedLog = logKey;
      } catch {
        /* No log pointer to an absent object. */
      }
      if (code === "cancelled")
        await options.runs
          .release(run.organizationId, run.id, run.leaseToken, now())
          .catch(() => false);
      else
        failed = logRetained = await options.runs
          .fail(
            run.organizationId,
            run.id,
            run.leaseToken,
            code,
            savedLog,
            now(),
          )
          .catch(() => false);
    }
  } finally {
    releaseSource();
    clearInterval(timer);
    clearTimeout(deadline);
    options.shutdown?.removeEventListener("abort", shutdown);
    await heartbeat;
    // A preview still uploading lands before the cleanup that removes it.
    await previewing;
    // Once it has ended: a released run is claimed again, and starts over.
    if (committed || failed)
      await options.runs
        .recordTiming(run.organizationId, run.id, timing.value())
        .catch(() => false);
    if (!committed && !commitUncertain)
      await Promise.allSettled(
        uploaded.map((key) => options.objects.remove(key)),
      );
    // A committed run's previews are not what it wrote; its artifacts are.
    else if (committed)
      await Promise.allSettled(
        [...previewKeys].map((key) => options.objects.remove(key)),
      );
    if (!logRetained) await options.objects.remove(logKey).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A commit's archive in the bucket. Written as a stream where the store
 * can, since an archive runs to the worker's size cap.
 */
function archiveOf(
  objects: ObjectStore,
  key: string,
): NonNullable<Parameters<typeof fetchSource>[2]["archive"]> {
  const contentType = "application/gzip";
  return {
    read: () => objects.get(key),
    write: async (path, bytes) =>
      objects.putStream === undefined
        ? objects.put(key, await readFile(path), { contentType })
        : objects.putStream(key, createReadStream(path), bytes, {
            contentType,
          }),
  };
}
