import { cleanup, render, screen, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import {
  DisclosureFindings,
  disclosureAcknowledgedAtOf,
  disclosureFindingsOf,
} from "../src/features/sandbox/DisclosureFindings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stamp = "2026-11-15T00:00:00.000Z";
const findings = [
  {
    kind: "url" as const,
    file: "src/app.ts",
    line: 2,
    value: "https://wiki.halcyon.internal/runbooks/app",
    acknowledged: false,
  },
  {
    kind: "email" as const,
    file: "src/app.ts",
    line: 3,
    value: "jo.doe@halcyon.io",
    acknowledged: false,
  },
  {
    kind: "url" as const,
    file: "src/pay.ts",
    line: 9,
    value: "https://docs.stripe.com/api",
    acknowledged: true,
  },
];

const version = {
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 1,
  title: "Fix the widget",
  specSummary: "Make it work.",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: stamp,
};
const run = {
  id: "arn_build_2",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "sandbox_build",
  toolVersion: "sandbox_build@13",
  params: {
    deadlineMinutes: 60,
    sliceRunId: "arn_slice",
    sandboxVersionId: "sbv_1",
    manifestSha256: "a".repeat(64),
    contractSha256: "b".repeat(64),
    transformConfigSha256: "c".repeat(64),
    approvedTaskSha256: "d".repeat(64),
  },
  status: "queued",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: null,
  createdAt: stamp,
};

function serve() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/build"))
        return Promise.resolve(Response.json({ run }, { status: 202 }));
      return Promise.resolve(Response.json({ version }));
    }),
  );
  return calls;
}

test("an owner marks a finding public and acknowledges it, keeping what a host covers, and the draft is built again", async () => {
  const calls = serve();
  const rebuilt = vi.fn();
  render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={findings}
      acknowledgements={[
        {
          kind: "host",
          value: "stripe.com",
          note: "Public docs.",
          by: "user_1",
          at: stamp,
        },
      ]}
      canAcknowledge
      onSaved={rebuilt}
    />,
  );
  const panel = screen.getByTestId("disclosure-findings");
  expect(within(panel).getByText("jo.doe@halcyon.io")).toBeTruthy();
  expect(within(panel).getByText("src/app.ts:2")).toBeTruthy();
  // Covered by the host entry: shown acknowledged, with nothing to mark.
  expect(within(panel).getByText("Acknowledged")).toBeTruthy();
  expect(within(panel).getByRole("status").textContent).toBe(
    "2 of 3 blocking.",
  );
  const button = within(panel).getByRole("button", {
    name: "Acknowledge and build again",
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(
    within(panel).getByRole("checkbox", {
      name: "Link at src/app.ts:2 may be public",
    }),
  );
  expect(within(panel).getByRole("status").textContent).toBe(
    "1 of 3 blocking.",
  );
  await userEvent.click(button);
  await vi.waitFor(() => expect(rebuilt).toHaveBeenCalled());
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    [
      "PUT",
      "/api/v1/orgs/org_1/sandboxes/versions/sbv_1/disclosure-acknowledgements",
    ],
    ["POST", "/api/v1/orgs/org_1/sandboxes/versions/sbv_1/build"],
  ]);
  expect(calls[0]?.body).toEqual({
    acknowledgements: [
      { kind: "host", value: "stripe.com", note: "Public docs." },
      {
        kind: "url",
        value: "https://wiki.halcyon.internal/runbooks/app",
        note: null,
      },
    ],
  });
});

test("a member, or a frozen version, sees the findings and where they stand, with no control", () => {
  render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={findings}
      acknowledgements={[]}
      canAcknowledge={false}
    />,
  );
  const panel = screen.getByTestId("disclosure-findings");
  expect(within(panel).queryByRole("checkbox")).toBeNull();
  expect(within(panel).queryByRole("button")).toBeNull();
  expect(within(panel).getAllByText("Blocking")).toHaveLength(2);
  expect(within(panel).getByText(/An owner or admin renames it/)).toBeTruthy();
});

