import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { bountyJson } from "./api-fixtures";
import { act, fireEvent, render, screen, waitFor, within } from "./render";

import {
  ProposalList,
  RateCardEditor,
  modelLabel,
  money,
} from "../src/Proposals";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The open proposal lives in the URL, and jsdom's is real: a test that
  // opens one must not hand the next test an already-open peek.
  window.history.replaceState(null, "", "/");
});

test("money formatting respects currencies with different minor units", () => {
  expect(money(25000, "USD")).toContain("250.00");
  expect(money(250, "JPY")).toContain("250");
  expect(money(null, null)).toBe("Unpriced");
});

test("modelLabel turns a provider id into a readable name", () => {
  expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
  expect(modelLabel("claude-opus-4-6")).toBe("Claude Opus 4.6");
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  expect(modelLabel("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  expect(modelLabel("mistral-large")).toBe("Mistral Large");
  expect(modelLabel(undefined)).toBeNull();
  expect(modelLabel("")).toBeNull();
});

function ratePointerX(
  size: string,
  amount: number,
  width = 300,
  maximum = 400,
  minimum = 100,
) {
  const index = ["XS", "S", "M", "L", "XL"].indexOf(size);
  return (
    width * 0.1 +
    index * 40 +
    ((amount - minimum) / (maximum - minimum)) * (width * 0.8 - 160)
  );
}

function handleX(handle: HTMLElement) {
  return (
    Number(
      handle.parentElement?.style.transform.match(
        /translateX\(([-\d.]+)px\)/,
      )?.[1],
    ) + 16
  );
}

function railGeometry(rail: HTMLElement) {
  return {
    start: Number(rail.style.transform.match(/translateX\(([-\d.]+)px\)/)?.[1]),
    scale: Number(rail.style.transform.match(/scaleX\(([-\d.]+)\)/)?.[1]),
  };
}

function displayedRate(size: string) {
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: `${size} rate`,
  });
  return `${input.parentElement?.textContent}${input.value}`;
}

async function editEndpoint(size: "XS" | "XL", amount: string) {
  const input = await screen.findByRole<HTMLInputElement>("textbox", {
    name: `${size} rate`,
  });
  await userEvent.clear(input);
  await userEvent.paste(amount);
  await userEvent.keyboard("{Enter}");
}

const savedRateCard = {
  organizationId: "org_1",
  currency: "USD",
  xsMinor: 10000,
  sMinor: 10000,
  mMinor: 20000,
  lMinor: 30000,
  xlMinor: 40000,
  revision: 1,
};

test("rate card uses persistent price pins and five draggable handles, with exact minor-unit saves", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  const large = screen.getByRole("slider", { name: "L rate" });
  expect(screen.getAllByRole("textbox")).toHaveLength(5);
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(screen.getAllByRole("slider")).toHaveLength(5);
  expect(medium.getAttribute("aria-valuenow")).toBe("200");
  expect(large.getAttribute("aria-valuenow")).toBe("300");
  await editEndpoint("XL", "700");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(medium.getAttribute("aria-valuenow")).toBe("300");
  expect(large.getAttribute("aria-valuenow")).toBe("500");
  expect(screen.queryByRole("button", { name: "Save rate card" })).toBeNull();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/orgs/org_1/rate-card",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: 1,
          currency: "USD",
          xsMinor: 10000,
          sMinor: 10000,
          mMinor: 30000,
          lMinor: 50000,
          xlMinor: 70000,
        }),
      }),
    ),
  );
});

test("persistent price editors stay separate from circular handles and validate on Enter", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  expect(screen.getAllByRole("textbox")).toHaveLength(5);
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(medium.textContent).toBe("M");
  expect(medium.querySelector("input")).toBeNull();
  await userEvent.click(medium);
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "M rate",
  });
  await userEvent.keyboard("{ArrowLeft}{Home}{End}");
  expect(medium.getAttribute("aria-valuenow")).toBe("200");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.clear(input);
  await userEvent.paste("350");
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("alert").textContent).toContain("between");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.clear(input);
  await userEvent.paste("250");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(medium.getAttribute("aria-valuenow")).toBe("250");
  expect(displayedRate("M")).toBe("USD250");
  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/orgs/org_1/rate-card",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"mMinor":25000'),
      }),
    ),
  );
});

test("interior sliders support keyboard steps and cannot cross each other or endpoints", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(bountyJson({ rateCard: savedRateCard }))),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  const large = screen.getByRole("slider", { name: "L rate" });
  medium.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(medium.getAttribute("aria-valuenow")).toBe("205");
  await userEvent.keyboard("{End}");
  expect(medium.getAttribute("aria-valuenow")).toBe("300");
  expect(large.getAttribute("aria-valuenow")).toBe("300");
  large.focus();
  await userEvent.keyboard("{Home}");
  expect(large.getAttribute("aria-valuenow")).toBe("300");
  await userEvent.keyboard("{End}");
  expect(large.getAttribute("aria-valuenow")).toBe("400");
});

test("dragging M changes only its rate and stops at L", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 44),
  );
  vi.spyOn(Element.prototype, "hasPointerCapture").mockReturnValue(true);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  const large = screen.getByRole("slider", { name: "L rate" });
  const point = medium;
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("M", clientX),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(point, event);
  };
  pointer("pointerdown", 200);
  pointer("pointermove", 250);
  expect(medium.getAttribute("aria-valuenow")).toBe("250");
  expect(displayedRate("M")).toBe("USD250");
  expect(large.getAttribute("aria-valuenow")).toBe("300");
  pointer("pointermove", 400);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pointer("pointerup", 400);
  fireEvent.click(medium);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(medium.getAttribute("aria-valuenow")).toBe("300");
  expect(large.getAttribute("aria-valuenow")).toBe("300");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/v1/orgs/org_1/rate-card",
    expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining('"mMinor":30000'),
    }),
  );
});

test("new cards autofill evenly spaced whole rates and autosave in the selected currency", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? { ...JSON.parse(String(init.body)), revision: 1 }
            : null,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const currency = await screen.findByRole("combobox", { name: "Currency" });
  expect(
    screen
      .getByRole("slider", { name: "M rate" })
      .getAttribute("aria-disabled"),
  ).toBe("false");
  for (const [size, amount] of Object.entries({
    XS: 10,
    S: 58,
    M: 105,
    L: 153,
    XL: 200,
  })) {
    expect(displayedRate(size)).toBe(`USD${amount}`);
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.click(currency);
  expect(screen.getAllByRole("option")).toHaveLength(49);
  expect(
    screen.getByRole("option", { name: "IDR — Indonesian Rupiah" }),
  ).toBeDefined();
  expect(
    screen.getByRole("option", { name: "AED — UAE Dirham" }),
  ).toBeDefined();
  const yen = screen.getByRole("option", { name: "JPY — Japanese Yen" });
  expect(yen.querySelector("img")?.getAttribute("src")).toBe(
    "https://wise.com/public-resources/assets/flags/rectangle/jpy.png",
  );
  await userEvent.click(yen);
  expect(
    screen
      .getByRole("slider", { name: "M rate" })
      .getAttribute("aria-valuetext"),
  ).toBe("JPY 105");
  expect(
    screen
      .getByRole("slider", { name: "L rate" })
      .getAttribute("aria-valuetext"),
  ).toBe("JPY 153");
  expect(screen.queryByRole("button", { name: "Save rate card" })).toBeNull();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/orgs/org_1/rate-card",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: 0,
          currency: "JPY",
          xsMinor: 10,
          sMinor: 58,
          mMinor: 105,
          lMinor: 153,
          xlMinor: 200,
        }),
      }),
    ),
  );
});

test("endpoint editors accept grouped integers and keep invalid or cancelled edits out of the slider", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(bountyJson({ rateCard: savedRateCard }))),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "1,000");
  expect(displayedRate("XL")).toBe("USD1,000");
  await editEndpoint("XS", "10000");
  expect(screen.getByRole("alert").textContent).toBe(
    "XS must be less than or equal to XL.",
  );
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(displayedRate("XS")).toBe("USD100");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "XS rate" }),
  );
});

test.each(["1.25", "1.00", "1,234.5", "0"])(
  "endpoint rate %s is rejected",
  async (amount) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(bountyJson({ rateCard: savedRateCard }))),
    );
    render(<RateCardEditor organizationId="org_1" role="admin" />);
    await editEndpoint("XS", amount);
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "XS rate",
    });
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a positive whole-number USD amount. Decimals are not supported.",
    );
    expect(displayedRate("XS")).toBe(`USD${amount}`);
    expect(screen.getByRole("slider", { name: "XS rate" }).textContent).toBe(
      "XS",
    );
  },
);

test("members cannot edit endpoints or move the interior sliders", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(bountyJson({ rateCard: savedRateCard }))),
  );
  render(<RateCardEditor organizationId="org_1" role="member" />);
  expect(
    (await screen.findByRole("slider", { name: "XS rate" })).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  expect(
    screen.getByRole("slider", { name: "XL rate" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("combobox", { name: "Currency" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("slider", { name: "M rate" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "Save rate card" })).toBeNull();
});

test("equal endpoints keep the sliders disabled and all five whole amounts visible", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        bountyJson({
          rateCard: {
            ...savedRateCard,
            xsMinor: 10000,
            sMinor: 10000,
            mMinor: 10000,
            lMinor: 10000,
            xlMinor: 10000,
          },
        }),
      ),
    ),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  expect(medium.getAttribute("aria-disabled")).toBe("true");
  expect(medium.getAttribute("aria-valuenow")).toBe("100");
  for (const size of ["XS", "S", "M", "L", "XL"])
    expect(displayedRate(size)).toBe("USD100");
});

test("autosave serializes requests and keeps the latest change while a save is pending", async () => {
  const requests: Array<{
    body: typeof savedRateCard & { expectedRevision: number };
    resolve: (response: Response) => void;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT")
        return Promise.resolve(bountyJson({ rateCard: savedRateCard }));
      return new Promise<Response>((resolve) =>
        requests.push({ body: JSON.parse(String(init.body)), resolve }),
      );
    }),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "700");
  expect(
    screen.getByRole("status", { name: "Rate card save status" }).textContent,
  ).toBe("Saving…");
  await editEndpoint("XL", "850");
  await editEndpoint("XL", "1000");
  expect(requests).toHaveLength(1);
  const first = requests[0]!;
  expect(first.body.expectedRevision).toBe(1);
  await act(async () =>
    first.resolve(
      bountyJson({
        rateCard: { ...savedRateCard, ...first.body, revision: 2 },
      }),
    ),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  const second = requests[1]!;
  expect(second.body).toMatchObject({
    expectedRevision: 2,
    xlMinor: 100000,
    mMinor: 40000,
    lMinor: 70000,
  });
  await act(async () =>
    second.resolve(
      bountyJson({
        rateCard: { ...savedRateCard, ...second.body, revision: 3 },
      }),
    ),
  );
  expect(
    screen.getByRole("status", { name: "Rate card save status" }).textContent,
  ).toBe("Saved");
  expect(displayedRate("XL")).toBe("USD1,000");
});

