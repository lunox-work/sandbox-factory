/**
 * A workspace's API tokens: the list (revoked and expired ones too), the
 * form that makes one, and revoking.
 *
 * A token's secret is answered once, by the request that made it, and is
 * held here in this component's state until the person dismisses it; it is
 * never written to the query cache, the URL or storage, and the list shows
 * only each token's prefix. The API keeps a hash, so a lost secret means a
 * new token.
 */

import type { ApiTokenDto, CreatedApiTokenDto } from "@sandbox-factory/shared";
import { KeyRound, Plus, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { API_SCOPES, type ApiScope } from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine, RetryableError } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CodeBlock";
import { failureText, tokenState, useApiTokens } from "./data";
import { Chips, Meta } from "./parts";
import { SCOPE_SUMMARY } from "./scopes";

/** How long a new token lasts; `null` never expires. */
const EXPIRY_CHOICES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "No expiry" },
] as const;
type ExpiryDays = (typeof EXPIRY_CHOICES)[number]["days"];

export function ApiTokens({ organizationId }: { organizationId: string }) {
  const tokens = useApiTokens(organizationId);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null);

  return (
    <section
      aria-labelledby="developers-tokens"
      className="flex flex-col gap-4"
    >
      <SectionHeader
        id="developers-tokens"
        title="API tokens"
        description="Each token reaches this workspace only, with the scopes it names, acting as the person who made it while they stay an owner or admin."
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

      {created !== null && (
        <NewSecret created={created} onDone={() => setCreated(null)} />
      )}

      {creating && (
        <CreateTokenForm
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            const result = await tokens.create(input);
            setCreating(false);
            setCreated(result);
          }}
        />
      )}

      {tokens.isPending ? (
        <LoadingLine />
      ) : tokens.isError ? (
        <RetryableError onRetry={() => void tokens.refetch()}>
          {failureText(tokens.error, "Could not load the API tokens.")}
        </RetryableError>
      ) : tokens.data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No tokens yet. Make one for a script, CI job or agent.
        </p>
      ) : (
        <ul aria-label="API tokens" className="divide-y rounded-lg border">
          {tokens.data.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              onRevoke={async () => {
                try {
                  await tokens.revoke(token.id);
                } catch (error) {
                  return failureText(error, "Could not revoke that token.");
                }
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The secret, once. Said plainly that it will not be shown again, with a
 * copy button; "Done" drops it from memory.
 */
function NewSecret({
  created,
  onDone,
}: {
  created: CreatedApiTokenDto;
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
    scopes: ApiScope[];
    expiresInDays: number | null;
  }) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["workspace:read"]);
  const [days, setDays] = useState<ExpiryDays>(90);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== "" && scopes.length > 0 && !pending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        // In core's order, whatever order they were ticked in.
        scopes: API_SCOPES.filter((scope) => scopes.includes(scope)),
        expiresInDays: days,
      });
    } catch (failure) {
      setError(failureText(failure, "Could not make the token."));
      setPending(false);
    }
  }

  return (
    <form
      aria-label="New API token"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-5 rounded-lg border px-4 py-4"
    >
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
        Name
        <Input
          value={name}
          maxLength={80}
          autoFocus
          placeholder="CI on main"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Scopes</legend>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {API_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex min-w-0 cursor-pointer items-start gap-2.5 text-sm"
            >
              <input
                type="checkbox"
                className="accent-foreground mt-0.5 size-3.5 shrink-0"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  )
                }
              />
              <span className="min-w-0">
                <span className="font-mono text-xs">{scope}</span>
                <span className="text-muted-foreground block text-xs">
                  {SCOPE_SUMMARY[scope]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

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
  token: ApiTokenDto;
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
        <Chips
          label="Scopes"
          items={token.scopes}
          describe={(scope) => SCOPE_SUMMARY[scope as ApiScope]}
        />
        <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          <Meta term="Created by" value={token.createdBy.name} />
          <Meta term="Created" value={dateTime(token.createdAt)} />
          <Meta
            term="Last used"
            value={
              token.lastUsedAt === null ? "Never" : dateTime(token.lastUsedAt)
            }
          />
          {token.revokedAt !== null ? (
            <Meta term="Revoked" value={dateTime(token.revokedAt)} />
          ) : (
            <Meta
              term={state === "expired" ? "Expired" : "Expires"}
              value={
                token.expiresAt === null ? "Never" : dateTime(token.expiresAt)
              }
            />
          )}
        </dl>
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
