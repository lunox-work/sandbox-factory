import { isAtLeastAdmin } from "../access.js";
/**
 * Connecting a client's GitHub: the App's connect flow, the installations it
 * links, and the repositories registered from them.
 *
 * One GitHub App, used two ways. Its **user-to-server** half is what the
 * connect flow runs on: the person authorizes the App, and their token lists
 * the installations they can see. Its **installation tokens** do everything
 * else. The sign-in GitHub OAuth app is a different app and plays no part.
 *
 *   GET  .../github/connect         membership checked HERE, then to GitHub
 *   GET  /api/v1/github/callback    signed state proves that check still applies
 *
 * **The callback's `installation_id` is untrusted.** Installation ids are
 * small integers anyone can type, and the signed state proves only that the
 * person started *a* flow for their own organization. So an installation is
 * linked only when it appears in `GET /user/installations` for the token the
 * callback has just been granted — whether its id came from the query or
 * from the picker. That is why the user half is not optional here.
 *
 * **Appearing there is not enough.** That list holds every installation
 * covering a repository the person can reach, so it is checked again for
 * authority before anything is linked: see `authority.ts`.
 *
 * **An installation is never re-homed.** One linked to another organization
 * answers `claimed` and nothing is written; unlinking it is that
 * organization's owner's job.
 *
 * **The flow starts at the OAuth authorize URL, not the install page.** The
 * install page returns to the callback only for a fresh install; for an
 * account where the App is already installed it shows GitHub's settings
 * page instead — exactly the situation after a connection is deleted, or when
 * a second of our organizations wants the same installation. The authorize
 * URL always comes back with `state`, and the callback decides from the
 * person's installation list, sending them to the install page only when
 * there is nothing to link.
 */

