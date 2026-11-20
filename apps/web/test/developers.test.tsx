/**
 * The developer portal: its addresses, who sees it, and each page against a
 * server faked at `fetch`.
 *
 * The properties that matter: a member is told the portal is not theirs
 * rather than shown controls the API refuses; a token's secret is shown
 * once, by the answer that made it, and never by the list; revoking asks
 * first, in the page; a server without the grants routes reads as "not
 * available yet"; and the reference is laid out from whatever document the
 * API serves.
 */

import type { ApiTokenDto, MembershipDto } from "@sandbox-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { act, fireEvent, render, screen, waitFor, within } from "./render";

const { DevelopersPage } =
  await import("../src/features/developers/DevelopersPage");
const { ApiReferenceView, groupOperations, typeLabel } =
  await import("../src/features/developers/ApiReference");
const { tokenState } = await import("../src/features/developers/data");
const { duration } = await import("../src/features/developers/Usage");
const {
  developerSectionForPath,
  developersPath,
  pathForScreen,
  screenForPath,
} = await import("../src/routes");
const { trailFor } = await import("../src/Breadcrumbs");

const at = "2026-11-01T08:00:00.000Z";
/** This month's model tokens, as every usage answer carries them. */
const modelTokens = {
  from: "2026-11-01T00:00:00.000Z",
  resetsAt: "2026-12-01T00:00:00.000Z",
  used: 0,
  limit: 10_000_000,
  remaining: 10_000_000,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
/** This month's evaluator seconds and counts, as every usage answer carries them. */
const evaluatorSeconds = {
  from: "2026-11-01T00:00:00.000Z",
  resetsAt: "2026-12-01T00:00:00.000Z",
  used: 0,
  limit: 360_000,
  remaining: 360_000,
  jobs: 0,
  byKind: [],
};
const thisMonth = {
  gradingAttempts: 0,
  contributorGradingAttempts: 0,
  uploads: 0,
};
const acme: MembershipDto = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team",
  role: "owner",
};