test("changing currency autosaves existing whole amounts with the new minor-unit scale", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Currency" }),
  );
  await userEvent.click(
    screen.getByRole("option", { name: "JPY — Japanese Yen" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Rate card save status" }).textContent,
    ).toBe("Saved"),
  );
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/v1/orgs/org_1/rate-card",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 1,
        currency: "JPY",
        xsMinor: 100,
        sMinor: 100,
        mMinor: 200,
        lMinor: 300,
        xlMinor: 400,
      }),
    }),
  );
});

test("failed autosaves retain the edited rates and can be retried", async () => {
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT")
        return Promise.resolve(bountyJson({ rateCard: savedRateCard }));
      writes++;
      if (writes === 1) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        bountyJson({
          rateCard: {
            ...savedRateCard,
            ...JSON.parse(String(init.body)),
            revision: 2,
          },
        }),
      );
    }),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "700");
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(
    screen.getByRole("status", { name: "Rate card save status" }).textContent,
  ).toBe("Changes not saved.");
  expect(displayedRate("XL")).toBe("USD700");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Rate card save status" }).textContent,
    ).toBe("Saved"),
  );
  expect(writes).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("revision conflicts reload the latest rates and keep an explanation visible", async () => {
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return Promise.resolve(
          bountyJson({ error: "conflict" }, { status: 409 }),
        );
      reads++;
      return Promise.resolve(
        bountyJson({
          rateCard:
            reads === 1
              ? savedRateCard
              : { ...savedRateCard, xlMinor: 80000, revision: 9 },
        }),
      );
    }),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "700");
  expect(
    await screen.findByText(
      "The rate card changed elsewhere. The latest rates have been reloaded.",
    ),
  ).toBeDefined();
  expect(displayedRate("XL")).toBe("USD800");
  expect(reads).toBe(2);
});

test("members see proposals without review or run controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/runs"))
        return Promise.resolve(
          bountyJson({
            runs: [
              {
                id: "brn_1",
                status: "succeeded",
                requestedModel: "claude-sonnet-5",
                outcomes: [
                  {
                    externalIssueId: "1",
                    issueKey: "APP-1",
                    status: "proposed",
                    actualModel: "deepseek-v4-pro",
                  },
                  {
                    externalIssueId: "2",
                    issueKey: "APP-2",
                    status: "proposed",
                    actualModel: "deepseek-v4-pro",
                  },
                ],
              },
            ],
            sizingAvailable: true,
          }),
        );
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
        actualModel: "deepseek-v4-pro",
        freshness: "current",
        status: "proposed",
        revision: 1,
      };
      if (url.includes("/proposals/bpr_1?")) {
        return Promise.resolve(
          bountyJson({
            proposal,
            freshness: { freshness: "current", checkedAt: "now" },
            writebackOperations: [],
          }),
        );
      }
      return Promise.resolve(bountyJson({ proposals: [proposal] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="member"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  expect(await screen.findByText(/Ship export/)).toBeDefined();
  // No run controls and no run summary: the list is the proposals alone.
  expect(screen.queryByText(/Latest run/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Run sizing" })).toBeNull();

  // Opened, the proposal says which model sized it, readable and with the
  // raw id on hover — and a member still has nothing to press.
  await userEvent.click(screen.getByRole("button", { name: /Ship export/ }));
  const panel = await screen.findByTestId("proposal-panel");
  expect(within(panel).getByTitle("deepseek-v4-pro").textContent).toBe(
    "DeepSeek V4 Pro",
  );
  expect(within(panel).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(panel).queryByTestId("proposal-actions")).toBeNull();
});

test("a spec change running on one proposal is not the board's stream", async () => {
  // The peek that asked for it follows it; the board has nothing to size.
  const respec = {
    id: "brn_9",
    kind: "respec",
    status: "running",
    planned: [{ externalIssueId: "1", issueKey: "APP-1", summary: "" }],
    outcomes: [],
  };
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url);
      if (url.includes("/runs"))
        return Promise.resolve(
          bountyJson({ runs: [respec], sizingAvailable: true }),
        );
      return Promise.resolve(
        bountyJson({
          proposals: [
            {
              id: "bpr_1",
              issueKey: "APP-1",
              liveTitle: "Bounty 1",
              complexity: "M",
              amountMinor: 10500,
              currency: "USD",
              status: "proposed",
              revision: 1,
            },
          ],
        }),
      );
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted
      readIssue={() => Promise.resolve(null)}
    />,
  );
  await screen.findByText("Bounty 1");
  expect(screen.queryByTestId("sizing-active")).toBeNull();
  expect(urls.some((url) => url.endsWith("/runs/brn_9"))).toBe(false);
});

test("a board opened mid-run streams the run bounty by bounty", async () => {
  // Connecting a site sizes its boards in the background, so a board is
  // often opened while that is still going.
  const planned = [1, 2, 3, 4, 5].map((n) => ({
    externalIssueId: String(n),
    issueKey: `APP-${n}`,
    summary: `Bounty ${n}`,
  }));
  const running = {
    id: "brn_1",
    status: "running",
    planned,
    outcomes: [
      {
        externalIssueId: "1",
        issueKey: "APP-1",
        status: "proposed",
        proposalId: "bpr_1",
      },
    ],
  };
  const proposal = {
    id: "bpr_1",
    issueKey: "APP-1",
    liveTitle: "Bounty 1",
    complexity: "M",
    amountMinor: 10500,
    currency: "USD",
    status: "proposed",
    revision: 1,
  };
  let finished = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url);
      const run = finished ? { ...running, status: "succeeded" } : running;
      if (url.endsWith("/runs/brn_1"))
        return Promise.resolve(bountyJson({ run }));
      if (url.includes("/runs"))
        return Promise.resolve(
          bountyJson({ runs: [run], sizingAvailable: true }),
        );
      return Promise.resolve(bountyJson({ proposals: [proposal] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted
      readIssue={() => Promise.resolve(null)}
    />,
  );

  const stream = await screen.findByTestId("sizing-active");
  expect(within(stream).getByText(/Sizing 5 bounties/)).toBeDefined();
  expect(within(stream).getByText(/1 done/)).toBeDefined();
  const states = within(stream)
    .getAllByRole("listitem")
    .map((row) => row.getAttribute("data-state"));
  // The executor works three at a time, in plan order.
  expect(states).toEqual(["done", "sizing", "sizing", "sizing", "queued"]);
  // A finished bounty shows its price as soon as it lands.
  expect(within(stream).getByText(/105\.00/)).toBeDefined();

  // Only the run is polled while it runs; the list is re-read when it ends.
  const listReads = urls.filter((url) => url.includes("/proposals?")).length;
  finished = true;
  await waitFor(
    () => expect(screen.queryByTestId("sizing-active")).toBeNull(),
    {
      timeout: 3000,
    },
  );
  expect(urls.some((url) => url.endsWith("/runs/brn_1"))).toBe(true);
  expect(
    urls.filter((url) => url.includes("/proposals?")).length,
  ).toBeGreaterThan(listReads);
});

test("a run that has not picked its bounties yet says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/runs")
          ? bountyJson({
              runs: [
                { id: "brn_1", status: "queued", planned: [], outcomes: [] },
              ],
              sizingAvailable: true,
            })
          : bountyJson({ proposals: [] }),
      ),
    ),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted
      readIssue={() => Promise.resolve(null)}
    />,
  );
  expect(await screen.findByText(/Picking tickets/)).toBeDefined();
  expect(
    screen.getByText("Proposals appear here as bounties are sized."),
  ).toBeDefined();
});

function searchingBoard(options: {
  results: unknown[];
  add?: { status: number; body: unknown };
  runs?: unknown[];
}) {
  const proposal = {
    id: "bpr_7",
    issueKey: "APP-7",
    liveKey: "APP-7",
    liveTitle: "Add login",
    modelRationale: "One form.",
    modelComplexity: "S",
    modelConfidence: "high",
    actualModel: "deepseek-v4-pro",
    freshness: "current",
    complexity: "S",
    amountMinor: 5800,
    currency: "USD",
    status: "proposed",
    revision: 1,
  };
  const runs = [...(options.runs ?? [])];
  const requests: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined });
      if (url.includes("/search?"))
        return Promise.resolve(bountyJson({ issues: options.results }));
      if (url.endsWith("/issues"))
        return Promise.resolve(
          bountyJson(options.add?.body ?? {}, {
            status: options.add?.status ?? 202,
          }),
        );
      if (url.endsWith("/runs/brn_7"))
        return Promise.resolve(
          bountyJson({ run: runs.length > 1 ? runs.shift() : runs[0] }),
        );
      if (url.includes("/runs"))
        return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
      if (url.includes("/proposals/bpr_7?"))
        return Promise.resolve(
          bountyJson({
            proposal,
            freshness: { freshness: "current", checkedAt: "now" },
            writebackOperations: [],
          }),
        );
      return Promise.resolve(bountyJson({ proposals: [proposal] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted
      readIssue={() => Promise.resolve(null)}
    />,
  );
  return requests;
}

const addLogin = {
  id: "10007",
  key: "APP-7",
  summary: "Add login",
  status: "To Do",
  issueType: "Story",
};

test("a bounty found by search is sized, then opened when its proposal lands", async () => {
  const requests = searchingBoard({
    results: [addLogin],
    add: { status: 202, body: { run: { id: "brn_7" } } },
    runs: [
      { id: "brn_7", kind: "issue", status: "running", outcomes: [] },
      {
        id: "brn_7",
        kind: "issue",
        status: "succeeded",
        outcomes: [
          {
            externalIssueId: "10007",
            issueKey: "APP-7",
            status: "proposed",
            proposalId: "bpr_7",
          },
        ],
      },
    ],
  });

  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Find a ticket to size" }),
    "login",
  );
  const results = await screen.findByTestId("issue-results");
  await userEvent.click(
    await within(results).findByRole("button", { name: /APP-7/ }),
  );

  expect(
    requests.find(({ url }) => url.endsWith("/jira/boards/jrb_1/issues"))?.body,
  ).toContain('"issueId":"10007"');
  expect((await screen.findByRole("status")).textContent).toContain(
    "Sizing APP-7",
  );
  // Opened by itself, once the run has the proposal.
  expect(
    await screen.findByTestId("proposal-panel", {}, { timeout: 4000 }),
  ).toBeDefined();
  expect(new URLSearchParams(window.location.search).get("proposal")).toBe(
    "bpr_7",
  );
});

test("a bounty proposed by the board's run meanwhile opens that proposal", async () => {
  // The add lost a race to the backlog run. Search no longer lists the
  // bounty, so its proposal is found in the board's list.
  searchingBoard({
    results: [addLogin],
    add: { status: 202, body: { run: { id: "brn_7" } } },
    runs: [
      {
        id: "brn_7",
        kind: "issue",
        status: "succeeded",
        outcomes: [
          {
            externalIssueId: "10007",
            issueKey: "APP-7",
            status: "skipped",
            code: "live_proposal",
          },
        ],
      },
    ],
  });
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Find a ticket to size" }),
    "login",
  );
  await userEvent.click(
    await within(await screen.findByTestId("issue-results")).findByRole(
      "button",
      { name: /APP-7/ },
    ),
  );
  expect(
    await screen.findByTestId("proposal-panel", {}, { timeout: 4000 }),
  ).toBeDefined();
});

