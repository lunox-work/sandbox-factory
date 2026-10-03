import { useQuery } from "@tanstack/react-query";
import { clients, queryKeys, useUserId } from "./data/query";
import { plural } from "./lib/format";
export { plural } from "./lib/format";
/**
 * A proposal's drafted spec, read-only: what the ticket asks for as
 * scenarios, grouped by kind, with the questions the ticket left open and
 * the assumptions the draft made. The peek's Scenarios tab.
 *
 * Called Scenarios rather than Spec because the peek already has a Spec
 * tab, which is the Jira ticket read live. This is the other side of it:
 * what was made of the ticket when it was sized.
 *
 * The tab opens on why the ticket is the size it is: the sizing model's
 * size and reasoning, or, when a reviewer overrode it, the reviewer's size
 * with the model's original size and reasoning under it. That reasoning is
 * the proposal's, not the spec's, so it shows whatever state the spec is in.
 *
 * Each scenario wears its weight: how much work it adds, in the drafting
 * model's judgement, with the model's reason when the scenario is opened.
 * The points are what the scenario step counts when a reviewer grows the
 * spec, so each kind's group shows its total. A spec drafted before
 * weights shows none of this, and says how to get them.
 *
 * A reviewer who may change the spec does it here: more scenarios of a
 * kind or for an instruction, answers to the open questions, or a scenario
 * taken out (`SpecChanges.tsx`). Each change is a new revision, and the
 * revisions before it stay readable, read-only, from the picker.
 *
 * The read is split from the view so the peek can start it when it opens,
 * as it does the ticket's, and a switch to the tab is instant. It is a
 * stored read and answers without Jira, which is why it does not ride on
 * the proposal's own read, which waits for Jira to say whether the ticket
 * changed.
 */

import type {
  BountySpecDto,
  BountySpecRevisionDto,
  RespecRequestDto,
} from "@sandbox-factory/shared";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  countScenarios,
  groupScenarios,
  pointsOf,
  pointsOfScenarios,
  SCENARIO_WEIGHT_DEFINITIONS,
  SCENARIO_WEIGHTS,
  WEIGHT_POINTS,
  type Scenario,
  type ScenarioWeight,
} from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  AnswerForm,
  expandLabel,
  ExpandMenu,
  InstructionForm,
  RespecStatus,
  RevisionPicker,
  useSpecRevisions,
  type RespecControl,
} from "./SpecChanges";

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
/** What each weight counts for, as the step that will count them reads it. */
export type WeightPoints = Readonly<Record<ScenarioWeight, number>>;

const WEIGHT_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  SCENARIO_WEIGHT_DEFINITIONS.map(({ id, label }) => [id, label]),
);

/** What one weight counts for, or undefined for a weight the rubric dropped. */
function pointsFor(
  weight: ScenarioWeight,
  weightPoints: WeightPoints,
): number | undefined {
  return Object.hasOwn(weightPoints, weight) ? weightPoints[weight] : undefined;
}

/**
 * A scenario's weight as a badge: its name and what it counts for, after
 * a small rising mark filled to the weight, so a list of them reads by
 * shape before it is read by word. The reason, when there is one, is the
 * badge's tooltip.
 */
export function WeightBadge({
  weight,
  points,
  reason,
}: {
  weight: ScenarioWeight;
  /** What the weight counts for in the step; left off when not known. */
  points?: number | undefined;
  reason?: string | undefined;
}) {
  const rank = SCENARIO_WEIGHTS.indexOf(weight) + 1;
  return (
    <Badge
      variant="outline"
      className="text-muted-foreground shrink-0 gap-1.5 font-normal"
      title={reason}
      data-weight={weight}
    >
      <span aria-hidden="true" className="flex items-end gap-px">
        {["h-1.5", "h-2", "h-2.5"].map((height, index) => (
          <span
            key={height}
            className={`w-0.5 rounded-full ${height} ${
              index < rank ? "bg-foreground/70" : "bg-foreground/15"
            }`}
          />
        ))}
      </span>
      {WEIGHT_LABEL[weight] ?? weight}
      {points !== undefined && (
        <span className="tabular-nums">· {plural(points, "pt")}</span>
      )}
    </Badge>
  );
}

/**
 * The open proposal's spec, read when it is asked for.
 *
 * `specRevision` is the revision the proposal points at. Null, or absent on
 * a row from before specs, means there is none, and nothing is asked for.
 * `revision`, when given, reads that revision instead, by number: an
 * earlier one, from the picker.
 */
