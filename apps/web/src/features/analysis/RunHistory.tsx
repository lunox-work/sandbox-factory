/**
 * Every run on the repository, as the context builders block's footer: a
 * line that says how many there are, and the way into their logs. The
 * runs themselves are listed in the logs dialog, beside each one's log,
 * so the page keeps to the count. Logs are for owners and admins only.
 */

import { ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";

import { BLOCK_ACTION } from "./Blocks";

export function RunHistory({
  count,
  loading,
  unavailable,
  manageable,
  onOpenLogs,
}: {
  count: number;
  loading: boolean;
  /** The list could not be read; the page says why above. */
  unavailable: boolean;
  manageable: boolean;
  onOpenLogs: () => void;
}) {
  return (
    <section
      aria-label="Run history"
      className="bg-muted/30 flex min-h-12 items-center justify-between gap-3 rounded-b-lg px-4 py-2 text-xs"
    >
      <p className="text-muted-foreground">
        <span className="text-foreground font-medium">Run history</span>
        {" · "}
        {loading
          ? "Loading…"
          : unavailable && count === 0
            ? "Unavailable"
            : count === 0
              ? "No runs yet"
              : `${count.toLocaleString()} ${count === 1 ? "run" : "runs"}`}
      </p>
      {manageable && count > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className={BLOCK_ACTION}
          onClick={onOpenLogs}
        >
          <ScrollText />
          View logs
        </Button>
      )}
    </section>
  );
}