const ciToken: ApiTokenDto = {
  id: "tok_1",
  name: "CI",
  prefix: "lnx_ab12cd",
  scopes: ["workspace:read", "bounties:write"],
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: at,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

const SECRET = `lnx_${"s".repeat(40)}`;

/** The caller's default token, as `POST .../tokens/default` answers it. */
const DEFAULT_SECRET = `lnx_${"d".repeat(40)}`;
const defaultToken: ApiTokenDto = {
  ...ciToken,
  id: "tok_default",
  name: "Default",
  prefix: "lnx_dddddddd",
};

interface Server {
  tokens: (typeof ciToken)[];
  /** "missing" for a server without the route. */
  defaultToken: "present" | "missing";
  grants: unknown[] | "missing";
  usage: (days: number) => unknown;
  calls: string[];
  bodies: unknown[];
}

let server: Server;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  server = {
    tokens: [ciToken],
    defaultToken: "present",
    grants: [],
    usage: (days) => ({
      window: { from: at, to: at, days },
      runs: [],
      modelTokens,
      evaluatorSeconds,
      thisMonth,
    }),
    calls: [],
    bodies: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      server.calls.push(`${method} ${url}`);
      if (typeof init?.body === "string") {
        server.bodies.push(JSON.parse(init.body));
      }
      if (url.endsWith("/github/connections")) return json({ connections: [] });
      if (url.endsWith("/jira/connections")) return json({ connections: [] });
      if (url.endsWith("/org_1/tokens/default") && method === "POST") {
        return server.defaultToken === "missing"
          ? json({ error: "Not found" }, 404)
          : json({ token: defaultToken, secret: DEFAULT_SECRET });
      }
      if (url.endsWith("/org_1/tokens") && method === "GET") {
        return json({ tokens: server.tokens });
      }
      if (url.endsWith("/org_1/tokens") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Pick<
          ApiTokenDto,
          "name" | "scopes"
        >;
        const token = {
          ...ciToken,
          id: "tok_2",
          name: body.name,
          prefix: "lnx_ssssss",
          scopes: body.scopes,
        };
        server.tokens = [token, ...server.tokens];
        return json({ token, secret: SECRET }, 201);
      }
      const revoke = /\/tokens\/([^/]+)\/revoke$/.exec(url);
      if (revoke !== null) {
        const token = server.tokens.find((entry) => entry.id === revoke[1]);
        return token === undefined
          ? json({ error: "Not found" }, 404)
          : json({ token: { ...token, revokedAt: at } });
      }
      if (url.endsWith("/oauth/grants")) {
        return server.grants === "missing"
          ? json({ error: "Not found" }, 404)
          : json({ grants: server.grants });
      }
      if (url.includes("/oauth/grants/") && url.endsWith("/revoke")) {
        return json({ grant: (server.grants as unknown[])[0] });
      }
      const usage = /\/usage\?days=(\d+)$/.exec(url);
      if (usage !== null) return json(server.usage(Number(usage[1])));
      return json({ error: "Not found" }, 404);
    }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function showPortal(
  section: Parameters<typeof DevelopersPage>[0]["section"],
  organization: MembershipDto = acme,
) {
  const onNavigate = vi.fn();
  const onOpenConnection = vi.fn();
  render(
    <DevelopersPage
      organization={organization}
      section={section}
      onNavigate={onNavigate}
      onOpenConnection={onOpenConnection}
    />,
  );
  return { onNavigate, onOpenConnection };
}

test("the portal is at /o/:slug/developers, and /developers without one", () => {
  expect(developersPath("acme")).toBe("/o/acme/developers");
  expect(developersPath("acme", "tokens")).toBe("/o/acme/developers/tokens");
  expect(developersPath(undefined, "usage")).toBe("/developers/usage");
  expect(developerSectionForPath("/o/acme/developers")).toBe("overview");
  expect(developerSectionForPath("/o/acme/developers/reference/")).toBe(
    "reference",
  );
  expect(developerSectionForPath("/developers")).toBe("overview");
  expect(developerSectionForPath("/developers/apps")).toBe("apps");
  expect(developerSectionForPath("/developers/webhooks")).toBeUndefined();
  expect(
    developerSectionForPath("/o/acme/developers/tokens/x"),
  ).toBeUndefined();
  expect(developerSectionForPath("/o//developers")).toBeUndefined();
  expect(screenForPath("/o/acme/developers/mcp")).toBe("developers");
  expect(screenForPath("/developers")).toBe("developers");
  expect(screenForPath("/o/acme/developers/nope")).toBe("not-found");
  expect(pathForScreen("developers", "acme")).toBe("/o/acme/developers");
  expect(pathForScreen("developers")).toBe("/developers");
  expect(trailFor("developers").map((crumb) => crumb.label)).toEqual([
    "Home",
    "Developers",
  ]);
  expect(
    trailFor("developers", { name: "Acme", slug: "acme" }).map(
      (crumb) => crumb.label,
    ),
  ).toEqual(["Home", "Workspaces", "Acme", "Developers"]);
});

test("an owner sees the portal: its pages, nothing unbuilt, and the overview", async () => {
  const { onNavigate, onOpenConnection } = showPortal("overview");
  const nav = screen.getByRole("navigation", { name: "Developers" });
  expect(
    within(nav)
      .getByRole("link", { name: "Overview" })
      .getAttribute("aria-current"),
  ).toBe("page");
  // Unbuilt pages are not listed, not even disabled.
  for (const label of ["Webhooks", "CI", "Audit log"])
    expect(within(nav).queryByText(label)).toBeNull();
  expect(within(nav).queryByText(/Coming soon/)).toBeNull();
  fireEvent.click(within(nav).getByRole("link", { name: "API tokens" }));
  expect(onNavigate).toHaveBeenCalledWith("/o/acme/developers/tokens");

  // Connections come from the existing reads, and link to the connect flows.
  const connect = await screen.findByRole("link", { name: "Connect GitHub" });
  expect(connect.getAttribute("href")).toBe(
    "/o/acme/settings?connection=github",
  );
  fireEvent.click(connect);
  expect(onOpenConnection).toHaveBeenCalledWith("github");
  expect(
    (await screen.findByRole("link", { name: "Connect Jira" })).getAttribute(
      "href",
    ),
  ).toBe("/o/acme/settings?connection=jira");

  // The quickstart names this app's own origin.
  const origin = window.location.origin;
  expect(screen.getByText(new RegExp(`curl ${origin}/api/v1/me`))).toBeTruthy();
  expect(
    screen.getByText(
      new RegExp(`claude mcp add --transport http lunox ${origin}/mcp`),
    ),
  ).toBeTruthy();
  expect(screen.getByText(/npx @lunox-work\/bouncer login/)).toBeTruthy();
});

test("the API quickstart shows the default token redacted and copies it whole", async () => {
  showPortal("overview");
  const origin = window.location.origin;
  const redacted = await screen.findByText(/Bearer lnx_dddddddd…/);
  expect(redacted.textContent).toBe(
    `curl ${origin}/api/v1/me \\\n  -H "Authorization: Bearer lnx_dddddddd…"`,
  );
  // The secret is never on the page, only in what the button copies.
  expect(document.body.textContent?.includes(DEFAULT_SECRET)).toBe(false);
  expect(screen.getByText(/Copy includes your default token/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Copy API example" }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `curl ${origin}/api/v1/me \\\n  -H "Authorization: Bearer ${DEFAULT_SECRET}"`,
    ),
  );
});

test("without a default token the quickstart keeps the placeholder", async () => {
  server.defaultToken = "missing";
  showPortal("overview");
  await waitFor(() =>
    expect(server.calls).toContain("POST /api/v1/orgs/org_1/tokens/default"),
  );
  expect(screen.getByText(/Bearer lnx_…"/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy API example" }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('Bearer lnx_…"'),
    ),
  );
});

