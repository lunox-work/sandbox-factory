import type {
  BountyProposalDto,
  BountyWritebackDto,
  ProposalLiveSpecDto,
  StepResultDto,
} from "@sandbox-factory/shared";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Minus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { type ReactElement } from "react";
import {
  nextHalfStep,
  SCENARIO_WEIGHTS,
  WEIGHT_POINTS,
  WHOLE_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";
import { modelLabel, money } from "../../lib/format";
import { capitalize, unweighed } from "./presentation";
import { type EnrichedProposal } from "./types";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CategoryIcon } from "../../CategoryIcon";
import {
  ComplexityProfileBlock,
  useProposalProfile,
} from "../../ComplexityProfile";
import { IssueSpec, IssueSpecSkeleton } from "../../IssueSpec";
import {
  plural,
  ProposalSpec,
  scenarioTotal,
  useProposalSpec,
  WeightBadge,
} from "../../ProposalSpec";
import { JiraIcon, ModelIcon } from "../../ProviderIcon";
import { useRespec } from "../../SpecChanges";
import { BountyText } from "../../BountyText";
import { useRepoSnapshot } from "../../useGithub";
import type { JiraIssueDetail } from "../../useJira";

function freshnessLabel(freshness: EnrichedProposal["freshness"]): {
  text: string;
  tone: "muted" | "warn" | "bad";
} {
  switch (freshness) {
    case "current":
      return { text: "Unchanged since sizing", tone: "muted" };
    case "stale":
      return { text: "Changed since sizing", tone: "warn" };
    case "missing":
      return { text: "Bounty no longer exists", tone: "bad" };
    // Not known yet: the open proposal's own read is still out.
    case undefined:
      return { text: "Checking the bounty…", tone: "muted" };
    default:
      return { text: "Not checked", tone: "muted" };
  }
}

const CONFIDENCE_MARK: Record<
  BountyProposalDto["modelConfidence"],
  { icon: ReactElement; tone: string }
> = {
  high: { icon: <ChevronUp strokeWidth={2.5} />, tone: "text-emerald-500" },
  medium: { icon: <Minus strokeWidth={2.5} />, tone: "text-muted-foreground" },
  low: { icon: <ChevronDown strokeWidth={2.5} />, tone: "text-red-500" },
};