test("a run that could not size the bounty says so", async () => {
  searchingBoard({
    results: [addLogin],
    add: { status: 202, body: { run: { id: "brn_7" } } },
    runs: [
      {
        id: "brn_7",
        kind: "issue",
        status: "failed",
        outcomes: [],
      },
    ],
  });
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Find a ticket to size" }),
    "login",
  );
  await userEvent.click(
    await within(await screen.findByTestId("issue-results")).findByRole(
      "button",
      { name: /APP-7/ },
    ),
  );
  expect(
    (await screen.findByRole("alert", {}, { timeout: 4000 })).textContent,
  ).toBe("Could not size APP-7.");
});

test("a refused add is said, and Enter picks the first result", async () => {
  searchingBoard({
    results: [addLogin],
    add: {
      status: 409,
      body: { error: "This Jira connection needs reconnecting." },
    },
  });
  const box = await screen.findByRole("searchbox", {
    name: "Find a ticket to size",
  });
  await userEvent.type(box, "login");
  await within(await screen.findByTestId("issue-results")).findByRole(
    "button",
    { name: /APP-7/ },
  );
  await userEvent.type(box, "{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This Jira connection needs reconnecting.",
  );
});

test("an issue split into sub-tasks is listed but cannot be added, and Enter passes over it", async () => {
  const requests = searchingBoard({
    results: [
      {
        id: "10006",
        key: "APP-6",
        summary: "Rework login",
        status: "To Do",
        issueType: "Story",
        subtaskCount: 3,
      },
      { ...addLogin, subtaskCount: 0 },
    ],
    add: {
      status: 409,
      body: { error: "This Jira connection needs reconnecting." },
    },
  });
  const box = await screen.findByRole("searchbox", {
    name: "Find a ticket to size",
  });
  await userEvent.type(box, "login");
  const results = await screen.findByTestId("issue-results");
  const parent = await within(results).findByRole("button", { name: /APP-6/ });

  // Said why, in place of the offer to add it.
  expect((parent as HTMLButtonElement).disabled).toBe(true);
  expect(parent.textContent).toContain("3 sub-tasks: size those");
  expect(parent.textContent).not.toContain("Add");
  expect(
    within(results).getByRole("button", { name: /APP-7/ }).textContent,
  ).toContain("Add");

  // Enter takes the first bounty that can be added, not the parent above it.
  await userEvent.type(box, "{Enter}");
  await screen.findByRole("alert");
  const added = requests.filter(({ url }) =>
    url.endsWith("/jira/boards/jrb_1/issues"),
  );
  expect(added).toHaveLength(1);
  expect(added[0]?.body).toContain('"issueId":"10007"');
});

test("members get no bounty search, since adding sizes and spends", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/runs")
          ? bountyJson({ runs: [], sizingAvailable: true })
          : bountyJson({ proposals: [] }),
      ),
    ),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="member"
      writeGranted
      readIssue={() => Promise.resolve(null)}
    />,
  );
  await screen.findByText("No proposals yet.");
  expect(screen.queryByRole("searchbox")).toBeNull();
});

test("proposal detail links survive navigation", async () => {
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
        return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
      }
      if (url.includes("/proposals/bpr_1?")) {
        return Promise.resolve(
          bountyJson({
            proposal,
            freshness: { freshness: "current", checkedAt: "now" },
            writebackOperations: [],
          }),
        );
      }
      return Promise.resolve(bountyJson({ proposals: [proposal] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /Ship export/ }),
  );
  expect(await screen.findByText("Why this size")).toBeDefined();
  expect(window.location.search).toContain("proposal=bpr_1");

  // The list is behind the peek; closing it hands the list back.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });
  expect(window.location.search).not.toContain("proposal=");
  // One list of every status, so nothing asks the server to filter.
  expect(urls.some((url) => url.includes("status="))).toBe(false);
});

test("a shared link to a proposal that is gone says so instead of loading forever", async () => {
  window.history.replaceState(null, "", "/?proposal=bpr_gone");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/runs")) {
        return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
      }
      if (url.includes("/proposals/bpr_gone?")) {
        return Promise.resolve(
          bountyJson({ error: "not_found" }, { status: 404 }),
        );
      }
      return Promise.resolve(bountyJson({ proposals: [] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  const panel = await screen.findByTestId("proposal-panel");
  expect(
    await within(panel).findByText("This proposal is not on this board."),
  ).toBeDefined();
  expect(within(panel).queryByText("Loading the proposal…")).toBeNull();
});

test("a proposal that could not be read offers another try", async () => {
  window.history.replaceState(null, "", "/?proposal=bpr_1");
  let detailCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/runs")) {
        return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
      }
      if (url.includes("/proposals/bpr_1?")) {
        detailCalls += 1;
        return Promise.resolve(
          bountyJson({ error: "internal" }, { status: 500 }),
        );
      }
      return Promise.resolve(bountyJson({ proposals: [] }));
    }),
  );
  render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="owner"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  const panel = await screen.findByTestId("proposal-panel");
  expect(
    await within(panel).findByText("Could not load the proposal."),
  ).toBeDefined();
  const before = detailCalls;
  await userEvent.click(
    within(panel).getByRole("button", { name: "Try again" }),
  );
  await waitFor(() => {
    expect(detailCalls).toBeGreaterThan(before);
  });
});

test("S is draggable between XS and M, and XS edits autosave the five-point range", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const small = await screen.findByRole("slider", { name: "S rate" });
  small.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(small.getAttribute("aria-valuenow")).toBe("105");
  await userEvent.keyboard("{End}");
  expect(small.getAttribute("aria-valuenow")).toBe("200");
  await userEvent.keyboard("{Home}");
  expect(small.getAttribute("aria-valuenow")).toBe("100");
  await editEndpoint("XS", "50");
  expect(displayedRate("XS")).toBe("USD50");
  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/orgs/org_1/rate-card",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"xsMinor":5000'),
      }),
    ),
  );
  expect(screen.getAllByRole("slider")).toHaveLength(5);
});

test("persistent editors save on blur and Escape discards unfinished changes", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const input = await screen.findByRole<HTMLInputElement>("textbox", {
    name: "M rate",
  });
  await userEvent.clear(input);
  await userEvent.paste("275");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.tab();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(displayedRate("M")).toBe("USD275");
  await userEvent.clear(input);
  await userEvent.paste("280");
  await userEvent.keyboard("{Escape}");
  await userEvent.tab();
  expect(displayedRate("M")).toBe("USD275");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("textbox")).toHaveLength(5);
});

test("cancelled drags restore the prior value and a subsequent drag still saves", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const medium = await screen.findByRole("slider", { name: "M rate" });
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("M", clientX),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(medium, event);
  };
  pointer("pointerdown", 200);
  pointer("pointermove", 250);
  expect(displayedRate("M")).toBe("USD250");
  pointer("pointercancel", 150);
  expect(displayedRate("M")).toBe("USD200");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pointer("pointerdown", 200);
  pointer("pointermove", 250);
  pointer("pointerup", 250);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(displayedRate("M")).toBe("USD250");
});

test("Saved only appears after a write and expires after the latest save", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const input = await screen.findByRole<HTMLInputElement>("textbox", {
    name: "M rate",
  });
  const status = screen.getByRole("status", { name: "Rate card save status" });
  const savedVisual = status.parentElement?.querySelector(
    '[data-save-state="saved"]',
  );
  expect(savedVisual?.getAttribute("data-active")).toBe("false");
  expect(status.textContent).toBe("");
  vi.useFakeTimers();
  const change = async (value: string) => {
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    });
  };
  await change("250");
  expect(savedVisual?.getAttribute("data-active")).toBe("true");
  expect(status.textContent).toBe("Saved");
  await act(async () => vi.advanceTimersByTime(2000));
  await change("260");
  expect(status.textContent).toBe("Saved");
  await act(async () => vi.advanceTimersByTime(2000));
  expect(status.textContent).toBe("Saved");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(status.textContent).toBe("");
  // Retain the outgoing visual layer so CSS can fade it out, while the live
  // region immediately stops announcing an expired confirmation.
  expect(savedVisual?.isConnected).toBe(true);
  expect(savedVisual?.getAttribute("data-active")).toBe("false");
  await change("260");
  expect(status.textContent).toBe("");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("XS and XL drag independently, stop at adjacent sizes, and save on release", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xs = await screen.findByRole("slider", { name: "XS rate" });
  const xl = screen.getByRole("slider", { name: "XL rate" });
  const rail = screen
    .getByRole("group", { name: "Bounty rate scale" })
    .querySelector<HTMLElement>("[data-rate-rail]");
  const expectRailAtEndpoints = () => {
    expect(rail).not.toBeNull();
    const { start, scale } = railGeometry(rail!);
    expect(start).toBeCloseTo(handleX(xs));
    expect(scale * 499).toBeCloseTo(handleX(xl) - handleX(xs));
  };
  expectRailAtEndpoints();
  const expectCentered = () => {
    expect(railGeometry(rail!).start).toBeCloseTo(49.9);
    expect(railGeometry(rail!).scale).toBeCloseTo(0.8);
    expect(rail!.parentElement?.getAttribute("data-rate-dragging")).toBe(
      "false",
    );
  };
  expectCentered();
  let frameSmall = 100;
  let frameLarge = 400;
  const pointer = (handle: HTMLElement, type: string, amount: number) => {
    if (type === "pointerdown") {
      frameSmall = Number(xs.getAttribute("aria-valuenow"));
      frameLarge = Number(xl.getAttribute("aria-valuenow"));
    }
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX(
        handle === xs ? "XS" : "XL",
        amount,
        499,
        frameLarge,
        frameSmall,
      ),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(handle, event);
  };
  pointer(xs, "pointerdown", 100);
  pointer(xs, "pointermove", 50);
  expect(displayedRate("XS")).toBe("USD50");
  expectRailAtEndpoints();
  expect(displayedRate("S")).toBe("USD100");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pointer(xs, "pointerup", 50);
  expectCentered();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  pointer(xs, "pointerdown", 50);
  pointer(xs, "pointermove", 200);
  expect(displayedRate("XS")).toBe("USD100");
  pointer(xs, "pointercancel", 200);
  expect(displayedRate("XS")).toBe("USD50");
  expectRailAtEndpoints();
  pointer(xl, "pointerdown", 400);
  pointer(xl, "pointermove", 450);
  expect(displayedRate("XL")).toBe("USD450");
  expectRailAtEndpoints();
  expect(displayedRate("L")).toBe("USD300");
  pointer(xl, "pointermove", 200);
  expect(displayedRate("XL")).toBe("USD300");
  expectRailAtEndpoints();
  pointer(xl, "pointerup", 200);
  expectCentered();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  xs.focus();
  await userEvent.keyboard("{Home}");
  expect(displayedRate("XS")).toBe("USD1");
  xl.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(displayedRate("XL")).toBe("USD305");
});

