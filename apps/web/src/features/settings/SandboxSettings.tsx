/**
 * The workspace's sandbox settings: whether an approved bounty's sandbox is
 * prepared before anyone asks for it. Any member reads it; owners and
 * admins change it. The API checks the role again; a member sees the
 * setting as it stands, with no control.
 */

import { useId, useState } from "react";
import { rankAtLeast } from "sandbox-factory";

import { ErrorBanner, LoadingLine, RetryButton } from "@/components/Message";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { clients, useOwnerQuery } from "../../data/query";
import { errorMessage } from "../analysis/labels";

export function SandboxSettings({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const query = useOwnerQuery(organizationId, "settings", (owner, signal) =>
    clients.settings.settings(owner, signal),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manage = rankAtLeast(role, "admin");
  const labelId = useId();
  const on = query.data?.prepareSandboxes;

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await clients.settings.saveSettings(organizationId, {
        prepareSandboxes: next,
      });
      query.setData(() => saved);
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the setting. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Sandboxes
        </CardTitle>
        <CardDescription>How a bounty&rsquo;s sandbox is made.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending ? (
          <LoadingLine />
        ) : query.isError ? (
          <ErrorBanner
            className="mt-0"
            action={<RetryButton onRetry={() => void query.refetch()} />}
          >
            Could not load the workspace&rsquo;s settings.
          </ErrorBanner>
        ) : (
          <>
            {error !== null && (
              <ErrorBanner className="mt-0">{error}</ErrorBanner>
            )}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p id={labelId} className="text-sm font-medium">
                  Prepare sandboxes in advance
                </p>
                <p className="text-muted-foreground text-sm">
                  Once a bounty&rsquo;s price is approved, agents write its
                  sandbox&rsquo;s fake data and names ahead of time, so opening
                  the sandbox is quicker. This spends model usage on sandboxes
                  that may never be opened.
                </p>
                {!manage && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    Only owners and admins can change this.
                  </p>
                )}
              </div>
              <Switch
                checked={on === true}
                labelledBy={labelId}
                disabled={!manage || saving}
                onChange={(next) => void save(next)}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** An on/off control, as the platform's switch reads to assistive tech. */
function Switch({
  checked,
  labelledBy,
  disabled,
  onChange,
}: {
  checked: boolean;
  labelledBy: string;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "focus-visible:ring-ring/50 relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-background pointer-events-none block size-4 rounded-full shadow-xs transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
