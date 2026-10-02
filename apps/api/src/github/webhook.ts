/**
 * GitHub's webhook deliveries: how a pointer moves within seconds of a push.
 *
 * `POST /api/github/webhook`, outside the session guard — GitHub has no
 * session — and outside `/api/v1`. What authenticates a delivery is its
 * signature, checked over the **raw bytes** before anything is parsed: a
 * body re-serialised from parsed JSON would not reproduce GitHub's bytes,
 * and parsing an unauthenticated body is work a stranger should not be able
 * to make us do. A bad signature is 401 and touches nothing.
 *
 * **A delivery is applied before it is answered.** GitHub does not retry a
 * failed delivery on its own, and records any 2xx as delivered, so work
 * deferred past the answer and then lost is lost for good: a `suspend` or a
 * selection change the sweep never repairs. The database writes are quick,
 * so they run first and a failure answers 500, which GitHub shows as failed
 * and lets someone redeliver. Only the one handler that needs a round trip
 * to GitHub of its own — re-reading a head after the default branch changed
 * — runs that part after the answer, since GitHub times a delivery out at
 * ten seconds; the sweep re-reads it anyway if that is lost.
 *
 * Every handler is idempotent — a redelivery sets the same values again — so
 * there is no delivery table.
 *
 * The installation a delivery names is what says whose it is. The signature
 * has proved GitHub sent it; an installation we have not linked is logged
 * and dropped.
 */