test("XL keeps its scale stable while dragging and reveals more range after release", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        bountyJson({
          rateCard:
            init?.method === "PUT"
              ? {
                  ...savedRateCard,
                  ...JSON.parse(String(init.body)),
                  revision: 2,
                }
              : savedRateCard,
        }),
      ),
    ),
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xl = await screen.findByRole("slider", { name: "XL rate" });
  const pointer = (type: string, amount: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("XL", amount, 499),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(xl, event);
  };
  pointer("pointerdown", 400);
  pointer("pointermove", 460);
  expect(displayedRate("XL")).toBe("USD460");
  expect(xl.getAttribute("aria-valuemax")).toBe("1000");
  pointer("pointermove", 440);
  expect(displayedRate("XL")).toBe("USD440");
  pointer("pointermove", 460);
  pointer("pointerup", 460);
  await waitFor(() => expect(xl.getAttribute("aria-valuemax")).toBe("1000"));
  xl.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(displayedRate("XL")).toBe("USD465");
});

test.each([300, 499, 900])(
  "handles stay separated on the rail at %ipx without changing equal prices",
  async (width) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(bountyJson({ rateCard: savedRateCard })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, width, 32),
    );
    render(<RateCardEditor organizationId="org_1" role="admin" />);
    await screen.findByRole("slider", { name: "XS rate" });
    const handles = ["XS", "S", "M", "L", "XL"].map((size) =>
      screen.getByRole("slider", { name: `${size} rate` }),
    );
    const checkSpacing = () => {
      let previous = -40;
      for (const handle of handles) {
        const parent = handle.parentElement!;
        const x = handleX(handle);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width);
        expect(x - previous).toBeGreaterThanOrEqual(39.999);
        expect(parent.style.transform).toContain("translateY(-16px)");
        previous = x;
      }
    };
    checkSpacing();
    expect(displayedRate("XS")).toBe("USD100");
    expect(displayedRate("S")).toBe("USD100");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    handles[2]!.focus();
    await userEvent.keyboard("{End}");
    checkSpacing();
    expect(displayedRate("M")).toBe("USD300");
    expect(displayedRate("L")).toBe("USD300");
  },
);

test("XL commits the final release position before expanding its range", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xl = await screen.findByRole("slider", { name: "XL rate" });
  const pointer = (type: string, amount: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("XL", amount, 499),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(xl, event);
  };
  pointer("pointerdown", 400);
  pointer("pointermove", 450);
  pointer("pointerup", 460);
  expect(displayedRate("XL")).toBe("USD460");
  await waitFor(() => expect(xl.getAttribute("aria-valuemax")).toBe("1000"));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/v1/orgs/org_1/rate-card",
    expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining('"xlMinor":46000'),
    }),
  );
});

test("XL can cancel after capture loss and accepts the next drag", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xl = await screen.findByRole("slider", { name: "XL rate" });
  const pointer = (type: string, amount: number, pointerId: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("XL", amount, 499),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    fireEvent(xl, event);
  };
  pointer("pointerdown", 400, 1);
  pointer("pointermove", 450, 1);
  pointer("lostpointercapture", 450, 1);
  expect(displayedRate("XL")).toBe("USD450");
  pointer("pointercancel", 450, 1);
  expect(displayedRate("XL")).toBe("USD400");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pointer("pointerdown", 400, 2);
  pointer("pointermove", 460, 2);
  pointer("pointerup", 460, 2);
  expect(displayedRate("XL")).toBe("USD460");
  await waitFor(() => expect(xl.getAttribute("aria-valuemax")).toBe("1000"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

test("XL can repeatedly extend its range with off-center grabs and quick releases", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xl = await screen.findByRole("slider", { name: "XL rate" });
  let current = 400;
  let writes = 1;
  for (const maximum of [450, 510, 580]) {
    const pointer = (type: string, amount: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: ratePointerX("XL", amount, 499, current) + 12,
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: maximum });
      fireEvent(xl, event);
    };
    pointer("pointerdown", current);
    // A fast drag can deliver its final position only in pointerup.
    pointer("pointerup", maximum);
    pointer("lostpointercapture", maximum);
    expect(displayedRate("XL")).toBe(`USD${maximum}`);
    await waitFor(() => expect(xl.getAttribute("aria-valuemax")).toBe("1000"));
    writes += 1;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(writes));
    current = maximum;
  }
});

test("USD XL rejects typed amounts above 1,000 and stops dragging at the cap", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "1001");
  expect(screen.getByRole("alert").textContent).toBe(
    "XL cannot exceed USD 1,000.",
  );
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
  ).toHaveLength(0);
  await editEndpoint("XL", "1,000");
  const xl = screen.getByRole("slider", { name: "XL rate" });
  expect(xl.getAttribute("aria-valuemax")).toBe("1000");
  const track = xl.parentElement!.parentElement!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 300,
  } as DOMRect);
  for (const [type, clientX] of [
    ["pointerdown", 300],
    ["pointermove", 900],
    ["pointerup", 900],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(xl, event);
  }
  xl.focus();
  await userEvent.keyboard("{End}{ArrowRight}");
  expect(xl.getAttribute("aria-valuenow")).toBe("1000");
  expect(displayedRate("XL")).toBe("USD1,000");
  expect(
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .every(([, init]) => JSON.parse(String(init?.body)).xlMinor === 100000),
  ).toBe(true);
});

test("switching an oversized card to USD requires lowering XL before saving", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      bountyJson({
        rateCard: {
          ...savedRateCard,
          currency: "JPY",
          xsMinor: 10,
          sMinor: 58,
          mMinor: 105,
          lMinor: 153,
          xlMinor: 2000,
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Currency" }),
  );
  await userEvent.click(
    screen.getByRole("option", { name: "USD — US Dollar" }),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "XL cannot exceed USD 1,000.",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("rail returns to the middle 80% after growing and shrinking either endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        bountyJson({
          rateCard:
            init?.method === "PUT"
              ? {
                  ...savedRateCard,
                  ...JSON.parse(String(init.body)),
                  revision: 2,
                }
              : savedRateCard,
        }),
      ),
    ),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await screen.findByRole("slider", { name: "XL rate" });
  const rail = screen
    .getByRole("group", { name: "Bounty rate scale" })
    .querySelector<HTMLElement>("[data-rate-rail]")!;
  const check = () => {
    expect(railGeometry(rail).start).toBeCloseTo(48);
    expect(railGeometry(rail).scale).toBeCloseTo(0.8);
  };
  check();
  for (const [size, amount] of [
    ["XL", "1000"],
    ["XL", "300"],
    ["XS", "150"],
    ["XS", "1"],
  ] as const) {
    await editEndpoint(size, amount);
    check();
  }
});

test("a collapsed whole-number range still has draggable runway", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        bountyJson({
          rateCard:
            init?.method === "PUT"
              ? {
                  ...savedRateCard,
                  ...JSON.parse(String(init.body)),
                  revision: 2,
                }
              : savedRateCard,
        }),
      ),
    ),
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await editEndpoint("XL", "100");
  const xl = screen.getByRole("slider", { name: "XL rate" });
  for (const [type, clientX] of [
    ["pointerdown", 449.1],
    ["pointerup", 499],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(xl, event);
  }
  expect(displayedRate("XL")).toBe("USD105");
  const rail = screen
    .getByRole("group", { name: "Bounty rate scale" })
    .querySelector<HTMLElement>("[data-rate-rail]")!;
  expect(railGeometry(rail).scale).toBeCloseTo(0.8);
});

test.each([
  ["XS", 100, 50],
  ["XL", 400, 450],
] as const)(
  "%s retains its drag through capture loss and release outside the handle",
  async (size, initial, next) => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        bountyJson({
          rateCard:
            init?.method === "PUT"
              ? {
                  ...savedRateCard,
                  ...JSON.parse(String(init.body)),
                  revision: 2,
                }
              : savedRateCard,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 499, 32),
    );
    render(<RateCardEditor organizationId="org_1" role="admin" />);
    const handle = await screen.findByRole("slider", { name: `${size} rate` });
    const pointer = (
      target: HTMLElement | Window,
      type: string,
      amount: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: ratePointerX(size, amount, 499),
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(target, event);
    };
    pointer(handle, "pointerdown", initial);
    pointer(handle, "pointermove", next);
    pointer(handle, "lostpointercapture", next);
    expect(displayedRate(size)).toBe(`USD${next}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pointer(window, "pointerup", next);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(displayedRate(size)).toBe(`USD${next}`);
    // A browser's trailing capture-loss notification must not undo a commit.
    pointer(handle, "lostpointercapture", next);
    expect(displayedRate(size)).toBe(`USD${next}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

test("an earlier save response cannot undo a newer endpoint drag", async () => {
  const requests: Array<{
    body: typeof savedRateCard;
    resolve: (response: Response) => void;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT")
        return Promise.resolve(bountyJson({ rateCard: savedRateCard }));
      return new Promise<Response>((resolve) =>
        requests.push({ body: JSON.parse(String(init.body)), resolve }),
      );
    }),
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  await screen.findByRole("slider", { name: "XL rate" });
  const drag = (size: string, start: number, end: number, maximum: number) => {
    const handle = screen.getByRole("slider", { name: `${size} rate` });
    for (const [type, amount] of [
      ["pointerdown", start],
      ["pointerup", end],
    ] as const) {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: ratePointerX(size, amount, 499, maximum),
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(type === "pointerdown" ? handle : window, event);
    }
  };
  drag("XL", 400, 450, 400);
  drag("XS", 100, 50, 450);
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () =>
    requests[0]!.resolve(
      bountyJson({
        rateCard: { ...savedRateCard, ...requests[0]!.body, revision: 2 },
      }),
    ),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(displayedRate("XS")).toBe("USD50");
  expect(displayedRate("XL")).toBe("USD450");
  expect(requests[1]!.body).toMatchObject({ xsMinor: 5000, xlMinor: 45000 });
  await act(async () =>
    requests[1]!.resolve(
      bountyJson({
        rateCard: { ...savedRateCard, ...requests[1]!.body, revision: 3 },
      }),
    ),
  );
  expect(displayedRate("XS")).toBe("USD50");
  expect(displayedRate("XL")).toBe("USD450");
});

test("leaving the window cancels a drag and removes its release listener", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(bountyJson({ rateCard: savedRateCard })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 499, 32),
  );
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const xl = await screen.findByRole("slider", { name: "XL rate" });
  const pointer = (type: string, amount: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: ratePointerX("XL", amount, 499),
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(xl, event);
  };
  pointer("pointerdown", 400);
  pointer("pointermove", 450);
  expect(displayedRate("XL")).toBe("USD450");
  fireEvent(window, new Event("blur"));
  pointer("pointerup", 450);
  expect(displayedRate("XL")).toBe("USD400");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([
  ["XS", 100, 93, 95],
  ["S", 100, 107, 105],
  ["M", 200, 207, 205],
  ["L", 300, 307, 305],
  ["XL", 400, 407, 405],
] as const)(
  "%s drags in increments of five",
  async (size, initial, pointerAmount, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(bountyJson({ rateCard: savedRateCard }))),
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 499, 32),
    );
    render(<RateCardEditor organizationId="org_1" role="admin" />);
    const handle = await screen.findByRole("slider", { name: `${size} rate` });
    for (const [type, amount] of [
      ["pointerdown", initial],
      ["pointerup", pointerAmount],
    ] as const) {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: ratePointerX(size, amount, 499),
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(handle, event);
    }
    expect(displayedRate(size)).toBe(`USD${expected}`);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Rate card save status" })
          .textContent,
      ).not.toBe("Saving…"),
    );
  },
);