test("a member is told the portal is for owners and admins, and reads nothing", () => {
  showPortal("tokens", { ...acme, role: "member" });
  expect(screen.getByRole("note").textContent).toMatch(
    /for owners and admins of Acme/,
  );
  expect(screen.queryByRole("navigation", { name: "Developers" })).toBeNull();
  expect(screen.queryByRole("button", { name: /New token/ })).toBeNull();
  expect(server.calls).toEqual([]);
});

test("a new token's secret is shown once, and the list never shows it", async () => {
  showPortal("tokens");
  const list = await screen.findByRole("list", { name: "API tokens" });
  expect(within(list).getByText("lnx_ab12cd…")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "New token" }));
  const form = screen.getByRole("form", { name: "New API token" });
  const make = within(form).getByRole("button", { name: "Make token" });
  expect((make as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText("Name"), {
    target: { value: "Deploy bot" },
  });
  fireEvent.click(within(form).getByLabelText(/sandboxes:write/));
  fireEvent.change(within(form).getByLabelText("Expires"), {
    target: { value: "30" },
  });
  fireEvent.click(make);

  const secret = await screen.findByTestId("token-secret");
  expect(secret.textContent).toBe(SECRET);
  expect(screen.getByText(/You won’t see it again/)).toBeTruthy();
  expect(server.bodies.at(-1)).toEqual({
    name: "Deploy bot",
    scopes: ["workspace:read", "sandboxes:write"],
    expiresInDays: 30,
  });
  // Once on the page, and only in the panel: the new row shows its prefix.
  expect(screen.getAllByText(SECRET)).toHaveLength(1);
  const row = within(
    screen.getByRole("list", { name: "API tokens" }),
  ).getByRole("listitem", { name: "Deploy bot" });
  expect(row.textContent).toContain("lnx_ssssss…");
  expect(row.textContent).not.toContain(SECRET);

  fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SECRET);

  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(SECRET)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET);
});

