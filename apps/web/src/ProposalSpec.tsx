import { useQuery } from "@tanstack/react-query";
import { clients, queryKeys, useUserId } from "./data/query";
import { plural } from "./lib/format";
export { plural } from "./lib/format";
/**
 * A proposal's drafted spec, read-only: what the bounty asks for as
 * scenarios, grouped by kind, with the questions the bounty left open and
 * the assumptions the draft made. The peek's Scenarios tab.
 *
 * Called Scenarios rather than Spec because the peek already has a Spec
 * tab, which is the Jira issue read live. This is the other side of it:
 * what was made of the bounty when it was sized.
 *
 * The tab opens on why the bounty is the size it is: the sizing model's
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
 * as it does the bounty's, and a switch to the tab is instant. It is a
 * stored read and answers without Jira, which is why it does not ride on
 * the proposal's own read, which waits for Jira to say whether the bounty
 * changed.
 */

import type {
  BountySpecDto,
  BountySpecRevisionDto,
  RespecRequestDto,
  StepResultDto,
} from "@sandbox-factory/shared";
import {
  ChevronRight,
  CircleHelp,
  CornerDownRight,
  Lightbulb,
  RefreshCw,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  countScenarios,
  pointsOf,
  pointsOfScenarios,
  SCENARIO_KIND_DEFINITIONS,
  SCENARIO_WEIGHT_DEFINITIONS,
  SCENARIO_WEIGHTS,
  WEIGHT_POINTS,
  type Scenario,
  type ScenarioWeight,
} from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LoadingLine } from "@/components/Message";
import { ModelCard } from "@/components/ReadSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
export const ORIGIN_LABEL: Record<
  Exclude<Scenario["origin"], "draft">,
  string