test("findings are read from a build summary's disclosure gate, and nothing is shown without them", () => {
  expect(
    disclosureFindingsOf({
      disclosure: {
        findings: [
          findings[0],
          { kind: "name", file: "a", line: 1, value: "x" },
          null,
        ],
      },
    }),
  ).toEqual([findings[0]]);
  expect(disclosureFindingsOf({ disclosure: {} })).toEqual([]);
  expect(disclosureFindingsOf(null)).toEqual([]);
  // Acknowledged where the gate says: a sliced build unless it says not.
  expect(
    disclosureAcknowledgedAtOf({ disclosure: { acknowledgedAt: "publish" } }),
  ).toBe("publish");
  expect(disclosureAcknowledgedAtOf({ disclosure: {} })).toBe("build");
  expect(disclosureAcknowledgedAtOf(null)).toBe("build");
  const { container } = render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={[]}
      acknowledgements={[]}
      canAcknowledge
    />,
  );
  expect(container.textContent).toBe("");
});

test("a refused acknowledgement says why, and builds nothing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: "A frozen version cannot change; create a new version." },
          { status: 409 },
        ),
      ),
    ),
  );
  render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={findings}
      acknowledgements={[]}
      canAcknowledge
    />,
  );
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "Address at src/app.ts:3 may be public",
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Acknowledge and build again" }),
  );
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /frozen version cannot change/,
  );
});

test("acknowledged at publication: the draft's list says what stands, saving builds nothing", async () => {
  const calls = serve();
  const saved = vi.fn();
  const pending = findings.map((item) => ({
    ...item,
    // A build that read no list marks none.
    acknowledged: false,
    term: item.kind === "url" ? new URL(item.value).hostname : "halcyon.io",
  }));
  render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={pending}
      acknowledgements={[
        {
          kind: "host",
          value: "stripe.com",
          note: "Public docs.",
          by: "user_1",
          at: stamp,
        },
      ]}
      acknowledgedAt="publish"
      canAcknowledge
      onSaved={saved}
    />,
  );
  const panel = screen.getByTestId("disclosure-findings");
  // The host entry covers the docs link now, though the build marked none.
  expect(within(panel).getByText("Acknowledged")).toBeTruthy();
  expect(within(panel).getByRole("status").textContent).toBe(
    "2 of 3 to acknowledge before publishing.",
  );
  expect(within(panel).getByText(/with no build again/)).toBeTruthy();
  await userEvent.click(
    within(panel).getByRole("checkbox", {
      name: "Address at src/app.ts:3 may be public",
    }),
  );
  await userEvent.click(
    within(panel).getByRole("button", { name: "Acknowledge" }),
  );
  await vi.waitFor(() => expect(saved).toHaveBeenCalled());
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    [
      "PUT",
      "/api/v1/orgs/org_1/sandboxes/versions/sbv_1/disclosure-acknowledgements",
    ],
  ]);
  expect(calls[0]?.body).toEqual({
    acknowledgements: [
      { kind: "host", value: "stripe.com", note: "Public docs." },
      { kind: "email", value: "jo.doe@halcyon.io", note: null },
    ],
  });
});

test("a member sees what waits for acknowledgement at publication, with no control", () => {
  render(
    <DisclosureFindings
      organizationId="org_1"
      versionId="sbv_1"
      findings={findings.map((item) => ({ ...item, acknowledged: false }))}
      acknowledgements={[]}
      acknowledgedAt="publish"
      canAcknowledge={false}
    />,
  );
  const panel = screen.getByTestId("disclosure-findings");
  expect(within(panel).queryByRole("button")).toBeNull();
  expect(within(panel).getAllByText("Not acknowledged")).toHaveLength(3);
  expect(
    within(panel).getByText(
      /acknowledges it as public before the version is published/,
    ),
  ).toBeTruthy();
});
