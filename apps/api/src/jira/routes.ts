/**
 * Connecting a client's Jira site: the OAuth 2.0 (3LO) round trip, and the
 * connections it produces.
 *
 * This is a **second** Atlassian grant, separate from signing in with
 * Atlassian. Better Auth owns that one and asks only for `read:me`; this one
 * asks for the Jira scopes and belongs to a different app, because an
 * Atlassian grant is per app and a new grant overwrites the previous one's
 * scopes — one app serving both would make the two flows break each other.
 *
 * The flow, and where each guard sits:
 *
 *   GET  .../jira/connect    membership checked HERE, then redirect to Atlassian
 *   GET  /api/v1/jira/callback   signed state proves that check still applies
 *
 * The callback deliberately carries no organization id of its own. It takes it
 * from the signed state, because one read from the query string would let
 * anyone attach a site to an organization they were never authorised for.
 *
 * But the signature proves only *which* organization was chosen and *who*
 * chose it — never that they are still entitled to. Membership is therefore
 * checked again when the callback lands, not merely when the flow starts.
 */

import type { JiraBoardStore, JiraConnectionStore } from "@sandbox-factory/db";
import {
  accessibleSites,
  backlogJql,
  backlogSource,
  exchangeCode,
  JiraApiError,
  JiraAuthError,
  READ_SCOPES,
  stripTrailingSlashes,
} from "@sandbox-factory/jira";
import {
  boardSelectionSchema,
  registerBoardSchema,
  updateBoardSchema,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";

import { jiraClientFor, noteAuthFailure } from "./credential.js";
import { signState, verifyState } from "./state.js";

/** What the routes need. Supplied by `createApp`, faked in tests. */
export interface JiraRouteOptions {
  connections: JiraConnectionStore;
  boards: JiraBoardStore;
  /**
   * The caller's current role in an organization, or undefined if they are not
   * a member. Read again in the callback — see the comment there.
   */
  roleOf: (
    userId: string,
    organizationId: string,
  ) => Promise<string | undefined>;
  /** The second Atlassian app's credentials. */
  clientId: string;
  clientSecret: string;
  /** Signs the `state`. `BETTER_AUTH_SECRET`. */
  secret: string;
  /** Public origin of the API, for building the callback URL. */
  apiUrl: string;
  /** Public origin of the web app, where the browser is sent afterwards. */
  appUrl: string;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * What these routes need on the context, set by the session and membership
 * guards in `routes.ts`.
 *
 * `mountJiraRoutes` is generic over the app's own env rather than taking this
 * shape directly: Hono's env parameter is invariant, so a `Hono<AppEnv>` —
 * which also carries `sessionId` — is not assignable to a `Hono<JiraAppEnv>`
 * however compatible the two look. The constraint says "at least these",
 * which is what is actually required.
 */
export interface JiraAppEnv {
  Variables: {
    user: { id: string; email: string; name: string };
    member: { organizationId: string; role: string };
  };
}

/**
 * Where a finished flow sends the browser.
 *
 * Always the web app, never a URL from the request: `returnTo` is carried in
 * the signed state, and even then only its path is used. An open redirect here
 * would be reachable by anyone who can start a flow.
 */
function redirectTarget(
  appUrl: string,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(appUrl);
  // A path from the state, not an origin. `new URL(path, appUrl)` would honour
  // an absolute URL and send the browser off-site.
  url.pathname = path.startsWith("/") ? path : `/${path}`;
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function mountJiraRoutes<Env extends JiraAppEnv>(
  app: Hono<Env>,
  options: JiraRouteOptions,
): void {
  const {
    connections,
    boards,
    roleOf,
    clientId,
    clientSecret,
    secret,
    apiUrl,
    appUrl,
    fetch: fetchImpl,
    now,
  } = options;

  /** What `jiraClientFor` needs, assembled once rather than per route. */
  const clientOptions = {
    connections,
    clientId,
    clientSecret,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(now === undefined ? {} : { now }),
  };

  // `stripTrailingSlashes`, not `replace(/\/+$/, "")`: that pattern is the one
  // CodeQL flagged as a ReDoS on PR #25, and `apiUrl` is configuration rather
  // than a constant.
  const redirectUri = `${stripTrailingSlashes(apiUrl)}/api/v1/jira/callback`;

  /**
   * Start the flow. Behind the membership guard, so the caller has already
   * been shown to belong to the organization in the path.
   *
   * Owners and admins only. Connecting a Jira site grants the platform read
   * access to a client's tickets for as long as the connection lives, which
   * is not a decision an ordinary member should make for the organization.
   */
  app.get("/api/v1/orgs/:orgId/jira/connect", (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      // 403 rather than 404: membership is already established, so the
      // organization's existence is not what is being hidden.
      return c.json({ error: "Only an owner or admin may connect Jira." }, 403);
    }

    const returnTo = c.req.query("returnTo") ?? "/settings/jira";
    const state = signState(secret, {
      organizationId,
      userId: c.get("user").id,
      // Only the path survives; see `redirectTarget`.
      returnTo: safePath(returnTo),
      ...(now === undefined ? {} : { issuedAt: now() }),
    });

    const url = new URL("https://auth.atlassian.com/authorize");
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", READ_SCOPES.join(" "));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    // Without it Atlassian returns no refresh token to a user who has already
    // consented, and the connection dies in an hour with nothing to renew it.
    url.searchParams.set("prompt", "consent");

    return c.redirect(url.toString());
  });

  /**
   * Atlassian sends the browser back here.
   *
   * Outside the membership guard — the path has no organization id, because
   * trusting one from the query string would defeat the check made at the
   * start. It is still behind the session guard, and the state must name the
   * session it arrived on.
   */
  app.get("/api/v1/jira/callback", async (c) => {
    // Atlassian reports a refusal in the query string rather than by status.
    const denied = c.req.query("error");
    if (denied !== undefined) {
      // `access_denied` is the user pressing Cancel on the consent screen,
      // which is a choice rather than a fault.
      return c.redirect(
        redirectTarget(appUrl, "/settings/jira", {
          jira: denied === "access_denied" ? "cancelled" : "error",
        }),
      );
    }

    const verified = verifyState(
      secret,
      c.req.query("state"),
      c.get("user").id,
      now?.(),
    );
    if (!verified.ok) {
      // The reason is not reported to the browser: each one tells an attacker
      // something about why their forgery failed.
      return c.redirect(
        redirectTarget(appUrl, "/settings/jira", { jira: "state" }),
      );
    }
    const { organizationId, returnTo } = verified.state;

    /**
     * Membership, re-read rather than inferred from the state.
     *
     * The state is signed, so `organizationId` is the one chosen at the start
     * and the membership guard passed then. It does not follow that it passes
     * now: the window is ten minutes, and a person can be demoted or removed
     * inside it. Checking only the signature would let a former admin finish a
     * flow they were no longer entitled to, which is an authorization bypass
     * however narrow the window.
     *
     * Before the exchange, so a code that cannot be used is never spent.
     */
    const role = await roleOf(c.get("user").id, organizationId);
    if (role === undefined || !isAtLeastAdmin(role)) {
      return c.redirect(
        redirectTarget(appUrl, returnTo, { jira: "forbidden" }),
      );
    }

    const code = c.req.query("code");
    if (code === undefined || code === "") {
      return c.redirect(redirectTarget(appUrl, returnTo, { jira: "error" }));
    }

    try {
      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        redirectUri,
        code,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
        ...(now === undefined ? {} : { now }),
      });

      const sites = await accessibleSites({
        accessToken: tokens.accessToken,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      });

      if (sites.length === 0) {
        // The token is fine; the user granted no Jira site. Usually consent on
        // an account with no Jira product, or a Confluence-only site — which
        // `accessibleSites` filters out precisely because it would 404 later.
        return c.redirect(
          redirectTarget(appUrl, returnTo, { jira: "no-sites" }),
        );
      }

      // Every granted site is recorded. Asking the user to pick one here would
      // mean holding the tokens somewhere while they choose; a connection per
      // site is cheap, and a board is registered against one of them later.
      for (const site of sites) {
        await connections.upsert(organizationId, {
          cloudId: site.cloudId,
          siteUrl: site.url,
          siteName: site.name,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        });
      }

      const missing = missingScopes(tokens.scopes);
      return c.redirect(
        redirectTarget(appUrl, returnTo, {
          jira: missing.length > 0 ? "partial-scopes" : "connected",
          ...(missing.length > 0 ? { missing: missing.join(",") } : {}),
        }),
      );
    } catch (error) {
      // A failed exchange is reported to the user as a failed connection, not
      // as a 500: nothing is broken, and the remedy is to try again.
      if (error instanceof JiraAuthError) {
        return c.redirect(redirectTarget(appUrl, returnTo, { jira: "denied" }));
      }
      throw error;
    }
  });

  /** The organization's connections. No token material; see the store. */
  app.get("/api/v1/orgs/:orgId/jira/connections", async (c) => {
    return c.json({
      connections: await connections.list(c.get("member").organizationId),
    });
  });

  /**
   * Disconnect. Owners and admins only, matching who may connect.
   *
   * The row is deleted rather than flagged, which is what revokes our access:
   * the tokens go with it. Atlassian's own grant survives until the user
   * revokes it in their account settings, and the UI says so.
   */
  app.delete("/api/v1/orgs/:orgId/jira/connections/:id", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may disconnect Jira." },
        403,
      );
    }

    const removed = await connections.remove(organizationId, c.req.param("id"));
    if (!removed) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.body(null, 204);
  });

  /**
   * The boards a connection can see, live from Jira.
   *
   * Not stored: a site's boards change without telling us, and a stale list is
   * worse than a round trip here. Registering one is what creates a row.
   */
  app.get("/api/v1/orgs/:orgId/jira/connections/:id/boards", async (c) => {
    const { organizationId } = c.get("member");
    const connectionId = c.req.param("id");

    const result = await jiraClientFor(
      clientOptions,
      organizationId,
      connectionId,
    );
    if (!result.ok) {
      return failureResponse(c, result.failure);
    }

    try {
      return c.json({ boards: await result.client.boards() });
    } catch (error) {
      return await jiraFailure(c, connections, connectionId, error);
    }
  });

  /** The boards this organization has registered. Local rows, no Jira call. */
  app.get("/api/v1/orgs/:orgId/jira/boards", async (c) => {
    return c.json({
      boards: await boards.list(c.get("member").organizationId),
    });
  });

  /**
   * Register a board, or re-register it to change its settings.
   *
   * The name, type and project key are read from Jira rather than taken from
   * the body: they are Jira's to state, and a client that sent its own could
   * register a board under a name the site does not use.
   *
   * Owners and admins only, matching who may connect a site. Registering a
   * board is what decides which of a client's tickets get priced.
   */
  app.post("/api/v1/orgs/:orgId/jira/boards", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json({ error: "Only an owner or admin may add a board." }, 403);
    }

    const parsed = registerBoardSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Provide a connection and a board." }, 400);
    }

    const result = await jiraClientFor(
      clientOptions,
      organizationId,
      parsed.data.connectionId,
    );
    if (!result.ok) {
      return failureResponse(c, result.failure);
    }

    let board;
    try {
      // Read through the board list rather than by id: the Agile endpoint for
      // a single board answers 404 for one the grant cannot see, which is
      // indistinguishable from one that does not exist.
      const visible = await result.client.boards();
      board = visible.find(
        (candidate) => String(candidate.id) === parsed.data.externalId,
      );
    } catch (error) {
      return await jiraFailure(c, connections, parsed.data.connectionId, error);
    }

    if (board === undefined) {
      return c.json({ error: "That board is not on this Jira site." }, 404);
    }

    return c.json(
      {
        board: await boards.register(organizationId, {
          connectionId: parsed.data.connectionId,
          externalId: String(board.id),
          name: board.name,
          boardType: board.type,
          projectKey: board.projectKey,
          // Defaults filled in here, so a row always holds a complete set and
          // the preview does not have to re-derive them.
          selection: boardSelectionSchema.parse(parsed.data.selection ?? {}),
        }),
      },
      201,
    );
  });

  /** Edit a board's settings. The selection is merged; see the store. */
  app.patch("/api/v1/orgs/:orgId/jira/boards/:id", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json({ error: "Only an owner or admin may edit a board." }, 403);
    }

    const parsed = updateBoardSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "Provide selection settings, a write-back flag, or both." },
        400,
      );
    }

    const updated = await boards.update(organizationId, c.req.param("id"), {
      ...(parsed.data.selection === undefined
        ? {}
        : {
            selection: Object.fromEntries(
              // `maxAgeDays: null` clears the bound, and the store merges, so
              // an undefined-stripping spread would drop the clear. Nulls are
              // kept; only genuinely absent keys are removed.
              Object.entries(parsed.data.selection).filter(
                ([, value]) => value !== undefined,
              ),
            ),
          }),
      ...(parsed.data.writebackEnabled === undefined
        ? {}
        : { writebackEnabled: parsed.data.writebackEnabled }),
    });

    if (updated === null) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ board: updated });
  });

  /**
   * The tickets a run would price, read live and priced by nobody.
   *
   * The point of the route: a client can see exactly which tickets their
   * settings select before spending a model call on any of them. It stores
   * nothing — no `jira_issue` row, no run — so pressing it twice is free and
   * looking at a board stays distinguishable from pricing it.
   *
   * Any member may call it. It reads tickets the organization already has a
   * grant for and reveals nothing a board's own backlog view would not.
   */
  app.get("/api/v1/orgs/:orgId/jira/boards/:id/backlog-preview", async (c) => {
    const { organizationId } = c.get("member");

    const registered = await boards.forRun(organizationId, c.req.param("id"));
    if (registered === null) {
      return c.json({ error: "Not found" }, 404);
    }
    const { board, connectionId } = registered;

    const result = await jiraClientFor(
      clientOptions,
      organizationId,
      connectionId,
    );
    if (!result.ok) {
      return failureResponse(c, result.failure);
    }

    // Parsed rather than cast: a row written before a setting existed holds
    // none of its defaults, and the JQL builder reads every field.
    const selection = boardSelectionSchema.parse(board.selection);
    const source = backlogSource(board.boardType);
    const jql = backlogJql(selection, {
      projectKey: board.projectKey ?? undefined,
      source,
      ...(now === undefined ? {} : { now: new Date(now()) }),
    });

    const boardId = Number(board.externalId);
    if (!Number.isInteger(boardId)) {
      // Jira's board ids are numeric; a row holding anything else predates a
      // check or was written by hand, and the Agile URL would 404 opaquely.
      return c.json({ error: "That board has an unusable id." }, 422);
    }

    try {
      const page =
        source === "backlog"
          ? await result.client.backlogIssues(boardId, {
              jql,
              maxResults: selection.maxTickets,
            })
          : await result.client.boardIssues(boardId, {
              jql,
              maxResults: selection.maxTickets,
            });

      return c.json({
        boardId: board.id,
        source,
        jql,
        selection,
        issues: page.issues,
        ...(page.total === undefined ? {} : { total: page.total }),
      });
    } catch (error) {
      return await jiraFailure(c, connections, connectionId, error);
    }
  });
}

