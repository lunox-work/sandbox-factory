import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import {
  BoardBounties,
  RateCardEditor,
  modelLabel,
  money,
} from "../src/Bounties";

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
      Response.json({
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
      Response.json({
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
    vi.fn(() => Promise.resolve(Response.json({ rateCard: savedRateCard }))),
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
      Response.json({
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
      Response.json({
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
    vi.fn(() => Promise.resolve(Response.json({ rateCard: savedRateCard }))),
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
      vi.fn(() => Promise.resolve(Response.json({ rateCard: savedRateCard }))),
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
    vi.fn(() => Promise.resolve(Response.json({ rateCard: savedRateCard }))),
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
        Response.json({
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
        return Promise.resolve(Response.json({ rateCard: savedRateCard }));
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
        return Promise.resolve(Response.json({ rateCard: savedRateCard }));
      writes++;
      if (writes === 1) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        Response.json({
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
          Response.json({ error: "conflict" }, { status: 409 }),
        );
      reads++;
      return Promise.resolve(
        Response.json({
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
          Response.json({
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
          Response.json({
            proposal,
            freshness: { freshness: "current", checkedAt: "now" },
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
      role="member"
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  expect(await screen.findByText(/Ship export/)).toBeDefined();
  // The run summary says what actually did the work — the fallback here,
  // not the requested Sonnet.
  expect(screen.getByText(/Latest run/).textContent).toContain(
    "2 results · sized by DeepSeek V4 Pro",
  );
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
      writeGranted={false}
      readIssue={() => Promise.resolve(null)}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /Ship export/ }),
  );
  expect(await screen.findByText("Why this size")).toBeDefined();
  expect(window.location.search).toContain("proposal=bpr_1");

  // The filters are behind the peek; closing it hands the list back.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });
  expect(window.location.search).not.toContain("proposal=");
  await userEvent.click(screen.getByRole("tab", { name: "Approved" }));
  await waitFor(() =>
    expect(urls.some((url) => url.includes("status=approved"))).toBe(true),
  );
});

test("S is draggable between XS and M, and XS edits autosave the five-point range", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      Response.json({
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
        Response.json({
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
      Promise.resolve(Response.json({ rateCard: savedRateCard })),
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
      Response.json({
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
        Response.json({
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
        Response.json({
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
        Response.json({
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
        return Promise.resolve(Response.json({ rateCard: savedRateCard }));
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
  expect(requests).toHaveLength(1);
  await act(async () =>
    requests[0]!.resolve(
      Response.json({
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
      Response.json({
        rateCard: { ...savedRateCard, ...requests[1]!.body, revision: 3 },
      }),
    ),
  );
  expect(displayedRate("XS")).toBe("USD50");
  expect(displayedRate("XL")).toBe("USD450");
});

test("leaving the window cancels a drag and removes its release listener", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(Response.json({ rateCard: savedRateCard })),
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
      vi.fn(() => Promise.resolve(Response.json({ rateCard: savedRateCard }))),
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
      Response.json({
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
      Response.json({
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
