/**
 * `/oauth/consent`: where a person lets an app (an MCP client such as
 * Claude Code or Cursor) use one workspace through the API.
 *
 * Better Auth's authorization endpoint sends the browser here with a
 * signed query naming the client and the scopes it asked for; a signed-out
 * person first sees sign-in, which returns to this same address. The page
 * shows the client's name, the requested scopes (all checked: an MCP
 * endpoint asks for exactly what its tools need; the person may untick any) and the workspaces the
 * person owns or administers. Approving posts the decision to
 * `/oauth2/consent` with the chosen workspace in `x-lunox-organization`;
 * the API refuses a workspace the person cannot administer, and every
 * token the app gets is bound to it.
 *
 * A page of its own, outside the shell, like `/device`.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { useEffect, useState } from "react";
import {
  API_SCOPES,
  OFFLINE_ACCESS_SCOPE,
  rankAtLeast,
  type ApiScope,
} from "sandbox-factory";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { authClient } from "../../auth";
import { useOrganizations } from "../../useOrganizations";

/** The header the API reads the chosen workspace from; see the API's `oauth/provider.ts`. */
export const ORGANIZATION_HEADER = "x-lunox-organization";

/** What each scope lets an app do, in a person's words. */
const SCOPE_TEXT: Record<ApiScope, string> = {
  "workspace:read":
    "Read bounties, proposals, repositories, boards, sandboxes and runs",
  "integrations:write": "Connect and change Jira and GitHub integrations",
  "bounties:write": "Write, edit and approve bounties",
  "pricing:write": "Size and price bounties (spends model calls)",
  "specs:write": "Change specs",
  "sandboxes:write": "Analyse repositories and build sandboxes",
  "submissions:write": "Submit work",
  judge: "Judge submissions",
  "webhooks:write": "Manage webhooks",
};

/** The scopes a consent page's query asks for, split into API and refresh. */
export function requestedScopes(search: string): {
  api: ApiScope[];
  offline: boolean;
} {
  const asked = new Set(
    (new URLSearchParams(search).get("scope") ?? "").split(" "),
  );
  return {
    api: API_SCOPES.filter((scope) => asked.has(scope)),
    offline: asked.has(OFFLINE_ACCESS_SCOPE),
  };
}

/**
 * Everything asked for: an MCP endpoint asks for what its own tools need
 * (`toolsetScopes` in the API), so a plugin signed in here can use the
 * tools its skill names. The person may untick any scope before allowing.
 */
export function defaultScopes(api: readonly ApiScope[]): ApiScope[] {
  return [...api];
}

interface PublicClient {
  client_id: string;
  client_name?: string | null;
  client_uri?: string | null;
}

type Step = { kind: "review" } | { kind: "leaving"; approved: boolean };

