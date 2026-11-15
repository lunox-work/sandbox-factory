import { cleanup, render, screen, waitFor } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  mergeLabel,
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

  // A generated or uploaded version: nothing to merge into; its files instead.
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
  expect(
    screen.getByRole("button", { name: "Download the passing files" }),
  ).toBeTruthy();
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

const opened = (overrides: object = {}) => ({
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/shop/pull/7",
  branch: "lunox/sbm_1",
  createdAt: stamp,
  ...overrides,
});

test("a pass can be opened to merge when CI passes, which sends that with the merge", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/merge")) {
        bodies.push(
          init?.body === undefined ? null : JSON.parse(String(init.body)),
        );
        return json({
          submission: submission({ merge: opened({ when: "ci_passes" }) }),
        });
      }
      if (url.endsWith("/merge-back")) return json({ mergeBack: ready });
      return json({
        submissions: [
          submission({
            merge: bodies.length === 0 ? null : opened({ when: "ci_passes" }),
          }),
        ],
      });
    }),
  );
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  const button = await screen.findByRole("button", {
    name: "Open and merge when CI passes",
  });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  await userEvent.click(button);
  expect(
    (await screen.findByTestId("submission-merge-state")).textContent,
  ).toBe("CI not started · merges when CI passes");
  expect(bodies).toEqual([{ when: "ci_passes" }]);
  // Already merging on CI: not offered again.
  expect(screen.queryByRole("button", { name: "Merge when CI passes" })).toBe(
    null,
  );
});