import type {
  GithubConnectionStore,
  GithubConnectionSummary,
  GithubGrantStore,
  GithubRepoStore,
  GithubRepoSummary,
  RepoSnapshotStore,
  RepoSnapshotSummary,
  StoredRepoSnapshot,
} from "@sandbox-factory/db";
import {
  authorizeUrl,
  exchangeCode,
  GithubApiError,
  GithubAuthError,
  GithubClient,
  GithubInstallationUnavailable,
  GithubOAuthError,
  GithubRateLimited,
  type InstallationTokens,
} from "@sandbox-factory/github";
import {
  type GithubAvailableInstallationDto,
  type GithubConnectionDto,
  type GithubConnectOutcome,
  type GithubInstallationRepositoryDto,
  type GithubInstallationResponse,
  githubInstallationSettingsUrl,
  type GithubRepoDto,
  linkInstallationRequestSchema,
  registerRepoRequestSchema,
  type RepoSnapshotDetailDto,
  type RepoSnapshotDto,
  type RepoTreePageDto,
  repoTreeQuerySchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";

import {
  redirectTarget,
  safePath,
  signState,
  verifyState,
} from "../connect-state.js";
import { type Authority, authorityOver, type Person } from "./authority.js";
import {
  installationClient,
  noteGrantFailure,
  userClientFor,
} from "./credential.js";
import type { GithubSnapshotter } from "./snapshot.js";
import { repoMetadata, syncRepo } from "./sync.js";

/** What the routes need. Supplied by `createApp`, faked in tests. */
export interface GithubRouteOptions {
  connections: GithubConnectionStore;
  grants: GithubGrantStore;
  repos: GithubRepoStore;
  /** The App's installation-token cache, shared with the webhook and sweep. */
  installations: InstallationTokens;
  /**
   * Repository snapshots, when object storage is configured to hold their
   * trees. Absent, none are taken and the snapshot routes answer 503.
   */
  snapshots?:
    | {
        readonly store: RepoSnapshotStore;
        readonly snapshotter: GithubSnapshotter;
      }
    | undefined;
  /** The caller's current role, re-read in the callback. */
  roleOf: (
    userId: string,
    organizationId: string,
  ) => Promise<string | undefined>;
  /** Builds `github.com/apps/<slug>/installations/new`. */
  appSlug: string;
  /** The App's own OAuth half; not the sign-in pair. */
  clientId: string;
  clientSecret: string;
  /** Signs the `state`. `BETTER_AUTH_SECRET`. */
  secret: string;
  /** Public origin of the API, for the callback URL. */
  apiUrl: string;
  /** Public origin of the web app, where the browser is sent afterwards. */
  appUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** What these routes need on the context; see `JiraAppEnv` for why generic. */
export interface GithubAppEnv {
  Variables: {
    user: { id: string; email: string; name: string };
    member: { organizationId: string; role: string };
  };
}

/** Where a flow returns when nothing better is known. */
const DEFAULT_RETURN = "/";

export function mountGithubRoutes<Env extends GithubAppEnv>(
  app: Hono<Env>,
  options: GithubRouteOptions,
): void {
  const {
    connections,
    grants,
    repos,
    installations,
    snapshots,
    roleOf,
    appSlug,
    clientId,
    clientSecret,
    secret,
    apiUrl,
    appUrl,
    fetch: fetchImpl,
    now,
  } = options;

  const redirectUri = `${new URL(apiUrl).origin}/api/v1/github/callback`;
  const userClientOptions = {
    grants,
    clientId,
    clientSecret,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(now === undefined ? {} : { now }),
  };
  const back = (path: string, outcome: GithubConnectOutcome) =>
    redirectTarget(appUrl, path, { github: outcome });

  /** A state for this flow, signed for this person and organization. */
  function stateFor(organizationId: string, userId: string, returnTo: string) {
    return signState(secret, "github", {
      organizationId,
      userId,
      returnTo,
      ...(now === undefined ? {} : { issuedAt: now() }),
    });
  }

  /**
   * Links one of the installations the person was shown by GitHub.
   * `claimed` when another organization holds it, which the store decides
   * in the same statement that would have written it.
   */
  async function link(
    organizationId: string,
    installation: GithubInstallationResponse,
  ) {
    return connections.link(organizationId, {
      installationId: String(installation.id),
      accountLogin: installation.account?.login ?? String(installation.id),
      accountType: installation.account?.type ?? "User",
      repositorySelection: installation.repository_selection ?? "selected",
      permissions: installation.permissions ?? {},
      suspendedAt: installation.suspended_at ?? null,
    });
  }

  /** Whether this person may link that installation; see `authority.ts`. */
  function authority(
    person: Person,
    installation: GithubInstallationResponse,
  ): Promise<Authority> {
    return authorityOver(person, installation, installations, fetchImpl);
  }

  /**
   * Start the flow. Owners and admins only: a connection lets the platform
   * read a client's repositories for as long as it lives.
   */
  app.get("/api/v1/orgs/:orgId/github/connect", (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may connect GitHub." },
        403,
      );
    }
    const returnTo = safePath(c.req.query("returnTo") ?? "", DEFAULT_RETURN);
    return c.redirect(
      authorizeUrl({
        clientId,
        redirectUri,
        state: stateFor(organizationId, c.get("user").id, returnTo),
      }),
    );
  });

  /**
   * GitHub sends the browser back here: from the authorize URL with `code`
   * and `state`, and from the install or settings page with
   * `installation_id` and `setup_action` too.
   *
   * Outside the membership guard — no organization id in the path, because
   * one from the query could be swapped — but behind the session guard, and
   * the state must name the session it arrived on.
   */
  app.get("/api/v1/github/callback", async (c) => {
    const userId = c.get("user").id;
    const verified = verifyState(
      secret,
      "github",
      c.req.query("state"),
      userId,
      now?.(),
    );
    const returnTo = verified.ok ? verified.state.returnTo : DEFAULT_RETURN;

    const denied = c.req.query("error");
    if (denied !== undefined) {
      return c.redirect(
        back(returnTo, denied === "access_denied" ? "cancelled" : "error"),
      );
    }
    if (!verified.ok) {
      // Also the landing for an install begun on GitHub's own App page:
      // nothing here started it, so there is no organization to give it to.
      // Pressing Connect then finds it in the person's list.
      return c.redirect(back(DEFAULT_RETURN, "state"));
    }
    const { organizationId } = verified.state;

    // Re-read, not inferred from the state: a person can be demoted inside
    // the ten minutes the state lives. Before the exchange, so a code that
    // cannot be used is never spent.
    const role = await roleOf(userId, organizationId);
    if (role === undefined || !isAtLeastAdmin(role)) {
      return c.redirect(back(returnTo, "forbidden"));
    }

    const code = c.req.query("code");
    if (code === undefined || code === "") {
      return c.redirect(back(returnTo, "error"));
    }

    try {
      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
        ...(now === undefined ? {} : { now }),
      });
      // The fresh token, used directly: it was minted a moment ago, and the
      // grant written below is what later requests read.
      const client = new GithubClient({
        token: () => Promise.resolve(tokens.accessToken),
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      });
      const me = await client.user();
      await grants.upsert(organizationId, userId, {
        githubLogin: me.login,
        githubUserId: String(me.id),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
      });

      const person: Person = { client, githubUserId: String(me.id) };
      const listed = await client.userInstallations();
      const owners = await connections.owners(
        listed.map((installation) => String(installation.id)),
      );

      const named = c.req.query("installation_id");
      if (named !== undefined && named !== "") {
        const installation = listed.find(
          (candidate) => String(candidate.id) === named,
        );
        if (installation === undefined) {
          return c.redirect(back(returnTo, "not-visible"));
        }
        const owner = owners.get(named);
        if (owner !== undefined && owner !== organizationId) {
          return c.redirect(back(returnTo, "claimed"));
        }
        // Asked again even when it is linked here already: re-linking
        // refreshes the selection, which `setup_action=update` comes back to
        // do, and a refresh is a link like any other.
        const verdict = await authority(person, installation);
        if (verdict !== "yours") {
          return c.redirect(
            back(
              returnTo,
              verdict === "not-yours" ? "not-authorized" : "unavailable",
            ),
          );
        }
        const result = await link(organizationId, installation);
        return c.redirect(
          back(returnTo, result.status === "linked" ? "connected" : "claimed"),
        );
      }

      const free = listed.filter(
        (installation) => !owners.has(String(installation.id)),
      );
      // Linked without a choice only when exactly one is theirs. Two found
      // is enough to know the picker is needed, so the checks stop there.
      const linkable: GithubInstallationResponse[] = [];
      for (const installation of free) {
        if ((await authority(person, installation)) === "yours") {
          linkable.push(installation);
          if (linkable.length > 1) break;
        }
      }
      const only = linkable.length === 1 ? linkable[0] : undefined;
      if (only !== undefined) {
        const result = await link(organizationId, only);
        return c.redirect(
          back(returnTo, result.status === "linked" ? "connected" : "claimed"),
        );
      }
      // Several to choose from, or some visible that are not theirs: the
      // picker says which is which, and offers the install page as well.
      if (free.length > 0) {
        return c.redirect(back(returnTo, "pick"));
      }

      // Nothing to link: install the App somewhere. A fresh state, because
      // GitHub returns from the install page with a new `code` and this
      // callback runs again from the top.
      const install = new URL(
        `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
      );
      install.searchParams.set(
        "state",
        stateFor(organizationId, userId, returnTo),
      );
      return c.redirect(install.toString());
    } catch (error) {
      if (error instanceof GithubOAuthError) {
        // GitHub not answering is not GitHub refusing the person.
        return c.redirect(
          back(returnTo, error.unanswered ? "error" : "denied"),
        );
      }
      if (error instanceof GithubApiError) {
        return c.redirect(back(returnTo, "error"));
      }
      throw error;
    }
  });

  /**
   * The installations the signed-in person can see, each marked for this
   * organization. What the picker shows after `?github=pick`.
   */
  app.get("/api/v1/orgs/:orgId/github/connections/available", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may connect GitHub." },
        403,
      );
    }
    const listed = await listForPerson(c, organizationId);
    if (listed instanceof Response) return listed;

    const owners = await connections.owners(
      listed.installations.map((installation) => String(installation.id)),
    );
    let installationsDto: GithubAvailableInstallationDto[];
    try {
      installationsDto = await Promise.all(
        listed.installations.map(async (installation) => {
          const id = String(installation.id);
          const owner = owners.get(id);
          return {
            installationId: id,
            accountLogin: installation.account?.login ?? id,
            accountType: installation.account?.type ?? "User",
            repositorySelection:
              installation.repository_selection ?? "selected",
            status:
              owner === organizationId
                ? "linked"
                : owner !== undefined
                  ? "claimed"
                  : await freeStatus(listed.person, installation),
          };
        }),
      );
    } catch (error) {
      return githubFailure(c, error);
    }
    return c.json({
      grant: { githubLogin: listed.githubLogin, healthy: true },
      installations: installationsDto,
    });
  });

  /**
   * Link one installation from the picker. Only one this person can see,
   * read again from GitHub here — never the id as the body states it.
   */
  app.post("/api/v1/orgs/:orgId/github/connections", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may connect GitHub." },
        403,
      );
    }
    const parsed = linkInstallationRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Name an installation." }, 400);
    }

    const listed = await listForPerson(c, organizationId);
    if (listed instanceof Response) return listed;
    const installation = listed.installations.find(
      (candidate) => String(candidate.id) === parsed.data.installationId,
    );
    if (installation === undefined) {
      return c.json({ error: "Not found" }, 404);
    }
    let verdict: Authority;
    try {
      verdict = await authority(listed.person, installation);
    } catch (error) {
      return githubFailure(c, error);
    }
    if (verdict === "not-yours") {
      return c.json(
        {
          error:
            "That installation covers repositories you cannot read yourself, " +
            "or an account that is not yours.",
          code: "not-authorized",
        },
        403,
      );
    }
    if (verdict === "unavailable") {
      return c.json(
        {
          error:
            "GitHub will not let us use that installation. It may be suspended.",
          code: "unavailable",
        },
        409,
      );
    }
    const result = await link(organizationId, installation);
    if (result.status === "claimed") {
      return c.json(
        {
          error: "That installation is connected to another workspace.",
          code: "claimed",
        },
        409,
      );
    }
    return c.json({ connection: toConnectionDto(result.connection) }, 201);
  });

  /** The organization's linked installations. */
  app.get("/api/v1/orgs/:orgId/github/connections", async (c) => {
    const listed = await connections.list(c.get("member").organizationId);
    return c.json({ connections: listed.map(toConnectionDto) });
  });

  /**
   * Unlink an installation. Its repositories go with it. The App stays
   * installed on GitHub until the client removes it there; the UI says so
   * and links to the settings page.
   */
  app.delete("/api/v1/orgs/:orgId/github/connections/:id", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may disconnect GitHub." },
        403,
      );
    }
    const result =
      snapshots === undefined
        ? {
            removed: await connections.remove(
              organizationId,
              c.req.param("id"),
            ),
            treeKeys: [],
          }
        : await connections.removeWithTrees(organizationId, c.req.param("id"));
    const { removed } = result;
    if (!removed) return c.json({ error: "Not found" }, 404);
    await snapshots?.snapshotter.removeObjects(
      "objectKeys" in result
        ? (result.objectKeys ?? result.treeKeys)
        : result.treeKeys,
    );
    return c.body(null, 204);
  });

  /**
   * The repositories an installation can see, live from GitHub, each marked
   * with whether it is registered. Not stored: the client changes the
   * selection on GitHub without telling us, and the picker is where it
   * matters.
   */
  app.get(
    "/api/v1/orgs/:orgId/github/connections/:id/repositories",
    async (c) => {
      const { organizationId } = c.get("member");
      const connection = await connections.get(
        organizationId,
        c.req.param("id"),
      );
      if (connection === null) return c.json({ error: "Not found" }, 404);
      if (!connection.healthy) return unhealthy(c);

      try {
        const { repositories } = await installationClient(
          installations,
          connection.installationId,
          { kind: "discovery" },
          fetchImpl,
        ).installationRepositories();
        const registered = new Map(
          (await repos.list(organizationId))
            .filter((repo) => repo.connectionId === connection.id)
            .map((repo) => [repo.externalId, repo.id]),
        );
        const listed: GithubInstallationRepositoryDto[] = repositories
          .map((repository) => {
            const metadata = repoMetadata(repository);
            return {
              externalId: String(repository.id),
              fullName: metadata.fullName,
              defaultBranch: metadata.defaultBranch,
              isPrivate: metadata.isPrivate,
              registeredId: registered.get(String(repository.id)) ?? null,
            };
          })
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        return c.json({ repositories: listed });
      } catch (error) {
        return installationFailure(c, organizationId, connection, error);
      }
    },
  );

  /**
   * Register a repository. Only one the installation can see — checked
   * against the installation's own listing, so a public repository outside
   * it cannot be registered by id. The head is read before answering, so a
   * new row comes back `ok` with a commit; its snapshot follows in the
   * background, since a large tree takes longer than a click should.
   */
  app.post(
    "/api/v1/orgs/:orgId/github/connections/:id/repositories",
    async (c) => {
      const { organizationId, role } = c.get("member");
      if (!isAtLeastAdmin(role)) {
        return c.json(
          { error: "Only an owner or admin may register a repository." },
          403,
        );
      }
      const parsed = registerRepoRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json({ error: "Name a repository and its role." }, 400);
      }
      const connection = await connections.get(
        organizationId,
        c.req.param("id"),
      );
      if (connection === null) return c.json({ error: "Not found" }, 404);
      if (!connection.healthy) return unhealthy(c);

      try {
        const { repositories } = await installationClient(
          installations,
          connection.installationId,
          { kind: "discovery" },
          fetchImpl,
        ).installationRepositories();
        const repository = repositories.find(
          (candidate) => String(candidate.id) === parsed.data.externalId,
        );
        if (repository === undefined) {
          return c.json({ error: "Not found" }, 404);
        }
        const registered = await repos.register(organizationId, {
          ...repoMetadata(repository),
          connectionId: connection.id,
          externalId: String(repository.id),
          role: parsed.data.role,
        });
        const outcome = await syncRepo(
          repos,
          installationClient(
            installations,
            connection.installationId,
            { kind: "repository", repositoryId: registered.externalId },
            fetchImpl,
          ),
          {
            organizationId,
            repoId: registered.id,
            externalId: registered.externalId,
            headEtag: null,
          },
          repository,
        );
        if (outcome === "ok" || outcome === "unchanged") {
          snapshots?.snapshotter.schedule({
            organizationId,
            repoId: registered.id,
            installationId: connection.installationId,
          });
        }
        return c.json(
          {
            repository: repoDto(
              (await repos.get(organizationId, registered.id)) ?? registered,
            ),
          },
          201,
        );
      } catch (error) {
        return installationFailure(c, organizationId, connection, error);
      }
    },
  );

  /** The organization's registered repositories, with where each stands. */
  app.get("/api/v1/orgs/:orgId/github/repositories", async (c) => {
    return c.json({
      repositories: (await repos.list(c.get("member").organizationId)).map(
        repoDto,
      ),
    });
  });

  app.delete("/api/v1/orgs/:orgId/github/repositories/:id", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may remove a repository." },
        403,
      );
    }
    const repoId = c.req.param("id");
    if (repos.removeWithObjects !== undefined) {
      const result = await repos.removeWithObjects(organizationId, repoId);
      if (!result.removed) return c.json({ error: "Not found" }, 404);
      await snapshots?.snapshotter.removeObjects(result.objectKeys);
      return c.body(null, 204);
    }
    // Read before the cascade takes the rows, so the trees can go too.
    const trees =
      snapshots === undefined
        ? []
        : (
            await snapshots.store.list(organizationId, repoId, REMOVE_TREES_MAX)
          ).map(({ treeKey }) => treeKey);
    const removed = await repos.remove(organizationId, repoId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    await snapshots?.snapshotter.removeObjects(trees);
    return c.body(null, 204);
  });

  /**
   * A repository's snapshots, newest first. Any member may read them, as
   * they may read the repository list: paths and counts, never contents.
   */
  app.get(
    "/api/v1/orgs/:orgId/github/repositories/:id/snapshots",
    async (c) => {
      if (snapshots === undefined) return snapshotsUnconfigured(c);
      const { organizationId } = c.get("member");
      const repoId = c.req.param("id");
      if ((await repos.get(organizationId, repoId)) === null) {
        return c.json({ error: "Not found" }, 404);
      }
      const listed = await snapshots.store.list(
        organizationId,
        repoId,
        SNAPSHOT_LIST_MAX,
      );
      return c.json({ snapshots: listed.map(toSnapshotDto) });
    },
  );

  /** One snapshot with its facts. */
  app.get("/api/v1/orgs/:orgId/github/snapshots/:id", async (c) => {
    if (snapshots === undefined) return snapshotsUnconfigured(c);
    const found = await snapshots.store.get(
      c.get("member").organizationId,
      c.req.param("id"),
    );
    if (found === null) return c.json({ error: "Not found" }, 404);
    return c.json({ snapshot: toSnapshotDetailDto(found) });
  });

  /**
   * A snapshot's file list, a page at a time, in path order: optionally
   * only under one directory, resuming after the last path of the previous
   * page. Read from the bucket, not from GitHub, so it describes the
   * snapshot's commit whatever the branch has done since.
   */
  app.get("/api/v1/orgs/:orgId/github/snapshots/:id/tree", async (c) => {
    if (snapshots === undefined) return snapshotsUnconfigured(c);
    const query = repoTreeQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: "Invalid prefix, cursor or limit." }, 400);
    }
    const found = await snapshots.store.get(
      c.get("member").organizationId,
      c.req.param("id"),
    );
    if (found === null) return c.json({ error: "Not found" }, 404);
    const tree = await snapshots.snapshotter.tree(found.treeKey);
    if (tree === null) {
      return c.json(
        {
          error: "The file list for this snapshot could not be read.",
          code: "tree_unavailable",
        },
        502,
      );
    }
    return c.json(treePage(tree.entries, tree.truncated, query.data));
  });

  /**
   * The installations the signed-in person can see, through their stored
   * grant, or the response that explains why not.
   */
  async function listForPerson(
    c: Context<Env>,
    organizationId: string,
  ): Promise<
    | {
        githubLogin: string;
        person: Person;
        installations: GithubInstallationResponse[];
      }
    | Response
  > {
    const userId = c.get("user").id;
    const result = await userClientFor(
      userClientOptions,
      organizationId,
      userId,
    );
    if (!result.ok) {
      return c.json(
        {
          error:
            result.reason === "missing"
              ? "Connect GitHub first, so we can see your installations."
              : "Your GitHub authorization has lapsed. Connect GitHub again.",
          code: "reconnect",
        },
        409,
      );
    }
    try {
      return {
        githubLogin: result.grant.githubLogin,
        person: {
          client: result.client,
          githubUserId: result.grant.githubUserId,
        },
        installations: await result.client.userInstallations(),
      };
    } catch (error) {
      const finished = await noteGrantFailure(
        grants,
        {
          organizationId,
          userId,
          credentialRevision: result.grant.credentialRevision,
        },
        error,
      );
      if (finished) {
        return c.json(
          {
            error:
              "Your GitHub authorization has lapsed. Connect GitHub again.",
            code: "reconnect",
          },
          409,
        );
      }
      return githubFailure(c, error);
    }
  }

  /** What a free installation is to this person, for the picker. */
  async function freeStatus(
    person: Person,
    installation: GithubInstallationResponse,
  ): Promise<GithubAvailableInstallationDto["status"]> {
    const verdict = await authority(person, installation);
    return verdict === "yours"
      ? "free"
      : verdict === "not-yours"
        ? "not-authorized"
        : "unavailable";
  }

  /**
   * A failed call on an installation's token. GitHub refusing to mint one,
   * or refusing one it minted, means the installation is gone or suspended
   * on its side — which the webhook normally says first; flagged here in
   * case that delivery did not arrive.
   */
  async function installationFailure(
    c: Context<Env>,
    organizationId: string,
    connection: GithubConnectionSummary,
    error: unknown,
  ): Promise<Response> {
    if (
      error instanceof GithubInstallationUnavailable ||
      (error instanceof GithubAuthError && error.status === 401)
    ) {
      installations.forget(connection.installationId);
      await connections.update(organizationId, connection.id, {
        healthy: false,
      });
      return unhealthy(c);
    }
    return githubFailure(c, error);
  }
}

/** The most snapshots one listing returns. */
const SNAPSHOT_LIST_MAX = 50;
/**
 * The most snapshots whose trees go when a repository is removed. Past it
 * the rest are left in the bucket, which costs storage and nothing else.
 */
const REMOVE_TREES_MAX = 1_000;

function snapshotsUnconfigured(c: Context): Response {
  return c.json(
    {
      error:
        "Repository snapshots need object storage, which is not set up here.",
      code: "unconfigured",
    },
    503,
  );
}

/**
 * One page of a stored tree. Entries are stored in path order, so a page is
 * the entries under `prefix` that sort after `cursor`, up to `limit`.
 */
export function treePage(
  entries: readonly RepoTreePageDto["entries"][number][],
  truncated: boolean,
  query: {
    prefix?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): RepoTreePageDto {
  const prefix = (query.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const cursor = query.cursor;
  const page: RepoTreePageDto["entries"] = [];
  let more = false;
  for (const entry of entries) {
    if (
      prefix !== "" &&
      entry.path !== prefix &&
      !entry.path.startsWith(`${prefix}/`)
    ) {
      continue;
    }
    if (cursor !== undefined && entry.path <= cursor) continue;
    if (page.length === query.limit) {
      more = true;
      break;
    }
    page.push(entry);
  }
  return {
    entries: page,
    nextCursor: more ? (page.at(-1)?.path ?? null) : null,
    truncated,
  };
}

/** The wire shape: the bucket key left out. */
export function toSnapshotDto(snapshot: RepoSnapshotSummary): RepoSnapshotDto {
  return {
    id: snapshot.id,
    repoId: snapshot.repoId,
    commitSha: snapshot.commitSha,
    ref: snapshot.ref,
    treeSha: snapshot.treeSha,
    treeTruncated: snapshot.treeTruncated,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    languages: { ...snapshot.languages },
    createdAt: snapshot.createdAt,
  };
}

function toSnapshotDetailDto(
  snapshot: StoredRepoSnapshot,
): RepoSnapshotDetailDto {
  return {
    ...toSnapshotDto(snapshot),
    repoFullName: snapshot.repoFullName,
    // The same shape; core's is merely the read-only spelling of it.
    facts: snapshot.facts as RepoSnapshotDetailDto["facts"],
  };
}

function unhealthy(c: Context): Response {
  return c.json(
    {
      error:
        "GitHub no longer lets us use this installation. It may have been uninstalled or suspended.",
      code: "unhealthy",
    },
    409,
  );
}

/** GitHub's refusals as responses; anything else is ours, and rethrown. */
function githubFailure(c: Context, error: unknown): Response {
  if (error instanceof GithubRateLimited) {
    const seconds = Math.max(
      1,
      Math.ceil((error.resetAt.getTime() - Date.now()) / 1000),
    );
    c.header("Retry-After", String(seconds));
    return c.json(
      {
        error: "GitHub is rate limiting us. Try again shortly.",
        code: "rate_limited",
      },
      429,
    );
  }
  if (error instanceof GithubApiError) {
    return c.json(
      { error: "GitHub refused that request.", code: "github" },
      502,
    );
  }
  throw error;
}

/** The wire shape: the settings link added, permissions left out. */
export function toConnectionDto(
  connection: GithubConnectionSummary,
): GithubConnectionDto {
  return {
    id: connection.id,
    installationId: connection.installationId,
    accountLogin: connection.accountLogin,
    accountType: connection.accountType,
    repositorySelection: connection.repositorySelection,
    healthy: connection.healthy,
    suspendedAt: connection.suspendedAt,
    uninstalledAt: connection.uninstalledAt,
    settingsUrl: githubInstallationSettingsUrl(
      connection.accountType,
      connection.accountLogin,
      connection.installationId,
    ),
    createdAt: connection.createdAt,
  };
}

/**
 * A repository as the wire carries it. Which commit and detection version
 * its stack came from is the snapshotter's business, not the page's.
 */
function repoDto(repo: GithubRepoSummary): GithubRepoDto {
  const { stackCommitSha: _commit, stackVersion: _version, ...dto } = repo;
  return { ...dto, stack: repo.stack === null ? null : [...repo.stack] };
}
