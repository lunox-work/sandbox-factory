import { ApiError } from "@sandbox-factory/client";
import { useQuery } from "@tanstack/react-query";
import { rankAtLeast } from "sandbox-factory";
import { clients, queryKeys, useUserId } from "./data/query";
/**
 * The GitHub tab of an organization's settings: the accounts where the App
 * is installed and linked here, and the repositories registered from them.
 *
 * A registered repository is a pointer — its name and the commit its default
 * branch is at — never its contents, and the page says so where a person
 * decides to register one.
 *
 * Connecting is a round trip through GitHub, so the outcome banner comes
 * first, as on the Jira tab. One outcome asks something back: `pick`, when
 * the person can see the App on accounts but none is plainly the one to
 * link — several are theirs, or some are visible that are not — opens the
 * picker here, which says which is which.
 *
 * Roles come from the API, which checks them again on every write; hiding a
 * control the API would refuse is courtesy, not security.
 */

import type {
  GithubAvailableInstallationDto,
  GithubConnectionDto,
  GithubConnectOutcome,
  GithubRepoDto,
} from "@sandbox-factory/shared";
import {
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  FolderGit2,
  Link2,
  Loader2,
  Lock,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine, RetryableError } from "@/components/Message";
import { OutcomeNotice, type OutcomeTone } from "@/components/OutcomeNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

import { ProviderIcon } from "./ProviderIcon";
import { isPlainLeftClick, pathForScreen } from "./routes";
import {
  linkInstallation,
  useGithub,
  useGithubOutcome,
  useGithubRepos,
} from "./useGithub";

/** Roles that may connect, register and remove, matching the API's floor. */
function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

/**
 * Which control sent the browser to GitHub. Not a boolean: every control
 * waits, but only the one pressed says why.
 */
type Redirect = "connect" | "reconnect" | "install";

/**
 * What each outcome means, in the words the person needs. `place` is where
 * it is shown: a flow that could not be tied to a workspace lands on Home,
 * where there is no Connect button to point at.
 */
export function describeGithubOutcome(
  outcome: GithubConnectOutcome,
  place: "tab" | "home" = "tab",
): {
  tone: OutcomeTone;
  title: string;
  detail: string;
} {
  switch (outcome) {
    case "connected":
      return {
        tone: "ok",
        title: "GitHub connected",
        detail:
          "Register the repositories this workspace's bounties are about. Each is tracked by commit; its code is read only by the builders and sandboxes you run.",
      };
    case "pick":
      return {
        tone: "ok",
        title: "Choose an account",
        detail:
          "The App is installed on accounts you can see. Pick the one this workspace should use, or install it on one you manage.",
      };
    case "cancelled":
      return {
        tone: "warn",
        title: "Connection cancelled",
        detail: "Nothing was changed. You can try again whenever you like.",
      };
    case "claimed":
      return {
        tone: "warn",
        title: "Connected to another workspace",
        detail:
          "That account's installation already belongs to another workspace here, and nothing was changed. Its owner can disconnect it there first.",
      };
    case "not-authorized":
      return {
        tone: "error",
        title: "That account is not yours to connect",
        detail:
          "You can see the App there, but it is someone else\u2019s account, or it covers repositories you cannot read yourself. Nothing was connected. Ask whoever administers it to connect it, or install the App on an account you manage.",
      };
    case "unavailable":
      return {
        tone: "warn",
        title: "GitHub would not let us use that installation",
        detail:
          "It may be suspended. Nothing was connected. Unsuspend it in the installation\u2019s settings on GitHub, then connect again.",
      };
    case "not-visible":
      return {
        tone: "error",
        title: "That installation is not one you can see",
        detail:
          "GitHub did not list it for your account. Ask someone who administers it to connect it, or install the App on an account you manage.",
      };
    case "state":
      return {
        tone: "error",
        title: "That connection could not be verified",
        detail:
          place === "tab"
            ? "It may have expired, been started in another browser, or begun on GitHub's own page. Press Connect GitHub here to finish."
            : "It may have expired, been started in another browser, or begun on GitHub's own page. Open the workspace's settings, choose GitHub, and press Connect GitHub to finish.",
      };
    case "forbidden":
      return {
        tone: "error",
        title: "You are no longer allowed to connect GitHub",
        detail:
          "Your role in this workspace changed while you were on GitHub. Nothing was connected. Ask an owner or admin to do it.",
      };
    case "denied":
      return {
        tone: "error",
        title: "GitHub refused the authorization",
        detail:
          "The authorization could not be completed. Try connecting again.",
      };
    case "error":
      return {
        tone: "error",
        title: "Something went wrong",
        detail: "The connection did not complete. Try again.",
      };
  }
}

