/**
 * Connected apps: the OAuth clients (Claude Code, Cursor, the CLIs' MCP
 * servers, any app) that hold a grant in this workspace, one per person who
 * approved one, with what it may do and when it last did anything. Revoking
 * ends the grant and its tokens at once; the app must ask for consent again.
 *
 * On a server without the grants routes the list answers 404, and the page
 * says the feature is not available there yet rather than failing.
 */

import type { OAuthGrantDto } from "@sandbox-factory/shared";
import { AppWindow } from "lucide-react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LoadingLine, RetryableError } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { dateTime } from "@/lib/format";

import { failureText, useOAuthGrants } from "./data";
import { Chips, Meta } from "./parts";

export function ConnectedApps({
  organizationId,
  onOpenMcp,
}: {
  organizationId: string;
  onOpenMcp: () => void;
}) {
  const grants = useOAuthGrants(organizationId);
  return (
    <section aria-labelledby="developers-apps" className="flex flex-col gap-4">
      <SectionHeader
        id="developers-apps"
        title="Connected apps"
        description="Apps someone let into this workspace over OAuth. Each acts as the person who approved it, with the scopes they approved."
      />
      {grants.isPending ? (
        <LoadingLine />
      ) : grants.isError ? (
        <RetryableError onRetry={() => void grants.refetch()}>
          {failureText(grants.error, "Could not load the connected apps.")}
        </RetryableError>
      ) : grants.data === null ? (
        <p
          role="note"
          className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm"
        >
          Connected apps are not available on this server yet.
        </p>
      ) : grants.data.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          <p>
            No apps connected. An MCP client appears here once someone approves
            it for this workspace.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onOpenMcp}>
            Set up MCP
          </Button>
        </div>
      ) : (
        <ul aria-label="Connected apps" className="divide-y rounded-lg border">
          {grants.data.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              onRevoke={async () => {
                try {
                  await grants.revoke(grant.id);
                } catch (error) {
                  return failureText(error, "Could not revoke that app.");
                }
              }}
            />
          ))}
        </ul>
      )}
    </section>
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
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <AppWindow
            aria-hidden="true"
            className="text-muted-foreground size-3.5 shrink-0"
          />
          <span className="truncate text-sm font-medium">{name}</span>
          {grant.client.name !== null && (
            <code className="text-muted-foreground truncate font-mono text-xs">
              {grant.client.id}
            </code>
          )}
        </div>
        <Chips label="Scopes" items={grant.scopes} />
        <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          <Meta term="Approved by" value={grant.user.name} />
          <Meta term="Approved" value={dateTime(grant.createdAt)} />
          <Meta
            term="Last used"
            value={
              grant.lastUsedAt === null ? "Never" : dateTime(grant.lastUsedAt)
            }
          />
        </dl>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            aria-label={`Revoke ${name}`}
          >
            Revoke
          </Button>
        }
        title={`Revoke ${name}?`}
        description="Its tokens stop working at once, and it has to ask for consent again to come back."
        confirmLabel="Revoke access"
        pendingLabel="Revoking…"
        onConfirm={onRevoke}
      />
    </li>
  );
}
