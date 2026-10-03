/**
 * `sandbox-task.json`: the public version descriptor at a project's root.
 *
 * It tells the extension and a terminal user what the task is, how to run
 * it and what the tests are called. It carries no mapping, hidden test,
 * source commit or any other private field; `descriptorPublic` is the
 * check tests run on every generated one.
 */

import { SANDBOX_COMMANDS, type Toolchain } from "./build.js";

export const TASK_DESCRIPTOR_SCHEMA_VERSION = 1;
export const TASK_DESCRIPTOR_PATH = "sandbox-task.json";

export interface TaskDescriptor {
  readonly schemaVersion: typeof TASK_DESCRIPTOR_SCHEMA_VERSION;
  readonly sandboxId: string;
  readonly versionId: string;
  readonly version: number;
  readonly title: string;
  readonly specSummary: string;
  readonly complexity: string;
  readonly tags: readonly string[];
  readonly commands: typeof SANDBOX_COMMANDS;
  readonly toolchain: Toolchain;
  /** Paths a contribution may change; everything else is harness. */
  readonly editablePaths: readonly string[];
  readonly publicTests: readonly string[];
  readonly testSummary: readonly {
    readonly label: string;
    readonly count: number;
  }[];
}

/**
 * Keys that must never appear anywhere in a descriptor, however nested.
 * The list is the private vocabulary of the version record; a descriptor
 * that mentions one has been built from the wrong object.
 */
export const DESCRIPTOR_FORBIDDEN_KEYS: readonly string[] = [
  "aliasRules",
  "aliases",
  "sourceCommitSha",
  "sourceSnapshotId",
  "sliceRunId",
  "approvedTaskSha256",
  "transformConfigSha256",
  "privateTests",
  "acceptanceTests",
  "proposalId",
  "amountMinor",
  "jiraIssueIds",
  "repoFullName",
];

export function descriptorPublic(value: unknown): {
  ok: boolean;
  offending: string[];
} {
  const offending: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node))
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (node !== null && typeof node === "object")
      for (const [key, child] of Object.entries(node)) {
        if (DESCRIPTOR_FORBIDDEN_KEYS.includes(key))
          offending.push(path === "" ? key : `${path}.${key}`);
        walk(child, path === "" ? key : `${path}.${key}`);
      }
  };
  walk(value, "");
  return { ok: offending.length === 0, offending };
}