export function GithubConnections({
  organizationId,
  organizationSlug,
  role,
  onOpenRepository,
}: {
  organizationId: string;
  /** For the registered rows' links, which address the repository's page. */
  organizationSlug: string;
  role: string;
  /**
   * Opens a registered repository's page in the app. A plain click on a row
   * calls it; a modified click, or a row without it, follows the link.
   */
  onOpenRepository?: ((repo: GithubRepoDto) => void) | undefined;
}) {
  const {
    connections,
    loading,
    error,
    unconfigured,
    connect,
    disconnect,
    refresh,
    listed,
  } = useGithub(organizationId);
  const repos = useGithubRepos(organizationId);
  const { outcome, dismiss, announce } = useGithubOutcome();
  const manageable = canManage(role);
  // `pick` is a question, not just news: the picker asks it, in place of its
  // notice. Read from the outcome rather than copied into state by an effect,
  // so the notice never shows alone for a frame first.
  const picking = outcome === "pick" && manageable;
  const [redirecting, setRedirecting] = useState<Redirect | null>(null);

  // Back from GitHub can restore this page from the browser's cache exactly
  // as it was left: mid-redirect, every control waiting.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  /** Leaves for GitHub, saying so on the control that was pressed. */
  function redirect(control: Redirect) {
    setRedirecting(control);
    connect(control === "install" ? { install: true } : undefined);
  }

  const header = (
    <header>
      <h3 className="leading-none font-semibold">GitHub</h3>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Registered repositories are tracked by commit, with each commit&rsquo;s
        file list and package manifests, which name its stack. Code is read only
        when you run a context builder or build a sandbox from it.
      </p>
    </header>
  );

  if (unconfigured) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          GitHub is not set up on this server yet, so there is nothing to
          connect. Once it is, this workspace&rsquo;s accounts will be managed
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {header}

      {outcome !== null && !picking && (
        <OutcomeNotice
          {...describeGithubOutcome(outcome)}
          onDismiss={dismiss}
          testId="github-outcome"
        />
      )}

      {picking && (
        <InstallationPicker
          organizationId={organizationId}
          redirecting={redirecting}
          onConnect={() => redirect("reconnect")}
          onInstall={() => redirect("install")}
          onLinked={(connection) => {
            // Listed from the API's answer, in the same render the picker
            // gives way to the outcome: never "none connected" in between,
            // and no wait on reading the lists again, which follows.
            listed(connection);
            announce("connected");
            void Promise.all([refresh(), repos.refresh()]);
          }}
          onClose={dismiss}
        />
      )}

      {loading && connections.length === 0 ? (
        <LoadingLine />
      ) : error !== null && connections.length === 0 ? (
        <RetryableError onRetry={() => void refresh()}>{error}</RetryableError>
      ) : connections.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No GitHub accounts connected yet.
        </p>
      ) : (
        connections.map((connection) => (
          <InstallationCard
            key={connection.id}
            organizationId={organizationId}
            connection={connection}
            repos={repos.repos.filter(
              (repo) => repo.connectionId === connection.id,
            )}
            reposLoading={repos.loading}
            reposFailed={repos.error !== null}
            manageable={manageable}
            onUnhealthy={() => void refresh()}
            onRegister={(externalId) =>
              repos.register(connection.id, externalId)
            }
            onRemove={(repoId) => repos.remove(repoId)}
            repositoryHref={(repo) =>
              pathForScreen("org-repository", organizationSlug, repo.id)
            }
            onOpenRepo={onOpenRepository}
            onDisconnect={async () => {
              const result = await disconnect(connection.id);
              if (result.ok) await repos.refresh();
              return result.ok ? undefined : result.error;
            }}
          />
        ))
      )}

      {repos.error !== null && (
        <RetryableError onRetry={() => void repos.refresh()}>
          {repos.error}
        </RetryableError>
      )}

      {manageable ? (
        <div className="flex justify-end">
          <Button
            className="gap-2"
            disabled={redirecting !== null}
            onClick={() => redirect("connect")}
          >
            {redirecting === "connect" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Link2 className="size-4" />
            )}
            {redirecting === "connect"
              ? "Redirecting to GitHub…"
              : connections.length === 0
                ? "Connect GitHub"
                : "Connect another account"}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Only an owner or admin can connect GitHub.
        </p>
      )}
    </div>
  );
}

