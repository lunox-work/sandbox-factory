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

const ready = { code: null, error: null, missing: [], acceptUrl: null };

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
  status: () => unknown = () => ready,
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
      if (url.endsWith("/merge-back")) return json({ mergeBack: status() });
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

test("a submission that could not be graded says why and is graded again with the same files", async () => {
  const calls: string[] = [];
  let regraded = false;
  let refuse = false;
  const errored = submission({
    status: "errored",
    errorCode: "grading_timed_out",
    verdict: null,
    public: null,
    hidden: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/regrade")) {
        if (refuse)
          return json(
            {
              error:
                "The submission's grading run has used its attempts. Retry it with other files.",
              code: "regrade_spent",
            },
            409,
          );
        regraded = true;
        return json({
          submission: submission({ status: "queued", verdict: null }),
        });
      }
      return json({
        submissions: [
          regraded
            ? submission({
                status: "queued",
                verdict: null,
                public: null,
                hidden: null,
              })
            : errored,
        ],
      });
    }),
  );
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect(await screen.findByText("Could not run")).toBeTruthy();
  expect(screen.getByText(/Grading ran out of time/).textContent).toContain(
    "keeps its retry",
  );
  expect(screen.queryByRole("button", { name: "Open pull request" })).toBe(
    null,
  );
  await userEvent.click(screen.getByRole("button", { name: "Grade again" }));
  expect(await screen.findByText("Queued")).toBeTruthy();
  expect(calls).toContain(
    "POST /api/v1/orgs/org_1/sandboxes/submissions/sbm_1/regrade",
  );
  expect(screen.queryByRole("button", { name: "Grade again" })).toBe(null);
  cleanup();

  // Out of attempts: the refusal says so.
  regraded = false;
  refuse = true;
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Grade again" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "used its attempts",
  );
});

test("a submission's label: waiting, grading, errored, and verdicts before and after they were kept", () => {
  const label = (overrides: object) =>
    submissionLabel(submission(overrides) as never);
  expect(label({ status: "queued", verdict: null })).toBe("Queued");
  expect(label({ status: "running", verdict: null })).toBe("Grading");
  expect(label({ status: "errored", verdict: null })).toBe("Could not run");
  expect(
    label({ status: "errored", errorCode: "grading_failed", verdict: null }),
  ).toBe("Could not run");
  expect(label({ status: "passed", verdict: null })).toBe("Passed");
  expect(label({ status: "failed", verdict: null })).toBe("Failed");
  expect(label({ status: "failed", verdict: "refused" })).toBe("Refused");
});

test("a pass whose carry back failed says so and offers no merge-back", async () => {
  const { calls } = serve([submission({ carryBack: "failed" })]);
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect(await screen.findByText("Passed")).toBeTruthy();
  expect(
    screen.getByText(/did not build and pass in the repository's names/)
      .textContent,
  ).toContain("merge-back is disabled");
  expect(screen.queryByRole("button", { name: "Open pull request" })).toBe(
    null,
  );
  expect(calls.some((call) => call.endsWith("/merge"))).toBe(false);
});

test("a GitHub App without merge-back's permissions disables the button, says why and links to where they are accepted", async () => {
  let status: unknown = {
    code: "app_permissions_missing",
    error:
      "The GitHub App has not been granted what merge-back needs on this installation.",
    missing: ["contents:write", "pull_requests:write"],
    acceptUrl: "https://github.com/organizations/acme/settings/installations/9",
  };
  const { calls } = serve([submission()], undefined, () => status);
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  const reason = await screen.findByTestId("merge-back-blocked");
  expect(reason.textContent).toContain("has not been granted");
  expect(reason.textContent).toContain(
    "Missing: contents:write, pull_requests:write.",
  );
  expect(
    screen
      .getByRole("link", { name: "Accept new permissions on GitHub" })
      .getAttribute("href"),
  ).toBe("https://github.com/organizations/acme/settings/installations/9");
  const button = screen.getByRole("button", { name: "Open pull request" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute("aria-describedby")).toBe("merge-back-blocked");
  await userEvent.click(button);
  expect(calls.some((call) => call.endsWith("/merge"))).toBe(false);
  expect(calls).toContain(
    "GET /api/v1/orgs/org_1/sandboxes/versions/sbv_1/merge-back",
  );
  cleanup();

  // Accepted: the same version offers the merge.
  status = ready;
  serve([submission()], undefined, () => status);
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  const enabled = await screen.findByRole("button", {
    name: "Open pull request",
  });
  await waitFor(() =>
    expect((enabled as HTMLButtonElement).disabled).toBe(false),
  );
  expect(screen.queryByTestId("merge-back-blocked")).toBe(null);
  cleanup();

  // A repository gone says so, with nothing to accept.
  serve([submission()], undefined, () => ({
    code: "repository_unavailable",
    error: "The repository is gone, or its GitHub installation is not healthy.",
    missing: [],
    acceptUrl: null,
  }));
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect((await screen.findByTestId("merge-back-blocked")).textContent).toBe(
    "The repository is gone, or its GitHub installation is not healthy.",
  );
  expect(screen.queryByRole("link")).toBe(null);
});