test("revoking a token asks in the page first, then marks it revoked", async () => {
  const confirm = vi.spyOn(window, "confirm");
  showPortal("tokens");
  fireEvent.click(await screen.findByRole("button", { name: "Revoke CI" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Revoke “CI”?")).toBeTruthy();
  expect(server.calls.some((call) => call.includes("/revoke"))).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(server.calls).toContain("POST /api/v1/orgs/org_1/tokens/tok_1/revoke");
  const row = screen.getByRole("listitem", { name: "CI" });
  expect(within(row).getByText("Revoked", { selector: "span" })).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Revoke CI" })).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
});

test("a token is active until revoked or past its expiry", () => {
  const now = new Date(at);
  expect(tokenState(ciToken, now)).toBe("active");
  expect(
    tokenState({ ...ciToken, expiresAt: "2026-10-01T00:00:00.000Z" }, now),
  ).toBe("expired");
  expect(tokenState({ ...ciToken, revokedAt: at }, now)).toBe("revoked");
});

test("connected apps say they are not available where the route is missing", async () => {
  server.grants = "missing";
  showPortal("apps");
  expect((await screen.findByRole("note")).textContent).toMatch(
    /not available on this server yet/,
  );
});

test("connected apps are listed and revoked", async () => {
  server.grants = [
    {
      id: "grt_1",
      client: { id: "client_1", name: "Claude Code" },
      user: { id: "user_1", name: "Ada Lovelace" },
      scopes: ["workspace:read", "offline_access"],
      createdAt: at,
      updatedAt: at,
      lastUsedAt: at,
    },
  ];
  showPortal("apps");
  const row = await screen.findByRole("listitem", { name: "Claude Code" });
  expect(within(row).getByText("offline_access")).toBeTruthy();
  expect(within(row).getByText("Ada Lovelace")).toBeTruthy();
  fireEvent.click(
    within(row).getByRole("button", { name: "Revoke Claude Code" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Revoke access" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("listitem", { name: "Claude Code" })).toBeNull(),
  );
  expect(server.calls).toContain(
    "POST /api/v1/orgs/org_1/oauth/grants/grt_1/revoke",
  );
});

test("no connected apps points at MCP setup", async () => {
  const { onNavigate } = showPortal("apps");
  fireEvent.click(await screen.findByRole("button", { name: "Set up MCP" }));
  expect(onNavigate).toHaveBeenCalledWith("/o/acme/developers/mcp");
});

test("usage reads the chosen window again when it changes", async () => {
  server.usage = (days) => ({
    window: { from: at, to: at, days },
    modelTokens,
    evaluatorSeconds,
    thisMonth,
    runs:
      days === 30
        ? [
            {
              family: "sizing",
              kind: "backlog",
              status: "succeeded",
              count: 12,
            },
            {
              family: "analysis",
              kind: "graphify",
              status: "failed",
              count: 3,
            },
          ]
        : [{ family: "sizing", kind: "ticket", status: "succeeded", count: 2 }],
  });
  showPortal("usage");
  expect(await screen.findByText("backlog")).toBeTruthy();
  expect(screen.getByText("15 runs")).toBeTruthy();
  expect(server.calls).toContain("GET /api/v1/orgs/org_1/usage?days=30");

  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  expect(await screen.findByText("ticket")).toBeTruthy();
  expect(server.calls).toContain("GET /api/v1/orgs/org_1/usage?days=7");
  expect(
    screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByText("backlog")).toBeNull();
});

test("usage shows this month's model tokens and evaluator time against their limits, with grading attempts and uploads", async () => {
  server.usage = (days) => ({
    window: { from: at, to: at, days },
    runs: [],
    modelTokens: { ...modelTokens, used: 2_500_000, remaining: 7_500_000 },
    evaluatorSeconds: {
      ...evaluatorSeconds,
      used: 4_980,
      remaining: 355_020,
      jobs: 31,
      byKind: [{ kind: "sandbox_build", seconds: 4_980, jobs: 31 }],
    },
    thisMonth: {
      gradingAttempts: 7,
      contributorGradingAttempts: 4,
      uploads: 2,
    },
  });
  showPortal("usage");
  const month = await screen.findByRole("group", { name: "This month" });
  const tokens = within(month).getByRole("meter", {
    name: "Model tokens used",
  });
  expect(tokens.getAttribute("aria-valuetext")).toBe("2,500,000 of 10,000,000");
  const evaluator = within(month).getByRole("meter", {
    name: "Evaluator time used",
  });
  expect(evaluator.getAttribute("aria-valuetext")).toBe("1 h 23 min of 100 h");
  expect(within(month).getByText("7")).toBeTruthy();
  expect(within(month).getByText("4 by invited contributors")).toBeTruthy();
  expect(within(month).getByText("2")).toBeTruthy();
  expect(screen.getByText(/both reset on December 1/)).toBeTruthy();
});

test("evaluator time reads in seconds, minutes and hours", () => {
  expect(duration(42)).toBe("42 s");
  expect(duration(300)).toBe("5 min");
  expect(duration(3_600)).toBe("1 h");
  expect(duration(4_980)).toBe("1 h 23 min");
});

test("an empty window says so", async () => {
  showPortal("usage");
  expect(
    await screen.findByText("No runs started in the last 30 days."),
  ).toBeTruthy();
});

test("the MCP page lists each server with its URL and install snippets", async () => {
  showPortal("mcp");
  const origin = window.location.origin;
  const servers = screen.getByRole("list", { name: "MCP servers" });
  for (const path of ["/mcp", "/mcp/bouncer", "/mcp/carveout"]) {
    expect(
      within(servers).getByRole("listitem", { name: path }).textContent,
    ).toContain(`${origin}${path}`);
  }
  // The plugins bundle no MCP server for now: no plugin install snippet.
  expect(screen.queryByText(/claude plugin install/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: `Copy /mcp/carveout URL` }),
  );
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    `${origin}/mcp/carveout`,
  );
  // Radix tabs choose on focus and pointer-down, not a bare click.
  const cursor = screen.getByRole("tab", { name: "Cursor" });
  await act(async () => {
    fireEvent.mouseDown(cursor);
    fireEvent.focus(cursor);
  });
  expect(await screen.findByText(/"mcpServers"/)).toBeTruthy();
});

const fixture = {
  openapi: "3.1.0",
  info: { title: "Lunox platform API", version: "1", description: "Tokens." },
  paths: {
    "/api/v1/me": {
      get: {
        summary: "The account the credential acts as",
        tags: ["Workspace"],
        "x-required-scope": "workspace:read",
        parameters: [],
        responses: {
          "200": {
            description: "Success.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        username: { type: ["string", "null"] },
                      },
                      required: ["id"],
                    },
                  },
                  required: ["user"],
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/orgs/{orgId}/bounties": {
      post: {
        summary: "Write a bounty",
        tags: ["Bounties"],
        "x-required-scope": "bounties:write",
        parameters: [
          {
            name: "orgId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", description: "What it is called." },
                  stack: { type: "array", items: { type: "string" } },
                  kind: { enum: ["feature", "bug"] },
                },
                required: ["title"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Success.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Bounty" },
              },
            },
          },
        },
      },
    },
    "/api/v1/orgs/{orgId}/usage": {
      get: {
        summary: "Usage",
        parameters: [
          {
            name: "days",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        ],
        responses: { "200": { description: "Success." } },
      },
    },
  },
  components: {
    schemas: {
      Bounty: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

test("the reference groups operations by tag, or by path when untagged", () => {
  expect(
    groupOperations(fixture).map((group) => [
      group.name,
      group.operations.map(
        (operation) => `${operation.method} ${operation.path}`,
      ),
    ]),
  ).toEqual([
    ["Workspace", ["get /api/v1/me"]],
    ["Bounties", ["post /api/v1/orgs/{orgId}/bounties"]],
    ["usage", ["get /api/v1/orgs/{orgId}/usage"]],
  ]);
  expect(typeLabel({ type: ["string", "null"] }, fixture)).toBe(
    "string | null",
  );
  expect(typeLabel({ type: "array", items: { type: "string" } }, fixture)).toBe(
    "string[]",
  );
  expect(
    typeLabel({ anyOf: [{ type: "string" }, { type: "null" }] }, fixture),
  ).toBe("string | null");
  expect(typeLabel({ $ref: "#/components/schemas/Bounty" }, fixture)).toBe(
    "Bounty",
  );
  expect(
    typeLabel(
      { type: "object", additionalProperties: { type: "number" } },
      fixture,
    ),
  ).toBe("record<number>");
  expect(typeLabel({ const: "x" }, fixture)).toBe('"x"');
  expect(typeLabel({ type: "string", format: "date-time" }, fixture)).toBe(
    "string (date-time)",
  );
  expect(typeLabel({}, fixture)).toBe("any");
});

test("the reference renders each group's operations, opening one on demand", async () => {
  render(<ApiReferenceView document={fixture} />);
  const workspace = screen.getByRole("region", { name: "Workspace" });
  expect(within(workspace).getByText("/me")).toBeTruthy();
  expect(
    within(workspace).getByText("The account the credential acts as"),
  ).toBeTruthy();
  const bounties = screen.getByRole("region", { name: "Bounties" });
  expect(within(bounties).getByText("bounties:write")).toBeTruthy();
  // Folded until opened: the schema is not drawn yet.
  expect(within(bounties).queryByText("What it is called.")).toBeNull();
  const details = bounties.querySelector("details");
  if (details === null) throw new Error("No operation to open.");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(within(bounties).getByText("What it is called.")).toBeTruthy();
  expect(within(bounties).getByText("Request body")).toBeTruthy();
  expect(within(bounties).getByText("Response 201")).toBeTruthy();
  expect(within(bounties).getByText('"feature" | "bug"')).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Filter operations"), {
    target: { value: "usage" },
  });
  expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();
  expect(screen.getByRole("region", { name: "usage" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter operations"), {
    target: { value: "nothing like this" },
  });
  expect(screen.getByText(/No operation matches/)).toBeTruthy();
});

test("the reference page reads the API's document, lazily", async () => {
  const answer = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) =>
      String(input).endsWith("/api/v1/openapi.json")
        ? json(fixture)
        : answer(input, init),
    ),
  );
  showPortal("reference");
  expect(
    await screen.findByRole("region", { name: "Bounties" }, { timeout: 5000 }),
  ).toBeTruthy();
});