export function useProposalSpec(
  base: string,
  proposalId: string,
  specRevision: number | null | undefined,
  revision?: number,
): { readonly read: SpecRead; readonly retry: () => void } {
  const owner = decodeURIComponent(base.split("/").at(-1) ?? "");
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(
      userId,
      owner,
      "proposal-spec",
      proposalId,
      specRevision,
      revision,
    ),
    enabled: specRevision != null,
    queryFn: ({ signal }) =>
      clients.pricing.spec(owner, proposalId, signal, revision),
  });
  return {
    read:
      specRevision == null
        ? { state: "ready", spec: null }
        : query.isError
          ? { state: "failed" }
          : query.data === undefined
            ? { state: "loading" }
            : { state: "ready", spec: query.data.spec },
    retry: () => {
      void query.refetch();
    },
  };
}

/** Why the proposal is the size it is, for the head of the tab. */
export interface SizeReason {
  /** The sizing model's answer: a whole size, or "unsized". */
  readonly modelSize: string;
  /** The model's reasoning for that answer. */
  readonly rationale: string;
  /** The size a reviewer set over the model's, or null when none did. */
  readonly reviewerSize: string | null;
  /**
   * The repository snapshot the spec was drafted beside, when it was.
   * Null for a draft that was shown no outline, or one not loaded yet.
   */
  readonly outline?: {
    readonly repoFullName: string;
    readonly commitSha: string;
  } | null;
}

/** A size as it reads inside a sentence. */
function SizeName({ size }: { size: string }) {
  return <span className="font-mono font-semibold">{size}</span>;
}

/**
 * Why this size: who set it, and the model's reasoning. When a reviewer
 * overrode the model, the override leads and the model's own size and
 * reasoning follow, so what the model thought is never lost behind it.
 */
function SizeReasonBlock({ reason }: { reason: SizeReason }) {
  const unsized = reason.modelSize === "unsized";
  return (
    <section
      aria-label="Why this size"
      data-testid="spec-size-reason"
      className="bg-muted/40 flex flex-col gap-1 rounded-md px-3 py-2.5"
    >
      {reason.reviewerSize === null ? (
        <p className="text-xs font-medium">
          {unsized ? (
            "Left unsized by the model"
          ) : (
            <>
              Sized <SizeName size={reason.modelSize} /> by the model
            </>
          )}
        </p>
      ) : (
        <>
          <p className="text-xs font-medium">
            Overridden to <SizeName size={reason.reviewerSize} /> by a reviewer
          </p>
          <p className="text-muted-foreground text-xs">
            {unsized ? (
              "The model left it unsized:"
            ) : (
              <>
                The model sized it <SizeName size={reason.modelSize} />:
              </>
            )}
          </p>
        </>
      )}
      <p className="text-sm leading-relaxed">{reason.rationale}</p>
      {reason.outline != null && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="spec-outline-source"
        >
          Drafted with the repository outline from{" "}
          <span title={reason.outline.repoFullName}>
            {reason.outline.repoFullName}
          </span>{" "}
          at{" "}
          <code className="font-mono" title={reason.outline.commitSha}>
            {reason.outline.commitSha.slice(0, 7)}
          </code>
        </p>
      )}
    </section>
  );
}

/** How many scenarios the tab holds, once that is known; null until then. */
export function scenarioTotal(read: SpecRead): number | null {
  return read.state === "ready" && read.spec !== null
    ? countScenarios(read.spec.draft).total
    : null;
}

/** Where the spec's earlier revisions are read from. */
export interface SpecHistory {
  readonly base: string;
  readonly proposalId: string;
  /** The revision the proposal points at: the current one. */
  readonly specRevision: number | null;
}

/** The ways to change the spec, for a reader who may change it. */
export interface SpecChanges {
  readonly control: RespecControl;
  /** The proposal's size now, which a landed change is read against. */
  readonly size: string;
}