> = {
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
export function pointsFor(
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
      className="text-muted-foreground bg-background/60 shrink-0 gap-1.5 rounded-full px-2 font-normal"
      title={reason}
      data-weight={weight}
    >
      <span aria-hidden="true" className="flex items-end gap-px">
        {["h-1.5", "h-2", "h-2.5"].map((height, index) => (
          <span
            key={height}
            className={`w-0.5 rounded-full ${height} ${
              index < rank ? "bg-primary" : "bg-foreground/15"
            }`}
          />
        ))}
      </span>
      <span className="text-foreground/90">
        {WEIGHT_LABEL[weight] ?? weight}
      </span>
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
  return (
    <span className="border-primary/30 bg-primary/10 text-primary mx-0.5 rounded-[4px] border px-1 py-px font-mono text-[11px] font-semibold">
      {size}
    </span>
  );
}

/**
 * Why this size: who set it, and the model's reasoning. When a reviewer
 * overrode the model, the override leads and the model's own size and
 * reasoning follow, so what the model thought is never lost behind it.
 */
function SizeReasonBlock({ reason }: { reason: SizeReason }) {
  const unsized = reason.modelSize === "unsized";
  return (
    <ModelCard
      as="section"
      aria-label="Why this size"
      data-testid="spec-size-reason"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-(image:--brand-gradient) text-white shadow-sm shadow-blue-500/20 [&>svg]:size-3.5"
        >
          <Sparkles />
        </span>
        <div className="flex min-h-6 min-w-0 flex-col justify-center gap-0.5">
          {reason.reviewerSize === null ? (
            <p className="text-sm font-semibold tracking-tight">
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
              <p className="text-sm font-semibold tracking-tight">
                Overridden to <SizeName size={reason.reviewerSize} /> by a
                reviewer
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
        </div>
      </div>
      <p className="mt-3 text-[15px] leading-relaxed">{reason.rationale}</p>
      {reason.outline != null && (
        <OutlineSource outline={reason.outline} className="mt-3" />
      )}
    </ModelCard>
  );
}

/** The repository snapshot a spec was drafted beside, said in a line. */
export function OutlineSource({
  outline,
  className,
}: {
  outline: NonNullable<SizeReason["outline"]>;
  className?: string;
}) {
  return (
    <p
      className={cn("text-muted-foreground text-xs", className)}
      data-testid="spec-outline-source"
    >
      Drafted with the repository outline from{" "}
      <span title={outline.repoFullName}>{outline.repoFullName}</span> at{" "}
      <code className="font-mono" title={outline.commitSha}>
        {outline.commitSha.slice(0, 7)}
      </code>
    </p>
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

/**
 * Which revision is on show: null for the current one. A change that lands
 * moves the current revision, and the view goes with it.
 */
export function useRevisionView(current: number | null) {
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => setViewing(null), [current]);
  return [viewing, setViewing] as const;
}

/** The revision on show, when it is chosen above the spec. */
export interface RevisionView {
  readonly viewing: number | null;
  readonly onView: (revision: number | null) => void;
}

/** The ways to change the spec, for a reader who may change it. */
export interface SpecChanges {
  readonly control: RespecControl;
  /** The proposal's size now, which a landed change is read against. */
  readonly size: string;
}

/**
 * What the spec gained and lost since it was sized, marked on the current
 * revision: the ids of the scenarios added, and the scenarios trimmed,
 * which the revision no longer has to show.
 */
export interface SinceSized {
  readonly added: readonly string[];
  readonly removed: readonly StepResultDto["added"][number][];
}

/**
 * The changes a revision on show is marked with, as a change tracker draws
 * them. Some of its scenarios are marked where they stand; the other side's
 * scenarios, which it does not have, follow under their kind.
 */
export interface SpecDiff {
  /** Scenarios on show, drawn as added. */
  readonly added: ReadonlySet<string>;
  /** Scenarios on show, drawn as removed. */
  readonly removed: ReadonlySet<string>;
  /** Scenarios not on show, drawn as added: the next revision's. */
  readonly gained: readonly Scenario[];
  /** Scenarios not on show, drawn as removed: trimmed since sizing. */
  readonly lost: readonly StepResultDto["added"][number][];
  /** When the changes were made, as a screen reader hears it. */
  readonly when: string;
}

/** The current revision's changes: what it gained and lost since sizing. */
function sinceSizedDiff(since: SinceSized): SpecDiff {
  return {
    added: new Set(since.added),
    removed: new Set(),
    gained: [],
    lost: since.removed,
    when: "since sizing",
  };
}

/**
 * An earlier revision's changes: what the revision after it took out of
 * it and put in. Scenarios keep their ids across revisions, so the two
 * are matched by id.
 */
function nextRevisionDiff(shown: BountySpecDto, next: BountySpecDto): SpecDiff {
  const before = new Set(shown.draft.scenarios.map(({ id }) => id));
  const after = new Set(next.draft.scenarios.map(({ id }) => id));
  return {
    added: new Set(),
    removed: new Set([...before].filter((id) => !after.has(id))),
    gained: next.draft.scenarios.filter(({ id }) => !before.has(id)),
    lost: [],
    when: `in revision ${next.revision}`,
  };
}

/**
 * The spec on show: the current revision's read, or an earlier one's when
 * one is chosen, with the changes it is marked with.
 */
export interface ShownSpec {
  readonly read: SpecRead;
  /** The spec on show, once it is read; null until then or when none. */
  readonly spec: BountySpecDto | null;
  /** The revision the proposal points at, which the price goes with. */
  readonly current: number | null;
  /** An earlier revision on show; null for the current one. */
  readonly viewing: number | null;
  readonly onView: (revision: number | null) => void;
  /** Every revision, when there is more than one; else empty. */
  readonly revisions: readonly BountySpecRevisionDto[];
  readonly diff: SpecDiff | undefined;
  /** Reads the revision on show again, after it failed. */
  readonly retry: () => void;
}

/**
 * Which revision of the spec is on show, read, and marked: the current one
 * with what changed since sizing, an earlier one with what the revision
 * after it changed.
 */
export function useShownSpec({
  read,
  onRetry,
  history,
  sinceSized,
  view,
}: {
  read: SpecRead;
  onRetry: () => void;
  history?: SpecHistory | undefined;
  sinceSized?: SinceSized | undefined;
  view?: RevisionView | undefined;
}): ShownSpec {
  const current = history?.specRevision ?? null;
  // The revision on show, when it is not the current one.
  const own = useRevisionView(current);
  const viewing = view === undefined ? own[0] : view.viewing;
  const setViewing = view === undefined ? own[1] : view.onView;
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
  // The revision after the earlier one on show, which its changes are read
  // against: the current one is already read.
  const next =
    viewing === null
      ? null
      : (revisions
          .map(({ revision }) => revision)
          .filter((revision) => revision > viewing)
          .sort((a, b) => a - b)[0] ?? null);
  const following = useProposalSpec(
    history?.base ?? "",
    history?.proposalId ?? "",
    next === current ? null : next,
    next ?? undefined,
  );
  const nextRead =
    next === null ? null : next === current ? read : following.read;
  const nextSpec = nextRead?.state === "ready" ? nextRead.spec : null;
  const diff =
    viewing === null
      ? sinceSized === undefined
        ? undefined
        : sinceSizedDiff(sinceSized)
      : spec === null || nextSpec === null
        ? undefined
        : nextRevisionDiff(spec, nextSpec);
  return {
    read: shown,
    spec,
    current,
    viewing,
    onView: setViewing,
    revisions,
    diff,
    retry: viewing === null ? onRetry : earlier.retry,
  };
}

export function ProposalSpec({
  read,
  onRetry,
  canAnalyze,
  weightPoints = WEIGHT_POINTS,
  sizeReason,
  history,
  changes,
  sinceSized,
  view,
}: {
  read: SpecRead;
  onRetry: () => void;
  /** Whether the reader can have the bounty analyzed again. */
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
  /**
   * Marked on the current revision. An earlier one is marked with what the
   * revision after it changed instead.
   */
  sinceSized?: SinceSized;
  /**
   * The revision on show, chosen above the spec, as inside a bounty: the
   * spec follows it and has no picker of its own.
   */
  view?: RevisionView;
}) {
  const {
    read: shown,
    spec,
    current,
    viewing,
    onView: setViewing,
    revisions,
    diff,
    retry,
  } = useShownSpec({ read, onRetry, history, sinceSized, view });

  return (
    <div data-testid="proposal-spec" className="flex flex-col gap-4">
      {sizeReason !== undefined && <SizeReasonBlock reason={sizeReason} />}
      {shown.state === "loading" ? (
        <LoadingLine>Loading scenarios…</LoadingLine>
      ) : shown.state === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">The scenarios could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      ) : spec === null ? (
        <p className="text-muted-foreground text-sm" data-testid="spec-empty">
          No scenarios were drafted for this proposal.
          {canAnalyze &&
            " Re-analyze drafts them from the bounty as it is now."}
        </p>
      ) : (
        <SpecBody
          spec={spec}
          canAnalyze={canAnalyze}
          weightPoints={weightPoints}
          revisions={revisions}
          picker={view === undefined}
          current={current}
          onView={(revision) =>
            setViewing(revision === current ? null : revision)
          }
          changes={viewing === null ? changes : undefined}
          diff={diff}
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
  picker,
  current,
  onView,
  changes,
  diff,
}: {
  spec: BountySpecDto;
  canAnalyze: boolean;
  weightPoints: WeightPoints;
  /** Every revision, when there is more than one; else empty. */
  revisions: readonly BountySpecRevisionDto[];
  /** Whether the revision is named, and chosen, here. */
  picker: boolean;
  /** The revision the proposal points at. */
  current: number | null;
  onView: (revision: number) => void;
  changes: SpecChanges | undefined;
  diff: SpecDiff | undefined;
}) {
  const { draft } = spec;
  // Each kind with what it has, and after it what the other side of the
  // diff has instead: a kind with nothing on show still shows its lines.
  const groups = SCENARIO_KIND_DEFINITIONS.flatMap(({ id, label }) => {
    const scenarios = draft.scenarios.filter(({ kind }) => kind === id);
    const gained = (diff?.gained ?? []).filter(({ kind }) => kind === id);
    const gone = (diff?.lost ?? []).filter(({ kind }) => kind === id);
    return scenarios.length + gained.length + gone.length === 0
      ? []
      : [{ kind: id, label, scenarios, gained, gone }];
  });
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
      {/* What the bounty is about, and which revision of the spec this is. */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-[15px] leading-snug font-semibold tracking-tight">
            {draft.feature}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {plural(countScenarios(draft).total, "scenario")}
            {points !== null &&
              draft.scenarios.length > 0 &&
              ` · ${plural(points, "point")}`}
            {picker && (
              <>
                {" "}
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
              </>
            )}
          </p>
        </div>
        {/* What the reviewer asked for, on a revision that came from it. */}
        {spec.origin !== "draft" && spec.instruction !== null && (
          <p
            className="text-muted-foreground flex items-start gap-1.5 text-xs"
            data-testid="spec-instruction"
          >
            <CornerDownRight
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            <span className="min-w-0 whitespace-pre-line">
              {ASKED[spec.origin] === undefined
                ? spec.instruction
                : `${ASKED[spec.origin]}: ${spec.instruction}`}
            </span>
          </p>
        )}
      </div>

      {earlier && (
        <div
          className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
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
          {canAnalyze && " Re-analyze drafts it again with weights."}
        </p>
      )}

      {/*
        The scenarios as one list, a band per kind: what the background
        sets up, then each kind with what the step counts of it.
      */}
      {(draft.background.length > 0 || groups.length > 0) && (
        <div className="bg-card divide-y overflow-hidden rounded-xl border">
          {draft.background.length > 0 && (
            <section aria-label="Background">
              <h4 className={GROUP_HEAD}>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="bg-muted-foreground/50 size-1.5 rounded-full"
                  />
                  Background
                </span>
              </h4>
              <div className={cn(STEPS_INSET, "py-3")}>
                <Steps
                  steps={draft.background.map((text, index) => ({
                    keyword: index === 0 ? "Given" : "And",
                    text,
                  }))}
                />
              </div>
            </section>
          )}

          {groups.map((group) => {
            const groupPoints = pointsOfScenarios(
              group.scenarios,
              weightPoints,
            );
            return (
              <section key={group.kind} aria-label={group.label}>
                {/*
              The kind, and at the right edge, over its scenarios' pills,
              what the step counts of it.
            */}
                <h4 className={GROUP_HEAD}>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        KIND_TONE[group.kind] ?? "bg-muted-foreground/50",
                      )}
                    />
                    {group.label}
                  </span>
                  {groupPoints !== null && (
                    <span className="font-normal tracking-normal normal-case tabular-nums">
                      {plural(groupPoints, "pt")}
                    </span>
                  )}
                </h4>
                <ul className="divide-border/60 divide-y">
                  {group.scenarios.map((scenario) => (
                    <ScenarioRow
                      key={scenario.id}
                      scenario={scenario}
                      weightPoints={weightPoints}
                      change={
                        diff?.added.has(scenario.id)
                          ? "added"
                          : diff?.removed.has(scenario.id)
                            ? "removed"
                            : undefined
                      }
                      when={diff?.when}
                      {...(changes === undefined
                        ? {}
                        : {
                            removing: working,
                            onRemove: () =>
                              ask(
                                {
                                  mode: "trim",
                                  removeScenarioIds: [scenario.id],
                                },
                                `Removing “${scenario.title}”…`,
                              ),
                          })}
                    />
                  ))}
                  {group.gained.map((scenario) => (
                    <ScenarioRow
                      key={`added-${scenario.id}`}
                      scenario={scenario}
                      weightPoints={weightPoints}
                      change="added"
                      when={diff?.when}
                    />
                  ))}
                  {group.gone.map((scenario) => (
                    <RemovedRow
                      key={`removed-${scenario.id}`}
                      scenario={scenario}
                      weightPoints={weightPoints}
                      inset={changes !== undefined}
                      when={diff?.when ?? "since sizing"}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {draft.scenarios.length === 0 && (
        <p className="text-muted-foreground text-sm">
          The bounty did not describe behaviour to write a scenario for.
        </p>
      )}

      <Notes
        heading="Open questions"
        notes={draft.openQuestions}
        icon={CircleHelp}
        tone="text-amber-500"
      />
      <Notes
        heading="Assumptions"
        notes={draft.assumptions}
        icon={Lightbulb}
        tone="text-sky-500"
      />
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
  change,
  when = "since sizing",
  removing = false,
  onRemove,
}: {
  scenario: Scenario;
  weightPoints: WeightPoints;
  /** Added or removed by the diff on show: drawn as that diff line. */
  change?: keyof typeof DIFF_TONE | undefined;
  /** When it was, as a screen reader hears it. */
  when?: string | undefined;
  /** A change is running: the remove control waits for it. */
  removing?: boolean;
  /** Takes the scenario out; absent for a reader who may not. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const steps = useId();
  const added = change === "added";
  return (
    <li className="relative" data-change={change}>
      {onRemove !== undefined && (
        <span className="absolute top-2.5 right-3 z-10 flex h-lh items-center text-sm leading-relaxed">
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
        className={cn(
          ROW,
          "hover:bg-muted/40 focus-visible:ring-ring/50 w-full cursor-pointer text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-inset",
          open && "bg-muted/25",
          onRemove !== undefined && "pr-12",
          change !== undefined && DIFF_TONE[change],
          change === "added" && "hover:bg-emerald-500/15",
          change === "removed" && "hover:bg-red-500/15",
        )}
        onClick={() => setOpen((value) => !value)}
      >
        {change !== undefined && <DiffMark change={change} />}
        {/* Every mark is a line tall, so all of them centre on the title's
            first line, however many lines it wraps to. */}
        <span className="flex h-lh shrink-0 items-center">
          <ChevronRight
            aria-hidden="true"
            className={`text-muted-foreground size-3.5 transition-transform duration-150 motion-reduce:transition-none ${
              open ? "rotate-90" : ""
            }`}
          />
        </span>
        <span className="min-w-0 flex-1">
          {change !== undefined && (
            <span className="sr-only">
              {change === "added" ? "Added" : "Removed"} {when}:{" "}
            </span>
          )}
          {scenario.title}
        </span>
        <span className="flex h-lh shrink-0 items-center gap-1.5">
          {/* The "+" already says an expansion was added. */}
          {scenario.origin !== "draft" &&
            !(added && scenario.origin === "expansion") && (
              <Badge
                variant="outline"
                className="border-primary/25 bg-primary/10 text-primary shrink-0 rounded-full px-2"
              >
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
        <div
          id={steps}
          className={cn(
            STEPS_INSET,
            "bg-muted/25 flex flex-col gap-2.5 pb-3.5",
          )}
        >
          {/* Why it weighs what it does, before what it does. */}
          {scenario.weightReason !== undefined && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {WEIGHT_LABEL[scenario.weight ?? ""] ?? "Weighed"}:{" "}
              {scenario.weightReason}
            </p>
          )}
          <div className="bg-background/60 rounded-lg border px-3 py-2.5">
            <Steps steps={scenario.steps} />
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * A row of the scenario list. Its inset leaves a gutter on the left for a
 * diff line's mark, so a chevron and title stay in one column with every
 * other row's, and under the kind's name.
 */
const ROW =
  "relative flex items-start gap-2 px-5 py-2.5 text-sm leading-relaxed";

/** A kind's band at the head of its rows, its name in the rows' column. */
const GROUP_HEAD =
  "bg-muted/30 text-muted-foreground flex items-center justify-between gap-3 px-5 py-2 text-[11px] font-semibold tracking-wider uppercase";

/** Under a row, in the title's column: past the inset, the chevron and the gap. */
const STEPS_INSET = "pr-5 pl-[calc(1.25rem+0.875rem+0.5rem)]";

/** Each kind's mark beside its name: green for the path that works, and on. */
export const KIND_TONE: Readonly<Record<string, string>> = {
  happy: "bg-emerald-500",
  boundary: "bg-amber-500",
  unhappy: "bg-rose-500",
  recovery: "bg-sky-500",
  permission: "bg-violet-500",
  concurrency: "bg-blue-500",
  "non-functional": "bg-slate-400",
};

/** A diff line's tint and ink, as a change tracker draws them. */
export const DIFF_TONE = {
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  removed: "bg-red-500/10 text-red-700 dark:text-red-400",
} as const;

/** A diff line's "+" or "−", in the gutter its line reaches into. */
export function DiffMark({ change }: { change: keyof typeof DIFF_TONE }) {
  return (
    <span
      aria-hidden="true"
      className="absolute top-2.5 left-1.5 flex h-lh w-3 items-center justify-center font-mono select-none"
    >
      {change === "added" ? "+" : "−"}
    </span>
  );
}

/**
 * A scenario trimmed since sizing, as a diff's removed line under its kind.
 * Only its title and weight are kept, so it does not open.
 */
function RemovedRow({
  scenario,
  weightPoints,
  inset,
  when,
}: {
  scenario: StepResultDto["added"][number];
  weightPoints: WeightPoints;
  /** Clear of the remove control the rows above it carry. */
  inset: boolean;
  /** When it was removed, as a screen reader hears it. */
  when: string;
}) {
  return (
    <li
      data-change="removed"
      className={cn(ROW, DIFF_TONE.removed, inset && "pr-12")}
    >
      <DiffMark change="removed" />
      {/* Where a chevron would be: it does not open. */}
      <span aria-hidden="true" className="w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="sr-only">Removed {when}: </span>
        {scenario.title}
      </span>
      <span className="flex h-lh shrink-0 items-center">
        <WeightBadge
          weight={scenario.weight}
          points={pointsFor(scenario.weight, weightPoints)}
        />
      </span>
    </li>
  );
}

/** Gherkin steps, the keywords in a column so the sentences line up. */
export function Steps({
  steps,
}: {
  steps: readonly { readonly keyword: string; readonly text: string }[];
}) {
  return (
    <ol className="flex flex-col gap-1 text-sm leading-relaxed">
      {steps.map((step, index) => (
        <li key={index} className="flex items-baseline gap-2.5">
          <span className="text-primary/80 w-11 shrink-0 text-right font-mono text-[11px] font-semibold tracking-wide uppercase">
            {step.keyword}
          </span>
          <span className="min-w-0">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The spec's open questions or its assumptions, as a card, numbered. */
function Notes({
  heading,
  notes,
  icon: Icon,
  tone,
}: {
  heading: string;
  notes: readonly string[];
  icon: LucideIcon;
  /** The icon's colour. */
  tone: string;
}) {
  if (notes.length === 0) return null;
  return (
    <section
      aria-label={heading}
      className="bg-card overflow-hidden rounded-xl border"
    >
      <h4 className="flex items-center gap-2 border-b px-5 py-2.5 text-sm font-semibold tracking-tight">
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
        {heading}
        <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] leading-[18px] font-medium tabular-nums">
          {notes.length}
        </span>
      </h4>
      <ol className="marker:text-muted-foreground list-decimal space-y-1.5 py-3 pr-5 pl-10 text-sm leading-relaxed marker:text-xs marker:tabular-nums">
        {notes.map((note, index) => (
          <li key={index} className="pl-1">
            {note}
          </li>
        ))}
      </ol>
    </section>
  );
}
