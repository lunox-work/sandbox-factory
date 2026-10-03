import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnalysisRunStore,
  ArtifactStore,
  ClaimedAnalysisRun,
  ObjectStore,
  SandboxStore,
} from "@sandbox-factory/db";
import { fetchSource } from "./fetch-source.js";
import { AnalysisError } from "./errors.js";
import { uploadArtifacts } from "./upload.js";
import type { AgentTask, ToolAdapter, ToolInputs } from "./tools/adapter.js";

export interface RunOptions {
  readonly runs: AnalysisRunStore;
  /** Earlier runs' artifacts, read owner-scoped for tools that build on them. */
  readonly artifacts?: Pick<ArtifactStore, "list">;
  /** Sandbox versions, owner-scoped, for the build adapter. */
  readonly sandboxes?: Pick<SandboxStore, "getVersion" | "recordBuildOutput">;
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
  readonly source: Omit<Parameters<typeof fetchSource>[2], "signal">;
  readonly fetchSource?: typeof fetchSource;
  readonly now?: () => Date;
  readonly shutdown?: AbortSignal;
  readonly heartbeatMs?: number;
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
  let committed = false;
  let commitUncertain = false;
  let heartbeat: Promise<void> | undefined;
  let logRetained = false;
  let stage: "source" | "tool" = "source";
  const shutdown = () => abort.abort(new AnalysisError("cancelled"));
  // Object keys are not owner-scoped; only those an owner-scoped listing
  // returned may be read.
  const listedKeys = new Set<string>();
  const inputs: ToolInputs = {
    getRun: (id) => options.runs.get(run.organizationId, id),
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
    const source = await (options.fetchSource ?? fetchSource)(run, directory, {
      ...options.source,
      signal: abort.signal,
    });
    lines.push("Source archive fetched and validated.");
    stage = "tool";
    const files = await options.tool.run({
      sourceDir: source,
      outDir: join(directory, "out"),
      params: run.params,
      run: { snapshotId: run.snapshotId, commitSha: run.commitSha },
      inputs,
      signal: abort.signal,
      log: (line) => {
        if (lines.length < 100) lines.push(line);
      },
    });
    let artifacts;
    try {
      artifacts = await uploadArtifacts(
        options.objects,
        run.id,
        run.leaseToken,
        files,
        abort.signal,
        uploaded,
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
    committed = await options.runs.finish(
      run.organizationId,
      run.id,
      run.leaseToken,
      artifacts,
      logKey,
      now(),
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
        logRetained = await options.runs
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
    clearInterval(timer);
    clearTimeout(deadline);
    options.shutdown?.removeEventListener("abort", shutdown);
    await heartbeat;
    if (!committed && !commitUncertain)
      await Promise.allSettled(
        uploaded.map((key) => options.objects.remove(key)),
      );
    if (!logRetained) await options.objects.remove(logKey).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
