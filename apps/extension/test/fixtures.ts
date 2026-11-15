import type {
  ContributionDto,
  ContributionSubmissionDto,
} from "@sandbox-factory/shared";
import { SANDBOX_COMMANDS, SANDBOX_TOOLCHAIN } from "sandbox-factory";

/** A valid `sandbox-task.json`, shared by the task and command tests. */
export const descriptor = {
  schemaVersion: 1,
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 2,
  title: "Fix the widget",
  specSummary: "Make it work.",
  complexity: "M",
  tags: ["typescript"],
  commands: SANDBOX_COMMANDS,
  toolchain: SANDBOX_TOOLCHAIN,
  editablePaths: ["src/app.ts"],
  publicTests: ["tests/public/interface.test.ts", "tests/public/spec.test.ts"],
  testSummary: [{ label: "public", count: 2 }],
};

/** A contributor's own submission as the API answers it. */
export function submission(
  overrides: Partial<ContributionSubmissionDto> = {},
): ContributionSubmissionDto {
  return {
    id: "sbm_1",
    sandboxVersionId: "sbv_1",
    status: "queued",
    errorCode: null,
    verdict: null,
    public: null,
    hidden: null,
    failedScenarios: [],
    refused: [],
    retryOf: null,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

/** A contribution as `GET /api/v1/contributions` lists it. */
export function contribution(
  overrides: Partial<ContributionDto> = {},
): ContributionDto {
  return {
    assignmentId: "asg_1",
    versionId: "sbv_1",
    version: 2,
    root: "sbx_1-v2",
    title: "Fix the widget",
    specSummary: "Make it work.",
    complexity: "M",
    tags: [],
    commands: null,
    editablePaths: ["src/app.ts"],
    nodeRange: null,
    open: true,
    closesAt: "2026-12-01T00:00:00.000Z",
    joinedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}