test("manual rates keep arbitrary whole numbers while keyboard adjustments snap to five", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const input = await screen.findByRole("textbox", { name: "M rate" });
  await userEvent.clear(input);
  await userEvent.paste("247");
  await userEvent.keyboard("{Enter}");
  expect(displayedRate("M")).toBe("USD247");
  screen.getByRole("slider", { name: "M rate" }).focus();
  // An off-grid rate snaps onto the multiple-of-five grid before stepping,
  // so 247 moves to 250 and 245, never to 252 and 242.
  await userEvent.keyboard("{ArrowRight}");
  expect(displayedRate("M")).toBe("USD250");
  await userEvent.keyboard("{ArrowRight}");
  expect(displayedRate("M")).toBe("USD255");
  await userEvent.keyboard("{ArrowLeft}");
  expect(displayedRate("M")).toBe("USD250");
  await userEvent.keyboard("{ArrowLeft}");
  expect(displayedRate("M")).toBe("USD245");
  await editEndpoint("XS", "13");
  await editEndpoint("XL", "413");
  expect(displayedRate("XS")).toBe("USD13");
  expect(displayedRate("XL")).toBe("USD413");
});

test("keyboard adjustments land on the grid whichever way an off-grid rate moves", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      bountyJson({
        rateCard:
          init?.method === "PUT"
            ? {
                ...savedRateCard,
                ...JSON.parse(String(init.body)),
                revision: 2,
              }
            : savedRateCard,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RateCardEditor organizationId="org_1" role="admin" />);
  const input = await screen.findByRole("textbox", { name: "M rate" });
  await userEvent.clear(input);
  // M sits between S (100) and L (300), so use an off-grid value in range.
  await userEvent.paste("221");
  await userEvent.keyboard("{Enter}");
  expect(displayedRate("M")).toBe("USD221");
  const slider = screen.getByRole("slider", { name: "M rate" });
  slider.focus();
  // Stepping down from 221 walks 220, 215, 210 rather than 216, 211, 206.
  for (const expected of ["USD220", "USD215", "USD210"]) {
    await userEvent.keyboard("{ArrowLeft}");
    expect(displayedRate("M")).toBe(expected);
  }
  // A page step snaps first too, so it never leaves the grid.
  await userEvent.clear(input);
  await userEvent.paste("221");
  await userEvent.keyboard("{Enter}");
  slider.focus();
  await userEvent.keyboard("{PageUp}");
  expect(displayedRate("M")).toBe("USD270");
});

/*
  A board whose titles stream the test feeds a line at a time, and whose
  open-proposal read waits until the test lets it through. Two stored
  proposals: APP-1 at M, APP-2 at L.
*/
function streamedBoard(storedTitles: Record<number, string> = {}) {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
  let releaseDetail = () => {};
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  const stored = (n: number, overrides: object = {}) => ({
    id: `bpr_${n}`,
    issueKey: `APP-${n}`,
    modelRationale: "A few files.",
    complexity: n === 1 ? "M" : "L",
    amountMinor: n === 1 ? 200 : 300,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    actualModel: "deepseek-v4-pro",
    status: "proposed",
    revision: 1,
    // The bounty's stored title; empty stands for one with nothing stored.
    title: storedTitles[n] ?? "",
    ...overrides,
  });
  const fetchMock = vi.fn((input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/proposal-titles?")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          feed = controller;
        },
      });
      // Only what the page reads of a response: a plain object keeps the
      // test's stream out of the fetch implementation's own checks.
      return Promise.resolve({ ok: true, status: 200, body } as Response);
    }
    if (url.includes("/runs")) {
      return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
    }
    if (url.endsWith("/approve")) {
      return Promise.resolve(
        bountyJson({
          proposal: stored(1, { status: "approved", revision: 2 }),
        }),
      );
    }
    if (url.includes("/proposals/bpr_")) {
      const n = Number(/bpr_(\d+)/.exec(url)?.[1]);
      return detailGate.then(() =>
        bountyJson({
          proposal: stored(n),
          freshness: {
            freshness: "current",
            checkedAt: "now",
            liveKey: `APP-${n}`,
            liveTitle: `Bounty ${n}`,
          },
          writebackOperations: [],
        }),
      );
    }
    return Promise.resolve(bountyJson({ proposals: [stored(1), stored(2)] }));
  });
  const titleReads = () =>
    calls.filter((url) => url.includes("/proposal-titles?")).length;
  return {
    fetchMock,
    calls,
    titleReads,
    releaseDetail: () => releaseDetail(),
    /** Waits for the stream to open, then sends one line down it. */
    line: async (value: object) => {
      await waitFor(() => expect(feed).toBeDefined());
      act(() => {
        feed?.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      });
    },
    end: () => {
      act(() => feed?.close());
    },
  };
}

function renderStreamedBoard() {
  return render(
    <ProposalList
      organizationId="org_1"
      boardId="jrb_1"
      role="admin"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
}

test("rows show what is stored at once and fill in title by title", async () => {
  const server = streamedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  // Size, amount and status are stored: there before Jira has said anything.
  expect(within(list).getByText("M")).toBeDefined();
  expect(within(list).getByText("L")).toBeDefined();
  expect(within(list).getByText(money(300, "USD"))).toBeDefined();
  expect(within(list).getAllByText("Proposed")).toHaveLength(2);
  expect(within(list).getAllByTestId("title-pending")).toHaveLength(2);
  // One stream, asking for both rows.
  await waitFor(() => expect(server.titleReads()).toBe(1));
  expect(
    server.calls.find((url) => url.includes("/proposal-titles?")),
  ).toContain("/jira/boards/jrb_1/proposal-titles?ids=bpr_1,bpr_2");

  // One line fills one row; the other is still waiting.
  await server.line({ id: "bpr_2", key: "APP-2", title: "Second bounty" });
  expect(await within(list).findByText("Second bounty")).toBeDefined();
  expect(within(list).getAllByTestId("title-pending")).toHaveLength(1);

  // A row the stream ended without says what it is, not that it is loading.
  server.end();
  expect(await within(list).findByText("Bounty")).toBeDefined();
  expect(within(list).queryAllByTestId("title-pending")).toHaveLength(0);
});

test("a row is titled at once from its stored bounty, and Jira's answer wins", async () => {
  const server = streamedBoard({ 1: "Add login", 2: "Export to CSV" });
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  // Stored with the run that sized them: no placeholder, nothing to wait for.
  expect(within(list).getByText("Add login")).toBeDefined();
  expect(within(list).getByText("Export to CSV")).toBeDefined();
  expect(within(list).queryAllByTestId("title-pending")).toHaveLength(0);

  // The bounty was renamed since: the live title replaces the stored one.
  await server.line({ id: "bpr_1", key: "APP-1", title: "Add SSO login" });
  expect(await within(list).findByText("Add SSO login")).toBeDefined();
  expect(within(list).queryByText("Add login")).toBeNull();

  // Jira could not say: the row keeps the title it was sized under.
  await server.line({ id: "bpr_2", code: "missing" });
  server.end();
  await waitFor(() => expect(server.titleReads()).toBe(1));
  expect(within(list).getByText("Export to CSV")).toBeDefined();
  expect(within(list).queryByText("Bounty")).toBeNull();
});

test("opening a proposal reads it alone, and approval waits for its check", async () => {
  const server = streamedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await server.line({ id: "bpr_1", key: "APP-1", title: "First bounty" });
  await server.line({ id: "bpr_2", key: "APP-2", title: "Second bounty" });
  server.end();
  await within(list).findByText("First bounty");
  const before = server.calls.length;

  await userEvent.click(
    within(list).getByRole("button", { name: /First bounty/ }),
  );
  const panel = await screen.findByTestId("proposal-panel");
  // The row is there at once; whether the bounty changed is not claimed
  // until the proposal's own read says so, and approval waits for it.
  expect(within(panel).getByText("Checking the bounty…")).toBeDefined();
  const approve = within(panel).getByRole("button", {
    name: "Approve",
  }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);

  server.releaseDetail();
  expect(
    await within(panel).findByText("Unchanged since sizing"),
  ).toBeDefined();
  await waitFor(() => expect(approve.disabled).toBe(false));
  // One read: the proposal. Neither the list nor the titles again.
  expect(server.calls.slice(before)).toEqual([
    "/api/v1/orgs/org_1/proposals/bpr_1?boardId=jrb_1",
  ]);
});

test("a refresh after a decision asks Jira for no title it already has", async () => {
  const server = streamedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  server.releaseDetail();
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await server.line({ id: "bpr_1", key: "APP-1", title: "First bounty" });
  await server.line({ id: "bpr_2", key: "APP-2", title: "Second bounty" });
  server.end();
  await userEvent.click(
    await within(list).findByRole("button", { name: /First bounty/ }),
  );
  const panel = await screen.findByTestId("proposal-panel");
  const approve = await within(panel).findByRole("button", {
    name: "Approve",
  });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  const before = server.calls.length;

  await userEvent.click(approve);
  // The decision re-reads the list and the open proposal...
  await waitFor(() => {
    const after = server.calls.slice(before);
    expect(after.some((url) => url.includes("/proposals?boardId"))).toBe(true);
    expect(after.some((url) => url.includes("/proposals/bpr_1?"))).toBe(true);
  });
  // ...and the titles it already has stay where they are.
  expect(server.titleReads()).toBe(1);
  expect(within(list).getByText("Second bounty")).toBeDefined();
});

/* Why a bounty was picked, and lists longer than one page. */

/**
 * A board with `count` stored proposals, served a page at a time as the API
 * does: newest first, with a cursor while more remain. Titles are answered
 * at once, and every request is recorded.
 */
const SIX_CATEGORIES = [
  ["left-behind", "Left behind", "The team won't reach this."],
  ["always-next-sprint", "Always next sprint", "Only capacity is missing."],
  ["quietly-wanted", "Quietly wanted", "Demand the priority hides."],
  ["holding-others-up", "Holding others up", "One bounty unblocks several."],
  ["paper-cuts", "Paper cuts", "Small bugs agents fix reliably."],
  ["deadline-exposed", "Deadline exposed", "The deadline justifies paying."],
] as const;

function pagedBoard(
  count: number,
  categoriesFor: (n: number) => { id: string }[] = () => [],
  options: { categoriesFail?: boolean } = {},
) {
  const calls: string[] = [];
  const approved = new Set<number>();
  const row = (n: number) => ({
    id: `bpr_${n}`,
    issueKey: `APP-${n}`,
    modelRationale: "A few files.",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    actualModel: "deepseek-v4-pro",
    status: approved.has(n) ? "approved" : "proposed",
    revision: approved.has(n) ? 2 : 1,
    title: `Bounty ${n}`,
    categories: categoriesFor(n),
  });
  const fetchMock = vi.fn((input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/proposal-titles?")) {
      return Promise.resolve(new Response(""));
    }
    if (url.includes("/runs")) {
      return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
    }
    if (url.endsWith("/approve")) {
      const n = Number(/bpr_(\d+)/.exec(url)?.[1]);
      approved.add(n);
      return Promise.resolve(bountyJson({ proposal: row(n) }));
    }
    if (url.includes("/proposals/bpr_")) {
      const n = Number(/bpr_(\d+)/.exec(url)?.[1]);
      return Promise.resolve(
        bountyJson({
          // As the detail route answers: the stored proposal, which does
          // not carry the list's `categories`.
          proposal: { ...row(n), categories: undefined },
          freshness: { freshness: "current", checkedAt: "now" },
          writebackOperations: [],
        }),
      );
    }
    const everything = Array.from({ length: count }, (_, index) => index + 1);
    if (url.includes("/proposal-categories")) {
      if (options.categoriesFail === true) {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      return Promise.resolve(
        bountyJson({
          total: count,
          uncategorized: everything.filter((n) => categoriesFor(n).length === 0)
            .length,
          categories: SIX_CATEGORIES.map(([id, label, why]) => ({
            id,
            label,
            why,
            count: everything.filter((n) =>
              categoriesFor(n).some((category) => category.id === id),
            ).length,
          })),
        }),
      );
    }
    const query = new URL(url, "http://localhost").searchParams;
    const limit = Number(query.get("limit") ?? 25);
    const after = Number(/bpr_(\d+)$/.exec(query.get("cursor") ?? "")?.[1]);
    const wanted = query.get("category");
    const all = everything.filter((n) =>
      wanted === null
        ? true
        : wanted === "uncategorized"
          ? categoriesFor(n).length === 0
          : categoriesFor(n).some((category) => category.id === wanted),
    );
    const from = Number.isNaN(after) ? 0 : all.indexOf(after) + 1;
    const page = all.slice(from, from + limit);
    const last = page.at(-1);
    return Promise.resolve(
      bountyJson({
        proposals: page.map(row),
        nextCursor:
          page.length === limit && last !== undefined
            ? `2026-09-30T00:00:00.000Z|bpr_${last}`
            : null,
      }),
    );
  });
  return {
    fetchMock,
    calls,
    listReads: () => calls.filter((url) => url.includes("/proposals?")),
    titleReads: () => calls.filter((url) => url.includes("/proposal-titles?")),
  };
}

const leftBehindMatch = {
  id: "left-behind",
  label: "Left behind",
  reason: "Open 412 days, never in a sprint, unassigned",
};
const paperCutMatch = {
  id: "paper-cuts",
  label: "Paper cuts",
  reason: "Low-priority bug, open 412 days",
};

/** The categories whose icons are drawn inside an element, in order. */
function iconsIn(element: Element) {
  return [...element.querySelectorAll("svg[data-category-icon]")].map((svg) =>
    svg.getAttribute("data-category-icon"),
  );
}

test("a row says why its bounty was picked, and the peek lists every reason", async () => {
  const server = pagedBoard(3, (n) =>
    n === 1 ? [leftBehindMatch, paperCutMatch] : n === 2 ? [paperCutMatch] : [],
  );
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  const rows = within(list).getAllByRole("listitem");

  // The first category and its reason, and that there is another.
  expect(within(rows[0]!).getByTestId("category-line").textContent).toBe(
    "Left behind · Open 412 days, never in a sprint, unassigned · +1 more",
  );
  expect(within(rows[1]!).getByTestId("category-line").textContent).toBe(
    "Paper cuts · Low-priority bug, open 412 days",
  );
  // A bounty someone added by hand has no reason to give, and says nothing.
  expect(within(rows[2]!).queryByTestId("category-line")).toBeNull();

  await userEvent.click(within(rows[0]!).getByRole("button"));
  const panel = await screen.findByTestId("proposal-panel");
  const why = await within(panel).findByTestId("proposal-categories");
  expect(within(why).getByText("Why this bounty")).toBeDefined();
  expect(
    within(why)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Left behindOpen 412 days, never in a sprint, unassigned",
    "Paper cutsLow-priority bug, open 412 days",
  ]);
  // Each reason under its category's icon, on the row and in the peek.
  expect(iconsIn(within(rows[0]!).getByTestId("category-line"))).toEqual([
    "left-behind",
  ]);
  expect(iconsIn(within(rows[1]!).getByTestId("category-line"))).toEqual([
    "paper-cuts",
  ]);
  expect(iconsIn(why)).toEqual(["left-behind", "paper-cuts"]);
  // Still there once the proposal's own read has landed over the row.
  expect(
    await within(panel).findByText("Unchanged since sizing"),
  ).toBeDefined();
  expect(within(panel).getByTestId("proposal-categories")).toBeDefined();
});

