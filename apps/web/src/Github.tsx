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
  ArrowLeft,
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  FolderGit2,
  Link2,
  Loader2,
  Lock,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

import { ProviderIcon } from "./ProviderIcon";
import { RepositoryAnalysis } from "./RepositoryAnalysis";
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
          "Register the repositories this workspace's tickets are about. We track where each default branch points, never what is in it.",
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
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const {
    connections,
    loading,
    error,
    unconfigured,
    connect,
    disconnect,
    refresh,
  } = useGithub(organizationId);
  const repos = useGithubRepos(organizationId);
  const { outcome, dismiss } = useGithubOutcome();
  const [picking, setPicking] = useState(false);
  const [openRepoId, setOpenRepoId] = useState<string | null>(null);
  const manageable = canManage(role);
  const openRepo = repos.repos.find((repo) => repo.id === openRepoId);

  // `pick` is a question, not just news: open the picker for it.
  useEffect(() => {
    if (outcome === "pick") setPicking(true);
  }, [outcome]);

  const header = (
    <header>
      <h3 className="leading-none font-semibold">GitHub</h3>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Registered repositories are tracked by commit. Their contents are never
        stored.
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

  if (openRepo !== undefined) {
    return (
      <RepositoryPage
        organizationId={organizationId}
        repo={openRepo}
        manageable={manageable}
        onBack={() => setOpenRepoId(null)}
        onRemove={(repoId) => repos.remove(repoId)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {header}

      {outcome !== null && (
        <OutcomeNotice
          {...describeGithubOutcome(outcome)}
          onDismiss={dismiss}
          testId="github-outcome"
        />
      )}

      {picking && manageable && (
        <InstallationPicker
          organizationId={organizationId}
          onConnect={connect}
          onLinked={async () => {
            // The question is answered: its notice goes with the picker.
            setPicking(false);
            dismiss();
            await Promise.all([refresh(), repos.refresh()]);
          }}
          onClose={() => {
            setPicking(false);
            dismiss();
          }}
        />
      )}

      {loading && connections.length === 0 ? (
        <LoadingLine />
      ) : error !== null && connections.length === 0 ? (
        <ErrorBanner className="mt-0">{error}</ErrorBanner>
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
            onOpenRepo={(repo) => setOpenRepoId(repo.id)}
            onDisconnect={async () => {
              const result = await disconnect(connection.id);
              if (result.ok) await repos.refresh();
              return result.ok ? undefined : result.error;
            }}
          />
        ))
      )}

      {repos.error !== null && (
        <ErrorBanner className="mt-0">{repos.error}</ErrorBanner>
      )}

      {manageable ? (
        <div className="flex justify-end">
          <Button className="gap-2" onClick={() => connect()}>
            <Link2 className="size-4" />
            {connections.length === 0
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
 */
function InstallationPicker({
  organizationId,
  onConnect,
  onLinked,
  onClose,
}: {
  organizationId: string;
  onConnect: () => void;
  onLinked: () => Promise<void>;
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
    setLinking(null);
    if (result.ok) {
      await onLinked();
    } else {
      setLinkError({
        error: result.error,
        ...(result.code === undefined ? {} : { code: result.code }),
      });
    }
  }

  /** The person's own authorization lapsed: only a fresh round trip helps. */
  const reconnect = (
    <Button size="sm" className="gap-2 self-start" onClick={onConnect}>
      <Link2 className="size-4" />
      Connect GitHub again
    </Button>
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
          {state.status === "ready" && (
            <p className="text-muted-foreground mt-1 text-sm">
              Where the App is installed and @{state.login} can see it.
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {state.status === "loading" ? (
        <LoadingLine />
      ) : state.status === "error" ? (
        <>
          <ErrorBanner className="mt-0">{state.error}</ErrorBanner>
          {state.code === "reconnect" && reconnect}
        </>
      ) : state.installations.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          The App is not installed on any account you can see.{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={onConnect}
          >
            Install it
          </button>
          .
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
                  disabled={linking !== null}
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
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={onConnect}
            >
              Install the App on an account you manage
            </button>
            .
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
  onOpenRepo: (repo: GithubRepoDto) => void;
  /** Resolves to an error to show in the question, or nothing on success. */
  onDisconnect: () => Promise<string | undefined>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [adding, setAdding] = useState(false);
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
                  <DropdownMenuItem onSelect={() => setAdding(true)}>
                    <Plus />
                    Add a repository
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
                Removes this account and every repository registered from it.
                The App stays installed on GitHub until you uninstall it from{" "}
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
          onOpen={onOpenRepo}
        />

        {manageable && connection.healthy && adding && (
          <RepositoryPicker
            organizationId={organizationId}
            connectionId={connection.id}
            onRegister={onRegister}
            onUnhealthy={() => {
              setAdding(false);
              onUnhealthy();
            }}
            onClose={() => setAdding(false)}
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
  onOpen,
}: {
  repos: GithubRepoDto[];
  loading: boolean;
  /** The read failed; the page says so once, above, for every card. */
  failed: boolean;
  onOpen: (repo: GithubRepoDto) => void;
}) {
  // Never "none registered" before the list is known: that is a zero
  // nobody counted.
  if (repos.length === 0 && loading) return <LoadingLine />;
  if (repos.length === 0 && failed) return null;
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
          <button
            type="button"
            className="focus-visible:ring-ring/50 hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => onOpen(repo)}
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
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One registered repository, as a page of its own inside the GitHub tab: the
 * actions that used to sit in a table row, now that the row is only a way in.
 */
function RepositoryPage({
  organizationId,
  repo,
  manageable,
  onBack,
  onRemove,
}: {
  organizationId: string;
  repo: GithubRepoDto;
  manageable: boolean;
  onBack: () => void;
  onRemove: (
    repoId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [removing, setRemoving] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-1.5"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          GitHub
        </Button>
      </div>
      <header className="flex items-center gap-3">
        <span className="size-5 shrink-0">
          <FolderGit2 className="size-full" />
        </span>
        <h3 className="min-w-0 truncate leading-none font-semibold">
          {repo.fullName}
        </h3>
        {repo.isPrivate && (
          <Lock
            className="text-muted-foreground size-3.5 shrink-0"
            aria-label="Private"
          />
        )}
      </header>
      {repo.syncError !== null && (
        <ErrorBanner className="mt-0">{repo.syncError}</ErrorBanner>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          aria-label={`Analysis for ${repo.fullName}`}
          onClick={() => setAnalyzing(true)}
        >
          Analysis
        </Button>
        {manageable && (
          <Button
            variant="outline"
            className="text-destructive gap-2"
            aria-label={`Remove ${repo.fullName}`}
            onClick={() => setRemoving(true)}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        )}
      </div>
      {analyzing && (
        <RepositoryAnalysis
          key={repo.id}
          organizationId={organizationId}
          repo={repo}
          manageable={manageable}
          onClose={() => setAnalyzing(false)}
        />
      )}
      {manageable && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${repo.fullName}?`}
          description="Stops tracking it here. Nothing changes on GitHub, and you can register it again."
          confirmLabel="Remove"
          onConfirm={async () => {
            const result = await onRemove(repo.id);
            if (!result.ok) return result.error;
            onBack();
            return undefined;
          }}
        />
      )}
    </div>
  );
}

/**
 * The repositories an installation can see, live from GitHub, to register
 * from. Registered ones say so instead of offering the action again.
 */
function RepositoryPicker({
  organizationId,
  connectionId,
  onRegister,
  onUnhealthy,
  onClose,
}: {
  organizationId: string;
  connectionId: string;
  onRegister: (
    externalId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
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
      connectionId,
    ),
    queryFn: ({ signal }) =>
      clients.github.installationRepositories(
        organizationId,
        connectionId,
        signal,
      ),
  });
  const state =
    query.data !== undefined
      ? { status: "ready" as const, repositories: query.data }
      : query.isError
        ? {
            status: "error" as const,
            error:
              query.error instanceof ApiError
                ? query.error.message
                : "Could not reach the server.",
          }
        : { status: "loading" as const };
  const [registering, setRegistering] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  // Read through a ref: the card passes a fresh function on every render,
  // and `load` depending on it would refetch on every render too.
  const unhealthyRef = useRef(onUnhealthy);
  useEffect(() => {
    unhealthyRef.current = onUnhealthy;
  });

  const load = useCallback(async () => {
    await query.refetch();
  }, [query.refetch]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.code === "unhealthy")
      unhealthyRef.current();
  }, [query.error]);
  async function register(externalId: string) {
    setRegistering(externalId);
    setRegisterError(null);
    const result = await onRegister(externalId);
    setRegistering(null);
    if (result.ok) {
      await load();
    } else if (result.code === "unhealthy") {
      unhealthyRef.current();
    } else {
      setRegisterError(result.error);
    }
  }

  return (
    <section
      aria-label="Repositories this account can see"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Registering records the repository and where its default branch
          points. Its contents are not read.
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
      {state.status === "loading" ? (
        <LoadingLine />
      ) : state.status === "error" ? (
        <ErrorBanner className="mt-0">{state.error}</ErrorBanner>
      ) : state.repositories.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          The App cannot see any repositories on this account. Choose some in
          the installation&rsquo;s settings on GitHub.
        </p>
      ) : (
        <ul className="max-h-72 divide-y overflow-y-auto">
          {state.repositories.map((repository) => (
            <li
              key={repository.externalId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                <span className="truncate">{repository.fullName}</span>
                {repository.isPrivate && (
                  <Lock
                    className="text-muted-foreground size-3 shrink-0"
                    aria-label="Private"
                  />
                )}
              </span>
              {repository.registeredId !== null ? (
                <Badge variant="secondary">Registered</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={registering !== null}
                  aria-label={`Register ${repository.fullName}`}
                  onClick={() => void register(repository.externalId)}
                >
                  {registering === repository.externalId && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Register
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {registerError !== null && (
        <ErrorBanner className="mt-0">{registerError}</ErrorBanner>
      )}
    </section>
  );
}