/**
 * A connection that cannot produce a client, as a response.
 *
 * `not-found` is a 404 rather than a 403 for the reason every owner-scoped
 * read here is: another organization's connection id must look exactly like
 * one that does not exist.
 */
function failureResponse(
  c: { json: (body: unknown, status: 404 | 409) => Response },
  failure: { reason: "not-found" | "reconnect" },
): Response {
  if (failure.reason === "reconnect") {
    // 409 rather than 401: the caller's own session is fine, and answering 401
    // would invite the browser to re-authenticate the wrong thing.
    return c.json(
      { error: "This Jira connection needs reconnecting.", code: "reconnect" },
      409,
    );
  }
  return c.json({ error: "Not found" }, 404);
}

/**
 * A failed Jira call, as a response.
 *
 * Three outcomes, because they need three different things of the user: a
 * revoked grant means reconnect, a 4xx from Jira means the request was wrong
 * and is reported as it stands, and anything else is ours to fix and is
 * re-thrown for the error handler.
 */
async function jiraFailure(
  c: { json: (body: unknown, status: 404 | 409 | 502) => Response },
  connections: JiraConnectionStore,
  connectionId: string,
  error: unknown,
): Promise<Response> {
  if (await noteAuthFailure(connections, connectionId, error)) {
    return failureResponse(c, { reason: "reconnect" });
  }
  if (error instanceof JiraApiError) {
    // Jira's own message is not forwarded: it can carry site detail, and the
    // status is what the UI acts on.
    return c.json({ error: "Jira refused that request.", code: "jira" }, 502);
  }
  throw error;
}