/** A board of two proposals: one with a drafted spec, one from before specs. */
function specBoard() {
  const calls: string[] = [];
  const row = (n: number) => ({
    id: `bpr_${n}`,
    issueKey: `APP-${n}`,
    modelRationale: "A few files.",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
    modelComplexity: "M",
    modelConfidence: "high",
    actualModel: "deepseek-v4-pro",
    status: "proposed",
    revision: 1,
    specRevision: n === 1 ? 3 : null,
    title: `Bounty ${n}`,
    categories: [],
  });
  const fetchMock = vi.fn((input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/proposal-titles?")) {
      return Promise.resolve(new Response(""));
    }
    if (url.includes("/runs")) {
      return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
    }
    if (/\/proposals\/bpr_\d+\/spec$/.test(url)) {
      return Promise.resolve(
        bountyJson({
          spec: {
            id: "bsp_1",
            proposalId: "bpr_1",
            revision: 3,
            draft: {
              feature: "CSV export of a filtered table",
              background: [],
              scenarios: [
                {
                  id: "s1",
                  kind: "happy",
                  title: "The filtered rows are exported",
                  steps: [{ keyword: "Then", text: "a CSV is downloaded" }],
                  origin: "draft",
                },
                {
                  id: "s2",
                  kind: "boundary",
                  title: "An empty table exports its header",
                  steps: [{ keyword: "Then", text: "the file has one line" }],
                  origin: "draft",
                },
              ],
              openQuestions: [],
              assumptions: [],
            },
          },
        }),
      );
    }
    if (url.includes("/proposals/bpr_")) {
      const n = Number(/bpr_(\d+)/.exec(url)?.[1]);
      return Promise.resolve(
        bountyJson({
          proposal: row(n),
          freshness: { freshness: "current", checkedAt: "now" },
          writebackOperations: [],
        }),
      );
    }
    if (url.includes("/proposal-categories")) {
      return Promise.resolve(new Response("", { status: 500 }));
    }
    return Promise.resolve(
      bountyJson({ proposals: [row(1), row(2)], nextCursor: null }),
    );
  });
  return {
    fetchMock,
    specReads: () => calls.filter((url) => url.endsWith("/spec")),
  };
}

test("the scenarios have a tab of their own, read when the peek opens", async () => {
  const server = specBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  // The list reads no spec: it is the open proposal's.
  expect(server.specReads()).toEqual([]);

  await userEvent.click(within(list).getByRole("button", { name: /Bounty 1/ }));
  const panel = await screen.findByTestId("proposal-panel");
  // Between the decision and the bounty, and counted once the spec is in:
  // read with the peek, not when the tab is pressed, so it opens on it.
  expect(
    within(panel)
      .getAllByRole("tab")
      .map((tab) => tab.textContent?.replace(/\d+$/, "")),
  ).toEqual(["Price", "Scenarios", "Spec"]);
  await waitFor(() =>
    expect(
      within(panel).getByRole("tab", { name: /^Scenarios/ }).textContent,
    ).toBe("Scenarios2"),
  );
  expect(server.specReads()).toEqual([
    "/api/v1/orgs/org_1/proposals/bpr_1/spec",
  ]);
  // Not on the Price tab any more, which keeps to the decision.
  expect(within(panel).queryByTestId("proposal-spec")).toBeNull();

  await userEvent.click(within(panel).getByRole("tab", { name: /^Scenarios/ }));
  const spec = within(panel).getByTestId("proposal-spec");
  expect(
    within(spec).getByText("CSV export of a filtered table"),
  ).toBeDefined();
  expect(within(spec).getByText("2 scenarios · revision 3")).toBeDefined();
  expect(
    within(spec).getByRole("region", { name: "Happy path" }),
  ).toBeDefined();
  expect(within(spec).getByRole("region", { name: "Boundary" })).toBeDefined();
  // Opening the tab asked for nothing more.
  expect(server.specReads()).toHaveLength(1);
  // The Spec tab is still the Jira issue, and is a different thing.
  expect(within(panel).getByRole("tab", { name: "Spec" })).toBeDefined();
});

test("a proposal sized before specs has an uncounted tab saying so, without asking", async () => {
  const server = specBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  await userEvent.click(within(list).getByRole("button", { name: /Bounty 2/ }));
  const panel = await screen.findByTestId("proposal-panel");
  // The stored reasoning is still what explains the size.
  expect(within(panel).getByText("A few files.")).toBeDefined();
  expect(
    await within(panel).findByText("Unchanged since sizing"),
  ).toBeDefined();
  const tab = within(panel).getByRole("tab", { name: /^Scenarios/ });
  expect(tab.textContent).toBe("Scenarios");

  await userEvent.click(tab);
  expect(within(panel).getByTestId("spec-empty").textContent).toBe(
    "No scenarios were drafted for this proposal. Re-analyze, on the Price tab, drafts them from the bounty as it is now.",
  );
  expect(server.specReads()).toEqual([]);
});

/** A step of S → S+: a heavy and a light scenario added since sizing. */
const step = {
  base: "S",
  complexity: "S+",
  steps: 1,
  addedPoints: 5,
  added: [
    {
      id: "s3",
      kind: "recovery",
      title: "A failed export is retried",
      weight: "heavy",
    },
    { id: "s4", kind: "boundary", title: "An empty table", weight: "light" },
  ],
  nextStepIn: 3,
  settings: {
    pointsPerStep: 4,
    weightPoints: { light: 1, moderate: 2, heavy: 4 },
  },
  stepVersion: "step-v1",
};

/**
 * A board of two proposals: one whose spec grew a step since it was sized,
 * one sized before scenarios were weighed. Answers a resize as the server
 * would, the step rebased on the reviewer's size.
 */
