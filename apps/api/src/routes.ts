import { sizeIfNeverSized } from "./pricing/start-run.js";
import type { AuthVariables } from "./http-context.js";
export type { AuthVariables } from "./http-context.js";
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
} from "@sandbox-factory/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ErrorHandler } from "hono";

import { NotFoundError, RepositoryInUseError } from "@sandbox-factory/db";
import type {
  EmailStore,
  OrganizationStore,
  UserProfileStore,
} from "@sandbox-factory/db";

import type { Auth } from "./auth.js";
import {
  mountAvatarReadRoute,
  mountOrganizationAvatarRoutes,
  mountUserAvatarRoutes,
} from "./avatars/routes.js";
import type { AvatarService } from "./avatars/service.js";
import {
  mountPricingRoutes,
  type PricingRouteOptions,
} from "./pricing/routes.js";
import { mountGithubRoutes, type GithubRouteOptions } from "./github/routes.js";
import {
  mountGithubWebhook,
  type GithubWebhookOptions,
} from "./github/webhook.js";
import { mountJiraRoutes, type JiraRouteOptions } from "./jira/routes.js";
import { mountBountyJiraRoutes } from "./bounties/jira.js";
import {
  mountBountyRoutes,
  mountCallerBountyRoutes,
} from "./bounties/routes.js";
import {
  mountAnalysisRoutes,
  type AnalysisRouteOptions,
} from "./analysis/routes.js";
import {
  mountSandboxRoutes,
  type SandboxRouteOptions,
} from "./sandbox/routes.js";

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
   * GitHub connection routes and the webhook. Optional for the same reasons
   * as `jira`: the GitHub App is a credential a deployment may not have, and
   * without it everything else is still served. The routes need
   * `organizations` for the membership guard; the webhook does not.
   */
  github?:
    | (Omit<GithubRouteOptions, "roleOf"> &
        Pick<
          GithubWebhookOptions,
          "webhookSecret" | "background" | "onBackgroundError" | "log"
        >)
    | undefined;
  /** Commercial routes. Rate-card reads remain mounted without model config. */
  pricing?: PricingRouteOptions | undefined;
  analysis?: AnalysisRouteOptions | undefined;
  /**
   * Sandbox versions: private provenance cut from slice runs. Needs the
   * same object storage and worker as analysis, so it is mounted only when
   * `analysis` is; without it the routes answer 503 behind the guard.
   */
  sandbox?: SandboxRouteOptions | undefined;
  /**
   * Uploaded avatars. Optional for the same reason as `jira`: without object
   * storage configured the upload routes are not mounted and answer 404,
   * which the web app reads as "uploads are off here", and everything else
   * is served as before.
   */
  avatars?: AvatarService | undefined;
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

/** Shared by the app, the error handler and the factory's return type. */
type AppEnv = { Variables: AuthVariables };

export function createApp({
  corsOrigins,
  auth,
  emails,
  profiles,
  organizations,
  jira,
  github,
  pricing,
  analysis,
  sandbox,
  avatars,
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
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
   * Avatar pictures, sessionless. Under `/api/` so every proxy in front of
   * the API forwards it unchanged, and outside `/api/v1` so the session
   * guard below does not apply. See `avatars/routes.ts` for why that is safe.
   */
  if (avatars !== undefined) {
    mountAvatarReadRoute(app, { avatars });
  }

  /**
   * GitHub's webhook deliveries. Outside `/api/v1`, because GitHub has no
   * session: a delivery is authenticated by its signature instead, checked
   * over the raw body before anything is parsed. See `github/webhook.ts`.
   */
  if (github !== undefined) {
    mountGithubWebhook(app, {
      ...github,
      snapshotter: github.snapshots?.snapshotter,
    });
  }

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

    if (avatars !== undefined) {
      mountUserAvatarRoutes(app, { avatars, auth, profiles });
    }
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
     * One organization by its public handle, for any signed-in reader.
     *
     * Behind the session guard every `/api/v1` route is, but deliberately
     * outside the membership guard and deliberately thin: two names and
     * nothing else. Mounted before `/:orgId` so the literal segment
     * wins over the parameter.
     */
    app.get("/api/v1/orgs/by-handle/:slug", async (c) => {
      const found = await organizations.findBySlug(c.req.param("slug"));
      if (found === undefined) {
        throw new NotFoundError(c.req.param("slug"));
      }
      // Spelled out so a field added to the summary — the picture, say —
      // does not reach signed-out readers without a decision to send it.
      return c.json({
        id: found.id,
        name: found.name,
        slug: found.slug,
        kind: found.kind,
      });
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
        // Every board a sync sees is sized once, through the same checks
        // the board's own run endpoint applies.
        ...(pricing === undefined || jira.startSizing !== undefined
          ? {}
          : {
              startSizing: (input: {
                organizationId: string;
                boardId: string;
                startedBy: string;
              }) => sizeIfNeverSized(pricing, input),
            }),
      });
    }
    /**
     * Connecting a client's GitHub, on the same terms as Jira above: the
     * connect, list and register routes sit behind the membership guard,
     * and the callback behind the session guard only, taking its
     * organization from the signed state.
     */
    if (github !== undefined) {
      if (analysis !== undefined) mountAnalysisRoutes(app, analysis);
      else
        app.all("/api/v1/orgs/:orgId/github/repositories/:id/runs", (c) =>
          c.json(
            { error: "Analysis needs object storage.", code: "unconfigured" },
            503,
          ),
        );
      mountGithubRoutes(app, {
        ...github,
        roleOf: (userId, organizationId) =>
          organizations.roleOf(userId, organizationId),
      });
    } else {
      /*
        Without the App, an explicit 503 rather than the 404 an unmounted
        route would give: the web app reads this code as "not set up here"
        and shows GitHub as unavailable, where a 404 would read as a failed
        load. Behind the membership guard, so a non-member still gets 404.
      */
      app.all("/api/v1/orgs/:orgId/github/*", (c) =>
        c.json(
          {
            error: "GitHub is not set up on this server.",
            code: "unconfigured",
          },
          503,
        ),
      );
    }
    if (pricing !== undefined) {
      mountPricingRoutes(app, pricing);
      // The organization's own bounties, which need nothing but the
      // database: written here, they are sized with no Jira at all.
      mountBountyRoutes(app, pricing);
      // Its Jira issue, picked for it from any of the workspace's boards.
      mountBountyJiraRoutes(app, pricing);
      mountCallerBountyRoutes(app, {
        bounties: pricing.bounties,
        organizationsOf: async (userId) =>
          (await organizations.listForUser(userId)).map(({ id }) => id),
      });
    }
    if (sandbox !== undefined) mountSandboxRoutes(app, sandbox);
    else
      app.all("/api/v1/orgs/:orgId/sandboxes/*", (c) =>
        c.json(
          {
            error: "Sandboxes need GitHub and object storage.",
            code: "unconfigured",
          },
          503,
        ),
      );

    /** A team's picture; behind the membership guard above. */
    if (avatars !== undefined) {
      mountOrganizationAvatarRoutes(app, { avatars, organizations });
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
  if (error instanceof RepositoryInUseError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  // Unexpected: log it, but do not leak internals to the caller.
  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
};

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}