/**
 * Whether a role may connect or disconnect.
 *
 * A member may hold several comma-separated roles — the organization plugin
 * splits on `,` when it checks permissions — so any one of them being high
 * enough is enough.
 */
function isAtLeastAdmin(role: string): boolean {
  return role
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "owner" || entry === "admin");
}

/**
 * Reduces a caller-supplied `returnTo` to a path within the web app.
 *
 * Anything absolute, protocol-relative or otherwise odd becomes the default.
 * This is the open-redirect guard: `returnTo` reaches us as a query parameter
 * on a route anyone signed in can call.
 */
function safePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/settings/jira";
  }
  // No scheme, no host, no backslash (which some browsers normalise to `/`).
  if (/[\\:]/.test(value)) {
    return "/settings/jira";
  }
  return value;
}

/**
 * Which of the scopes we asked for were not granted.
 *
 * Atlassian can return a subset, and the two Jira Software scopes are the ones
 * that go missing: they are granular scopes, absent from a console still
 * showing only the classic list. Without them the agile endpoints answer 404,
 * which reads like "no such board" rather than "missing scope" — so the UI is
 * told, rather than leaving it to be diagnosed later.
 */
function missingScopes(granted: readonly string[]): string[] {
  return READ_SCOPES.filter((scope) => !granted.includes(scope));
}
