/**
 * What a project folder tells the extension, and what the extension will run.
 *
 * `sandbox-task.json` is read from the folder, so it is data: it is
 * parsed strictly and nothing in it decides what gets executed. The
 * commands come from the fixed table in `packages/core`, the same ones a
 * terminal user types; the descriptor can only confirm they exist.
 */

import {
  taskDescriptorSchema,
  type TaskDescriptorDto,
} from "@sandbox-factory/shared";
import { SANDBOX_COMMANDS, type SandboxCommand } from "sandbox-factory";

export type DescriptorResult =
  | { readonly ok: true; readonly descriptor: TaskDescriptorDto }
  | {
      readonly ok: false;
      readonly reason: "missing" | "invalid";
      readonly detail: string;
    };

export function parseDescriptor(text: string | null): DescriptorResult {
  if (text === null)
    return {
      ok: false,
      reason: "missing",
      detail: "No sandbox-task.json in this folder.",
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "invalid",
      detail: "sandbox-task.json is not JSON.",
    };
  }
  const result = taskDescriptorSchema.safeParse(parsed);
  return result.success
    ? { ok: true, descriptor: result.data }
    : {
        ok: false,
        reason: "invalid",
        detail: `sandbox-task.json is not a task descriptor: ${result.error.issues
          .map((issue) => issue.path.join(".") || "root")
          .join(", ")}.`,
      };
}

/** The exact shell line for a command. Never read from the folder. */
export function commandLine(kind: SandboxCommand): string {
  return SANDBOX_COMMANDS[kind];
}

export function describeTask(descriptor: TaskDescriptorDto): string {
  return `${descriptor.title} (v${descriptor.version}, ${descriptor.complexity}) · ${descriptor.editablePaths.length} editable file(s) · ${descriptor.publicTests.length} public test file(s) · Node ${descriptor.toolchain.nodeRange}`;
}