import type {
  GithubConnectionStore,
  GithubRepoStore,
} from "@sandbox-factory/db";
import {
  type InstallationTokens,
  verifySignature,
} from "@sandbox-factory/github";
import {
  GITHUB_WEBHOOK_HEADERS,
  githubInstallationEventSchema,
  githubInstallationRepositoriesEventSchema,
  githubPushEventSchema,
  githubRepositoryEventSchema,
  githubTimestamp,
  githubWebhookEnvelopeSchema,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { installationClient } from "./credential.js";
import type { GithubSnapshotter } from "./snapshot.js";
import { syncRepo } from "./sync.js";

export interface GithubWebhookOptions {
  connections: GithubConnectionStore;
  repos: GithubRepoStore;
  installations: InstallationTokens;
  /**
   * Asked for a snapshot when a push moves a head or a new default branch
   * is read. It queues the work, so the answer is not held for it.
   */
  snapshotter?: Pick<GithubSnapshotter, "schedule"> | undefined;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * Runs the part of a delivery left until after the answer: the head
   * re-read after a default-branch change. Defaults to fire-and-forget with
   * failures reported through `onBackgroundError`; tests pass one that
   * collects the promise so they can await it.
   */
  background?: (work: Promise<unknown>) => void;
  /** A delivery that failed, before or after the answer. */
  onBackgroundError?: (code: string, error: unknown) => void;
  /** Informational lines, such as a delivery for an unknown installation. */
  log?: (message: string) => void;
}

/** What handling a delivery did. For tests and logs; GitHub sees only 202. */
export type WebhookOutcome = "applied" | "ignored" | "unknown-installation";

/** A deleted ref's `after`: forty zeros, never a commit. */
const ZERO_SHA = /^0+$/;

/**
 * GitHub's own cap on a delivery. Read in full before the signature can be
 * checked, on the one unauthenticated POST that buffers its body, so a
 * stranger's is refused at the cap rather than read to the end.
 */
const MAX_DELIVERY_BYTES = 25 * 1024 * 1024;

function reportFailure(options: GithubWebhookOptions) {
  return options.onBackgroundError ?? ((code: string) => console.error(code));
}

/** `options.background`, or fire-and-forget that reports what fails. */
function backgroundOf(options: GithubWebhookOptions) {
  return (
    options.background ??
    ((work: Promise<unknown>) => {
      void work.catch((error: unknown) =>
        reportFailure(options)("github_webhook_failed", error),
      );
    })
  );
}

export function mountGithubWebhook<Env extends object>(
  app: Hono<Env>,
  options: GithubWebhookOptions,
): void {
  const limit = bodyLimit({
    maxSize: MAX_DELIVERY_BYTES,
    onError: (c) => c.json({ error: "Delivery too large." }, 413),
  });

  app.post("/api/github/webhook", limit, async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (
      !verifySignature(
        options.webhookSecret,
        raw,
        c.req.header(GITHUB_WEBHOOK_HEADERS.signature),
      )
    ) {
      return c.json({ error: "Invalid signature." }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return c.json({ error: "Expected a JSON body." }, 400);
    }

    const event = c.req.header(GITHUB_WEBHOOK_HEADERS.event) ?? "";
    try {
      await handleGithubEvent(options, event, payload);
    } catch (error) {
      // A 5xx is what makes GitHub show the delivery as failed, and offer
      // to redeliver it; a 2xx would record it as done.
      reportFailure(options)("github_webhook_failed", error);
      return c.json({ error: "Could not apply the delivery." }, 500);
    }
    return c.body(null, 202);
  });
}

/**
 * Applies one delivery. Exported so each handler is testable against a
 * recorded payload without the signature in the way.
 */
export async function handleGithubEvent(
  options: GithubWebhookOptions,
  event: string,
  payload: unknown,
): Promise<WebhookOutcome> {
  const envelope = githubWebhookEnvelopeSchema.safeParse(payload);
  const installationId = envelope.success
    ? envelope.data.installation?.id
    : undefined;
  // `ping` on creation, and anything not from an installation, is nothing
  // to act on.
  if (installationId === undefined) return "ignored";

  const owner = await options.connections.ownerOf(String(installationId));
  if (owner === null) {
    (options.log ?? console.info)(
      `github_webhook_unknown_installation event=${event} installation=${installationId}`,
    );
    return "unknown-installation";
  }

  const known: Owner = { ...owner, installationId: String(installationId) };
  switch (event) {
    case "installation":
      return onInstallation(options, known, payload);
    case "installation_repositories":
      return onInstallationRepositories(options, known, payload);
    case "push":
      return onPush(options, known, payload);
    case "repository":
      return onRepository(options, known, payload);
    default:
      return "ignored";
  }
}

interface Owner {
  readonly organizationId: string;
  readonly connectionId: string;
  /** The delivery's, which `ownerOf` has just tied to this connection. */
  readonly installationId: string;
}

/**
 * The App uninstalled, suspended, unsuspended, or granted new permissions.
 *
 * Uninstalling keeps the rows: the connection turns unhealthy and its
 * repositories `gone`, so the UI can say what happened to things the
 * organization recognises. Reinstalling and connecting again brings a new
 * installation id, which links as a new connection.
 */
async function onInstallation(
  options: GithubWebhookOptions,
  { organizationId, connectionId }: Owner,
  payload: unknown,
): Promise<WebhookOutcome> {
  const parsed = githubInstallationEventSchema.safeParse(payload);
  if (!parsed.success) return "ignored";
  const { action, installation } = parsed.data;
  const installationId = String(installation.id);

  switch (action) {
    case "deleted":
      options.installations.forget(installationId);
      await options.connections.update(organizationId, connectionId, {
        healthy: false,
        uninstalledAt: new Date((options.now ?? Date.now)()).toISOString(),
      });
      await options.repos.markGoneForConnection(organizationId, connectionId);
      return "applied";
    case "suspend":
      options.installations.forget(installationId);
      await options.connections.update(organizationId, connectionId, {
        healthy: false,
        suspendedAt:
          installation.suspended_at ??
          new Date((options.now ?? Date.now)()).toISOString(),
      });
      return "applied";
    case "unsuspend":
      await options.connections.update(organizationId, connectionId, {
        healthy: true,
        suspendedAt: null,
      });
      return "applied";
    case "new_permissions_accepted":
      // Tokens minted before carry the old permissions; drop them.
      options.installations.forget(installationId);
      await options.connections.update(organizationId, connectionId, {
        permissions: installation.permissions ?? {},
      });
      return "applied";
    default:
      return "ignored";
  }
}

/**
 * Repositories added to or removed from the installation on GitHub's side.
 *
 * Both carry `repository_selection`, which is stored: a client can flip
 * between "all" and "selected" here without ever visiting our callback. A
 * removed repository that was registered goes `gone`; one re-added comes
 * back `pending` and the sweep reads it again.
 */
async function onInstallationRepositories(
  options: GithubWebhookOptions,
  { organizationId, connectionId }: Owner,
  payload: unknown,
): Promise<WebhookOutcome> {
  const parsed = githubInstallationRepositoriesEventSchema.safeParse(payload);
  if (!parsed.success) return "ignored";
  const event = parsed.data;

  if (event.repository_selection !== undefined) {
    await options.connections.update(organizationId, connectionId, {
      repositorySelection: event.repository_selection,
    });
  }

  const registered = async (stubs: readonly { id: number }[] | undefined) => {
    const ids: string[] = [];
    for (const stub of stubs ?? []) {
      const repo = await options.repos.findByExternalId(
        organizationId,
        connectionId,
        String(stub.id),
      );
      if (repo !== null) ids.push(repo.id);
    }
    return ids;
  };
  await options.repos.markGone(
    organizationId,
    await registered(event.repositories_removed),
  );
  await options.repos.revive(
    organizationId,
    await registered(event.repositories_added),
  );
  return "applied";
}

/**
 * A push. Only one to the default branch moves the pointer, and never one
 * that deleted the ref: its `after` is all zeros, which is not a commit.
 * Other branches and tags are not what a registered repository tracks.
 */
async function onPush(
  options: GithubWebhookOptions,
  { organizationId, connectionId, installationId }: Owner,
  payload: unknown,
): Promise<WebhookOutcome> {
  const parsed = githubPushEventSchema.safeParse(payload);
  if (!parsed.success) return "ignored";
  const push = parsed.data;
  const defaultBranch = push.repository.default_branch;
  if (
    defaultBranch === undefined ||
    push.ref !== `refs/heads/${defaultBranch}` ||
    push.deleted === true ||
    ZERO_SHA.test(push.after)
  ) {
    return "ignored";
  }

  const repo = await options.repos.findByExternalId(
    organizationId,
    connectionId,
    String(push.repository.id),
  );
  if (repo === null) return "ignored";

  // A default-branch change whose `repository` delivery went missing is
  // caught here, since the push names the branch it is on.
  if (repo.defaultBranch !== defaultBranch) {
    await options.repos.update(organizationId, repo.id, { defaultBranch });
  }
  const moved = await options.repos.setHead(organizationId, repo.id, {
    headSha: push.after,
    pushedAt: githubTimestamp(push.repository.pushed_at),
  });
  // Not for a late delivery the head refused, nor for a gone repository.
  if (moved) {
    options.snapshotter?.schedule({
      organizationId,
      repoId: repo.id,
      installationId,
    });
  }
  return "applied";
}

/**
 * A repository renamed, transferred, deleted, made private or public, or
 * given a new default branch.
 *
 * A new default branch also re-reads the head through an installation
 * token: the next push lands on the new branch, and there may not be one for
 * a while, so the head would otherwise describe a branch nobody tracks.
 */
async function onRepository(
  options: GithubWebhookOptions,
  { organizationId, connectionId }: Owner,
  payload: unknown,
): Promise<WebhookOutcome> {
  const parsed = githubRepositoryEventSchema.safeParse(payload);
  if (!parsed.success) return "ignored";
  const { action, repository, changes } = parsed.data;

  const repo = await options.repos.findByExternalId(
    organizationId,
    connectionId,
    String(repository.id),
  );
  if (repo === null) return "ignored";

  switch (action) {
    case "renamed":
    case "transferred":
      await options.repos.update(organizationId, repo.id, {
        fullName: repository.full_name,
      });
      return "applied";
    case "deleted":
      await options.repos.markGone(organizationId, [repo.id]);
      return "applied";
    case "privatized":
    case "publicized":
      await options.repos.update(organizationId, repo.id, {
        isPrivate: action === "privatized",
      });
      return "applied";
    case "edited": {
      const branch = repository.default_branch;
      if (changes?.default_branch === undefined || branch === undefined) {
        return "ignored";
      }
      await options.repos.update(organizationId, repo.id, {
        defaultBranch: branch,
      });
      const connection = await options.connections.get(
        organizationId,
        connectionId,
      );
      if (connection === null) return "applied";
      // After the answer: a round trip to GitHub could outlast its timeout.
      backgroundOf(options)(
        syncRepo(
          options.repos,
          installationClient(
            options.installations,
            connection.installationId,
            { kind: "repository", repositoryId: repo.externalId },
            options.fetch,
          ),
          {
            organizationId,
            repoId: repo.id,
            externalId: repo.externalId,
            // The ETag described the old branch's ref.
            headEtag: null,
          },
          // The delivery carries the whole repository; no need to read it.
          repository,
        ).then((outcome) => {
          if (outcome === "ok" || outcome === "unchanged") {
            options.snapshotter?.schedule({
              organizationId,
              repoId: repo.id,
              installationId: connection.installationId,
            });
          }
        }),
      );
      return "applied";
    }
    default:
      return "ignored";
  }
}
