/**
 * HTTP routes, built by a factory that takes its dependencies so tests run
 * against fakes without binding a port or a database.
 *
 * Domain errors become status codes in one place, `errorHandler`. `auth` is
 * optional only for tests: without it every `/api/*` route answers 503, so
 * omitting it in `server.ts` cannot ship an open API.
 */

import {
  inviteMemberSchema,
  unknownBuildInfo,
  type BuildInfoDto,
  type OrganizationRole,
} from "@sandbox-factory/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ErrorHandler } from "hono";

import { NotFoundError } from "@sandbox-factory/db";
import type {
  EmailStore,
  OrganizationStore,
  UserProfileStore,
} from "@sandbox-factory/db";

import type { Auth } from "./auth.js";
import { mountJiraRoutes, type JiraRouteOptions } from "./jira/routes.js";

export interface AppOptions {
  corsOrigins: readonly string[];
  /** Omit only in tests. Without it no data route is mounted. */
  auth?: Auth | undefined;
  /**
   * Proven-email store. Optional so tests need no database; the email routes
   * are not mounted without it.
   */
  emails?: EmailStore | undefined;
  /** Username reads and writes. Optional for the same reason as `emails`. */
  profiles?: UserProfileStore | undefined;
  /**
   * Organization reads. Optional for the same reason as `emails`: without it
   * the organization routes are not mounted, so a test needs no database.
   */
  organizations?: OrganizationStore | undefined;
  /**
   * Jira connection routes. Optional for the same reason as `emails`, plus
   * one of its own: the second Atlassian app is a separate credential that a
   * deployment may not have, and its absence must not stop the API serving
   * everything else. Requires `organizations`, since the routes sit behind
   * that block's membership guard.
   */
  jira?: Omit<JiraRouteOptions, "roleOf"> | undefined;
  /**
   * Shared secret the CDN sends on every origin request. Set where the task is
   * internet-reachable with nothing upstream to filter (the CloudFront-to-
   * Fargate deploy in `infra/`): this header is all that separates a CDN
   * request from a stranger who resolved the origin. Undefined installs no
   * check.
   */
  originVerify?: string | undefined;

  /** The build record to report. Defaults to the unknown record. */
  buildInfo?: BuildInfoDto | undefined;
}

/** What the session middleware puts on the context for the routes behind it. */
export interface AuthVariables {
  user: { id: string; email: string; name: string };
  sessionId: string;
  /**
   * The caller's standing in the organization named by the path, set by
   * `requireMembership` on `/api/v1/orgs/:orgId/*`. Absent elsewhere.
   */
  member: { organizationId: string; role: string };
}

/**
 * Roles from least to most powerful, as the plugin defines them. Used only to
 * compare two roles; the plugin itself decides what each may do.
 */
const ROLE_RANK: Record<string, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

/**
 * Whether `held` is at least `required`.
 *
 * A member may hold several comma-separated roles — the plugin splits on `,`
 * when it checks permissions — so the strongest one counts. An unknown role
 * ranks lowest rather than throwing: a role added to the plugin's config but
 * not here must not silently pass a check.
 *
 * Exported for its tests. Nothing calls it yet: every route the membership
 * guard covers is readable by any member, and the plugin checks the role
 * itself on the writes that need one. It is here, and pinned, for the first
 * route that needs a floor — an untested comparison that grants access is
 * exactly the thing that should not be written under time pressure later.
 */
export function rankAtLeast(held: string, required: OrganizationRole): boolean {
  const strongest = held
    .split(",")
    .map((entry) => ROLE_RANK[entry.trim()] ?? -1)
    .reduce((best, rank) => Math.max(best, rank), -1);
  return strongest >= (ROLE_RANK[required] ?? 0);
}

/** Shared by the app, the error handler and the factory's return type. */
type AppEnv = { Variables: AuthVariables };