test("without CI read-back's permissions, merging on CI is disabled with why and where to accept them; opening alone is not", async () => {
  serve([submission()], undefined, () => ({
    ...ready,
    acceptUrl: "https://github.com/organizations/acme/settings/installations/9",
    ciMissing: ["checks:read", "statuses:read"],
  }));
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  const hint = await screen.findByTestId("merge-back-ci");
  expect(hint.textContent).toContain("missing checks:read, statuses:read");
  expect(
    screen
      .getByRole("link", { name: "Accept new permissions on GitHub" })
      .getAttribute("href"),
  ).toBe("https://github.com/organizations/acme/settings/installations/9");
  const onCi = screen.getByRole("button", {
    name: "Open and merge when CI passes",
  });
  expect((onCi as HTMLButtonElement).disabled).toBe(true);
  expect(onCi.getAttribute("aria-describedby")).toBe("merge-back-ci");
  expect(
    (
      screen.getByRole("button", {
        name: "Open pull request",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("an opened pull request's row shows its CI, a refused merge, and that it merged; one opened alone can be set to merge on CI", async () => {
  const calls: string[] = [];
  let row = opened({
    ci: {
      state: "failing",
      summary: {
        total: 3,
        passed: 2,
        failed: 1,
        pending: 0,
        failing: ["e2e"],
        detailsUrl: "https://ci.test/e2e",
      },
      headSha: "beef",
      checkedAt: stamp,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url} ${String(init?.body ?? "")}`);
      if (url.endsWith("/merge")) {
        row = { ...row, when: "ci_passes" } as typeof row;
        return json({ submission: submission({ merge: row }) });
      }
      if (url.endsWith("/merge-back")) return json({ mergeBack: ready });
      return json({ submissions: [submission({ merge: row })] });
    }),
  );
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  const state = await screen.findByTestId("submission-merge-state");
  expect(state.textContent).toBe("CI failing: e2e details");
  expect(
    screen.getByRole("link", { name: "details" }).getAttribute("href"),
  ).toBe("https://ci.test/e2e");
  await userEvent.click(
    screen.getByRole("button", { name: "Merge when CI passes" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Merge when CI passes" })).toBe(
      null,
    ),
  );
  expect(calls).toContain(
    `POST /api/v1/orgs/org_1/sandboxes/submissions/sbm_1/merge ${JSON.stringify({ when: "ci_passes" })}`,
  );
  cleanup();

  // Passing, GitHub refused (branch protection): said, and still open.
  row = opened({
    when: "ci_passes",
    ci: {
      state: "passing",
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        failing: [],
        detailsUrl: null,
      },
      headSha: "beef",
      checkedAt: stamp,
    },
    mergeError: "At least 1 approving review is required.",
  });
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect(
    (await screen.findByTestId("submission-merge-state")).textContent,
  ).toBe("CI passing (1/1) · merges when CI passes");
  expect(
    screen.getByText(/GitHub refused the merge: At least 1 approving review/),
  ).toBeTruthy();
  cleanup();

  row = opened({
    pullRequestState: "merged",
    mergedCommitSha: "0123456789abcdef",
    mergeError: "At least 1 approving review is required.",
  });
  render(
    <SandboxSubmissions organizationId="org_1" versionId="sbv_1" canMerge />,
  );
  expect(
    (await screen.findByTestId("submission-merge-state")).textContent,
  ).toBe("Merged as 0123456");
  expect(screen.queryByText(/GitHub refused/)).toBe(null);
  expect(screen.getByRole("link", { name: /Pull request #7/ })).toBeTruthy();
});

test("a merged-back pull request's label for each state it can be read in", () => {
  const label = (overrides: object) => mergeLabel(opened(overrides) as never);
  const summary = (passed: number, total: number) => ({
    total,
    passed,
    failed: 0,
    pending: total - passed,
    failing: [],
    detailsUrl: null,
  });
  const ci = (state: string, value: unknown = null) => ({
    ci: { state, summary: value, headSha: null, checkedAt: null },
  });
  expect(
    label({ when: "open", pullRequestState: "open", ...ci("pending") }),
  ).toBe("CI not started");
  expect(
    label({
      when: "open",
      pullRequestState: "open",
      ...ci("pending", summary(1, 3)),
    }),
  ).toBe("CI running (1/3 passed)");
  expect(
    label({ when: "open", pullRequestState: "open", ...ci("passing") }),
  ).toBe("CI passing");
  expect(
    label({ when: "open", pullRequestState: "open", ...ci("failing") }),
  ).toBe("CI failing");
  expect(
    label({ when: "ci_passes", pullRequestState: "open", ...ci("none") }),
  ).toBe("No CI checks reported · merges when CI passes");
  expect(
    label({ when: "ci_passes", pullRequestState: "open", ...ci("unknown") }),
  ).toBe("CI not readable: the GitHub App needs checks and statuses read");
  expect(
    label({
      pullRequestState: "merged",
      mergedCommitSha: null,
      ...ci("passing"),
    }),
  ).toBe("Merged");
  expect(label({ pullRequestState: "closed", ...ci("failing") })).toBe(
    "Closed without merging",
  );
});

test("a pass on a version with no repository downloads its changed files as the .zip the API names", async () => {
  const calls: string[] = [];
  let refuse = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/files/archive"))
        return refuse
          ? json(
              {
                error: "The submission's files could not be read.",
                code: "artifacts_unavailable",
              },
              502,
            )
          : Promise.resolve(
              new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
                status: 200,
                headers: {
                  "content-type": "application/zip",
                  "content-disposition":
                    'attachment; filename="sbm_1-files.zip"',
                },
              }),
            );
      return json({
        submissions: [
          submission(),
          submission({ id: "sbm_0", status: "failed", verdict: "incomplete" }),
        ],
      });
    }),
  );
  // jsdom has no object URLs; the page makes one and lets it go.
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = () => "blob:files";
  URL.revokeObjectURL = () => undefined;
  const clicked: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
  render(
    <SandboxSubmissions
      organizationId="org_1"
      versionId="sbv_1"
      canMerge={false}
    />,
  );
  // One button: the failing submission offers none.
  const buttons = await screen.findAllByRole("button", {
    name: "Download the passing files",
  });
  expect(buttons).toHaveLength(1);
  await userEvent.click(buttons[0] as HTMLElement);
  await waitFor(() => expect(clicked).toEqual(["sbm_1-files.zip"]));
  expect(calls).toContain(
    "/api/v1/orgs/org_1/sandboxes/submissions/sbm_1/files/archive",
  );
  // No merge-back readiness is read for such a version.
  expect(calls.some((url) => url.endsWith("/merge-back"))).toBe(false);
  refuse = true;
  await userEvent.click(
    screen.getByRole("button", { name: "Download the passing files" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "could not be read",
  );
  click.mockRestore();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});