function steppedBoard() {
  const posts: { url: string; body: unknown }[] = [];
  const rows: Record<string, Record<string, unknown>> = {
    bpr_1: {
      id: "bpr_1",
      issueKey: "APP-1",
      modelRationale: "One form and its validation.",
      complexity: "S+",
      amountMinor: 8150,
      currency: "USD",
      modelComplexity: "S",
      modelConfidence: "high",
      actualModel: "claude-sonnet-5",
      status: "proposed",
      sizedBy: "model",
      revision: 1,
      specRevision: 2,
      step,
      title: "Bounty 1",
      categories: [],
    },
    bpr_2: {
      id: "bpr_2",
      issueKey: "APP-2",
      modelRationale: "A few files.",
      complexity: "M",
      amountMinor: 10500,
      currency: "USD",
      modelComplexity: "M",
      modelConfidence: "high",
      actualModel: "claude-sonnet-5",
      status: "proposed",
      sizedBy: "model",
      revision: 1,
      specRevision: null,
      step: null,
      title: "Bounty 2",
      categories: [],
    },
  };
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { complexity: string };
      posts.push({ url, body });
      const resized = {
        ...rows["bpr_1"],
        complexity: "M+",
        amountMinor: 12900,
        sizedBy: "reviewer",
        revision: 2,
        step: { ...step, base: body.complexity, complexity: "M+" },
      };
      rows["bpr_1"] = resized;
      return Promise.resolve(bountyJson({ proposal: resized }));
    }
    if (url.includes("/proposal-titles?")) {
      return Promise.resolve(new Response(""));
    }
    if (url.includes("/runs")) {
      return Promise.resolve(bountyJson({ runs: [], sizingAvailable: true }));
    }
    if (/\/spec$/.test(url)) {
      return Promise.resolve(bountyJson({ spec: null }));
    }
    const id = /proposals\/(bpr_\d+)/.exec(url)?.[1];
    if (id !== undefined) {
      return Promise.resolve(
        bountyJson({
          proposal: rows[id],
          freshness: { freshness: "current", checkedAt: "now" },
          writebackOperations: [],
        }),
      );
    }
    if (url.includes("/proposal-categories")) {
      return Promise.resolve(new Response("", { status: 500 }));
    }
    return Promise.resolve(
      bountyJson({
        proposals: [rows["bpr_1"], rows["bpr_2"]],
        nextCursor: null,
      }),
    );
  });
  return { fetchMock, posts };
}

test("a half size shows on its whole size's card, and the row stays at five", async () => {
  const server = steppedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(within(list).getByRole("button", { name: /Bounty 1/ }));
  const panel = await screen.findByTestId("proposal-panel");
  const resize = await within(panel).findByRole("group", { name: "Resize" });

  // S+ is the S card, reading "S+": no card of its own, no "+" elsewhere.
  expect(
    within(resize)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["XS", "S+", "M", "L", "XL"]);
  // It is the size in force, and the whole size the step stands on.
  const base = within(resize).getByRole("button", { name: "S+" });
  expect(base.getAttribute("aria-pressed")).toBe("true");
  expect((base as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel).getByText(money(8150, "USD"))).toBeDefined();
});

test("the step says how the added weight moved the size, and what the next step needs", async () => {
  const server = steppedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(within(list).getByRole("button", { name: /Bounty 1/ }));
  const panel = await screen.findByTestId("proposal-panel");

  const block = await within(panel).findByTestId("proposal-step");
  expect(block.querySelector("p + p")?.textContent).toBe(
    "S → S+: 5 points added since it was sized (1 heavy, 1 light). M needs 3 more.",
  );
  expect(
    within(block)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "A failed export is retriedHeavy· 4 pts",
    "An empty tableLight· 1 pt",
  ]);
  // A weighed size needs no nudge.
  expect(within(panel).queryByTestId("proposal-unweighed")).toBeNull();
  // The model's own reasoning still comes first.
  expect(within(panel).getByText("One form and its validation.")).toBeDefined();

  // And it heads the Scenarios tab, with the size the model gave.
  await userEvent.click(within(panel).getByRole("tab", { name: /^Scenarios/ }));
  const reason = within(panel).getByRole("region", { name: "Why this size" });
  expect(reason.querySelector("p")?.textContent).toBe("Sized S by the model");
});

test("a resize sets the base, and the step stays on top", async () => {
  const server = steppedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(within(list).getByRole("button", { name: /Bounty 1/ }));
  const panel = await screen.findByTestId("proposal-panel");
  const resize = await within(panel).findByRole("group", { name: "Resize" });

  await userEvent.click(within(resize).getByRole("button", { name: "M" }));
  expect(server.posts).toEqual([
    {
      url: "/api/v1/orgs/org_1/proposals/bpr_1/resize",
      body: { expectedRevision: 1, complexity: "M" },
    },
  ]);
  // M, then the heavy and the light on top of it: the M card reads M+,
  // and S is back to a plain S.
  await waitFor(() =>
    expect(
      within(resize)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["XS", "S", "M+", "L", "XL"]),
  );
  expect(
    within(resize)
      .getByRole("button", { name: "M+" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(within(panel).getByText("the model said S")).toBeDefined();
  expect(within(panel).getByText("M set by a reviewer")).toBeDefined();
  expect(within(panel).getByTestId("proposal-step").textContent).toMatch(
    /^Added to the specM → M\+: /,
  );

  // The Scenarios tab leads with the override, and keeps what the model
  // said and why.
  await userEvent.click(within(panel).getByRole("tab", { name: /^Scenarios/ }));
  const reason = within(panel).getByRole("region", { name: "Why this size" });
  expect(
    [...reason.querySelectorAll("p")].map((line) => line.textContent),
  ).toEqual([
    "Overridden to M by a reviewer",
    "The model sized it S:",
    "One form and its validation.",
  ]);
});

test("a size with no weighed scenarios is marked on its row and explained in the peek", async () => {
  const server = steppedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  const rows = within(list).getAllByRole("button");
  const marked = rows.map(
    (row) => row.querySelector("[data-unweighed]")?.textContent ?? null,
  );
  expect(marked).toEqual([null, "M"]);

  await userEvent.click(within(list).getByRole("button", { name: /Bounty 2/ }));
  const panel = await screen.findByTestId("proposal-panel");
  expect(
    (await within(panel).findByTestId("proposal-unweighed")).textContent,
  ).toBe(
    "This size has no weighed scenarios, so a scenario added later cannot move it. Re-analyze drafts and weighs them.",
  );
  expect(within(panel).queryByTestId("proposal-step")).toBeNull();
});

test("a proposal for a hand-picked bounty shows no reason in the peek", async () => {
  const server = pagedBoard(1);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  await userEvent.click(within(list).getByRole("button"));
  const panel = await screen.findByTestId("proposal-panel");
  expect(
    await within(panel).findByText("Unchanged since sizing"),
  ).toBeDefined();
  expect(within(panel).queryByTestId("proposal-categories")).toBeNull();
});

test("a board with more proposals than a page offers the rest", async () => {
  // A run sizes every bounty that fits, so a board can hold hundreds.
  const server = pagedBoard(120);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  expect(within(list).getAllByRole("listitem")).toHaveLength(50);
  expect(server.listReads()).toEqual([
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50",
  ]);

  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(100),
  );
  // The second page continues from the first page's cursor.
  expect(server.listReads().at(-1)).toBe(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50&cursor=2026-09-30T00%3A00%3A00.000Z%7Cbpr_50",
  );
  expect(within(list).getByText("Bounty 100")).toBeDefined();

  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(120),
  );
  // The board has no more: the offer goes away.
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a board that fits in one page offers nothing more", async () => {
  const server = pagedBoard(50);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");

  // Exactly a page: the API hands back a cursor, and the next read is empty.
  expect(within(list).getAllByRole("listitem")).toHaveLength(50);
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull(),
  );
  expect(within(list).getAllByRole("listitem")).toHaveLength(50);
});

test("a refresh keeps every page that was open", async () => {
  const server = pagedBoard(120);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(100),
  );

  // Approving re-reads the list. It must not fold back to the first page
  // and take the row being decided out from under the peek.
  await userEvent.click(
    within(list).getByRole("button", { name: /Bounty 80/ }),
  );
  const panel = await screen.findByTestId("proposal-panel");
  const approve = await within(panel).findByRole("button", {
    name: "Approve",
  });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  const before = server.listReads().length;
  await userEvent.click(approve);

  // Two reads, because two pages were open. `hidden`, because the open
  // peek is modal and hides the list behind it from the accessibility tree.
  await waitFor(() =>
    expect(server.listReads().length).toBeGreaterThanOrEqual(before + 2),
  );
  await waitFor(() =>
    expect(within(panel).getByText("Approved")).toBeDefined(),
  );
  expect(within(list).getAllByRole("listitem", { hidden: true })).toHaveLength(
    100,
  );
  expect(within(list).getByText("Bounty 80")).toBeDefined();
});

test("titles are asked for in batches the route accepts", async () => {
  // The titles route takes at most fifty ids. A list holding more untitled
  // rows than that must not send them all in one refused request.
  const server = pagedBoard(120);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const list = await screen.findByTestId("proposal-list");
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(100),
  );

  await waitFor(() =>
    expect(server.titleReads().length).toBeGreaterThanOrEqual(2),
  );
  for (const url of server.titleReads()) {
    const ids = new URL(url, "http://localhost").searchParams.get("ids") ?? "";
    expect(ids.split(",").length).toBeLessThanOrEqual(50);
  }
});

test("a run in progress says why each bounty is in its plan", async () => {
  const planned = [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      summary: "Bounty 1",
      categories: [
        {
          id: "holding-others-up",
          label: "Holding others up",
          reason: "Blocks 3 open tickets, unassigned",
        },
      ],
    },
    // A plan recorded before categories existed has none, and still lists.
    { externalIssueId: "2", issueKey: "APP-2", summary: "Bounty 2" },
  ];
  const running = { id: "brn_1", status: "running", planned, outcomes: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/runs/brn_1"))
        return Promise.resolve(bountyJson({ run: running }));
      if (url.includes("/runs"))
        return Promise.resolve(
          bountyJson({ runs: [running], sizingAvailable: true }),
        );
      return Promise.resolve(bountyJson({ proposals: [] }));
    }),
  );
  renderStreamedBoard();

  const stream = await screen.findByTestId("sizing-active");
  const rows = within(stream).getAllByRole("listitem");
  expect(within(rows[0]!).getByTestId("category-line").textContent).toBe(
    "Holding others up · Blocks 3 open tickets, unassigned",
  );
  expect(within(rows[1]!).queryByTestId("category-line")).toBeNull();
  expect(within(rows[1]!).getByText("Bounty 2")).toBeDefined();
});

/* The category view above the table. */

/** Odd bounties are left behind, every third is a paper cut, n=7 is neither. */
function categorisedBoard(count = 12, options = {}) {
  return pagedBoard(
    count,
    (n) => [
      ...(n % 2 === 1 && n !== 7 ? [leftBehindMatch] : []),
      ...(n % 3 === 0 ? [paperCutMatch] : []),
    ],
    options,
  );
}

