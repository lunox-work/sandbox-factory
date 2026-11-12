import { cleanup, render, screen, waitFor } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  SandboxSubmissions,
  submissionLabel,
} from "../src/features/sandbox/SandboxSubmissions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stamp = "2026-11-12T00:00:00.000Z";
const submission = (overrides: object = {}) => ({
  id: "sbm_1",
  sandboxVersionId: "sbv_1",
  status: "passed",
  verdict: "passed",
  public: { passed: 1, total: 1 },
  hidden: { passed: 2, total: 2 },
  failedScenarios: [],
  refused: [],
  runId: "arn_grade",
  retryOf: null,
  merge: null,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

function serve(
  listed: unknown[],
  merge: () => Promise<Response> = () =>
    json({
      submission: submission({
        merge: {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/shop/pull/7",
          branch: "lunox/sbm_1",
          createdAt: stamp,
        },
      }),
    }),
) {
  const calls: string[] = [];
  let merged = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/merge")) {
        merged = true;
        return merge();
      }
      return json({
        submissions: merged
          ? [
              submission({
                merge: {
                  pullRequestNumber: 7,
                  pullRequestUrl: "https://github.com/acme/shop/pull/7",
                  branch: "lunox/sbm_1",
                  createdAt: stamp,
                },
              }),
            ]
          : listed,
      });
    }),
  );
  return { calls };
}

test("a version's submissions show verdicts, counts and failing scenario keys, and a pass is merged back", async () => {
  const { calls } = serve([
    submission(),
    submission({
      id: "sbm_0",
      status: "failed",
      verdict: "overfit",
      hidden: { passed: 1, total: 2 },
      failedScenarios: ["s2"],
    }),
  ]);
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect(await screen.findByText("Overfit")).toBeTruthy();
  expect(
    screen.getByText(/Hidden 1\/2 · Failing scenarios s2/).textContent,
  ).toContain("s2");
  await userEvent.click(
    screen.getByRole("button", { name: "Open pull request" }),
  );
  const link = await screen.findByRole("link", { name: /Pull request #7/ });
  expect(link.getAttribute("href")).toBe("https://github.com/acme/shop/pull/7");
  expect(calls).toContain(
    "POST /api/v1/orgs/org_1/sandboxes/submissions/sbm_1/merge",
  );
});

test("a refused merge-back says why; a generated version offers none; an empty list says how submissions come", async () => {
  serve([submission()], () =>
    json(
      {
        error: "The GitHub App cannot write to this repository.",
        code: "merge_forbidden",
      },
      409,
    ),
  );
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Open pull request" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "cannot write",
  );
  cleanup();

  serve([submission()]);
  render(
    <SandboxSubmissions
      organizationId="org_1"
      versionId="sbv_1"
      canMerge={false}
    />,
  );
  await screen.findByText("Passed");
  expect(screen.queryByRole("button", { name: "Open pull request" })).toBe(
    null,
  );
  cleanup();

  serve([]);
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  await waitFor(() =>
    expect(screen.getByText(/No submissions yet/)).toBeTruthy(),
  );
});

test("a submission's label: waiting, grading, errored, and verdicts before and after they were kept", () => {
  const label = (overrides: object) =>
    submissionLabel(submission(overrides) as never);
  expect(label({ status: "queued", verdict: null })).toBe("Queued");
  expect(label({ status: "running", verdict: null })).toBe("Grading");
  expect(label({ status: "errored", verdict: null })).toBe("Could not run");
  expect(label({ status: "passed", verdict: null })).toBe("Passed");
  expect(label({ status: "failed", verdict: null })).toBe("Failed");
  expect(label({ status: "failed", verdict: "refused" })).toBe("Refused");
});
