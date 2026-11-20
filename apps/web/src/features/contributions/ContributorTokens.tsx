/**
 * "Tokens for your editor or agent", on the Contributions page: a person's
 * own contributor tokens (`lnxc_…`) and the apps they let in as a
 * contributor over OAuth. A token reaches only their contributions, never
 * a workspace, whatever workspaces they belong to.
 *
 * A token's secret is answered once, by the request that made it, and is
 * held in this component's state until the person dismisses it; never in
 * the query cache, the URL or storage. The snippets name the app's own
 * origin, which serves the API and MCP too (see `developers/snippets.ts`).
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  ContributorTokenDto,
  CreatedContributorTokenDto,
  OAuthGrantDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { MCP_CONTRIBUTOR_PATH } from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine, RetryableError } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { CopyButton } from "../developers/CodeBlock";
import { appOrigin } from "../developers/snippets";

/** How long a new token lasts; `null` never expires. */
const EXPIRY_CHOICES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "No expiry" },
] as const;
type ExpiryDays = (typeof EXPIRY_CHOICES)[number]["days"];

/** The MCP server a contributor adds to Claude Code, signing in by browser. */
export function contributorMcpAdd(origin: string): string {
  return `claude mcp add --transport http lunox-contribute ${origin}${MCP_CONTRIBUTOR_PATH}`;
}

/** The same with a contributor token, for a client without a browser. */
export function contributorMcpAddWithToken(origin: string): string {
  return `${contributorMcpAdd(origin)} --header "Authorization: Bearer lnxc_…"`;
}

/**
 * The VS Code extension's commands a contributor runs, in order, as the
 * Command Palette shows them (`apps/extension/package.json`, category
 * "Lunox"); `contributions.test.tsx` holds them to that file.
 */
export const VSCODE_COMMANDS = [
  "Lunox: Sign in with a contributor token",
  "Lunox: Open contribution",
  "Lunox: Submit",
] as const;

function failureText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status !== 404
    ? error.message
    : fallback;
}

function tokenState(
  token: ContributorTokenDto,
  now: Date = new Date(),
): "active" | "revoked" | "expired" {
  if (token.revokedAt !== null) return "revoked";
  if (token.expiresAt !== null && new Date(token.expiresAt) <= now)
    return "expired";
  return "active";
}