function tile(name: RegExp) {
  return within(screen.getByTestId("category-nav")).getByRole("button", {
    name,
  }) as HTMLButtonElement;
}

function rowKeys(list: HTMLElement) {
  return within(list)
    .getAllByRole("listitem")
    .map((row) => /APP-\d+/.exec(row.textContent ?? "")?.[0]);
}

test("the categories sit above the table with how many proposals each has", async () => {
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const nav = await screen.findByTestId("category-nav");

  // All, then the six in the order the API gives them, then the rest.
  expect(
    within(nav)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "All, 12 proposals",
    "Left behind, 5 proposals",
    "Always next sprint, 0 proposals",
    "Quietly wanted, 0 proposals",
    "Holding others up, 0 proposals",
    "Paper cuts, 4 proposals",
    "Deadline exposed, 0 proposals",
    "Uncategorized, 5 proposals",
  ]);
  // Nothing is narrowed yet: All is the pressed one, and no why-text shows.
  expect(tile(/^All/).getAttribute("aria-pressed")).toBe("true");
  expect(tile(/^Left behind/).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByTestId("category-why")).toBeNull();
  // A category with nothing in it is shown, and is nowhere to go.
  expect(tile(/^Quietly wanted/).disabled).toBe(true);
  expect(tile(/^Paper cuts/).disabled).toBe(false);
  // The strip comes before the table it narrows.
  const list = screen.getByTestId("proposal-list");
  expect(
    nav.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(rowKeys(list)).toHaveLength(12);
});

test("each tile carries its own category's icon", async () => {
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  const nav = await screen.findByTestId("category-nav");

  // One per category, each its own, in the order of the tiles. The names
  // asserted above are untouched: the icons are not read aloud.
  expect(
    within(nav)
      .getAllByRole("button")
      .slice(1, -1)
      .map((button) => iconsIn(button)),
  ).toEqual(SIX_CATEGORIES.map(([id]) => [id]));
  // "All" and "Uncategorized" are not categories, and still have an icon
  // each so the row keeps its shape.
  for (const name of [/^All/, /^Uncategorized/]) {
    expect(tile(name).querySelector("svg")).not.toBeNull();
    expect(iconsIn(tile(name))).toEqual([]);
  }
});

test("pressing a category shows its bounties, says why, and can be undone", async () => {
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");

  await userEvent.click(tile(/^Paper cuts/));
  // The list is read again for that category, from the first page.
  await waitFor(() =>
    expect(server.listReads().at(-1)).toBe(
      "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50&category=paper-cuts",
    ),
  );
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toEqual([
      "APP-3",
      "APP-6",
      "APP-9",
      "APP-12",
    ]),
  );
  expect(tile(/^Paper cuts/).getAttribute("aria-pressed")).toBe("true");
  expect(tile(/^All/).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByTestId("category-why").textContent).toBe(
    "Paper cuts. Small bugs agents fix reliably.",
  );
  // The view is in the URL, so it can be linked.
  expect(window.location.search).toBe("?category=paper-cuts");

  // Straight to another category.
  await userEvent.click(tile(/^Left behind/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toEqual([
      "APP-1",
      "APP-3",
      "APP-5",
      "APP-9",
      "APP-11",
    ]),
  );
  expect(window.location.search).toBe("?category=left-behind");

  // Pressing the category that is showing lets go of it...
  await userEvent.click(tile(/^Left behind/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(12),
  );
  expect(window.location.search).toBe("");
  expect(screen.queryByTestId("category-why")).toBeNull();

  // ...and so does All.
  await userEvent.click(tile(/^Paper cuts/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(4),
  );
  await userEvent.click(tile(/^All/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(12),
  );
  // Returning to a fresh view shares its cached page.
  expect(server.listReads()).toContain(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50",
  );
});

test("the bounties in no category have a tile of their own, after the six", async () => {
  // Even bounties that are not a multiple of three, and APP-7: picked by
  // hand, or sized before there were categories.
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");

  await userEvent.click(tile(/^Uncategorized/));
  await waitFor(() =>
    expect(server.listReads().at(-1)).toBe(
      "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50&category=uncategorized",
    ),
  );
  const list = screen.getByTestId("proposal-list");
  await waitFor(() =>
    expect(rowKeys(list)).toEqual([
      "APP-2",
      "APP-4",
      "APP-7",
      "APP-8",
      "APP-10",
    ]),
  );
  expect(tile(/^Uncategorized/).getAttribute("aria-pressed")).toBe("true");
  expect(window.location.search).toBe("?category=uncategorized");
  // It is not in the registry, so what it means is the page's to say.
  expect(screen.getByTestId("category-why").textContent).toBe(
    "Uncategorized. Picked by hand, or sized before there were categories.",
  );
  // None of these rows has a reason to give.
  expect(within(list).queryByTestId("category-line")).toBeNull();

  // Pressed again, it lets go like any other tile.
  await userEvent.click(tile(/^Uncategorized/));
  await waitFor(() => expect(rowKeys(list)).toHaveLength(12));
  expect(window.location.search).toBe("");
});

test("a board with every bounty in a category still shows the empty tile", async () => {
  const server = pagedBoard(4, () => [leftBehindMatch]);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");

  expect(tile(/^Uncategorized/).getAttribute("aria-label")).toBe(
    "Uncategorized, 0 proposals",
  );
  expect(tile(/^Uncategorized/).disabled).toBe(true);
});

test("a row in a category leads with that category's reason", async () => {
  // APP-3 and APP-9 are both left behind and paper cuts. Under "Paper
  // cuts" a row that led with "Left behind" would be answering a question
  // nobody asked.
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");
  const lineOf = (key: string) =>
    within(screen.getByTestId("proposal-list"))
      .getAllByRole("listitem")
      .find((row) => row.textContent?.includes(`${key}Bounty`))
      ?.querySelector('[data-testid="category-line"]');
  const reasonOf = (key: string) => lineOf(key)?.textContent;

  // With nothing chosen, the first reason the run gave.
  expect(reasonOf("APP-3")).toBe(
    "Left behind · Open 412 days, never in a sprint, unassigned · +1 more",
  );
  expect(iconsIn(lineOf("APP-3")!)).toEqual(["left-behind"]);

  await userEvent.click(tile(/^Paper cuts/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(4),
  );
  expect(reasonOf("APP-3")).toBe(
    "Paper cuts · Low-priority bug, open 412 days · +1 more",
  );
  // The icon is the leading reason's, so it changes with it.
  expect(iconsIn(lineOf("APP-3")!)).toEqual(["paper-cuts"]);
  // A row with only the one reason reads as it always did.
  expect(reasonOf("APP-6")).toBe(
    "Paper cuts · Low-priority bug, open 412 days",
  );
});

test("a link to a category opens on it, and Back leaves it", async () => {
  window.history.replaceState(null, "", "/?category=paper-cuts");
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  const list = await screen.findByTestId("proposal-list");
  expect(rowKeys(list)).toEqual(["APP-3", "APP-6", "APP-9", "APP-12"]);
  expect(tile(/^Paper cuts/).getAttribute("aria-pressed")).toBe("true");
  // Only ever read narrowed: the whole board was not fetched first.
  expect(server.listReads()).toEqual([
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50&category=paper-cuts",
  ]);

  // The browser going back to the page without the category.
  act(() => {
    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(12),
  );
  expect(tile(/^All/).getAttribute("aria-pressed")).toBe("true");
});

test("a category keeps its place while one of its proposals is open", async () => {
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");
  await userEvent.click(tile(/^Paper cuts/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(4),
  );

  await userEvent.click(
    within(screen.getByTestId("proposal-list")).getByRole("button", {
      name: /Bounty 6/,
    }),
  );
  await screen.findByTestId("proposal-panel");
  // Both are in the URL: the proposal that is open, in the view it is in.
  const params = new URLSearchParams(window.location.search);
  expect(params.get("category")).toBe("paper-cuts");
  expect(params.get("proposal")).toBe("bpr_6");
});

test("a long category pages like the whole list, within the category", async () => {
  // 130 bounties, every other one left behind: 65 in the category.
  const server = pagedBoard(130, (n) => (n % 2 === 1 ? [leftBehindMatch] : []));
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");

  await userEvent.click(tile(/^Left behind/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(50),
  );
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(65),
  );
  // The next page stays in the category, from the category's own cursor.
  expect(server.listReads().at(-1)).toBe(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50&category=left-behind&cursor=2026-09-30T00%3A00%3A00.000Z%7Cbpr_99",
  );
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

  // Another category starts from its first page, not where this one got to.
  await userEvent.click(tile(/^All/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(50),
  );
});

test("a board with no proposals shows no categories", async () => {
  const server = categorisedBoard(0);
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  expect(await screen.findByText("No proposals yet.")).toBeDefined();
  expect(screen.queryByTestId("category-nav")).toBeNull();
});

test("a category link that leads nowhere says so and can be left", async () => {
  // A category retired since the link was made: nothing fits it.
  window.history.replaceState(null, "", "/?category=retired-last-month");
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  expect(
    await screen.findByText("No proposals in this category."),
  ).toBeDefined();
  // None of the six is the one showing, so All is the way out.
  await userEvent.click(tile(/^All/));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(12),
  );
});

test("a malformed category in the URL is ignored, not sent", async () => {
  window.history.replaceState(null, "", "/?category=Paper%20Cuts");
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  const list = await screen.findByTestId("proposal-list");
  expect(rowKeys(list)).toHaveLength(12);
  expect(server.listReads()).toEqual([
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&limit=50",
  ]);
});

test("the list still loads when the category counts cannot be read", async () => {
  const server = categorisedBoard(12, { categoriesFail: true });
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  const list = await screen.findByTestId("proposal-list");
  expect(rowKeys(list)).toHaveLength(12);
  expect(screen.queryByTestId("category-nav")).toBeNull();
});

test("a narrowed list without its counts still says so and can be widened", async () => {
  window.history.replaceState(null, "", "/?category=paper-cuts");
  const server = categorisedBoard(12, { categoriesFail: true });
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();

  const list = await screen.findByTestId("proposal-list");
  expect(rowKeys(list)).toHaveLength(4);
  expect(screen.getByText(/Showing one category/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  await waitFor(() =>
    expect(rowKeys(screen.getByTestId("proposal-list"))).toHaveLength(12),
  );
});

test("the counts move with the list when a decision re-reads it", async () => {
  const server = categorisedBoard();
  vi.stubGlobal("fetch", server.fetchMock);
  renderStreamedBoard();
  await screen.findByTestId("category-nav");
  const countReads = () =>
    server.calls.filter((url) => url.includes("/proposal-categories")).length;
  expect(countReads()).toBe(1);

  await userEvent.click(
    within(screen.getByTestId("proposal-list")).getByRole("button", {
      name: /Bounty 3/,
    }),
  );
  const panel = await screen.findByTestId("proposal-panel");
  const approve = await within(panel).findByRole("button", {
    name: "Approve",
  });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  await userEvent.click(approve);

  await waitFor(() => expect(countReads()).toBeGreaterThanOrEqual(2));
});
