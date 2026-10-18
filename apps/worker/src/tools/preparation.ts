/**
 * A sandbox's preparation: what a `fixtures` run with `pseudonyms` writes
 * beside its fixture set, once a bounty's profile is ready and its price
 * approved, so a Sandbox click finds both written and its build runs one
 * baseline and the hidden-tests agent only.
 *
 * The name table is checked here as far as it can be without a version:
 * the rules hold as a set and map back, and no file a contributor will
 * read (the slice, its stubs, the spec, the fixtures, the walkthrough and
 * the listing a cut gives the version) names the workspace. The build
 * checks it again against the project it generates, and writes its own
 * when that check refuses it (`sandbox-build.ts`).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXTURES_TOOL_VERSION,
  applyAliases,
  canonicalJson,
  emailNames,
  isFixturesParams,
  jsonLeaves,
  vocabularyBlockers,
  vocabularyLeaks,
} from "sandbox-factory";
import type {
  AgentUsage,
  AliasRule,
  SandboxFixture,
  SpecDraft,
  VersionFixtures,
  VocabularyName,
} from "sandbox-factory";
import {
  aliasRulesSchema,
  agentUsageSchema,
  fixtureSetSchema,
} from "@sandbox-factory/shared";
import { z } from "zod";
import type { AgentSettings } from "../agent/loop.js";
import type { RunTiming } from "../timing.js";
import type { ArtifactFile, ToolInputs } from "./adapter.js";
import type { PseudonymCheck, WrittenPseudonyms } from "./pseudonyms.js";
import { settlePseudonyms, writePseudonyms } from "./pseudonyms.js";
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

/**
 * A preparation's check of a name table: what `applyAliases` refuses, and
 * every workspace name left in the renamed files. Pure, so cheap to repeat.
 */
export function preparationCheck(input: {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly spec: SpecDraft | null;
  readonly fixtures: readonly SandboxFixture[];
  readonly scenario: string | null;
  readonly listing: { readonly title: string; readonly summary: string };
  readonly vocabulary: readonly string[];
}): (rules: readonly AliasRule[]) => PseudonymCheck {
  const files = [
    ...input.files,
    ...(input.spec === null ? [] : jsonLeaves("__spec__.json", input.spec)),
    ...jsonLeaves("__fixtures__.json", input.fixtures),
    ...jsonLeaves("__listing__.json", input.listing),
    ...(input.scenario === null
      ? []
      : [{ path: "sandbox/run.ts", text: input.scenario }]),
  ];
  return (rules) => {
    const aliased = applyAliases(files, rules);
    if (!aliased.ok)
      return {
        problems: aliased.problems.map(
          (problem) =>
            `${problem.file ?? problem.code}: ${problem.code}${problem.rule === null ? "" : ` (rule ${problem.rule})`}: ${problem.detail}`,
        ),
        applied: aliased.applied,
      };
    return {
      problems: vocabularyBlockers(
        vocabularyLeaks(aliased.files, input.vocabulary),
      ).map((blocker) => `${blocker.file ?? blocker.code}: ${blocker.detail}`),
      applied: aliased.applied,
    };
  };
}

/** What a preparation's name table is written from. */
export interface PseudonymsInput {
  readonly settings: AgentSettings;
  readonly listing: { readonly title: string; readonly summary: string };
  readonly spec: SpecDraft;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly vocabulary: readonly string[];
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly step?: ((text: string) => void) | undefined;
  readonly timing?: RunTiming | undefined;
}

/**
 * A table drafted from the slice while the fixtures agent writes the
 * fixtures, checked without them; `writePreparedPseudonyms` checks it
 * against them once they are there.
 */
export async function draftPreparedPseudonyms(
  input: PseudonymsInput,
): Promise<WrittenPseudonyms | null> {
  if (input.settings.model === null) return null;
  return writePseudonyms({
    model: input.settings.model,
    limits: input.settings.limits,
    task: { ...input.listing, spec: input.spec },
    files: input.files,
    vocabulary: input.vocabulary,
    check: preparationCheck({ ...input, fixtures: [], scenario: null }),
    signal: input.signal,
    log: input.log,
    step: input.step,
    timing: input.timing,
  });
}

/**
 * Writes a preparation's name table, or none when its agent kept none: the
 * one drafted beside the fixtures when it holds against them, else one an
 * agent writes, from that draft if there was one.
 */
export async function writePreparedPseudonyms(
  input: PseudonymsInput & {
    readonly outDir: string;
    readonly sliceRunId: string;
    readonly fixtures: readonly SandboxFixture[];
    readonly scenario: string;
    readonly drafted: WrittenPseudonyms | null;
  },
): Promise<ArtifactFile | null> {
  const model = input.settings.model;
  if (model === null) return null;
  const check = preparationCheck(input);
  const written = await settlePseudonyms(
    input.drafted,
    (drafted) =>
      writePseudonyms({
        model,
        limits: input.settings.limits,
        task: { ...input.listing, spec: input.spec },
        files: input.files,
        vocabulary: input.vocabulary,
        check,
        drafted,
        signal: input.signal,
        log: input.log,
        step: input.step,
        timing: input.timing,
      }),
    check,
    input.log,
  );
  if (written === null) return null;
  const table = {
    schemaVersion: PREPARED_PSEUDONYMS_SCHEMA_VERSION,
    toolVersion: FIXTURES_TOOL_VERSION,
    sliceRunId: input.sliceRunId,
    rules: written.rules,
    summary: written.summary,
    usage: written.usage,
  };
  const absolutePath = join(input.outDir, PREPARED_PSEUDONYMS_PATH);
  await writeFile(absolutePath, canonicalJson(table), "utf8");
  return {
    path: PREPARED_PSEUDONYMS_PATH,
    absolutePath,
    kind: "pseudonyms",
    contentType: "application/json",
    meta: { rules: written.rules.length },
  };
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
