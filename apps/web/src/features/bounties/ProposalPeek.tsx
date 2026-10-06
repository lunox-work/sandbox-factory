import type {
  BountyProposalDto,
  BountyWritebackDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListChecks,
  Loader2,
  Minus,
  RefreshCw,
  Sparkles,
  Target,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  priceFor,
  WEIGHT_POINTS,
  WHOLE_BOUNTY_COMPLEXITIES,
  type WholeComplexity,
} from "sandbox-factory";
import { dateTime, modelLabel, money } from "../../lib/format";
import { capitalize, unweighed } from "./presentation";
import { type EnrichedProposal } from "./types";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledReason } from "@/components/DisabledReason";
import { ErrorBanner } from "@/components/Message";
import { ModelCard, SectionHeading } from "@/components/ReadSection";
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
  OutlineSource,
  ProposalSpec,
  scenarioTotal,
  useProposalSpec,
  useRevisionView,
} from "../../ProposalSpec";
import { PricingRubricBlock } from "../../PricingRubric";
import { JiraIcon, ModelIcon } from "../../ProviderIcon";
import { RevisionMenu, useRespec, useSpecRevisions } from "../../SpecChanges";
import { BountyText } from "../../BountyText";
import { useRepoSnapshot } from "../../useGithub";
import type { JiraIssueDetail } from "../../useJira";