export function ProposalSpec({
  read,
  onRetry,
  canAnalyze,
  weightPoints = WEIGHT_POINTS,
  sizeReason,
  history,
  changes,
}: {
  read: SpecRead;
  onRetry: () => void;
  /** Whether the reader can have the ticket analyzed again. */
  canAnalyze: boolean;
  /**
   * What each weight counts for: the settings the proposal's step was
   * computed with, so the totals here are the ones the size counted.
   */
  weightPoints?: WeightPoints;
  /** Why the proposal is its size, shown above the scenarios. */
  sizeReason?: SizeReason;
  /** Where to read earlier revisions; without it there is no picker. */
  history?: SpecHistory;
  /**
   * The controls that change the spec. Absent for a reader who may not, and
   * for a proposal whose spec cannot be changed (approved, or with no step).
   */
  changes?: SpecChanges;
}) {
  const current = history?.specRevision ?? null;
  // The revision on show, when it is not the current one.
  const [viewing, setViewing] = useState<number | null>(null);
  // A change that lands moves the current revision: show it.
  useEffect(() => setViewing(null), [current]);
  const revisions = useSpecRevisions(
    history?.base ?? "",
    history?.proposalId ?? "",
    history === undefined ? null : current,
  );
  const earlier = useProposalSpec(
    history?.base ?? "",
    history?.proposalId ?? "",
    viewing,
    viewing ?? undefined,
  );
  const shown = viewing === null ? read : earlier.read;
  const spec = shown.state === "ready" ? shown.spec : null;

  return (
    <div data-testid="proposal-spec" className="flex flex-col gap-4">
      {sizeReason !== undefined && <SizeReasonBlock reason={sizeReason} />}
      {shown.state === "loading" ? (
        <LoadingLine>Loading scenarios…</LoadingLine>
      ) : shown.state === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">The scenarios could not be loaded.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={viewing === null ? onRetry : earlier.retry}
          >
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
        <SpecBody
          spec={spec}
          canAnalyze={canAnalyze}
          weightPoints={weightPoints}
          revisions={revisions}
          current={current}
          onView={(revision) =>
            setViewing(revision === current ? null : revision)
          }
          changes={viewing === null ? changes : undefined}
        />
      )}
    </div>
  );
}

/** How a revision that a reviewer asked for introduces what was asked. */
const ASKED: Readonly<Record<string, string>> = {
  expand: "Asked for",
  answer: "Answered",
};