export function createApp({
  corsOrigins,
  auth,
  emails,
  profiles,
  organizations,
  jira,
  buildInfo = unknownBuildInfo,
  originVerify,
}: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Must stay first: a request that bypassed the CDN should cost one string
  // comparison and never reach CORS, auth or the database. `/health` is exempt
  // because container and uptime probes reach the task directly.
  if (originVerify !== undefined) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
      if (c.req.header("x-origin-verify") !== originVerify) {
        return c.json({ error: "Not found" }, 404);
      }
      return next();
    });
  }

  app.use(
    "/api/*",
    cors({
      // `credentials: true` lets the browser send the session cookie, and
      // browsers reject it with "*", so the origins are enumerated.
      origin: [...corsOrigins],
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Unauthenticated, for containers and uptime checks. Carries the version so
  // the same probe can watch a rollout.
  app.get("/health", (c) =>
    c.json({ status: "ok", version: buildInfo.version, sha: buildInfo.gitSha }),
  );

  /**
   * The build record, verbatim. Unauthenticated on purpose: the sha of a public
   * repository is not a secret, and the sign-in screen, deploy tooling and
   * provenance checks all read it without a session. `imageDigest` is the only
   * field not supplied by the build; see image-digest.ts.
   */
  app.get("/version", (c) => c.json(buildInfo));

  if (auth === undefined) {
    // No auth configured: serve health and version only. 503 rather than 404
    // says "this server is misconfigured", not "wrong URL".
    app.all("/api/*", (c) =>
      c.json({ error: "Authentication is not configured." }, 503),
    );
    app.notFound((c) => c.json({ error: "Not found." }, 404));
    app.onError(errorHandler);
    return app;
  }

  /**
   * Better Auth owns everything under /api/auth: provider redirects, OAuth
   * callbacks, session reads and sign-out.
   */
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  /**
   * Everything under /api/v1 requires a session. Resolving it from the headers
   * covers both the cookie (web) and the bearer token (extension).
   */
  app.use("/api/v1/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session === null) {
      return c.json({ error: "Authentication required." }, 401);
    }
    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    c.set("sessionId", session.session.id);
    await next();
    return;
  });

  /**
   * Who am I? `id` is the account: permanent, and what anything durable must
   * reference. `username` is the public handle: unique but renameable, so
   * never store it as a foreign key.
   */
  app.get("/api/v1/me", async (c) => {
    const user = c.get("user");
    const profile =
      profiles === undefined ? undefined : await profiles.get(user.id);
    return c.json({
      user: {
        ...user,
        username: profile?.username ?? null,
      },
    });
  });

  if (profiles !== undefined) {
    /** The handle, for the settings form to render. */
    app.get("/api/v1/me/username", async (c) => {
      const profile = await profiles.get(c.get("user").id);
      return c.json({ username: profile?.username ?? null });
    });

    /**
     * Changes the display name.
     *
     * Writes it in two places on purpose. `organization.name` on the caller's
     * personal organization is a copy of `user.name` taken at signup, and
     * nothing else edits it — so without the second write a rename would
     * leave that organization headed by the name the person just abandoned.
     * Only their own personal organization is touched; `renamePersonal`
     * matches on `personal_user_id`, so no team can be reached from here.
     *
     * The organization write is best-effort: the name itself is saved, and
     * failing the whole request over the copy would report a rename that in
     * fact happened.
     */
    app.put("/api/v1/me/name", async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        name?: unknown;
      } | null;
      if (typeof body?.name !== "string") {
        return c.json({ error: "Provide a name." }, 400);
      }

      const userId = c.get("user").id;
      const result = await profiles.setName(userId, body.name);
      if (result.status === "invalid") {
        return c.json({ error: result.reason }, 400);
      }

      if (organizations !== undefined) {
        try {
          await organizations.renamePersonal(userId, result.name);
        } catch (error) {
          console.error("Failed to rename the personal organization", error);
        }
      }

      return c.json({ name: result.name });
    });

    /**
     * Claims or changes the handle. A taken name is 409, not 400, so the form
     * can tell it from a malformed one.
     */
    app.put("/api/v1/me/username", async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        username?: unknown;
      } | null;
      if (typeof body?.username !== "string") {
        return c.json({ error: "Provide a username." }, 400);
      }

      const result = await profiles.setUsername(
        c.get("user").id,
        body.username,
      );
      if (result.status === "invalid") {
        return c.json({ error: result.reason }, 400);
      }
      if (result.status === "taken") {
        return c.json({ error: "That username is taken." }, 409);
      }
      return c.json({
        username: result.username,
        displayUsername: result.displayUsername,
      });
    });
  }

  if (emails !== undefined) {
    /** The caller's proven addresses, and which provider vouched for each. */
    app.get("/api/v1/me/emails", async (c) => {
      return c.json({ emails: await emails.list(c.get("user").id) });
    });

    /**
     * Promote an address to primary. This also changes the address Better Auth
     * reads, so the two cannot drift apart.
     */
    app.post("/api/v1/me/emails/:id/primary", async (c) => {
      const updated = await emails.setPrimary(
        c.get("user").id,
        c.req.param("id"),
      );
      if (updated === undefined) {
        // Another user's id is a 404, not a 403, which would confirm it exists.
        throw new NotFoundError(c.req.param("id"));
      }
      return c.json(updated);
    });

    app.delete("/api/v1/me/emails/:id", async (c) => {
      const result = await emails.remove(c.get("user").id, c.req.param("id"));
      if (result === "not-found") {
        throw new NotFoundError(c.req.param("id"));
      }
      if (result === "is-primary") {
        return c.json(
          {
            error:
              "Cannot remove the primary address. Make another one primary first.",
          },
          409,
        );
      }
      return c.body(null, 204);
    });
  }

  if (organizations !== undefined) {
    /**
     * The caller's organizations, with the role held in each. What the
     * sidebar switcher reads; a list, so it is its own call rather than a
     * field on `/api/v1/me`.
     */
    app.get("/api/v1/me/orgs", async (c) => {
      return c.json({
        organizations: await organizations.listForUser(c.get("user").id),
      });
    });

    /**
     * Invitations addressed to the caller, which is how someone joins an
     * organization: nothing is emailed, so this list is the delivery.
     *
     * Matched against the primary address only, because that is what Better
     * Auth compares on accept. An invitation sent to a proven secondary is
     * invisible until that address is made primary; the account page says so.
     */
    app.get("/api/v1/me/invitations", async (c) => {
      const pending = await organizations.pendingFor(c.get("user").email);
      return c.json({
        invitations: pending.map((entry) => ({
          ...entry,
          expiresAt: entry.expiresAt.toISOString(),
        })),
      });
    });

    /**
     * One organization by its public handle, for a signed-out reader.
     *
     * Deliberately outside the membership guard and deliberately thin: two
     * names and nothing else. Mounted before `/:orgId` so the literal segment
     * wins over the parameter.
     */
    app.get("/api/v1/orgs/by-handle/:slug", async (c) => {
      const found = await organizations.findBySlug(c.req.param("slug"));
      if (found === undefined) {
        throw new NotFoundError(c.req.param("slug"));
      }
      return c.json(found);
    });

    /**
     * Everything below is scoped to one organization, named in the path.
     *
     * The id comes from the URL, never from `session.activeOrganizationId`:
     * that is one value shared by every tab and by the extension's bearer
     * session, and the five-minute session cookie cache means a change in one
     * lags in another. A session says who is asking, not what they may read.
     *
     * A non-member gets 404, not 403, exactly as another user's row does:
     * 403 would confirm the organization exists.
     */
    app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
      const organizationId = c.req.param("orgId");
      const role = await organizations.roleOf(c.get("user").id, organizationId);
      if (role === undefined) {
        throw new NotFoundError(organizationId);
      }
      c.set("member", { organizationId, role });
      await next();
      return;
    });

    /** The organization, plus the caller's role in it. Members only. */
    app.get("/api/v1/orgs/:orgId", async (c) => {
      const { organizationId, role } = c.get("member");
      const found = await organizations.get(organizationId);
      if (found === undefined) {
        // Unreachable while the membership row exists, since `member`
        // cascades with its organization. Answering 404 rather than throwing
        // keeps a torn state from becoming a 500.
        throw new NotFoundError(organizationId);
      }
      return c.json({ organization: found, role });
    });

    /** Members, with the handle each person is known by. */
    app.get("/api/v1/orgs/:orgId/members", async (c) => {
      return c.json({
        members: await organizations.listMembers(
          c.get("member").organizationId,
        ),
      });
    });

    /**
     * Invite someone by handle or by address.
     *
     * By handle is the common case inside the product, and is resolved to
     * that user's primary address here because an invitation is addressed to
     * an email: the plugin matches it against the session's address on
     * accept. By address reaches someone with no account yet.
     *
     * The invitation itself is the plugin's to create, so the permission
     * check is its own: admins and owners may invite, members may not.
     */
    app.post("/api/v1/orgs/:orgId/invitations", async (c) => {
      const parsed = inviteMemberSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json({ error: firstIssue(parsed.error) }, 400);
      }

      let email = parsed.data.email;
      if (email === undefined) {
        const handle = parsed.data.handle ?? "";
        const invitee = await organizations.findUserByHandle(handle);
        if (invitee === undefined) {
          // The same 404 shape as any other unknown id.
          return c.json({ error: `Nobody holds the handle ${handle}.` }, 404);
        }
        email = invitee.email;
      }

      const created = await auth.api.createInvitation({
        body: {
          email,
          role: parsed.data.role,
          organizationId: c.get("member").organizationId,
        },
        headers: c.req.raw.headers,
      });
      return c.json({ invitation: created }, 201);
    });

    /**
     * Connecting a client's Jira site.
     *
     * Mounted inside this block because the connect, list and disconnect
     * routes sit under `/api/v1/orgs/:orgId/*` and so are covered by the
     * membership guard above. The callback is not — it has no organization id
     * in its path, by design — but it is still behind the session guard, and
     * `mountJiraRoutes` explains why that is the right boundary.
     *
     * Not mounted without `jira`, like every other optional dependency here:
     * an API with no second Atlassian app configured serves everything else
     * rather than refusing to start.
     */
    if (jira !== undefined) {
      mountJiraRoutes(app, {
        ...jira,
        // Supplied here rather than by the caller: the callback re-reads
        // membership, and this is the store that already answers that
        // question for the guard above.
        roleOf: (userId, organizationId) =>
          organizations.roleOf(userId, organizationId),
      });
    }
  }

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError(errorHandler);

  return app;
}

/**
 * Domain errors to status codes. Shared by the configured and unconfigured
 * apps so they cannot report the same failure differently.
 */
const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof NotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  // Unexpected: log it, but do not leak internals to the caller.
  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
};

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}