/** What the bounty's freshness says; nothing while it is unchanged. */
function freshnessLabel(freshness: EnrichedProposal["freshness"]): {
  text: string;
  tone: "muted" | "warn" | "bad";
} | null {
  switch (freshness) {
    case "current":
      return null;
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

/** How long "Saved" shows after a resize lands. */
const SAVED_MS = 2_500;

/** How long after the code settles the proposal is read again. */
const RUBRIC_REREAD_MS = 1_500;

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
  sandboxPublished = false,
  busy,
  mutate,
  onChanged,
  onRemoved,
  withinBounty = false,
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
  /**
   * The bounty's sandbox is published. It stands on the approval, so the
   * approval is not taken back, by an unapprove or a re-price, until it is
   * unpublished.
   */
  sandboxPublished?: boolean;
  busy: boolean;
  mutate: (
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => Promise<boolean>;
  /** Reads the proposal again, after a change to its spec has landed. */
  onChanged: () => Promise<void>;
  onRemoved: () => void;
  /**
   * Shown inside its own bounty, which has the bounty's text and its way to
   * Jira beside it. The Spec tab and the Jira link would say them twice, so
   * they are left off, and the price and the scenarios share one page.
   */
  withinBounty?: boolean;
}) {
  const url = withinBounty ? null : (bounty?.url ?? proposal.liveUrl ?? null);
  const label = modelLabel(proposal.actualModel);
  const delivery = proposal.writebackOperations?.at(-1);
  const freshness = freshnessLabel(proposal.freshness);
  const open = proposal.status === "proposed";
  /*
    A size clicked shows at once, priced from the proposal's own card, and
    the server's answer takes its place when it lands; one it refuses goes
    back. "Saved" then shows under who set it, for a moment.
  */
  const [chosen, setChosen] = useState<WholeComplexity | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (savedAt === 0) return;
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const complexity = chosen ?? proposal.complexity;
  const amountMinor =
    chosen === null
      ? proposal.amountMinor
      : priceFor(chosen, proposal.rateCard);
  const sizedBy = chosen === null ? proposal.sizedBy : "reviewer";
  const priced = amountMinor !== null;
  const resizeTo = async (size: WholeComplexity) => {
    setChosen(size);
    const done = await mutate(
      `/proposals/${proposal.id}/resize`,
      { expectedRevision: proposal.revision, complexity: size },
      { apply: true },
    );
    setChosen(null);
    if (done) setSavedAt(Date.now());
  };
  /*
    The decision under way, so the button that started it says it is
    working. Every control waits on `busy` as before; this is only which
    one says so.
  */
  const [acting, setActing] = useState<string | null>(null);
  const act = async (
    key: string,
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => {
    setActing(key);
    try {
      return await mutate(path, body, options);
    } finally {
      setActing(null);
    }
  };
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
  /*
    The code's measurement settling is what lets the rubric size the
    proposal, server side, just after the profile is written. Read the
    proposal again once, a moment later, so the new price shows without a
    reload. Once per settled profile, so a proposal the rubric may not
    change (an approved one) is not read in a loop.
  */
  const settled =
    profile.state === "ready" &&
    profile.profile !== null &&
    (profile.profile.status === "ready" || profile.profile.status === "failed")
      ? `${profile.profile.id}:${profile.profile.status}`
      : null;
  const awaitingCode = proposal.rubric?.code.status === "pending";
  const reread = useRef<string | null>(null);
  // The latest callback, so a parent's new function does not cancel the read.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (settled === null || !awaitingCode || reread.current === settled) return;
    const timer = setTimeout(() => {
      reread.current = settled;
      void changed.current();
    }, RUBRIC_REREAD_MS);
    return () => clearTimeout(timer);
  }, [settled, awaitingCode]);
  const scenarios = scenarioTotal(spec.read);
  // Inside its bounty, the spec's revision is chosen in the header, over
  // the decision, as a sandbox's version is.
  const specRevision = proposal.specRevision ?? null;
  const specRevisions = useSpecRevisions(base, proposal.id, specRevision);
  const [viewing, setViewing] = useRevisionView(specRevision);
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
  const lowerRow = sizedBy === "model" ? "sm:row-start-2" : "sm:row-start-3";
  /*
    What the bounty was taken to ask for when it was sized. In its own tab
    after the decision, which it supports; inside its bounty, on the one
    page under the price, where "Why this size" already says why, so the
    scenarios do not say it again.
  */
  const scenarioView = (
    <ProposalSpec
      read={spec.read}
      onRetry={spec.retry}
      canAnalyze={canDecide}
      weightPoints={step?.settings.weightPoints ?? WEIGHT_POINTS}
      sizeReason={
        withinBounty
          ? undefined
          : {
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
            }
      }
      history={{
        base,
        proposalId: proposal.id,
        specRevision: proposal.specRevision ?? null,
      }}
      {...(withinBounty ? { view: { viewing, onView: setViewing } } : {})}
      {...(canChange
        ? { changes: { control: respec, size: proposal.complexity } }
        : {})}
      // Once approved, what changed since sizing is what was approved.
      {...(step === null || !open
        ? {}
        : {
            sinceSized: {
              added: step.added.map(({ id }) => id),
              removed: step.removed ?? [],
            },
          })}
    />
  );

  /*
    What the decision is checked against: which version this is, moved
    only by an approval of something changed, and under it when that
    version was approved and, when the bounty no longer says what it said
    when sized, that it changed. Given the button's height so the two sit
    level.
  */
  const versionedAt = proposal.versionedAt ?? null;
  const revision = (
    <span className="flex min-h-9 flex-col justify-center text-xs">
      <span className="flex flex-wrap items-center gap-x-1">
        <span className="font-semibold">
          {proposal.version > 0
            ? `Version ${proposal.version}`
            : "Not approved yet"}
        </span>
        {withinBounty && specRevision !== null && (
          <>
            <span className="text-muted-foreground">·</span>
            <RevisionMenu
              revisions={specRevisions}
              current={specRevision}
              viewing={viewing ?? specRevision}
              onView={(revision) =>
                setViewing(revision === specRevision ? null : revision)
              }
            />
          </>
        )}
      </span>
      <span className="flex flex-wrap gap-x-1">
        {versionedAt !== null && (
          <span className="text-muted-foreground">
            Approved <time dateTime={versionedAt}>{dateTime(versionedAt)}</time>
            {freshness !== null && " ·"}
          </span>
        )}
        {freshness !== null && (
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
        )}
      </span>
    </span>
  );
  // A published sandbox holds the approval it was published over.
  const approvalHeld = !open && sandboxPublished;
  const heldReason = approvalHeld
    ? "Unpublish the bounty's sandbox before changing its approval."
    : null;
  // An approval is made on the bounty as it was sized, so only while it
  // still says that.
  const approveBlocked =
    proposal.freshness === "current"
      ? null
      : proposal.freshness === "stale"
        ? "The bounty changed since it was sized. Re-analyze it before approving."
        : proposal.freshness === "missing"
          ? "The bounty no longer exists."
          : "Checking the bounty is unchanged since it was sized.";
  // Whether this proposal can still be approved, and so removed.
  const decidable = canDecide && open && proposal.complexity !== "unsized";
  // The decision itself: Approve for a proposed bounty, the way back for an
  // approved one.
  const decision = !canDecide ? null : open ? (
    decidable && (
      <DisabledReason reason={approveBlocked}>
        <Button
          disabled={busy || approveBlocked !== null}
          aria-busy={acting === "approve"}
          onClick={() =>
            void act("approve", `/proposals/${proposal.id}/approve`, {
              expectedRevision: proposal.revision,
            })
          }
        >
          {acting === "approve" && <Loader2 className="animate-spin" />}
          {acting === "approve" ? "Approving…" : "Approve"}
        </Button>
      </DisabledReason>
    )
  ) : (
    <DisabledReason reason={heldReason}>
      <Button
        variant="outline"
        disabled={busy || approvalHeld}
        aria-busy={acting === "unapprove"}
        onClick={() =>
          void act("unapprove", `/proposals/${proposal.id}/unapprove`, {
            expectedRevision: proposal.revision,
          })
        }
      >
        {acting === "unapprove" && <Loader2 className="animate-spin" />}
        {acting === "unapprove" ? "Unapproving…" : "Unapprove"}
      </Button>
    </DisabledReason>
  );
  /*
    The way out: a muted text link rather than a button, since it is the
    least-wanted action on the page and should read as such; the
    confirmation is where it turns red.
  */
  const remove = decidable && (
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
      title={`Remove the proposal for ${key ?? "this bounty"}?`}
      description="The bounty will have no proposal, and the next sizing run may propose it again. Nothing is posted to Jira."
      confirmLabel="Remove"
      tone="destructive"
      busy={busy}
      onConfirm={async () => {
        const removed = await mutate(`/proposals/${proposal.id}/remove`, {
          expectedRevision: proposal.revision,
        });
        if (removed) onRemoved();
      }}
    />
  );

  const price = (
    <div className="flex flex-col gap-6" data-testid="proposal-bounty">
      {/*
        Inside its bounty, the decision first: which revision is being
        decided and the button that decides it, before the long read it
        rests on.
      */}
      {withinBounty && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {revision}
          {decision}
        </div>
      )}
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
            <DisabledReason reason={heldReason}>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex cursor-pointer items-center gap-1.5 rounded-sm text-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                disabled={busy || approvalHeld}
                aria-busy={acting === "reprice"}
                onClick={() =>
                  void act("reprice", `/proposals/${proposal.id}/reprice`, {
                    expectedRevision: proposal.revision,
                    requestId: crypto.randomUUID(),
                  })
                }
              >
                <RefreshCw
                  className={`size-3.5 ${
                    acting === "reprice"
                      ? "animate-spin motion-reduce:animate-none"
                      : ""
                  }`}
                />
                Re-analyze
              </button>
            </DisabledReason>
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
            {money(amountMinor, proposal.currency)}
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

                      Five cards, one per whole size, and the size clicked
                      is the size set. A half size is where the scenario
                      step lands, never a reviewer's choice, so it has no
                      card of its own: it is shown on the card of the whole
                      size below it, which reads "S+" while it is the size
                      in force, and a click there sets the whole size.
                    */
              <div
                role="group"
                aria-label="Resize"
                className="flex min-h-12 flex-wrap items-center gap-1.5 sm:justify-end"
              >
                {complexity === "unsized" && (
                  <SizeCard size="unsized" current />
                )}
                {WHOLE_BOUNTY_COMPLEXITIES.map((size) => {
                  const current =
                    complexity === size || complexity === `${size}+`;
                  return (
                    <SizeCard
                      key={size}
                      size={current ? complexity : size}
                      current={current}
                      disabled={busy || complexity === size}
                      onClick={() => void resizeTo(size)}
                    />
                  );
                })}
              </div>
            ) : (
              <SizeCard size={proposal.complexity} current />
            )}
          </div>
          {sizedBy !== "model" && (
            <div className="text-muted-foreground flex items-baseline justify-between gap-x-6 text-xs sm:col-span-2 sm:row-start-2">
              <span>the model said {proposal.modelComplexity}</span>
              {/*
                "Saved" hangs under who set the size, out of the flow, so
                coming and going it moves nothing around it.
              */}
              <span className="relative text-right">
                {sizedBy === "rubric"
                  ? "set by the rubric"
                  : chosen === null && step !== null && step.steps > 0
                    ? `${step.base} set by a reviewer`
                    : "set by a reviewer"}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-full right-0 pt-0.5 transition-[opacity,translate] duration-300 ease-out motion-reduce:transition-none ${
                    saved
                      ? "translate-y-0 opacity-100"
                      : "-translate-y-1 opacity-0"
                  }`}
                >
                  Saved
                </span>
                <span role="status" className="sr-only">
                  {saved ? "Saved" : ""}
                </span>
              </span>
            </div>
          )}
          {/*
            The one warning a size can carry, level with the model
            and under the size it is about: an XL is a hint that
            the bounty is two.
          */}
          {complexity === "XL" && (
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
      {proposal.categories !== undefined && proposal.categories.length > 0 && (
        <div data-testid="proposal-categories">
          <SectionHeading icon={<Target />}>Why this bounty</SectionHeading>
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
                <span className="leading-relaxed">{category.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Why this price: the rubric's working, factor by factor, before
        the model's opinion, which it replaces once the code is measured.
      */}
      <PricingRubricBlock
        proposal={proposal}
        canUse={canDecide && open}
        busy={busy}
        onUse={() =>
          void mutate(
            `/proposals/${proposal.id}/rubric`,
            { expectedRevision: proposal.revision },
            { apply: true },
          )
        }
      />

      {/*
        What the model made of the bounty: why this size, without a
        rubric; beside one, its second opinion. What the spec gained
        since is marked on its scenarios.
      */}
      <div>
        <SectionHeading icon={<Sparkles />} tone="model">
          {(proposal.rubric ?? null) === null
            ? "Why this size"
            : `The model's read: ${proposal.modelComplexity}`}
        </SectionHeading>
        <ModelCard>
          <p className="text-[15px] leading-relaxed">
            {proposal.modelRationale}
          </p>
          {canDecide && unweighed(proposal) && (
            <p
              className="text-muted-foreground mt-3 border-t pt-3 text-xs"
              data-testid="proposal-unweighed"
            >
              This size has no weighed scenarios, so a scenario added later
              cannot move it. Re-analyze drafts and weighs them.
            </p>
          )}
          {/* What the scenarios' own head says where they have a tab. */}
          {withinBounty && outline !== null && (
            <OutlineSource outline={outline} className="mt-3" />
          )}
        </ModelCard>
      </div>

      <ComplexityProfileBlock
        read={profile}
        specRevision={proposal.specRevision}
      />

      {/*
        Inside its bounty, the scenarios too, on the same page: the
        last of the reasoning, before the decision made on it.
      */}
      {withinBounty && (
        <div>
          <SectionHeading icon={<ListChecks />}>Scenarios</SectionHeading>
          {scenarioView}
        </div>
      )}

      {/* A rule before the decision: what follows is the act, not the record. */}
      {(!withinBounty || remove !== false) && <Separator />}

      {withinBounty ? (
        /*
          Inside its bounty the decision heads the page, over a long
          read; only the way out is left at its foot, after the
          reasoning, where it is not reached by accident.
        */
        remove !== false && <div className="flex justify-end">{remove}</div>
      ) : (
        /*
          The decision row, after the reasoning it is made on: what it is
          checked against on the left, and on the right the decision, where
          this app puts the action a surface offers, with the way out
          centred under it.
        */
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          {revision}
          {decision !== null && decision !== false && (
            <div className="flex flex-col items-center gap-1.5">
              {decision}
              {remove}
            </div>
          )}
        </div>
      )}

      {delivery !== undefined && (
        <div>
          <p className="text-muted-foreground mb-1.5 text-xs font-medium">
            Jira
          </p>
          <DeliveryStatus operation={delivery} busy={busy} mutate={mutate} />
        </div>
      )}
    </div>
  );

  // Inside its bounty, one page with no tabs: the price, then the scenarios.
  if (withinBounty) {
    return (
      <div className="flex flex-col gap-5" data-testid="proposal-detail">
        {price}
      </div>
    );
  }

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
          {price}
        </TabsContent>
        <TabsContent value="scenarios" className="mt-2">
          {scenarioView}
        </TabsContent>
        <TabsContent value="spec" className="mt-2">
          {liveSpec === null ? (
            <p className="text-muted-foreground py-6 text-sm">
              The bounty could not be read.
            </p>
          ) : liveSpec !== undefined ? (
            <BountyText
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