function SpecBody({
  spec,
  canAnalyze,
  weightPoints,
  revisions,
  current,
  onView,
  changes,
}: {
  spec: BountySpecDto;
  canAnalyze: boolean;
  weightPoints: WeightPoints;
  /** Every revision, when there is more than one; else empty. */
  revisions: readonly BountySpecRevisionDto[];
  /** The revision the proposal points at. */
  current: number | null;
  onView: (revision: number) => void;
  changes: SpecChanges | undefined;
}) {
  const { draft } = spec;
  const groups = groupScenarios(draft);
  // Null when any scenario has no weight: drafted before weights existed.
  const points = pointsOf(draft, weightPoints);
  const earlier = current !== null && spec.revision !== current;
  const [form, setForm] = useState<"answer" | "instruction" | null>(null);
  const working = changes?.control.state.phase === "working";
  const ask = (change: RespecRequestDto, label: string) => {
    setForm(null);
    changes?.control.request(change, label);
  };
  return (
    <div className="flex flex-col gap-4">
      {/* What the ticket is about, and which revision of the spec this is. */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm leading-relaxed font-medium">{draft.feature}</p>
          <p className="text-muted-foreground text-xs">
            {plural(countScenarios(draft).total, "scenario")}
            {points !== null &&
              draft.scenarios.length > 0 &&
              ` · ${plural(points, "point")}`}{" "}
            ·{" "}
            {revisions.length > 1 ? (
              <RevisionPicker
                revisions={revisions}
                viewing={spec.revision}
                onView={onView}
              />
            ) : (
              `revision ${spec.revision}`
            )}
          </p>
        </div>
        {/* What the reviewer asked for, on a revision that came from it. */}
        {spec.origin !== "draft" && spec.instruction !== null && (
          <p
            className="text-muted-foreground text-xs whitespace-pre-line"
            data-testid="spec-instruction"
          >
            {ASKED[spec.origin] === undefined
              ? spec.instruction
              : `${ASKED[spec.origin]}: ${spec.instruction}`}
          </p>
        )}
      </div>

      {earlier && (
        <div
          className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2"
          data-testid="spec-earlier"
        >
          <p className="text-muted-foreground text-xs">
            An earlier revision. The size goes with revision {current}.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onView(current)}
          >
            Show current
          </Button>
        </div>
      )}

      {changes !== undefined && (
        <div className="flex flex-col gap-2" data-testid="spec-changes">
          <div className="flex flex-wrap items-center gap-2">
            <ExpandMenu
              disabled={working}
              canAnswer={draft.openQuestions.length > 0}
              onKind={(kind) =>
                ask({ mode: "expand", kinds: [kind] }, expandLabel(kind))
              }
              onAnswer={() => setForm("answer")}
              onInstruction={() => setForm("instruction")}
            />
          </div>
          {form === "answer" && (
            <AnswerForm
              questions={draft.openQuestions}
              disabled={working}
              onCancel={() => setForm(null)}
              onSubmit={(answers) =>
                ask(
                  { mode: "answer", answers },
                  answers.length === 1
                    ? "Revising the spec for your answer…"
                    : "Revising the spec for your answers…",
                )
              }
            />
          )}
          {form === "instruction" && (
            <InstructionForm
              disabled={working}
              onCancel={() => setForm(null)}
              onSubmit={(instruction) =>
                ask(
                  { mode: "expand", instruction },
                  "Writing the scenarios you asked for…",
                )
              }
            />
          )}
          <RespecStatus state={changes.control.state} size={changes.size} />
        </div>
      )}

      {points === null && (
        <p
          className="text-muted-foreground text-sm"
          data-testid="spec-unweighed"
        >
          Drafted before scenarios carried weights, so a scenario added to this
          spec cannot move the size.
          {canAnalyze &&
            " Re-analyze, on the Bounty tab, drafts it again with weights."}
        </p>
      )}

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

      {groups.map((group) => {
        const groupPoints = pointsOfScenarios(group.scenarios, weightPoints);
        return (
          <section key={group.kind} aria-label={group.label}>
            {/*
              The kind, and at the right edge, over its scenarios' pills,
              what the step counts of it.
            */}
            <h4 className="mb-1 flex items-baseline justify-between gap-3 text-xs font-medium">
              {group.label}
              {groupPoints !== null && (
                <span className="text-muted-foreground font-normal tabular-nums">
                  {plural(groupPoints, "pt")}
                </span>
              )}
            </h4>
            <ul className="flex flex-col">
              {group.scenarios.map((scenario) => (
                <ScenarioRow
                  key={scenario.id}
                  scenario={scenario}
                  weightPoints={weightPoints}
                  {...(changes === undefined
                    ? {}
                    : {
                        removing: working,
                        onRemove: () =>
                          ask(
                            { mode: "trim", removeScenarioIds: [scenario.id] },
                            `Removing “${scenario.title}”…`,
                          ),
                      })}
                />
              ))}
            </ul>
          </section>
        );
      })}

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
function ScenarioRow({
  scenario,
  weightPoints,
  removing = false,
  onRemove,
}: {
  scenario: Scenario;
  weightPoints: WeightPoints;
  /** A change is running: the remove control waits for it. */
  removing?: boolean;
  /** Takes the scenario out; absent for a reader who may not. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const steps = useId();
  return (
    <li className="relative">
      {onRemove !== undefined && (
        <span className="absolute top-0 -right-1.5 flex min-h-[2.125rem] items-center">
          <ConfirmDialog
            trigger={
              <button
                type="button"
                aria-label={`Remove scenario: ${scenario.title}`}
                title="Remove"
                disabled={removing}
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring/50 flex size-6 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            }
            title="Remove this scenario?"
            description={
              <>
                “{scenario.title}” is taken out of the spec as a new revision.
                Points added since sizing come off the size; a scenario from the
                first draft never takes it below the model&rsquo;s size.
              </>
            }
            confirmLabel="Remove scenario"
            busy={removing}
            onConfirm={onRemove}
          />
        </span>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={steps}
        className={`hover:bg-muted/60 focus-visible:ring-ring/50 -mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none focus-visible:ring-[3px] ${
          onRemove === undefined ? "" : "pr-7"
        }`}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={`text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1 leading-relaxed">{scenario.title}</span>
        {/* Centred on each other, level with the title's first line. */}
        <span className="flex min-h-[1.625rem] shrink-0 items-center gap-1.5">
          {scenario.origin !== "draft" && (
            <Badge variant="outline" className="shrink-0">
              {ORIGIN_LABEL[scenario.origin]}
            </Badge>
          )}
          {scenario.weight !== undefined && (
            <WeightBadge
              weight={scenario.weight}
              points={pointsFor(scenario.weight, weightPoints)}
              reason={scenario.weightReason}
            />
          )}
        </span>
      </button>
      {open && (
        <div id={steps} className="flex flex-col gap-1.5 pt-0.5 pb-2 pl-5">
          {/* Why it weighs what it does, before what it does. */}
          {scenario.weightReason !== undefined && (
            <p className="text-muted-foreground text-xs">
              {WEIGHT_LABEL[scenario.weight ?? ""] ?? "Weighed"}:{" "}
              {scenario.weightReason}
            </p>
          )}
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
