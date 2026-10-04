import type { BountyProfileDto } from "@sandbox-factory/shared";
import { act, render, screen, waitFor, within } from "./render";
import { afterEach, expect, test, vi } from "vitest";

import {
  ComplexityProfileBlock,
  PROFILE_POLL_MS,
  useProposalProfile,
} from "../src/ComplexityProfile";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = "/api/v1/orgs/org_1";

function Wired({
  specRevision = 2,
  drafted = true,
}: {
  specRevision?: number | null;
  drafted?: boolean;
}) {
  const read = useProposalProfile(BASE, "bpr_1", specRevision, drafted);
  return <ComplexityProfileBlock read={read} specRevision={specRevision} />;
}

const profile = {
  version: "profile-v1",
  bounty: { issueType: "Bug", priority: "High" },
  slice: {
    files: 9,
    bytes: 42 * 1024,
    modules: ["src/mailer", "src/scheduler", "src/db"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  },
  touchedModules: ["src/mailer", "src/scheduler"],
  externals: { services: ["email"], environment: 2, seams: 1 },
  spec: {
    scenarios: 3,
    kinds: {
      happy: 1,
      boundary: 0,
      unhappy: 0,
      recovery: 1,
      permission: 0,
      concurrency: 0,
      "non-functional": 1,
    },
    openQuestions: 0,
    assumptions: 1,
  },
  tests: { files: 4, untestedModules: ["src/scheduler"] },
  pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  nonFunctional: { scenarios: 1, migrations: false, ci: true },
  risks: ["Retries only exist as a mock."],
} as const;

function stored(overrides: Partial<BountyProfileDto> = {}): BountyProfileDto {
  return {
    id: "bpf_1",
    proposalId: "bpr_1",
    specRevision: 2,
    status: "ready",
    errorCode: null,
    runErrorCode: null,
    snapshotId: "rsn_1",
    scopeRunId: "arn_1",
    sliceRunId: "arn_2",
    profile: profile as unknown as BountyProfileDto["profile"],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:05:00.000Z",
    ...overrides,
  };
}

function answer(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies)
    fetch.mockResolvedValueOnce(
      body instanceof Response
        ? body
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

test("a ready profile lists the evidence, one row per feature", async () => {
  const fetch = answer({ profile: stored() });
  render(<Wired />);

  const rows = await screen.findByTestId("profile-rows");
  expect(fetch).toHaveBeenCalledWith(
    `${BASE}/proposals/bpr_1/profile`,
    expect.objectContaining({
      credentials: "include",
      signal: expect.any(AbortSignal),
    }),
  );
  const text = (label: string) =>
    within(rows).getByText(label).nextElementSibling?.textContent;
  expect(text("Bounty")).toBe("Bug, priority High");
  expect(text("Slice")).toBe("9 files in 3 modules, 42 KB");
  expect(text("Modules touched")).toBe("2: src/mailer, src/scheduler");
  expect(text("External services")).toBe(
    "1: email; 2 environment variables; 1 mocked seam",
  );
  expect(text("Spec clarity")).toBe("0 open questions, 1 assumption");
  expect(text("Tests on the path")).toBe("4 test files; none in src/scheduler");
  expect(text("Analogous pattern")).toBe(
    "src/mailer/offer.ts — retries idempotently",
  );
  expect(text("Non-functional")).toBe(
    "1 non-functional scenario, CI configured",
  );
  expect(screen.getByText("Retries only exist as a mock.")).toBeTruthy();
  expect(screen.queryByText(/the spec has changed since/)).toBeNull();
});

test("a sparse profile says so plainly, and names an older spec revision", async () => {
  answer({
    profile: stored({
      specRevision: 1,
      profile: {
        ...profile,
        bounty: { issueType: "Task", priority: null },
        slice: { ...profile.slice, bytes: 900, blockers: 2 },
        externals: { services: [], environment: 0, seams: 0 },
        tests: { files: 0, untestedModules: ["src/mailer"] },
        pattern: null,
        nonFunctional: { scenarios: 0, migrations: true, ci: false },
        risks: [],
      } as unknown as BountyProfileDto["profile"],
    }),
  });
  render(<Wired />);

  const rows = await screen.findByTestId("profile-rows");
  const text = (label: string) =>
    within(rows).getByText(label).nextElementSibling?.textContent;
  expect(text("Bounty")).toBe("Task");
  expect(text("Slice")).toBe("9 files in 3 modules, 900 B, 2 blockers");
  expect(text("External services")).toBe("0");
  expect(text("Tests on the path")).toBe("None in the touched modules");
  expect(text("Analogous pattern")).toBe("None found");
  expect(text("Non-functional")).toBe("migrations in a touched module");
  expect(
    screen.getByText(/Measured for spec revision 1; the spec has changed/),
  ).toBeTruthy();
});

test("a profile in flight says where it stands and is read again until it lands", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = answer(
    { profile: stored({ status: "queued", profile: null }) },
    { profile: stored({ status: "slicing", profile: null }) },
    { profile: stored() },
  );
  render(<Wired />);

  expect(
    await screen.findByText(/Waiting for room in the workspace/),
  ).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(PROFILE_POLL_MS));
  expect(await screen.findByText(/Cutting the slice/)).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(PROFILE_POLL_MS));
  expect(await screen.findByTestId("profile-rows")).toBeTruthy();
  // Ready is final: nothing more is asked for.
  await act(() => vi.advanceTimersByTimeAsync(PROFILE_POLL_MS * 2));
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("a failed profile gives its reason and the run's own code", async () => {
  answer({
    profile: stored({
      status: "failed",
      errorCode: "scope_failed",
      runErrorCode: "agent_unavailable",
      profile: null,
    }),
  });
  render(<Wired />);
  const status = await screen.findByText(/could not choose a slice/);
  expect(status.textContent).toContain("(agent_unavailable)");
});

test("never profiled shows nothing; a read that fails says so", async () => {
  answer({ profile: null });
  const { container, unmount } = render(<Wired />);
  await waitFor(() =>
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1),
  );
  await act(async () => {});
  expect(container.textContent).toBe("");
  unmount();

  answer(new Response("{}", { status: 500 }));
  render(<Wired />);
  expect(
    await screen.findByText("The complexity profile could not be loaded."),
  ).toBeTruthy();
});

test("a proposal without a spec is never asked about", async () => {
  const fetch = answer({ profile: stored() });
  const { container } = render(<Wired drafted={false} />);
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});

test("an answer in a shape the page does not know counts as a failed read", async () => {
  answer({ profile: { status: "measuring" } });
  render(<Wired />);
  expect(
    await screen.findByText("The complexity profile could not be loaded."),
  ).toBeTruthy();
});
