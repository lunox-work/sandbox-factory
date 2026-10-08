/**
 * Browser smoke fixture: the built web app and compiled production Hono routes,
 * with injected session and in-memory store doubles. This does not exercise
 * Better Auth's OAuth implementation, PostgreSQL or third-party integrations.
 * It never imports server.ts, reads an env file or uses application credentials.
 */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "../apps/api/dist/routes.js";
import { baseURL, sessionCookie } from "./settings.mjs";

const webRoot = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
await access(`${webRoot}/index.html`);

const stamp = "2026-01-01T00:00:00.000Z";
const user = {
  id: "user_e2e",
  name: "Ada Example",
  email: "ada@example.test",
  emailVerified: true,
  image: null,
  createdAt: stamp,
  updatedAt: stamp,
};
const memberships = [
  {
    id: "org_alpha",
    name: "Alpha",
    slug: "alpha",
    kind: "team",
    role: "owner",
  },
  { id: "org_beta", name: "Beta", slug: "beta", kind: "team", role: "owner" },
];

function fixtureApp(token) {
  const session = {
    id: `session_${token}`,
    userId: user.id,
    token,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: stamp,
    updatedAt: stamp,
    activeOrganizationId: "org_alpha",
  };
  const signedIn = () => (token === "" ? null : { user, session });
  const rows = new Map();
  let sequence = 0;
  function addBounty(organizationId, createdBy, input) {
    const bounty = {
      id: `bty_${++sequence}`,
      organizationId,
      title: input.title,
      description: input.description,
      repoId: input.repoId,
      stack: input.stack ?? [],
      categories: [],
      components: [],
      inputTruncated: false,
      origin: "manual",
      createdBy,
      revision: 1,
      version: 1,
      approval: null,
      stages: { overview: { version: 1 }, bounty: null, sandbox: null },
      jira: null,
      sandbox: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    rows.set(bounty.id, bounty);
    return bounty;
  }
  // A workspace the user is not in, whose bounty no list may show them.
  for (const organization of [
    ...memberships,
    { id: "org_hidden", name: "Hidden" },
  ]) {
    addBounty(organization.id, user.id, {
      title: `${organization.name} private bounty`,
      description: `Work owned by ${organization.name}.`,
      repoId: null,
    });
  }

  return createApp({
    corsOrigins: [baseURL],
    auth: {
      api: { getSession: async () => signedIn() },
      async handler(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/get-session") return Response.json(signedIn());
        if (path === "/api/auth/organization/set-active" && token !== "") {
          const { organizationId } = await request.json();
          if (!memberships.some(({ id }) => id === organizationId)) {
            return Response.json({ message: "Not found" }, { status: 404 });
          }
          session.activeOrganizationId = organizationId;
          return Response.json({ id: organizationId });
        }
        return Response.json(
          { message: "Unsupported fixture request" },
          { status: 404 },
        );
      },
    },
    organizations: {
      listForUser: async () => memberships,
      pendingFor: async () => [],
      roleOf: async (_userId, organizationId) =>
        memberships.find(({ id }) => id === organizationId)?.role,
      get: async (organizationId) =>
        memberships.find(({ id }) => id === organizationId),
    },
    pricing: {
      bounties: {
        create: async (organizationId, createdBy, input) => ({
          ok: true,
          bounty: addBounty(organizationId, createdBy, input),
        }),
        list: async (organizationId) =>
          [...rows.values()]
            .filter((bounty) => bounty.organizationId === organizationId)
            .reverse()
            .map((bounty) => ({ ...bounty, proposal: null })),
        listAcross: async (organizationIds) =>
          [...rows.values()]
            .filter((bounty) => organizationIds.includes(bounty.organizationId))
            .reverse()
            .map((bounty) => ({ ...bounty, proposal: null })),
        // Written here, so in no category.
        categoryCounts: async (organizationIds) => {
          const total = [...rows.values()].filter((bounty) =>
            organizationIds.includes(bounty.organizationId),
          ).length;
          return { total, uncategorized: total, categories: {} };
        },
        get: async (organizationId, bountyId) => {
          const bounty = rows.get(bountyId);
          return bounty?.organizationId === organizationId ? bounty : null;
        },
        // Each bounty is at its first overview version, as written.
        versions: async (organizationId, bountyId) => {
          const bounty = rows.get(bountyId);
          return bounty?.organizationId === organizationId
            ? [
                {
                  version: 1,
                  title: bounty.title,
                  description: bounty.description,
                  createdBy: bounty.createdBy,
                  createdAt: bounty.createdAt,
                },
              ]
            : null;
        },
      },
      proposals: { liveForBounty: async () => null },
      // Nothing is being sized.
      runs: { activeForBounty: async () => null },
    },
  });
}

// Each browser context chooses a new UUID cookie, so retries and parallel tests
// get fresh fixtures. There is no reset endpoint or product auth bypass.
const fixtures = new Map([["", fixtureApp("")]]);
function api(request) {
  const value = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  const token = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value ?? "")
    ? value
    : "";
  if (!fixtures.has(token)) fixtures.set(token, fixtureApp(token));
  return fixtures.get(token).fetch(request);
}

const app = new Hono();
app.all("/api/*", (context) => api(context.req.raw));
app.get("/health", (context) => api(context.req.raw));
app.get("/version", (context) => api(context.req.raw));
app.use("*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ path: `${webRoot}/index.html` }));

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4179 });
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
