/**
 * A proposal's drafted spec, read-only: what the ticket asks for as
 * scenarios, grouped by kind, with the questions the ticket left open and
 * the assumptions the draft made. The peek's Scenarios tab.
 *
 * Called Scenarios rather than Spec because the peek already has a Spec
 * tab, which is the Jira ticket read live. This is the other side of it:
 * what was made of the ticket when it was sized.
 *
 * The read is split from the view so the peek can start it when it opens,
 * as it does the ticket's, and a switch to the tab is instant. It is a
 * stored read and answers without Jira, which is why it does not ride on
 * the proposal's own read, which waits for Jira to say whether the ticket
 * changed.
 */

import type { BountySpecDto } from "@sandbox-factory/shared";
import { countScenarios, groupScenarios, type Scenario } from "sandbox-factory";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** How a scenario that the first draft did not write came to be there. */
const ORIGIN_LABEL: Record<Exclude<Scenario["origin"], "draft">, string> = {
  expansion: "Added",
  reviewer: "Reviewer",
};

export type SpecRead =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly spec: BountySpecDto | null };

/**
 * The spec out of a response, or null when it carries none this page can
 * draw. Checked for the shape the tab reads, since a response is not
 * trusted to be one: a body that is not a spec is no spec, not a crash.
 */
function specFrom(body: unknown): BountySpecDto | null {
  if (typeof body !== "object" || body === null) return null;
  const spec = (body as { spec?: unknown }).spec;
  if (typeof spec !== "object" || spec === null) return null;
  const draft = (spec as { draft?: unknown }).draft;
  if (typeof draft !== "object" || draft === null) return null;
  const { feature, background, scenarios, openQuestions, assumptions } =
    draft as Record<string, unknown>;
  return typeof feature === "string" &&
    [background, scenarios, openQuestions, assumptions].every(Array.isArray)
    ? (spec as BountySpecDto)
    : null;
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * The open proposal's spec, read when it is asked for.
 *
 * `specRevision` is the revision the proposal points at. Null, or absent on
 * a row from before specs, means there is none, and nothing is asked for.
 */
export function useProposalSpec(
  base: string,
  proposalId: string,
  specRevision: number | null | undefined,
): { readonly read: SpecRead; readonly retry: () => void } {
  const wanted = specRevision ?? null;
  /*
    Keyed by what it was read for. A peek that moves to another proposal, or
    a re-price that moves this one to a new revision, must not show the last
    read's scenarios under the new one while its own is on the way.
  */
  const key = `${proposalId}:${wanted ?? ""}`;
  const [read, setRead] = useState<{ key: string } & SpecRead>({
    key,
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    setRead({ key, state: "loading" });
    fetch(`${base}/proposals/${encodeURIComponent(proposalId)}/spec`, {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const spec = specFrom(await response.json());
        if (live) setRead({ key, state: "ready", spec });
      })
      .catch(() => {
        if (live) setRead({ key, state: "failed" });
      });
    return () => {
      live = false;
    };
  }, [base, proposalId, wanted, key, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    read:
      wanted === null
        ? { state: "ready", spec: null }
        : read.key === key
          ? read
          : { state: "loading" },
    retry,
  };
}

/** How many scenarios the tab holds, once that is known; null until then. */
export function scenarioTotal(read: SpecRead): number | null {
  return read.state === "ready" && read.spec !== null
    ? countScenarios(read.spec.draft).total
    : null;
}

export function ProposalSpec({
  read,
  onRetry,
  canAnalyze,
}: {
  read: SpecRead;
  onRetry: () => void;
  /** Whether the reader can have the ticket analyzed again. */
  canAnalyze: boolean;
}) {
  const spec = read.state === "ready" ? read.spec : null;

  return (
    <div data-testid="proposal-spec">
      {read.state === "loading" ? (
        <LoadingLine>Loading scenarios…</LoadingLine>
      ) : read.state === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">The scenarios could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      ) : spec === null ? (
        <p className="text-muted-foreground text-sm" data-testid="spec-empty">
          No scenarios were drafted for this proposal.
          {canAnalyze &&
            " Re-analyze, on the Bounty tab, drafts them from the ticket as it is now."}
        </p>
      ) : (
        <SpecBody spec={spec} />
      )}
    </div>
  );
}

function SpecBody({ spec }: { spec: BountySpecDto }) {
  const { draft } = spec;
  const groups = groupScenarios(draft);
  return (
    <div className="flex flex-col gap-4">
      {/* What the ticket is about, and which revision of the spec this is. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm leading-relaxed font-medium">{draft.feature}</p>
        <p className="text-muted-foreground text-xs">
          {plural(countScenarios(draft).total, "scenario")} · revision{" "}
          {spec.revision}
        </p>
      </div>

      {draft.background.length > 0 && (
        <section aria-label="Background">
          <h4 className="mb-1 text-xs font-medium">Background</h4>
          <Steps
            steps={draft.background.map((text, index) => ({
              keyword: index === 0 ? "Given" : "And",
              text,
            }))}
          />
        </section>
      )}

      {groups.map((group) => (
        <section key={group.kind} aria-label={group.label}>
          {/* The count is what a reader compares across kinds. */}
          <h4 className="mb-1 flex items-baseline gap-1.5 text-xs font-medium">
            {group.label}
            <span className="text-muted-foreground tabular-nums">
              {group.scenarios.length}
            </span>
          </h4>
          <ul className="flex flex-col">
            {group.scenarios.map((scenario) => (
              <ScenarioRow key={scenario.id} scenario={scenario} />
            ))}
          </ul>
        </section>
      ))}

      {draft.scenarios.length === 0 && (
        <p className="text-muted-foreground text-sm">
          The ticket did not describe behaviour to write a scenario for.
        </p>
      )}

      <Notes heading="Open questions" notes={draft.openQuestions} />
      <Notes heading="Assumptions" notes={draft.assumptions} />
    </div>
  );
}

/**
 * One scenario: its title, and its steps when opened. Closed by default, so
 * a spec of a dozen scenarios reads as a list of what is covered before it
 * reads as forty lines of Given and Then.
 */
function ScenarioRow({ scenario }: { scenario: Scenario }) {
  const [open, setOpen] = useState(false);
  const steps = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={steps}
        className="hover:bg-muted/60 focus-visible:ring-ring/50 -mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none focus-visible:ring-[3px]"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={`text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1 leading-relaxed">{scenario.title}</span>
        {scenario.origin !== "draft" && (
          <Badge variant="outline" className="shrink-0">
            {ORIGIN_LABEL[scenario.origin]}
          </Badge>
        )}
      </button>
      {open && (
        <div id={steps} className="pt-0.5 pb-2 pl-5">
          <Steps steps={scenario.steps} />
        </div>
      )}
    </li>
  );
}

/** Gherkin steps, the keywords in a column so the sentences line up. */
function Steps({
  steps,
}: {
  steps: readonly { readonly keyword: string; readonly text: string }[];
}) {
  return (
    <ol className="flex flex-col gap-0.5 text-sm leading-relaxed">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-2">
          <span className="text-muted-foreground w-11 shrink-0 text-right font-medium">
            {step.keyword}
          </span>
          <span className="min-w-0">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Notes({
  heading,
  notes,
}: {
  heading: string;
  notes: readonly string[];
}) {
  if (notes.length === 0) return null;
  return (
    <section aria-label={heading}>
      <h4 className="mb-1 flex items-baseline gap-1.5 text-xs font-medium">
        {heading}
        <span className="text-muted-foreground tabular-nums">
          {notes.length}
        </span>
      </h4>
      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
        {notes.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </section>
  );
}
