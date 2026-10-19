/**
 * The first build's rows: builders that run at once fill bars side by
 * side, and one that waits names what it waits for.
 */

import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { expect, test } from "vitest";

import { RepositoryBuildProgress } from "../src/features/analysis/RepositoryBuildProgress";
import { render, screen, within } from "./render";

function run(
  tool: AnalysisRunDto["tool"],
  status: AnalysisRunDto["status"],
  fraction?: { done: number; total: number },
): AnalysisRunDto {
  return {
    id: `run_${tool}`,
    tool,
    status,
    progress: fraction === undefined ? null : { count: 0, steps: [], fraction },
  } as AnalysisRunDto;
}

const row = (name: string) => screen.getByRole("listitem", { name });

test("running builders fill bars; waiting ones name what they wait for", () => {
  render(
    <RepositoryBuildProgress
      build={{
        phase: "building",
        commitSha: "31d464c0",
        held: false,
        runs: {
          graphify: run("graphify", "running", { done: 340, total: 1000 }),
          documents: run("documents", "succeeded"),
          abstractions: run("abstractions", "queued"),
          data_model: run("data_model", "queued"),
          brief: run("brief", "queued"),
        },
      }}
      onRetry={() => {}}
    />,
  );
  const graph = within(row("Graphify")).getByRole("progressbar");
  expect(graph.getAttribute("aria-valuenow")).toBe("34");
  expect(within(row("Graphify")).getByText("34%")).toBeDefined();
  expect(
    within(row("Documents"))
      .getByRole("progressbar")
      .getAttribute("aria-valuenow"),
  ).toBe("100");
  expect(within(row("Documents")).getByLabelText("Built")).toBeDefined();
  expect(
    within(row("Abstractions")).getByText("Waiting for Graphify"),
  ).toBeDefined();
  expect(
    within(row("Data model")).getByText("Waiting for Graphify"),
  ).toBeDefined();
  expect(
    within(row("Brief")).getByText(
      "Waiting for Graphify, Abstractions, Data model",
    ),
  ).toBeDefined();
});

test("a builder running without a count sweeps; one that failed says so", () => {
  render(
    <RepositoryBuildProgress
      build={{
        phase: "building",
        commitSha: "31d464c0",
        held: false,
        runs: {
          graphify: run("graphify", "succeeded"),
          documents: run("documents", "succeeded"),
          abstractions: run("abstractions", "failed"),
          data_model: run("data_model", "succeeded"),
          brief: run("brief", "running"),
        },
      }}
      onRetry={() => {}}
    />,
  );
  expect(
    within(row("Brief")).getByRole("progressbar").hasAttribute("aria-valuenow"),
  ).toBe(false);
  expect(within(row("Abstractions")).getByText("Failed")).toBeDefined();
});

test("a set held for the run cap lists its builders queued", () => {
  render(
    <RepositoryBuildProgress
      build={{ phase: "building", commitSha: "31d464c0", held: true, runs: {} }}
      onRetry={() => {}}
    />,
  );
  expect(within(row("Graphify")).getByText("Queued")).toBeDefined();
  expect(within(row("Documents")).getByText("Queued")).toBeDefined();
  expect(
    within(row("Abstractions")).getByText("Waiting for Graphify"),
  ).toBeDefined();
});
