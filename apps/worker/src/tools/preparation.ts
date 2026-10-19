/**
 * A sandbox's preparation: a `fixtures` run with `pseudonyms` in its
 * parameters, which wrote a name table beside its fixture set. Runs were
 * queued before 2026-10-19; nothing queues one now. A build that finds one
 * on `bounty_profile.prepared_run_id` still takes its fixtures and its
 * table when its own checks pass them (`sandbox-build.ts`).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { emailNames, isFixturesParams } from "sandbox-factory";
import type {
  AgentUsage,
  VersionFixtures,
  VocabularyName,
} from "sandbox-factory";
import {
  aliasRulesSchema,
  agentUsageSchema,
  fixtureSetSchema,
} from "@sandbox-factory/shared";
import { z } from "zod";
import type { ArtifactFile, ToolInputs } from "./adapter.js";
import type { WrittenPseudonyms } from "./pseudonyms.js";
import { sha256 } from "./slice/hash.js";

/** Where a preparation keeps its name table. */
export const PREPARED_PSEUDONYMS_PATH = "pseudonym-table.json";
export const PREPARED_PSEUDONYMS_SCHEMA_VERSION = 1;

const preparedPseudonymsSchema = z.object({
  schemaVersion: z.literal(PREPARED_PSEUDONYMS_SCHEMA_VERSION),
  toolVersion: z.string(),
  sliceRunId: z.string(),
  rules: aliasRulesSchema,
  summary: z.string(),
  usage: agentUsageSchema,
});

/**
 * The names the repository's root `package.json` gives its owner: the
 * scope of its package name, or the whole name unscoped, its author, and
 * the author's address (`emailNames`). None when it has no readable
 * manifest.
 */
export async function packageVocabulary(
  sourceDir: string,
): Promise<VocabularyName[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(sourceDir, "package.json"), "utf8"),
    );
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null) return [];
  const { name, author } = manifest as { name?: unknown; author?: unknown };
  const names: VocabularyName[] = [];
  if (typeof name === "string")
    names.push({
      name: name.startsWith("@") ? (name.slice(1).split("/")[0] ?? "") : name,
      kind: "name",
    });
  // `Name <email> (url)`, or `{ name, email }`.
  const field = (key: string) =>
    typeof author === "object" &&
    author !== null &&
    typeof (author as Record<string, unknown>)[key] === "string"
      ? ((author as Record<string, string>)[key] ?? "")
      : "";
  const authorName =
    typeof author === "string"
      ? author.replace(/[<(].*$/, "").trim()
      : field("name");
  if (authorName.length > 0) names.push({ name: authorName, kind: "name" });
  const email =
    typeof author === "string"
      ? (/<([^>]*)>/.exec(author)?.[1] ?? "")
      : field("email");
  names.push(...emailNames(email.trim()));
  return names.filter((entry) => entry.name.length > 0);
}

/** What a preparation run left for a build: either part may be missing. */
export interface Preparation {
  readonly fixtures: VersionFixtures | null;
  readonly pseudonyms: WrittenPseudonyms | null;
}

/**
 * A succeeded preparation of the same slice, read back for a build. A run
 * that is not one, is on another slice, or whose files do not match their
 * hashes gives nothing: the build then writes its own, as it would have.
 */
export async function loadPreparation(
  inputs: ToolInputs,
  runId: string,
  sliceRunId: string,
  snapshotId: string,
): Promise<Preparation> {
  const none: Preparation = { fixtures: null, pseudonyms: null };
  const run = await inputs.getRun(runId);
  if (
    run === null ||
    run.status !== "succeeded" ||
    run.snapshotId !== snapshotId ||
    !isFixturesParams(run.params) ||
    run.params.sliceRunId !== sliceRunId
  )
    return none;
  const artifacts = await inputs.listArtifacts(run.id);
  const read = async <T>(
    kind: ArtifactFile["kind"],
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    const artifact = artifacts.find((item) => item.kind === kind);
    if (artifact === undefined) return null;
    const bytes = await inputs.readArtifact(artifact.objectKey);
    if (bytes === undefined || sha256(bytes) !== artifact.sha256) return null;
    try {
      const parsed = schema.safeParse(
        JSON.parse(Buffer.from(bytes).toString("utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const [set, table] = await Promise.all([
    read("fixture_set", fixtureSetSchema),
    read("pseudonyms", preparedPseudonymsSchema),
  ]);
  return {
    fixtures:
      set === null || set.sliceRunId !== sliceRunId
        ? null
        : {
            fixtureRunId: run.id,
            fixtures: set.fixtures,
            scenario: set.scenario,
          },
    pseudonyms:
      table === null || table.sliceRunId !== sliceRunId
        ? null
        : {
            rules: table.rules,
            summary: table.summary,
            usage: table.usage as AgentUsage,
          },
  };
}