export function ContributorTokens() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const tokensKey = queryKeys.me(userId, "contributor-tokens");
  const grantsKey = queryKeys.me(userId, "contributor-grants");
  const tokens = useQuery({
    queryKey: tokensKey,
    queryFn: ({ signal }) => clients.contributions.contributorTokens(signal),
  });
  const grants = useQuery({
    queryKey: grantsKey,
    queryFn: ({ signal }) => clients.contributions.contributorGrants(signal),
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedContributorTokenDto | null>(
    null,
  );
  const origin = appOrigin();

  return (
    <section
      aria-labelledby="contributor-tokens"
      className="flex flex-col gap-4"
    >
      <SectionHeader
        id="contributor-tokens"
        title="Tokens for your editor or agent"
        description="A token reaches your contributions only: list them, download a project, submit and read your verdicts. Never a workspace's."
        actions={
          creating ? undefined : (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setCreated(null);
                setCreating(true);
              }}
            >
              <Plus />
              New token
            </Button>
          )
        }
      />
      <div className="text-muted-foreground flex flex-col gap-2 text-xs">
        <p>
          In Claude Code, add the contributor MCP server and sign in when it
          asks; or pass a token to a client that cannot open a browser. The{" "}
          <code className="text-foreground font-mono">lunox-contribute</code>{" "}
          skill, in the bouncer-hosted and carveout plugins, walks an agent
          through a contribution with it.
        </p>
        <Snippet text={contributorMcpAdd(origin)} label="Copy command" />
        <Snippet
          text={contributorMcpAddWithToken(origin)}
          label="Copy command with a token"
        />
        <p data-testid="vscode-commands">
          In VS Code, the Lunox extension's commands:{" "}
          {VSCODE_COMMANDS.map((command, index) => (
            <span key={command}>
              {index > 0 && ", then "}
              <span className="text-foreground font-medium">{command}</span>
            </span>
          ))}
          .
        </p>
      </div>

      {created !== null && (
        <NewSecret created={created} onDone={() => setCreated(null)} />
      )}

      {creating && (
        <CreateTokenForm
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            const result =
              await clients.contributions.createContributorToken(input);
            queryClient.setQueryData<ContributorTokenDto[]>(
              tokensKey,
              (current) => [result.token, ...(current ?? [])],
            );
            setCreating(false);
            setCreated(result);
          }}
        />
      )}

      {tokens.isPending ? (
        <LoadingLine />
      ) : tokens.isError ? (
        <RetryableError onRetry={() => void tokens.refetch()}>
          {failureText(tokens.error, "Your tokens could not be read.")}
        </RetryableError>
      ) : tokens.data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No tokens yet.
        </p>
      ) : (
        <ul
          aria-label="Contributor tokens"
          className="divide-y rounded-lg border"
        >
          {tokens.data.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              onRevoke={async () => {
                try {
                  const revoked =
                    await clients.contributions.revokeContributorToken(
                      token.id,
                    );
                  queryClient.setQueryData<ContributorTokenDto[]>(
                    tokensKey,
                    (current) =>
                      (current ?? []).map((each) =>
                        each.id === revoked.id ? revoked : each,
                      ),
                  );
                } catch (error) {
                  return failureText(error, "Could not revoke that token.");
                }
              }}
            />
          ))}
        </ul>
      )}

      {grants.isSuccess && grants.data.length > 0 && (
        <ul aria-label="Connected apps" className="divide-y rounded-lg border">
          {grants.data.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              onRevoke={async () => {
                try {
                  await clients.contributions.revokeContributorGrant(grant.id);
                  queryClient.setQueryData<OAuthGrantDto[]>(
                    grantsKey,
                    (current) =>
                      (current ?? []).filter((each) => each.id !== grant.id),
                  );
                } catch (error) {
                  return failureText(error, "Could not disconnect that app.");
                }
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="bg-muted/40 dark:bg-muted/30 flex min-w-0 items-center gap-2 rounded-md border py-1 pr-1 pl-2.5">
      <code className="text-foreground min-w-0 flex-1 font-mono text-xs break-all">
        {text}
      </code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/** The secret, once, with a copy button; "Done" drops it from memory. */
function NewSecret({
  created,
  onDone,
}: {
  created: CreatedContributorTokenDto;
  onDone: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="New token secret"
      className="border-foreground/15 flex flex-col gap-3 rounded-lg border px-4 py-4"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Copy “{created.token.name}” now. You won’t see it again.
          </p>
          <p className="text-muted-foreground text-xs">
            Only a hash is kept. If it is lost, revoke it and make another.
          </p>
        </div>
      </div>
      <div className="bg-muted/40 dark:bg-muted/30 flex min-w-0 items-center gap-2 rounded-md border py-1 pr-1 pl-2.5">
        <code
          data-testid="token-secret"
          className="min-w-0 flex-1 font-mono text-xs break-all"
        >
          {created.secret}
        </code>
        <CopyButton text={created.secret} label="Copy token" />
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CreateTokenForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    expiresInDays: number | null;
  }) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [days, setDays] = useState<ExpiryDays>(90);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== "" && !pending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), expiresInDays: days });
    } catch (failure) {
      setError(failureText(failure, "Could not make the token."));
      setPending(false);
    }
  }

  return (
    <form
      aria-label="New contributor token"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-5 rounded-lg border px-4 py-4"
    >
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
        Name
        <Input
          value={name}
          maxLength={80}
          autoFocus
          placeholder="Claude Code on my laptop"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-expiry`} className="text-sm font-medium">
          Expires
        </label>
        <select
          id={`${id}-expiry`}
          value={days === null ? "never" : String(days)}
          onChange={(event) =>
            setDays(
              event.target.value === "never"
                ? null
                : (Number(event.target.value) as ExpiryDays),
            )
          }
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full max-w-48 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option
              key={choice.label}
              value={choice.days === null ? "never" : String(choice.days)}
            >
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready}>
          {pending ? "Making…" : "Make token"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TokenRow({
  token,
  onRevoke,
}: {
  token: ContributorTokenDto;
  onRevoke: () => Promise<string | undefined>;
}) {
  const state = tokenState(token);
  return (
    <li
      aria-label={token.name}
      className={cn(
        "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4",
        state !== "active" && "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <KeyRound
            aria-hidden="true"
            className="text-muted-foreground size-3.5 shrink-0"
          />
          <span
            className={cn(
              "truncate text-sm font-medium",
              state === "active" && "text-foreground",
            )}
          >
            {token.name}
          </span>
          <code className="text-muted-foreground font-mono text-xs">
            {token.prefix}…
          </code>
          {state !== "active" && (
            <span className="rounded-sm border px-1.5 text-2xs leading-4 font-medium">
              {state === "revoked" ? "Revoked" : "Expired"}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          Created {dateTime(token.createdAt)} · Last used{" "}
          {token.lastUsedAt === null ? "never" : dateTime(token.lastUsedAt)} ·{" "}
          {token.revokedAt !== null
            ? `Revoked ${dateTime(token.revokedAt)}`
            : token.expiresAt === null
              ? "Never expires"
              : `${state === "expired" ? "Expired" : "Expires"} ${dateTime(token.expiresAt)}`}
        </p>
      </div>
      {state === "active" && (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              aria-label={`Revoke ${token.name}`}
            >
              Revoke
            </Button>
          }
          title={`Revoke “${token.name}”?`}
          description="Anything using it stops working at once. This cannot be undone; make a new token to restore access."
          confirmLabel="Revoke token"
          pendingLabel="Revoking…"
          onConfirm={onRevoke}
        />
      )}
    </li>
  );
}

function GrantRow({
  grant,
  onRevoke,
}: {
  grant: OAuthGrantDto;
  onRevoke: () => Promise<string | undefined>;
}) {
  const name = grant.client.name ?? grant.client.id;
  return (
    <li
      aria-label={name}
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">{name}</span>
        <p className="text-muted-foreground text-xs">
          Signed in as a contributor {dateTime(grant.updatedAt)} · Last used{" "}
          {grant.lastUsedAt === null ? "never" : dateTime(grant.lastUsedAt)}
        </p>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            aria-label={`Disconnect ${name}`}
          >
            Disconnect
          </Button>
        }
        title={`Disconnect “${name}”?`}
        description="It stops working at once and must ask you to sign in again."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={onRevoke}
      />
    </li>
  );
}