/**
 * The accounts the signed-in person can see the App on, each marked for this
 * workspace. Only a free one can be chosen; one linked elsewhere says so
 * without saying where.
 *
 * `onConnect` authorizes again, for a lapsed grant. `onInstall` goes to the
 * install page itself: connecting again would find the same list and bring
 * the person straight back here.
 */
function InstallationPicker({
  organizationId,
  redirecting,
  onConnect,
  onInstall,
  onLinked,
  onClose,
}: {
  organizationId: string;
  redirecting: Redirect | null;
  onConnect: () => void;
  onInstall: () => void;
  onLinked: (connection: GithubConnectionDto) => void;
  onClose: () => void;
}) {
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(userId, organizationId, "github-available"),
    queryFn: ({ signal }) => clients.github.available(organizationId, signal),
  });
  const state =
    query.data !== undefined
      ? {
          status: "ready" as const,
          login: query.data.grant.githubLogin,
          installations: query.data.installations,
        }
      : query.isError
        ? {
            status: "error" as const,
            error:
              query.error instanceof ApiError
                ? query.error.message
                : "Could not reach the server.",
            code:
              query.error instanceof ApiError
                ? (query.error.code ?? undefined)
                : undefined,
          }
        : { status: "loading" as const };
  const [linking, setLinking] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<{
    error: string;
    code?: string;
  } | null>(null);

  async function choose(installationId: string) {
    setLinking(installationId);
    setLinkError(null);
    const result = await linkInstallation(organizationId, installationId);
    if (result.ok) {
      // The spinner stays to the end: the picker goes with this call.
      onLinked(result.value);
      return;
    }
    setLinking(null);
    setLinkError({
      error: result.error,
      ...(result.code === undefined ? {} : { code: result.code }),
    });
  }

  /** The person's own authorization lapsed: only a fresh round trip helps. */
  const reconnect = (
    <Button
      size="sm"
      className="gap-2 self-start"
      disabled={redirecting !== null}
      onClick={onConnect}
    >
      {redirecting === "reconnect" ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Link2 className="size-4" />
      )}
      {redirecting === "reconnect"
        ? "Redirecting to GitHub…"
        : "Connect GitHub again"}
    </Button>
  );

  /**
   * The way to GitHub's install page, inside a sentence. Pending, it keeps
   * its words and gains a spinner at their end, so the sentence does not
   * reflow under the pointer.
   */
  const install = (label: string) => (
    <button
      type="button"
      className="underline underline-offset-2 disabled:opacity-70"
      disabled={redirecting !== null || linking !== null}
      onClick={onInstall}
    >
      {redirecting === "install" && (
        <span className="sr-only">Opening GitHub: </span>
      )}
      {label}
      {redirecting === "install" && (
        <Loader2
          className="ml-1.5 inline size-3.5 animate-spin align-[-2px]"
          aria-hidden="true"
        />
      )}
    </button>
  );

  return (
    <section
      aria-labelledby="github-picker-heading"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 id="github-picker-heading" className="text-sm font-medium">
            Choose an account
          </h4>
          {/* One line for both, so the heading does not move when GitHub
              answers: only the list grows beneath it. */}
          {state.status === "loading" ? (
            <LoadingLine className="mt-1">
              Asking GitHub where the App is installed…
            </LoadingLine>
          ) : state.status === "ready" ? (
            <p className="text-muted-foreground mt-1 text-sm">
              Where the App is installed and @{state.login} can see it.
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {state.status === "loading" ? null : state.status === "error" ? (
        <>
          <ErrorBanner className="mt-0">{state.error}</ErrorBanner>
          {state.code === "reconnect" && reconnect}
        </>
      ) : state.installations.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          The App is not installed on any account you can see.{" "}
          {install("Install it")}.
        </p>
      ) : (
        <ul className="divide-y">
          {state.installations.map((installation) => (
            <li
              key={installation.installationId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {installation.accountLogin}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {installation.accountType === "Organization"
                    ? "Organization"
                    : "Personal account"}
                  {" · "}
                  {installation.repositorySelection === "all"
                    ? "all repositories"
                    : "selected repositories"}
                </span>
              </span>
              {installation.status === "free" ? (
                <Button
                  size="sm"
                  disabled={linking !== null || redirecting !== null}
                  onClick={() => void choose(installation.installationId)}
                >
                  {linking === installation.installationId && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Connect
                </Button>
              ) : (
                <Badge
                  variant={
                    installation.status === "linked" ? "secondary" : "outline"
                  }
                  title={PICKER_HINTS[installation.status]}
                >
                  {PICKER_LABELS[installation.status]}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" &&
        state.installations.length > 0 &&
        !state.installations.some((entry) => entry.status === "free") && (
          <p className="text-muted-foreground text-sm">
            None of these can be connected here.{" "}
            {install("Install the App on an account you manage")}.
          </p>
        )}
      {linkError !== null && (
        <>
          <ErrorBanner className="mt-0">{linkError.error}</ErrorBanner>
          {linkError.code === "reconnect" && reconnect}
        </>
      )}
    </section>
  );
}

/** What a picker row says when it cannot be chosen, and why on hover. */
const PICKER_LABELS: Record<
  Exclude<GithubAvailableInstallationDto["status"], "free">,
  string
> = {
  linked: "Connected here",
  claimed: "Another workspace",
  "not-authorized": "Not yours to connect",
  unavailable: "Unavailable",
};

const PICKER_HINTS: Record<
  Exclude<GithubAvailableInstallationDto["status"], "free">,
  string
> = {
  linked: "Already connected to this workspace.",
  claimed: "Connected to another workspace.",
  "not-authorized":
    "Someone else's account, or it covers repositories you cannot read yourself.",
  unavailable: "GitHub would not let us check it. It may be suspended.",
};

/** Why GitHub no longer lets us use a connection, and what fixes it. */
function unhealthyCopy(connection: GithubConnectionDto): {
  badge: string;
  detail: string;
} {
  if (connection.uninstalledAt !== null) {
    return {
      badge: "Uninstalled",
      detail: `The App was uninstalled from ${connection.accountLogin}. Reinstall it there and connect again; its repositories stay listed until then.`,
    };
  }
  if (connection.suspendedAt !== null) {
    return {
      badge: "Suspended",
      detail: `The App is suspended on ${connection.accountLogin}. Unsuspend it in the installation's settings on GitHub; this clears within a few minutes of that.`,
    };
  }
  return {
    badge: "Needs attention",
    detail:
      "GitHub refused our last request for this installation. We check again every few minutes, and connecting again clears it too.",
  };
}

/** One linked account: its state, its menu, and its registered repositories. */
function InstallationCard({
  organizationId,
  connection,
  repos,
  reposLoading,
  reposFailed,
  manageable,
  onUnhealthy,
  onRegister,
  onRemove,
  repositoryHref,
  onOpenRepo,
  onDisconnect,
}: {
  organizationId: string;
  connection: GithubConnectionDto;
  repos: GithubRepoDto[];
  /** The registered list is still loading, or failed; see `RegisteredRepos`. */
  reposLoading: boolean;
  reposFailed: boolean;
  manageable: boolean;
  /** GitHub turned the installation down mid-use; re-read the connections. */
  onUnhealthy: () => void;
  onRegister: (
    externalId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
  onRemove: (
    repoId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Where a repository's page is, for its row's link. */
  repositoryHref: (repo: GithubRepoDto) => string;
  onOpenRepo: ((repo: GithubRepoDto) => void) | undefined;
  /** Resolves to an error to show in the question, or nothing on success. */
  onDisconnect: () => Promise<string | undefined>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [managing, setManaging] = useState(false);
  const unhealthy = connection.healthy ? null : unhealthyCopy(connection);

  return (
    <Card className="gap-4 rounded-lg py-4 shadow-none sm:gap-4 sm:py-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 px-4 sm:px-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 size-5 shrink-0">
            <ProviderIcon provider="github" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <span className="truncate">{connection.accountLogin}</span>
              {unhealthy !== null && (
                <Badge variant="destructive" className="gap-1">
                  <TriangleAlert className="size-3" />
                  {unhealthy.badge}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              <a
                href={connection.settingsUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex max-w-full items-center gap-1 align-bottom hover:underline"
              >
                <span className="truncate">
                  {connection.settingsUrl.replace(
                    /\/settings\/installations\/\d+$/,
                    "",
                  )}
                </span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            </CardDescription>
          </div>
        </div>

        {manageable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="-my-1 -mr-2 shrink-0"
                aria-label={`${connection.accountLogin} options`}
              >
                <EllipsisVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {connection.healthy && (
                <>
                  <DropdownMenuItem onSelect={() => setManaging(true)}>
                    <FolderGit2 />
                    Manage repositories
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                variant="destructive"
                disabled={disconnecting}
                onSelect={() => setConfirming(true)}
              >
                <Trash2 />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {manageable && (
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Disconnect ${connection.accountLogin}?`}
            description={
              <>
                Removes this account and every repository registered from it,
                with everything recorded from them here: snapshots, analysis
                runs and their artifacts. Bounties linked to them lose the link,
                and none of it can be recovered. The App stays installed on
                GitHub until you uninstall it from{" "}
                <a
                  href={connection.settingsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  the installation&rsquo;s settings
                </a>
                .
              </>
            }
            confirmLabel="Disconnect"
            busy={disconnecting}
            onConfirm={async () => {
              setDisconnecting(true);
              try {
                return await onDisconnect();
              } finally {
                setDisconnecting(false);
              }
            }}
          />
        )}
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-col gap-4 px-4 sm:px-4">
        {unhealthy !== null && <p className="text-sm">{unhealthy.detail}</p>}

        <RegisteredRepos
          repos={repos}
          loading={reposLoading}
          failed={reposFailed}
          href={repositoryHref}
          onOpen={onOpenRepo}
          onManage={
            manageable && connection.healthy
              ? () => setManaging(true)
              : undefined
          }
        />

        {manageable && connection.healthy && managing && (
          <RepositoryDialog
            organizationId={organizationId}
            connection={connection}
            registered={repos}
            registeredLoading={reposLoading}
            onRegister={onRegister}
            onRemove={onRemove}
            onUnhealthy={() => {
              setManaging(false);
              onUnhealthy();
            }}
            onClose={() => setManaging(false)}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The registered repositories, each a way into the repository's own page. */
function RegisteredRepos({
  repos,
  loading,
  failed,
  href,
  onOpen,
  onManage,
}: {
  repos: GithubRepoDto[];
  loading: boolean;
  /** The read failed; the page says so once, above, for every card. */
  failed: boolean;
  href: (repo: GithubRepoDto) => string;
  onOpen: ((repo: GithubRepoDto) => void) | undefined;
  /** Opens the repositories dialog; absent where nobody here can register. */
  onManage: (() => void) | undefined;
}) {
  // Never "none registered" before the list is known: that is a zero
  // nobody counted.
  if (repos.length === 0 && loading) return <LoadingLine />;
  if (repos.length === 0 && failed) return null;
  // With none registered, the way to register one is the next step, not a
  // menu away.
  if (repos.length === 0 && onManage !== undefined) {
    return <ManageRepositoriesButton onClick={onManage} />;
  }
  if (repos.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No repositories registered from this account yet.
      </p>
    );
  }

  return (
    <ul aria-label="Registered repositories" className="-mx-3 flex flex-col">
      {repos.map((repo) => (
        <li key={repo.id}>
          {/*
            A link, as a board's row is: the page has an address of its
            own, so a modified click opens it in a new tab and a plain one
            stays in the app.
          */}
          <a
            href={href(repo)}
            className="focus-visible:ring-ring/50 hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
            onClick={(event) => {
              if (onOpen !== undefined && isPlainLeftClick(event)) {
                event.preventDefault();
                onOpen(repo);
              }
            }}
          >
            <span className="text-muted-foreground size-4 shrink-0">
              <FolderGit2 className="size-full" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {repo.fullName}
            </span>
            {repo.isPrivate && (
              <Lock
                className="text-muted-foreground size-3 shrink-0"
                aria-label="Private"
              />
            )}
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Opens an account's repositories dialog, where none is registered yet. */
export function ManageRepositoriesButton({
  onClick,
  label = "Manage repositories",
}: {
  onClick: () => void;
  /** The accessible name, where one page offers it for several accounts. */
  label?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit gap-1.5"
      aria-label={label}
      onClick={onClick}
    >
      <FolderGit2 className="size-4" />
      Manage repositories
    </Button>
  );
}

/**
 * What removing a repository destroys, said wherever it can be removed. The
 * delete cascades: every snapshot, analysis run and artifact read from it
 * goes with the row, and nothing keeps a copy.
 */
export const REMOVE_REPOSITORY_WARNING =
  "This deletes everything recorded from it here: its snapshots, its analysis runs and every artifact they produced. Bounties linked to it lose the link. None of it can be recovered. Nothing changes on GitHub, and registering it again starts from nothing.";

/** Both of the dialog's lists share one row, so their names line up. */
const DIALOG_ROW = "flex h-10 shrink-0 items-center gap-3";

function RepositoryName({
  fullName,
  isPrivate,
}: {
  fullName: string;
  isPrivate: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 text-sm">
      <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate">{fullName}</span>
      {isPrivate && (
        <Lock
          className="text-muted-foreground -ml-1.5 size-3 shrink-0"
          aria-label="Private"
        />
      )}
    </span>
  );
}

/**
 * One account's repositories in one place: those registered from it, each
 * removable, and a search over the rest of what the installation can see,
 * live from GitHub, to register more. Each change is made as it is pressed;
 * Done only closes.
 */
export function RepositoryDialog({
  organizationId,
  connection,
  registered,
  registeredLoading,
  onRegister,
  onRemove,
  onUnhealthy,
  onClose,
}: {
  organizationId: string;
  connection: GithubConnectionDto;
  /** The repositories registered from this account. */
  registered: GithubRepoDto[];
  registeredLoading: boolean;
  onRegister: (
    externalId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
  onRemove: (
    repoId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * The API answered `unhealthy`: GitHub turned the installation down and
   * the API has flagged it, so the card's own state is now stale.
   */
  onUnhealthy: () => void;
  onClose: () => void;
}) {
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "github-installation-repositories",
      connection.id,
    ),
    queryFn: ({ signal }) =>
      clients.github.installationRepositories(
        organizationId,
        connection.id,
        signal,
      ),
  });
  const [search, setSearch] = useState("");
  const [registering, setRegistering] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GithubRepoDto | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Read through a ref: the card passes a fresh function on every render,
  // and an effect depending on it would run on every render too.
  const unhealthyRef = useRef(onUnhealthy);
  useEffect(() => {
    unhealthyRef.current = onUnhealthy;
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.code === "unhealthy")
      unhealthyRef.current();
  }, [query.error]);

  // Registered is read from the list beside it, not only from the listing's
  // `registeredId`, so a repository moves across the moment it is added.
  const registeredIds = new Set(registered.map((repo) => repo.externalId));
  const needle = search.trim().toLowerCase();
  const addable = (query.data ?? []).filter(
    (repository) =>
      repository.registeredId === null &&
      !registeredIds.has(repository.externalId),
  );
  const matches = addable.filter((repository) =>
    repository.fullName.toLowerCase().includes(needle),
  );

  async function register(externalId: string) {
    setRegistering(externalId);
    setRegisterError(null);
    const result = await onRegister(externalId);
    setRegistering(null);
    if (result.ok) {
      await query.refetch();
    } else if (result.code === "unhealthy") {
      unhealthyRef.current();
    } else {
      setRegisterError(result.error);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-5 sm:max-w-lg"
        // The search, not the first remove button, is where a person starts.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        // Escape clears a search before it closes the dialog.
        onEscapeKeyDown={(event) => {
          if (search !== "") {
            event.preventDefault();
            setSearch("");
          }
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Repositories on {connection.accountLogin}</DialogTitle>
          <DialogDescription>
            Registering records the repository, where its default branch points
            and that commit&rsquo;s file list. Code is read only by the builders
            and sandboxes you run.
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="github-registered-heading"
          className="flex min-h-0 shrink-0 flex-col gap-2"
        >
          <h4
            id="github-registered-heading"
            className="text-muted-foreground text-xs font-medium"
          >
            Registered{registered.length > 0 && ` · ${registered.length}`}
          </h4>
          {registered.length === 0 && registeredLoading ? (
            <LoadingLine />
          ) : registered.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              None yet. Find one below to register it.
            </p>
          ) : (
            <ul
              aria-label={`Registered from ${connection.accountLogin}`}
              // Room for the remove buttons pulled out to the edge below, so a
              // scrolling list does not also scroll sideways.
              className="-mr-2 flex max-h-44 flex-col overflow-y-auto pr-2"
            >
              {registered.map((repo) => (
                <li key={repo.id} className={DIALOG_ROW}>
                  <RepositoryName
                    fullName={repo.fullName}
                    isPrivate={repo.isPrivate}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    // The glyph, not its invisible hit area, meets the
                    // column's edge, as the Register buttons' borders do.
                    className="text-muted-foreground hover:text-destructive -mr-2 size-8 shrink-0"
                    aria-label={`Remove ${repo.fullName}`}
                    onClick={() => setRemoving(repo)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Separator />

        <section
          aria-labelledby="github-add-heading"
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <h4
            id="github-add-heading"
            className="text-muted-foreground text-xs font-medium"
          >
            Add a repository
          </h4>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              ref={searchRef}
              type="search"
              aria-label={`Search repositories on ${connection.accountLogin}`}
              placeholder="Search by name"
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {query.data === undefined && !query.isError ? (
            <LoadingLine />
          ) : query.isError ? (
            <ErrorBanner className="mt-0">
              {query.error instanceof ApiError
                ? query.error.message
                : "Could not reach the server."}
            </ErrorBanner>
          ) : (query.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              The App cannot see any repositories on this account. Choose some
              in{" "}
              <a
                href={connection.settingsUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                the installation&rsquo;s settings
              </a>{" "}
              on GitHub.
            </p>
          ) : addable.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Every repository the App can see here is registered.
            </p>
          ) : matches.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No repository matches &ldquo;{search.trim()}&rdquo;.
            </p>
          ) : (
            <ul
              aria-label="Repositories to register"
              className="flex min-h-0 flex-col overflow-y-auto"
            >
              {matches.map((repository) => (
                <li key={repository.externalId} className={DIALOG_ROW}>
                  <RepositoryName
                    fullName={repository.fullName}
                    isPrivate={repository.isPrivate}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    disabled={registering !== null}
                    aria-label={`Register ${repository.fullName}`}
                    onClick={() => void register(repository.externalId)}
                  >
                    {registering === repository.externalId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Register
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {registerError !== null && (
            <ErrorBanner className="mt-0">{registerError}</ErrorBanner>
          )}
        </section>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>

        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove ${removing?.fullName ?? "this repository"}?`}
          description={REMOVE_REPOSITORY_WARNING}
          confirmLabel="Remove"
          onConfirm={async () => {
            if (removing === null) return undefined;
            const result = await onRemove(removing.id);
            if (!result.ok) return result.error;
            // It can be registered again, so the listing has to say so.
            await query.refetch();
            return undefined;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