export function OAuthConsent({
  search,
  organizations,
  loadError,
}: {
  /** The signed query Better Auth sent, `?` included. */
  search: string;
  /** The person's workspaces; null while they load. */
  organizations: readonly MembershipDto[] | null;
  loadError: string | null;
}) {
  const query = new URLSearchParams(search);
  const clientId = query.get("client_id") ?? "";
  const asked = requestedScopes(search);
  const administered = (organizations ?? []).filter((entry) =>
    rankAtLeast(entry.role, "admin"),
  );

  const [client, setClient] = useState<PublicClient | null>(null);
  const [granted, setGranted] = useState<ApiScope[]>(() =>
    defaultScopes(asked.api),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "review" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (clientId === "") return;
    let live = true;
    void authClient
      .$fetch<PublicClient>("/oauth2/public-client", {
        query: { client_id: clientId },
      })
      .then((result) => {
        if (!live) return;
        if (result.error !== null || result.data === null) {
          setError("This app is not registered here, or was disabled.");
          return;
        }
        setClient(result.data);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  // The only workspace a person administers is the one to grant.
  const workspace =
    chosen ?? (administered.length === 1 ? administered[0]?.id : null) ?? null;

  async function decide(approve: boolean) {
    setPending(true);
    setError(null);
    const scope = [
      ...granted,
      ...(asked.offline ? [OFFLINE_ACCESS_SCOPE] : []),
    ];
    const result = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
      method: "POST",
      headers:
        approve && workspace !== null
          ? { [ORGANIZATION_HEADER]: workspace }
          : {},
      body: {
        accept: approve,
        oauth_query: search.replace(/^\?/, ""),
        ...(approve ? { scope: scope.join(" ") } : {}),
      },
    });
    setPending(false);
    if (result.error !== null || result.data === null) {
      setError(
        result.error?.message ??
          "The decision could not be sent. Start again from the app.",
      );
      return;
    }
    setStep({ kind: "leaving", approved: approve });
    window.location.assign(result.data.url);
  }

  const name = client?.client_name ?? client?.client_id ?? "An app";
  const ready = clientId !== "" && client !== null && organizations !== null;

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>Connect an app to Lunox</h1>
          </CardTitle>
          <CardDescription>
            Approve only an app you are setting up yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {clientId === "" && (
            <ErrorBanner>
              This page is opened by an app asking for access. Start from the
              app.
            </ErrorBanner>
          )}
          {error !== null && <ErrorBanner>{error}</ErrorBanner>}
          {loadError !== null && <ErrorBanner>{loadError}</ErrorBanner>}
          {clientId !== "" &&
            !ready &&
            error === null &&
            loadError === null && <LoadingLine />}
          {ready && step.kind === "review" && (
            <form
              className="flex flex-col gap-4 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                void decide(true);
              }}
            >
              <p>
                <strong>{name}</strong> asks to use one workspace as you.
              </p>
              {administered.length === 0 ? (
                <p role="alert">
                  You own or administer no workspace, so you cannot grant one.
                  Ask a workspace&apos;s owner to connect the app.
                </p>
              ) : (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 font-medium">Workspace</legend>
                  {administered.map((entry) => (
                    <label key={entry.id} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="workspace"
                        value={entry.id}
                        checked={workspace === entry.id}
                        onChange={() => setChosen(entry.id)}
                      />
                      {entry.name}
                      <span className="text-muted-foreground font-mono text-xs">
                        {entry.slug}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 font-medium">It will be able to</legend>
                {asked.api.length === 0 && (
                  <p>
                    It asks for no Lunox scope, so there is nothing to grant.
                  </p>
                )}
                {asked.api.map((scope) => (
                  <label key={scope} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={granted.includes(scope)}
                      onChange={(event) =>
                        setGranted((current) =>
                          event.target.checked
                            ? API_SCOPES.filter(
                                (known) =>
                                  known === scope || current.includes(known),
                              )
                            : current.filter((held) => held !== scope),
                        )
                      }
                    />
                    <span>
                      {SCOPE_TEXT[scope]}{" "}
                      <span className="text-muted-foreground font-mono text-xs">
                        {scope}
                      </span>
                    </span>
                  </label>
                ))}
                {asked.offline && (
                  <p className="text-muted-foreground text-xs">
                    It stays connected until you revoke it or stop being an
                    owner or admin of the workspace.
                  </p>
                )}
              </fieldset>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={
                    pending || workspace === null || granted.length === 0
                  }
                >
                  Allow
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void decide(false)}
                >
                  Deny
                </Button>
              </div>
            </form>
          )}
          {step.kind === "leaving" && (
            <p className="text-sm" role="status">
              {step.approved
                ? `Allowed. Returning you to ${name}…`
                : "Denied. Nothing was shared."}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** The page, with the person's workspaces read as the shell reads them. */
export function OAuthConsentPage({ search }: { search: string }) {
  const { organizations, loading, error } = useOrganizations();
  return (
    <OAuthConsent
      search={search}
      organizations={loading ? null : organizations}
      loadError={error}
    />
  );
}
