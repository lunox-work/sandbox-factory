import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { BoardBounties, RateCardEditor, money } from "../src/Bounties";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("money formatting respects currencies with different minor units", () => {
  expect(money(25000, "USD")).toContain("250.00");
  expect(money(250, "JPY")).toContain("250");
  expect(money(null, null)).toBe("Unpriced");
});

test("an admin edits exact decimal rates and sends minor units", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(
        Response.json({
          rateCard: {
            organizationId: "org_1",
            currency: "USD",
            sMinor: 100,
            mMinor: 200,
            lMinor: 300,
            xlMinor: 400,
            revision: init?.method === "PUT" ? 2 : 1,
            updatedAt: "2026-09-22T00:00:00.000Z",
          },
        }),
      );
    }),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const small = await screen.findByLabelText("S");
  await userEvent.clear(small);
  await userEvent.type(small, "1.25");
  await userEvent.click(screen.getByRole("button", { name: "Save rate card" }));
  await waitFor(() =>
    expect(calls.some(({ method }) => method === "PUT")).toBe(true),
  );
  const put = calls.find(({ method }) => method === "PUT")!;
  expect(JSON.parse(String(put.body)).sMinor).toBe(125);
});

test("members see proposals without review or run controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/runs"))
        return Promise.resolve(
          Response.json({ runs: [], sizingAvailable: true }),
        );
      return Promise.resolve(
        Response.json({
          proposals: [
            {
              id: "bpr_1",
              issueKey: "APP-1",
              liveKey: "APP-1",
              liveTitle: "Ship export",
              modelRationale: "A few files.",
              complexity: "M",
              amountMinor: 200,
              currency: "USD",
              modelComplexity: "M",
              modelConfidence: "high",
              freshness: "current",
              status: "proposed",
              revision: 1,
            },
          ],
        }),
      );
    }),
  );
  render(
    <BoardBounties
      organizationId="org_1"
      boardId="jrb_1"
      role="member"
      writebackEnabled={false}
    />,
  );
  expect(await screen.findByText(/Ship export/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Run sizing" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});

test("proposal filters and detail links survive navigation", async () => {
  const urls: string[] = [];
  const proposal = {
    id: "bpr_1",
    issueKey: "APP-1",
    liveKey: "APP-1",
    liveTitle: "Ship export",
    modelRationale: "A few files.",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    freshness: "current",
    status: "proposed",
    revision: 1,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url);
      if (url.includes("/runs")) {
        return Promise.resolve(
          Response.json({ runs: [], sizingAvailable: true }),
        );
      }
      if (url.includes("/proposals/bpr_1?")) {
        return Promise.resolve(
          Response.json({
            proposal,
            freshness: { freshness: "current", checkedAt: "now" },
            history: [proposal],
            writebackOperations: [],
          }),
        );
      }
      return Promise.resolve(Response.json({ proposals: [proposal] }));
    }),
  );
  render(
    <BoardBounties
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writebackEnabled={false}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /Ship export/ }),
  );
  expect(await screen.findByText("Proposal history")).toBeDefined();
  expect(window.location.search).toContain("proposal=bpr_1");

  await userEvent.click(screen.getByRole("button", { name: "Approved" }));
  await waitFor(() =>
    expect(urls.some((url) => url.includes("status=approved"))).toBe(true),
  );
});
