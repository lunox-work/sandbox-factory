/**
 * Reading a slice's boundary: the view of the bounded summary the worker
 * attached to `boundary-contract.json`. Slices are made by bounties, so
 * this is the read-only view the repository page shows for such a run.
 */

import { render, screen, fireEvent } from "./render";
import { expect, test, vi } from "vitest";
import type {
  ArtifactDto,
  SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";
import { SliceBoundary } from "../src/features/analysis/SliceBoundary";

const stamp = "2026-10-01T00:00:00.000Z";

const summary: SliceBoundarySummaryDto = {
  schemaVersion: 1,
  language: "typescript",
  stubCoverage: "partial",
  ready: false,
  counts: {
    includedFiles: 2,
    includedBytes: 10,
    outboundModules: 1,
    inboundModules: 1,
    stubs: 2,
    publicSymbols: 1,
    externals: 2,
    blockers: 1,
  },
  included: ["src/app.ts", "src/local.ts"],
  outbound: [
    {
      module: "lib/service.ts",
      symbols: ["Service", "createService"],
      importedBy: ["src/app.ts"],
      truncated: true,
    },
  ],
  inbound: [
    {
      module: "src/app.ts",
      symbols: [],
      importedBy: ["consumers/cli.ts"],
      truncated: false,
    },
  ],
  externals: {
    packages: [{ specifier: "pg", service: "postgres" }],
    environment: ["DATABASE_URL"],
  },
  blockers: [
    {
      code: "unresolved_import",
      file: "src/app.ts",
      location: "L4",
      detail: "x does not resolve.",
    },
  ],
  truncated: true,
};
const artifact = (
  path: string,
  kind: ArtifactDto["kind"],
  meta: ArtifactDto["meta"] = null,
): ArtifactDto => ({
  id: `art_${path}`,
  runId: "arn_slice",
  kind,
  path,
  contentType: "text/plain",
  sizeBytes: 1,
  sha256: "c".repeat(64),
  meta,
  createdAt: stamp,
});

test("the boundary view renders coverage, blockers, modules and externals from the summary", () => {
  const onOpen = vi.fn();
  render(
    <SliceBoundary
      summary={summary}
      artifacts={[
        artifact("boundary.md", "boundary_md"),
        artifact("abstract.md", "abstract_md"),
      ]}
      onOpen={onOpen}
    />,
  );
  expect(screen.getByText("Diagnostic only")).toBeTruthy();
  expect(screen.getByText("coverage: partial")).toBeTruthy();
  expect(screen.getByText(/summary truncated/)).toBeTruthy();
  expect(screen.getByText(/x does not resolve/)).toBeTruthy();
  expect(screen.getByText("Service, createService …")).toBeTruthy();
  expect(screen.getByText("Whole module")).toBeTruthy();
  expect(screen.getByText(/Imported by consumers\/cli.ts/)).toBeTruthy();
  expect(screen.getByText("DATABASE_URL")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open boundary.md" }));
  expect(onOpen).toHaveBeenCalledWith("art_boundary.md");
  expect(screen.queryByRole("button", { name: "Open public-surface.md" })).toBe(
    null,
  );
  render(
    <SliceBoundary
      summary={{
        ...summary,
        ready: true,
        blockers: [],
        outbound: [],
        inbound: [],
        externals: { packages: [], environment: [] },
        truncated: false,
      }}
      artifacts={[]}
      onOpen={onOpen}
    />,
  );
  expect(screen.getByText("Ready for the sandbox gates")).toBeTruthy();
  expect(
    screen.getByText("The slice imports nothing outside itself."),
  ).toBeTruthy();
  expect(
    screen.getByText("No service SDKs or environment reads were detected."),
  ).toBeTruthy();
});
