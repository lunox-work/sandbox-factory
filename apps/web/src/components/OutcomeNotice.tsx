/**
 * The answer to a round trip through another site's consent screen: Jira's
 * and GitHub's connect flows both come back to a page with an outcome in the
 * query, and both explain it here, in one shape.
 *
 * Extracted from the Jira banner when GitHub needed the same thing. Each
 * flow keeps its own words — what an outcome means is the flow's business —
 * and this keeps the look.
 */

import { CircleCheck, CircleX, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type OutcomeTone = "ok" | "warn" | "error";

export function OutcomeNotice({
  tone,
  title,
  detail,
  onDismiss,
  testId,
}: {
  tone: OutcomeTone;
  title: string;
  detail: string;
  onDismiss: () => void;
  /** Each flow's tests look its banner up by its own id. */
  testId: string;
}) {
  /*
    Border and a faint wash of the same colour, matching `ErrorBanner`: the
    border alone was thin enough that the banner read as a stray input rather
    than as the page answering a round trip through another site.
  */
  const skin =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/7"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/7"
        : "border-destructive/40 bg-destructive/7";
  const Icon =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : CircleX;
  const iconTone =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-500"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-500"
        : "text-destructive";

  return (
    /*
      Title over detail, and the detail free to wrap: on one line with
      `truncate` it was clipped even for the shortest of these sentences,
      cutting instructions off mid-word.

      `alert` for a failure, which should interrupt, and `status` for the
      rest, which should wait until the reader is idle.
    */
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border ${skin} px-3 py-2.5 text-sm`}
      data-testid={testId}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${iconTone}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p
          className="text-muted-foreground mt-0.5"
          data-testid={`${testId}-detail`}
        >
          {detail}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-my-2 -mr-2 size-10 shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