export function ProposalPeek({
  base,
  proposal,
  bounty,
  liveSpec,
  bountyError,
  onRetryBounty,
  canDecide,
  busy,
  mutate,
  onChanged,
  onRemoved,
}: {
  /** The organization's API root, for the reads the peek makes itself. */
  base: string;
  proposal: EnrichedProposal;
  bounty: JiraIssueDetail | null;
  /**
   * The bounty as the proposal's own read returned it, for a list with no
   * Jira read of its own: undefined until that read lands, and null when it
   * found nothing to show.
   */
  liveSpec?: ProposalLiveSpecDto | null | undefined;
  bountyError: string | null;
  onRetryBounty: () => void;
  canDecide: boolean;
  busy: boolean;
  mutate: (
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => Promise<boolean>;
  /** Reads the proposal again, after a change to its spec has landed. */
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const url = bounty?.url ?? proposal.liveUrl ?? null;
  const label = modelLabel(proposal.actualModel);
  const delivery = proposal.writebackOperations?.at(-1);
  const freshness = freshnessLabel(proposal.freshness);
  const priced = proposal.amountMinor !== null;
  const open = proposal.status === "proposed";
  const key = proposal.liveKey ?? proposal.issueKey;
  // Read when the peek opens, like the bounty, so the tab opens on it.
  const spec = useProposalSpec(base, proposal.id, proposal.specRevision);
  // The commit the spec's repository outline came from, when it had one.
  const outline = useRepoSnapshot(base, proposal.repoSnapshotId ?? null);
  // What the size will point back to, measured from that repository.
  const profile = useProposalProfile(
    base,
    proposal.id,
    proposal.specRevision,
    (proposal.specRevision ?? null) !== null,
  );
  const scenarios = scenarioTotal(spec.read);
  const step = proposal.step ?? null;
  // A reviewer's changes to the spec, and the run each one starts.
  const respec = useRespec(base, proposal.id, proposal.revision, onChanged);
  // What a change moves is the step, so a proposal without one has nothing
  // to change; an approved one is unapproved first.
  const canChange =
    canDecide &&
    open &&
    step !== null &&
    (proposal.specRevision ?? null) !== null;
  // The size a resize replaces: the step's base when there is a step, so a
  // reviewer sees which whole size the half size stands on.
  const sizeBase = step?.base ?? proposal.complexity;
  // The model pill and the XL warning drop a row when the notes are shown.
  const lowerRow =
    proposal.sizedBy === "reviewer" ? "sm:row-start-3" : "sm:row-start-2";
  return (
    <div className="flex flex-col gap-5" data-testid="proposal-detail">
      {/*
        The tab strip and the way out to Jira share a row: both are controls
        on this proposal, and the right edge is where this app puts the
        action a surface offers.
      */}
      <Tabs defaultValue="price">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="price">Price</TabsTrigger>
            <TabsTrigger value="scenarios">
              Scenarios
              {scenarios !== null && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {scenarios}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="spec">Spec</TabsTrigger>
          </TabsList>
          {url !== null && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              asChild
            >
              <a href={url} target="_blank" rel="noreferrer noopener">
                <span className="size-3.5 shrink-0">
                  <JiraIcon />
                </span>
                Open in Jira
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </div>

        <TabsContent value="price" className="mt-2">
          <div className="flex flex-col gap-6" data-testid="proposal-bounty">
            {/*
              The proposal as one card: the status with the way to have
              the model look again, then the amount level with the size
              that sets it. The amount is the one number a reviewer is
              here to agree to, so it is the one thing set large.
            */}
            <div className="flex flex-col gap-4 rounded-lg border p-4 sm:p-5">
              {/* The state, and the way to have the model look again. */}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <Badge variant="secondary" className="w-fit">
                  {capitalize(proposal.status)}
                </Badge>
                {canDecide && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex cursor-pointer items-center gap-1.5 rounded-sm text-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/proposals/${proposal.id}/reprice`, {
                        expectedRevision: proposal.revision,
                        requestId: crypto.randomUUID(),
                      })
                    }
                  >
                    <RefreshCw className="size-3.5" />
                    Re-analyze
                  </button>
                )}
              </div>

              {/*
                The amount level with the size that sets it, and the
                sizing model level with the one warning a size can
                carry: a two-by-two grid, each row centred on itself.
                When a reviewer has overruled the model, a row of notes
                sits between the two — what the model said on the left,
                under the amount, and who set the size on the right,
                under the size — one row, so the two are level whatever
                the heights above them. On a phone it stacks in reading
                order instead, the notes still sharing their line.
              */}
              <div className="grid grid-cols-1 items-center gap-x-6 gap-y-2.5 sm:grid-cols-[1fr_auto]">
                <span
                  className={`text-3xl leading-none font-semibold tracking-tight sm:col-start-1 sm:row-start-1 ${
                    priced ? "tabular-nums" : "text-muted-foreground"
                  }`}
                >
                  {money(proposal.amountMinor, proposal.currency)}
                </span>
                {/* Who sized it, as a pill wearing the vendor's mark. */}
                <span
                  className={`inline-flex w-fit items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2 text-xs sm:col-start-1 ${lowerRow}`}
                >
                  <span className="flex size-3.5 shrink-0 items-center [&>svg]:size-3.5">
                    <ModelIcon model={proposal.actualModel} />
                  </span>
                  {label === null ? (
                    <span className="font-medium">{proposal.actualModel}</span>
                  ) : (
                    <span className="font-medium" title={proposal.actualModel}>
                      {label}
                    </span>
                  )}
                  {/*
                      The model's confidence as a mark: up in green, level
                      in neutral, down in red. Named for assistive
                      technology and on hover, since a shape and a colour
                      alone say nothing to a screen reader.
                    */}
                  <span
                    role="img"
                    aria-label={`${proposal.modelConfidence} confidence`}
                    title={`${proposal.modelConfidence} confidence`}
                    className={`flex shrink-0 items-center [&>svg]:size-3.5 ${CONFIDENCE_MARK[proposal.modelConfidence].tone}`}
                  >
                    {CONFIDENCE_MARK[proposal.modelConfidence].icon}
                  </span>
                </span>
                <div className="sm:col-start-2 sm:row-start-1 sm:justify-self-end">
                  {canDecide && open ? (
                    /*
                      The size is the resize: a row of cards, one per size,
                      with the current size drawn as the larger one. That
                      card is disabled, since it is not a change, but kept
                      solid rather than faded — it is the fact being shown.

                      Five cards, one per whole size. A half size is where
                      the scenario step lands, never a reviewer's choice,
                      so it has no card of its own: it is shown on the
                      card of the whole size below it, which reads "S+"
                      while it is the size in force. A reviewer sets the
                      whole size the step stands on.
                    */
                    <div
                      role="group"
                      aria-label="Resize"
                      className="flex min-h-12 flex-wrap items-center gap-1.5 sm:justify-end"
                    >
                      {proposal.complexity === "unsized" && (
                        <SizeCard size="unsized" current />
                      )}
                      {WHOLE_BOUNTY_COMPLEXITIES.map((size) => {
                        const current =
                          proposal.complexity === size ||
                          proposal.complexity === `${size}+`;
                        const isBase = sizeBase === size;
                        return (
                          <SizeCard
                            key={size}
                            size={current ? proposal.complexity : size}
                            current={current}
                            pressed={isBase}
                            disabled={busy || isBase}
                            onClick={() =>
                              void mutate(
                                `/proposals/${proposal.id}/resize`,
                                {
                                  expectedRevision: proposal.revision,
                                  complexity: size,
                                },
                                { apply: true },
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <SizeCard size={proposal.complexity} current />
                  )}
                </div>
                {proposal.sizedBy === "reviewer" && (
                  <div className="text-muted-foreground flex items-baseline justify-between gap-x-6 text-xs sm:col-span-2 sm:row-start-2">
                    <span>the model said {proposal.modelComplexity}</span>
                    <span className="text-right">
                      {step !== null && step.steps > 0
                        ? `${step.base} set by a reviewer`
                        : "set by a reviewer"}
                    </span>
                  </div>
                )}
                {/*
                  The one warning a size can carry, level with the model
                  and under the size it is about: an XL is a hint that
                  the bounty is two.
                */}
                {proposal.complexity === "XL" && (
                  <span
                    className={`flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 sm:col-start-2 sm:justify-self-end ${lowerRow}`}
                  >
                    <TriangleAlert className="size-3.5 shrink-0" />
                    Consider splitting
                  </span>
                )}
              </div>
            </div>

            {/*
              Why the run offered this bounty at all, before why it is the
              size it is: the first is the case for outsourcing it, the
              second for the price. Absent for a bounty someone added by
              hand, which needs no case made.
            */}
            {proposal.categories !== undefined &&
              proposal.categories.length > 0 && (
                <div data-testid="proposal-categories">
                  <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                    Why this bounty
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {proposal.categories.map((category) => (
                      <li
                        key={category.id}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
                      >
                        <Badge variant="outline" className="shrink-0">
                          <CategoryIcon category={category.id} />
                          {category.label}
                        </Badge>
                        <span className="leading-relaxed">
                          {category.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            {/*
              Why this size, in two parts: what the model made of the
              bounty, and then what the spec's added weight made of that.
            */}
            <div>
              <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                Why this size
              </p>
              <p className="text-sm leading-relaxed">
                {proposal.modelRationale}
              </p>
              {canDecide && unweighed(proposal) && (
                <p
                  className="text-muted-foreground mt-1.5 text-xs"
                  data-testid="proposal-unweighed"
                >
                  This size has no weighed scenarios, so a scenario added later
                  cannot move it. Re-analyze drafts and weighs them.
                </p>
              )}
            </div>

            {step !== null && <StepBlock step={step} />}

            <ComplexityProfileBlock
              read={profile}
              specRevision={proposal.specRevision}
            />

            {/* A rule before the decision: what follows is the act, not the record. */}
            <Separator />

            {/*
              The decision row, after the reasoning it is made on. On the
              left, what the decision is checked against: which revision
              this is, and under it whether the bounty still says what it
              said when sized. On the right, the decision itself — Approve for a
              proposed bounty, the way back for an approved one — where
              this app puts the action a surface offers, and centred under
              Approve, the way out: a muted text link rather than a button,
              since it is the least-wanted action on the page and should
              read as such; the confirmation is where it turns red. The left text is given the button's height so the two
              sit level whether or not Remove hangs below.
            */}
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <span className="flex h-9 flex-col justify-center text-xs">
                <span className="font-semibold">
                  Revision {proposal.revision}
                </span>
                <span
                  className={
                    freshness.tone === "warn"
                      ? "text-amber-700 dark:text-amber-400"
                      : freshness.tone === "bad"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {freshness.text}
                </span>
              </span>
              {canDecide &&
                (open ? (
                  proposal.complexity !== "unsized" && (
                    <div className="flex flex-col items-center gap-1.5">
                      <Button
                        disabled={busy || proposal.freshness !== "current"}
                        onClick={() =>
                          void mutate(`/proposals/${proposal.id}/approve`, {
                            expectedRevision: proposal.revision,
                          })
                        }
                      >
                        Approve
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline-offset-2 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                            disabled={busy}
                          >
                            Remove
                          </button>
                        }
                        title={`Remove the proposal for ${key}?`}
                        description="The bounty will have no proposal, and the next sizing run may propose it again. Nothing is posted to Jira."
                        confirmLabel="Remove"
                        tone="destructive"
                        busy={busy}
                        onConfirm={async () => {
                          const removed = await mutate(
                            `/proposals/${proposal.id}/remove`,
                            { expectedRevision: proposal.revision },
                          );
                          if (removed) onRemoved();
                        }}
                      />
                    </div>
                  )
                ) : (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/proposals/${proposal.id}/unapprove`, {
                        expectedRevision: proposal.revision,
                      })
                    }
                  >
                    Unapprove
                  </Button>
                ))}
            </div>

            {delivery !== undefined && (
              <div>
                <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                  Jira
                </p>
                <DeliveryStatus
                  operation={delivery}
                  busy={busy}
                  mutate={mutate}
                />
              </div>
            )}
          </div>
        </TabsContent>

        {/*
          What the bounty was taken to ask for when it was sized: after the
          decision, which it supports, and before the bounty it was drafted
          from.
        */}
        <TabsContent value="scenarios" className="mt-2">
          <ProposalSpec
            read={spec.read}
            onRetry={spec.retry}
            canAnalyze={canDecide}
            weightPoints={step?.settings.weightPoints ?? WEIGHT_POINTS}
            sizeReason={{
              modelSize: proposal.modelComplexity,
              rationale: proposal.modelRationale,
              // The size the reviewer chose: the step's base when the
              // spec's added weight has moved it on since.
              reviewerSize: proposal.sizedBy === "reviewer" ? sizeBase : null,
              outline:
                outline === null
                  ? null
                  : {
                      repoFullName: outline.repoFullName,
                      commitSha: outline.commitSha,
                    },
            }}
            history={{
              base,
              proposalId: proposal.id,
              specRevision: proposal.specRevision ?? null,
            }}
            {...(canChange
              ? { changes: { control: respec, size: proposal.complexity } }
              : {})}
          />
        </TabsContent>

        <TabsContent value="spec" className="mt-2">
          {liveSpec === null ? (
            <p className="text-muted-foreground py-6 text-sm">
              The bounty could not be read.
            </p>
          ) : liveSpec !== undefined ? (
            <BountyText
              issueType={liveSpec.issueType}
              description={liveSpec.descriptionText}
              inputTruncated={liveSpec.inputTruncated}
            />
          ) : bountyError !== null ? (
            <div className="flex min-h-48 flex-col items-start justify-center gap-3">
              <ErrorBanner className="mt-0">{bountyError}</ErrorBanner>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryBounty}
              >
                <RefreshCw />
                Try again
              </Button>
            </div>
          ) : bounty === null ? (
            <IssueSpecSkeleton />
          ) : (
            <IssueSpec issue={bounty} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * How the weight added to the spec since it was sized moved the size: the
 * half steps it climbed, the points behind them and what the next half
 * step needs, then the scenarios that brought the points. Nothing when no
 * weight was added, which is every fresh sizing.
 */
function StepBlock({ step }: { step: StepResultDto }) {
  if (step.addedPoints === 0) return null;
  const next = nextHalfStep(step.complexity);
  // Heaviest first: the scenarios that moved the size most lead.
  const tally = [...SCENARIO_WEIGHTS].reverse().flatMap((weight) => {
    const count = step.added.filter((added) => added.weight === weight).length;
    return count === 0 ? [] : [`${count} ${weight}`];
  });
  return (
    <div data-testid="proposal-step">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        Added to the spec
      </p>
      <p className="text-sm leading-relaxed">
        {step.steps > 0 && (
          <span className="font-mono font-medium">
            {step.base} → {step.complexity}:{" "}
          </span>
        )}
        {plural(step.addedPoints, "point")} added since it was sized
        {tally.length > 0 && ` (${tally.join(", ")})`}.
        {next !== null &&
          step.nextStepIn !== null &&
          ` ${next} needs ${step.nextStepIn} more.`}
      </p>
      {step.added.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {step.added.map((scenario) => (
            <li
              key={scenario.id}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 leading-relaxed">
                {scenario.title}
              </span>
              <span className="flex shrink-0 self-center">
                <WeightBadge
                  weight={scenario.weight}
                  points={step.settings.weightPoints[scenario.weight]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One size as a card. The current size is the larger card, drawn solid; the
 * others are small and quiet, and become buttons when `onClick` is given.
 * Without it the card is a plain label, which is what a member or an
 * approved proposal sees: the size, without the offer to change it.
 *
 * A resize does not swap elements, it swaps classes on the same cards
 * once the server answers, so the change is animated rather than snapped:
 * the old size shrinks and fades to quiet while the new one grows and
 * fills, on one eased curve. Everything that differs between the two
 * shapes is in the transition list, so nothing jumps while the rest glides.
 * Off under reduced motion.
 *
 * Three things would make that bumpy, and each is kept out on purpose:
 *
 * - The width is never set, only the minimum. A set width lands on its new
 *   value at once while the minimum is still easing, so a growing card
 *   would pop wide and then finish growing. With only the minimum in play
 *   the box follows the ease in both directions, and "unsized" is free to
 *   be wider than it is tall.
 * - The other cards keep their look while the request is in flight. They
 *   are disabled, so a second click cannot race the first, but they are not
 *   dimmed and still answer the pointer: a dim would flash across the row
 *   on every click, and dropping the hover would make the pressed card
 *   fall back to quiet before it fills.
 * - The row is as tall as the large card whatever is mid-flight. Halfway
 *   through, the old card has shrunk and the new one has not yet grown,
 *   and without a floor the row would dip and lift the amount beside it.
 */
function SizeCard({
  size,
  current,
  pressed = current,
  disabled,
  onClick,
}: {
  size: string;
  current: boolean;
  /** Whether the button stands for the size in force; the current one by default. */
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  // Square: the minimum width is the height, and the padding is small
  // enough that "XS" and "XL" fit inside it. "unsized" and a half size
  // such as "XS+" grow wider.
  const shape = current
    ? "bg-primary text-primary-foreground border-primary h-12 min-w-12 px-2 text-lg font-extrabold shadow-sm"
    : "bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 h-7 min-w-7 px-1 text-xs";
  const className = `inline-flex items-center justify-center rounded-md border font-mono font-medium transition-[height,min-width,padding,font-size,font-weight,color,background-color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${shape}`;
  if (onClick === undefined) {
    return <span className={className}>{size}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.98] motion-reduce:active:scale-100`}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {size}
    </button>
  );
}

function DeliveryStatus({
  operation,
  busy,
  mutate,
}: {
  operation: BountyWritebackDto;
  busy: boolean;
  mutate: (
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>
        Jira: <strong>{operation.status}</strong>
        {operation.step === "label" && operation.status !== "done"
          ? " (comment posted; label pending)"
          : ""}
      </span>
      {operation.status === "failed" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void mutate(`/writebacks/${operation.id}/retry`, {})}
        >
          Retry
        </Button>
      )}
      {operation.status === "uncertain" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void mutate(`/writebacks/${operation.id}/reconcile`, {})
          }
        >
          Check Jira
        </Button>
      )}
      {(operation.status === "pending" || operation.status === "failed") && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void mutate(`/writebacks/${operation.id}/cancel`, {})}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
