import type {
  BountyProposalDto,
  BountyRunDto,
  BountyWritebackDto,
  RateCardDto,
} from "@sandbox-factory/shared";
import {
  maximumRateCardMinor,
  formatMinorUnits,
  PRICED_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";
import { ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { PeekPanel } from "@/components/PeekPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RateSlider } from "@/components/RateSlider";
import { parseRateAmount } from "@/lib/rate-amount";
import { CurrencySelect } from "@/components/CurrencySelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Field, IssueSpec, IssueSpecSkeleton } from "./IssueSpec";
import { JiraIcon } from "./ProviderIcon";
import type { JiraIssueDetail } from "./useJira";

type EnrichedProposal = BountyProposalDto & {
  freshness?: "current" | "stale" | "missing" | "unknown";
  checkedAt?: string;
  code?: string;
  liveTitle?: string;
  liveKey?: string;
  liveUrl?: string;
  writebackOperations?: BountyWritebackDto[];
};

type ProposalStatus = BountyProposalDto["status"];

interface ProposalDetail {
  proposal: BountyProposalDto;
  freshness: {
    freshness: "current" | "stale" | "missing" | "unknown";
    checkedAt: string;
    code?: string;
  };
  writebackOperations: BountyWritebackDto[];
}

function canManage(role: string): boolean {
  return role
    .split(",")
    .some((entry) => ["owner", "admin"].includes(entry.trim()));
}

function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function editableRateAmount(minor: number, digits: number): string {
  // Drop only an all-zero fraction from stored amounts. Legacy fractional
  // rates stay visible and must be corrected before the form can be saved.
  return (formatMinorUnits(minor, digits) ?? "").replace(/\.0+$/, "");
}

const MODEL_VENDORS: Record<string, string> = {
  claude: "Claude",
  deepseek: "DeepSeek",
};

/**
 * A readable name for a provider model id, e.g. `claude-sonnet-5` →
 * "Claude Sonnet 5", `deepseek-v4-pro` → "DeepSeek V4 Pro". Adjacent numeric
 * segments are a version (`4-6` → "4.6"); an eight-digit segment is a
 * snapshot date and is dropped. Unknown vendors are capitalised as-is, so a
 * new provider still reads as a name rather than an id. `null` when the
 * proposal carries no model.
 */
export function modelLabel(id: string | null | undefined): string | null {
  if (id === undefined || id === null || id.trim() === "") return null;
  const words: string[] = [];
  for (const segment of id.trim().split("-")) {
    if (segment === "") continue;
    if (/^\d{8}$/.test(segment)) continue;
    if (/^\d+$/.test(segment) && /^\d+(\.\d+)*$/.test(words.at(-1) ?? "")) {
      words[words.length - 1] = `${words.at(-1)}.${segment}`;
      continue;
    }
    words.push(
      MODEL_VENDORS[segment.toLowerCase()] ??
        segment[0]!.toUpperCase() + segment.slice(1),
    );
  }
  return words.length === 0 ? null : words.join(" ");
}

/** The distinct models that actually sized a run's tickets, in first-seen order. */
function runModels(outcomes: readonly { actualModel?: string }[]): string[] {
  const seen: string[] = [];
  for (const { actualModel } of outcomes) {
    const label = modelLabel(actualModel);
    if (label !== null && !seen.includes(label)) seen.push(label);
  }
  return seen;
}

export function money(
  amountMinor: number | null,
  currency: string | null,
): string {
  if (amountMinor === null || currency === null) return "Unpriced";
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

type RateDraft = Pick<
  RateCardDto,
  "currency" | "xsMinor" | "sMinor" | "mMinor" | "lMinor" | "xlMinor"
>;

function rateDraft(
  currency: string,
  values: Record<string, string>,
): RateDraft | null {
  const digits = fractionDigits(currency);
  const [xsMinor = 0, sMinor = 0, mMinor = 0, lMinor = 0, xlMinor = 0] = [
    "XS",
    "S",
    "M",
    "L",
    "XL",
  ].map((size) => parseRateAmount(values[size] ?? "", digits) ?? 0);
  if (
    xsMinor <= 0 ||
    sMinor < xsMinor ||
    mMinor < sMinor ||
    lMinor < mMinor ||
    xlMinor < lMinor
  )
    return null;
  return { currency, xsMinor, sMinor, mMinor, lMinor, xlMinor };
}

function sameRates(left: RateDraft, right: RateDraft | null): boolean {
  return (
    right !== null &&
    left.currency === right.currency &&
    left.xsMinor === right.xsMinor &&
    left.sMinor === right.sMinor &&
    left.mMinor === right.mMinor &&
    left.lMinor === right.lMinor &&
    left.xlMinor === right.xlMinor
  );
}

// Evenly spaced from 10 to 200, rounded to whole major currency units.
const DEFAULT_RATE_AMOUNTS = {
  XS: "10",
  S: "58",
  M: "105",
  L: "153",
  XL: "200",
};

const RATE_SAVE_STATUSES = {
  saving: "Saving…",
  failed: "Changes not saved.",
  saved: "Saved",
  incomplete: "Set XS and XL to save your rates.",
  automatic: "Changes save automatically.",
} as const;

export function RateCardEditor({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const [card, setCard] = useState<RateCardDto | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [values, setValues] =
    useState<Record<string, string>>(DEFAULT_RATE_AMOUNTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedCard = useRef<RateCardDto | null>(null);
  const pending = useRef<RateDraft | null>(null);
  const writing = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    pending.current = null;
    writing.current = false;
    setSaving(false);
    setShowSaved(false);
    setLoading(true);
    setLoadFailed(false);
    setSaveFailed(false);
    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error();
      const next = ((await response.json()) as { rateCard: RateCardDto | null })
        .rateCard;
      if (request !== generation.current) return false;
      savedCard.current = next;
      setCard(next);
      setCurrency(next?.currency ?? "USD");
      const digits = fractionDigits(next?.currency ?? "USD");
      setValues(
        next === null
          ? { ...DEFAULT_RATE_AMOUNTS }
          : {
              XS: editableRateAmount(next.xsMinor, digits),
              S: editableRateAmount(next.sMinor, digits),
              M: editableRateAmount(next.mMinor, digits),
              L: editableRateAmount(next.lMinor, digits),
              XL: editableRateAmount(next.xlMinor, digits),
            },
      );
      setError(null);
      return true;
    } catch {
      if (request === generation.current) {
        setError("Could not load the rate card.");
        setLoadFailed(true);
      }
      return false;
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      pending.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!showSaved) return;
    const timer = window.setTimeout(() => setShowSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [showSaved, card]);

  async function save(
    nextCurrency: string,
    nextValues: Record<string, string>,
  ) {
    if (!canManage(role) || loading || loadFailed) return;
    const draft = rateDraft(nextCurrency, nextValues);
    if (draft === null) {
      // A new card needs both endpoints before there is a complete rate range.
      if (nextValues.XS && nextValues.XL) {
        setError(
          `Enter positive whole-number ${nextCurrency} amounts in increasing order. Decimals are not supported.`,
        );
      }
      return;
    }
    if (draft.xlMinor > maximumRateCardMinor(nextCurrency)) {
      setError("XL cannot exceed USD 1,000.");
      return;
    }
    pending.current = draft;
    if (writing.current) return;
    const request = generation.current;
    writing.current = true;
    setSaving(true);
    setShowSaved(false);
    setError(null);
    setSaveFailed(false);
    let wrote = false;
    try {
      while (pending.current !== null && request === generation.current) {
        const next = pending.current;
        pending.current = null;
        if (sameRates(next, savedCard.current)) continue;
        const response = await fetch(
          `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
          {
            method: "PUT",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expectedRevision: savedCard.current?.revision ?? 0,
              ...next,
            }),
          },
        );
        const body = (await response.json()) as {
          rateCard?: RateCardDto;
          error?: string;
        };
        if (request !== generation.current) return;
        if (!response.ok || body.rateCard === undefined) {
          pending.current = null;
          if (response.status === 409) {
            const reloaded = await load();
            if (reloaded)
              setError(
                "The rate card changed elsewhere. The latest rates have been reloaded.",
              );
          } else {
            setError(body.error ?? "Could not save the rate card.");
            setSaveFailed(true);
          }
          return;
        }
        savedCard.current = body.rateCard;
        setCard(body.rateCard);
        wrote = true;
      }
      if (wrote && request === generation.current) setShowSaved(true);
    } catch {
      if (request === generation.current) {
        pending.current = null;
        setError("Could not save changes. Check your connection and retry.");
        setSaveFailed(true);
      }
    } finally {
      if (request === generation.current) {
        writing.current = false;
        setSaving(false);
      }
    }
  }

  const draft = rateDraft(currency, values);
  const saved = draft !== null && sameRates(draft, card);
  const saveStatus = saving
    ? "saving"
    : saveFailed
      ? "failed"
      : saved
        ? showSaved
          ? "saved"
          : null
        : !values.XS || !values.XL
          ? "incomplete"
          : "automatic";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bounty rate card</CardTitle>
        <CardDescription>
          Prices used by future runs and re-pricing. Existing proposals keep
          their saved price.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingLine />
        ) : (
          <div className="flex flex-col gap-4">
            {error !== null && (
              <ErrorBanner className="mt-0">
                {error}
                {(loadFailed || saveFailed) && (
                  <button
                    type="button"
                    disabled={saving}
                    className="ml-2 font-medium underline underline-offset-2 disabled:opacity-50"
                    onClick={() => {
                      if (loadFailed) void load();
                      else void save(currency, values);
                    }}
                  >
                    Retry
                  </button>
                )}
              </ErrorBanner>
            )}
            <CurrencySelect
              value={currency}
              disabled={!canManage(role) || loadFailed}
              onValueChange={(next) => {
                setCurrency(next);
                void save(next, values);
              }}
            />
            <RateSlider
              currency={currency}
              digits={fractionDigits(currency)}
              values={values}
              onValueChange={setValues}
              onValueCommit={(next) => {
                void save(currency, next);
              }}
              disabled={!canManage(role) || loadFailed}
            />
            {canManage(role) && (
              <div className="text-muted-foreground relative min-h-4 text-right text-xs">
                <span
                  role="status"
                  aria-label="Rate card save status"
                  aria-atomic="true"
                  className="sr-only"
                >
                  {saveStatus === null ? "" : RATE_SAVE_STATUSES[saveStatus]}
                </span>
                {Object.entries(RATE_SAVE_STATUSES).map(([state, label]) => (
                  <span
                    key={state}
                    aria-hidden="true"
                    data-save-state={state}
                    data-active={state === saveStatus}
                    className="rate-save-message"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BoardBounties({
  organizationId,
  boardId,
  role,
  writeGranted,
  readIssue,
}: {
  organizationId: string;
  boardId: string;
  role: string;
  /**
   * Whether this board's site holds the write grant. Shown, not switched:
   * the permission is asked for when a site is connected, and a site
   * without it is connected again from the Jira page to grant it.
   */
  writeGranted: boolean;
  /**
   * Reads one ticket live from Jira, for the peek's Spec tab. Passed in
   * rather than fetched here because the board page owns the Jira read and
   * the reconnect banner that answers its failures.
   */
  readIssue: (issueKey: string) => Promise<JiraIssueDetail | null>;
}) {
  const [runs, setRuns] = useState<BountyRunDto[]>([]);
  const [proposals, setProposals] = useState<EnrichedProposal[]>([]);
  const [status, setStatus] = useState<ProposalStatus>("proposed");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("proposal"),
  );
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [sizingAvailable, setSizingAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  /*
    The ticket behind the open proposal, read live for the Spec tab.

    Read when the peek opens rather than when the tab is pressed, so the
    switch to Spec is instant. `wantedKey` is what stops a slow read for one
    ticket landing in a peek that has since moved to another — or closed:
    neither `ticket` nor the selection can be read inside the resolve, both
    are stale by then, so the check is against what was last asked for.
  */
  const [ticket, setTicket] = useState<JiraIssueDetail | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const wantedKey = useRef<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(organizationId)}`;
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const [runResponse, proposalResponse, detailResponse] = await Promise.all(
        [
          fetch(`${base}/jira/boards/${encodeURIComponent(boardId)}/runs`, {
            credentials: "include",
          }),
          fetch(
            `${base}/proposals?boardId=${encodeURIComponent(boardId)}&status=${encodeURIComponent(status)}`,
            { credentials: "include" },
          ),
          ...(selectedId === null
            ? []
            : [
                fetch(
                  `${base}/proposals/${encodeURIComponent(selectedId)}?boardId=${encodeURIComponent(boardId)}`,
                  { credentials: "include" },
                ),
              ]),
        ],
      );
      if (!runResponse.ok || !proposalResponse.ok) throw new Error();
      const runBody = (await runResponse.json()) as {
        runs: BountyRunDto[];
        sizingAvailable: boolean;
      };
      const proposalBody = (await proposalResponse.json()) as {
        proposals: EnrichedProposal[];
      };
      const nextDetail =
        detailResponse === undefined || !detailResponse.ok
          ? null
          : ((await detailResponse.json()) as ProposalDetail);
      if (generation !== requestGeneration.current) return;
      setRuns(runBody.runs ?? []);
      setSizingAvailable(runBody.sizingAvailable);
      setProposals(proposalBody.proposals ?? []);
      setDetail(nextDetail);
      setError(null);
    } catch {
      if (generation === requestGeneration.current)
        setError("Could not load bounty runs and proposals.");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [base, boardId, selectedId, status]);

  /*
    The list is emptied and shown loading only when what it lists changes —
    the board or the filter. Opening a proposal also re-reads (for its
    detail), and that read must not blank the list: the row that was pressed
    is what the peek returns focus to, and a list that unmounts under an
    open peek takes the row with it.
  */
  useEffect(() => {
    setLoading(true);
    setProposals([]);
  }, [boardId, status]);
  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);
  const active = runs.find(
    (run) => run.status === "queued" || run.status === "running",
  );
  useEffect(() => {
    if (active === undefined) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  /*
    `?proposal=<id>` is the open peek, so a reload or a shared link lands on
    the same proposal, and the browser's back button closes it — the same
    contract the backlog peek had with `?issue`.
  */
  const openProposal = useCallback((proposalId: string) => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("proposal") !== proposalId) {
      params.set("proposal", proposalId);
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`,
      );
    }
    setSelectedId(proposalId);
  }, []);

  const closeProposal = useCallback((updateUrl: boolean) => {
    setSelectedId(null);
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("proposal")) {
        params.delete("proposal");
        const query = params.toString();
        window.history.pushState(
          null,
          "",
          window.location.pathname + (query === "" ? "" : `?${query}`),
        );
      }
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = new URLSearchParams(window.location.search).get("proposal");
      if (next === null || next === "") closeProposal(false);
      else setSelectedId(next);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [closeProposal]);

  const detailProposal: EnrichedProposal | null =
    detail === null
      ? null
      : {
          ...detail.proposal,
          ...detail.freshness,
          writebackOperations: detail.writebackOperations,
        };
  const visibleProposals =
    detailProposal === null ||
    proposals.some(({ id }) => id === detailProposal.id)
      ? proposals
      : [detailProposal, ...proposals];
  const selected =
    selectedId === null
      ? null
      : (visibleProposals.find(({ id }) => id === selectedId) ?? null);
  const selectedKey =
    selected === null ? null : (selected.liveKey ?? selected.issueKey);

  const loadTicket = useCallback(
    (issueKey: string) => {
      wantedKey.current = issueKey;
      setTicket(null);
      setTicketError(null);
      void readIssue(issueKey).then((result) => {
        if (wantedKey.current !== issueKey) return;
        if (result !== null) setTicket(result);
        else setTicketError("Could not load this ticket from Jira.");
      });
    },
    [readIssue],
  );
  useEffect(() => {
    if (selectedKey === null) {
      wantedKey.current = null;
      setTicket(null);
      setTicketError(null);
      return;
    }
    loadTicket(selectedKey);
  }, [selectedKey, loadTicket]);

  async function mutate(path: string, body: object): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(value.error ?? "That action could not be completed.");
        return false;
      }
      setError(null);
      await refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingLine>Loading proposals…</LoadingLine>;

  const latest = runs[0];
  const latestModels = latest === undefined ? [] : runModels(latest.outcomes);
  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}

      {/*
        The view on the left and the one action on the right: what is being
        looked at, and what can be done about it. The filter is the same
        segmented control the peek's tabs use, so the page has one idiom.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={status}
          onValueChange={(next) => setStatus(next as ProposalStatus)}
        >
          <TabsList aria-label="Proposal status">
            {(["proposed", "approved"] as const).map((candidate) => (
              <TabsTrigger key={candidate} value={candidate}>
                {candidate[0]!.toUpperCase() + candidate.slice(1)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {canManage(role) && (
          <Button
            disabled={busy || active !== undefined || !sizingAvailable}
            onClick={() =>
              void mutate(`/jira/boards/${encodeURIComponent(boardId)}/runs`, {
                requestId: crypto.randomUUID(),
              })
            }
          >
            {active === undefined ? (
              "Run sizing"
            ) : (
              <>
                <Loader2 className="animate-spin" />
                Sizing…
              </>
            )}
          </Button>
        )}
      </div>

      {/* One line of state, and a warning only when there is something to warn about. */}
      {(latest !== undefined || !sizingAvailable || !writeGranted) && (
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          {latest !== undefined && (
            <p>
              Latest run:{" "}
              <span className="text-foreground font-medium">
                {latest.status}
              </span>{" "}
              · {latest.outcomes.length} result
              {latest.outcomes.length === 1 ? "" : "s"}
              {latestModels.length > 0 && (
                <> · sized by {latestModels.join(", ")}</>
              )}
            </p>
          )}
          {!sizingAvailable && (
            <p>Sizing is not configured for this deployment.</p>
          )}
          {!writeGranted && (
            <p
              className="text-amber-700 dark:text-amber-400"
              data-testid="jira-writeback"
            >
              Approvals stay here: this site was connected without write access.
              Connect it again from the Jira page to grant it.
            </p>
          )}
        </div>
      )}

      {/*
        The list at full width, with the proposal opening over it rather than
        beside it or inside it. See `PeekPanel` for why. A row carries only
        what a scan needs — which ticket, at what size, for how much — and
        everything a decision needs is in the peek.
      */}
      <div className="overflow-hidden rounded-lg border">
        {visibleProposals.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            No {status} proposals.
          </p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="text-muted-foreground bg-muted/40 hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium sm:flex"
            >
              <span className="w-20 shrink-0">Ticket</span>
              <span className="flex-1" />
              <span className="w-12 shrink-0">Size</span>
              <span className="w-24 shrink-0 text-right">Amount</span>
              <span className="size-4 shrink-0" />
            </div>
            <ul className="divide-y" data-testid="proposal-list">
              {visibleProposals.map((proposal) => (
                <li key={proposal.id}>
                  <button
                    type="button"
                    aria-current={
                      selectedId === proposal.id ? "true" : undefined
                    }
                    className={`hover:bg-muted/50 grid w-full grid-cols-[1fr_auto_1rem] items-center gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors sm:flex sm:py-2.5 ${
                      selectedId === proposal.id ? "bg-muted" : ""
                    }`}
                    onClick={() => openProposal(proposal.id)}
                  >
                    <span className="flex min-w-0 flex-col sm:contents">
                      <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
                        {proposal.liveKey ?? proposal.issueKey}
                      </span>
                      <span className="min-w-0 text-sm sm:flex-1 sm:truncate">
                        {proposal.liveTitle ?? "Jira ticket"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 sm:contents">
                      <span className="sm:w-12 sm:shrink-0">
                        <Badge variant="outline" className="font-mono">
                          {proposal.complexity}
                        </Badge>
                      </span>
                      <span className="text-sm tabular-nums sm:w-24 sm:shrink-0 sm:text-right">
                        {money(proposal.amountMinor, proposal.currency)}
                      </span>
                    </span>
                    <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/*
        Mounted whether or not a proposal is open, so Radix can animate it
        out on close. The actions sit in the footer, outside the scrolling
        body, so a long spec never pushes Approve off the bottom.
      */}
      <PeekPanel
        open={selectedId !== null}
        onOpenChange={(next: boolean) => {
          if (!next) closeProposal(true);
        }}
        title={selected?.liveTitle ?? "Proposal"}
        description={selected?.liveKey ?? selected?.issueKey ?? undefined}
        data-testid="proposal-panel"
        footer={
          canManage(role) && selected !== null ? (
            <ProposalActions
              proposal={selected}
              busy={busy}
              mutate={mutate}
              onRemoved={() => closeProposal(true)}
            />
          ) : undefined
        }
      >
        {selected === null ? (
          <LoadingLine>Loading the proposal…</LoadingLine>
        ) : (
          <ProposalPeek
            proposal={selected}
            ticket={ticket}
            ticketError={ticketError}
            onRetryTicket={() => {
              if (selectedKey !== null) loadTicket(selectedKey);
            }}
            canDecide={canManage(role)}
            writeGranted={writeGranted}
            busy={busy}
            mutate={mutate}
          />
        )}
      </PeekPanel>
    </div>
  );
}

/** What the freshness check found, said plainly rather than as a code. */
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
      return { text: "No longer in Jira", tone: "bad" };
    default:
      return { text: "Not checked", tone: "muted" };
  }
}

function capitalize(value: string): string {
  return value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * The open proposal, in two tabs.
 *
 * Bounty is the decision — a property list of what the proposal is, the
 * model's reasoning as prose, and where delivery to Jira stands. Spec is
 * the ticket itself, read live, so the
 * decision is made against what Jira says now rather than what was stored
 * at sizing time.
 */
function ProposalPeek({
  proposal,
  ticket,
  ticketError,
  onRetryTicket,
  canDecide,
  writeGranted,
  busy,
  mutate,
}: {
  proposal: EnrichedProposal;
  ticket: JiraIssueDetail | null;
  ticketError: string | null;
  onRetryTicket: () => void;
  canDecide: boolean;
  writeGranted: boolean;
  busy: boolean;
  mutate: (path: string, body: object) => Promise<boolean>;
}) {
  const url = ticket?.url ?? proposal.liveUrl ?? null;
  const label = modelLabel(proposal.actualModel);
  const delivery = proposal.writebackOperations?.at(-1);
  const freshness = freshnessLabel(proposal.freshness);
  const priced = proposal.amountMinor !== null;
  return (
    <div className="flex flex-col gap-5" data-testid="proposal-detail">
      {/*
        The tab strip and the way out to Jira share a row: both are controls
        on this proposal, and the right edge is where this app puts the
        action a surface offers.
      */}
      <Tabs defaultValue="bounty">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="bounty">Bounty</TabsTrigger>
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

        <TabsContent value="bounty" className="mt-2">
          <div className="flex flex-col gap-6" data-testid="proposal-bounty">
            {/* The proposal as properties, the way a record reads in Notion. */}
            <div className="divide-y rounded-md border px-3">
              <Field label="Status">
                <Badge variant="secondary">{capitalize(proposal.status)}</Badge>
              </Field>
              <Field label="Size">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge className="font-mono">{proposal.complexity}</Badge>
                  {proposal.sizedBy === "reviewer" && (
                    <span className="text-muted-foreground text-xs">
                      set by a reviewer · the model said{" "}
                      {proposal.modelComplexity}
                    </span>
                  )}
                  {proposal.complexity === "XL" && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      Consider splitting
                    </span>
                  )}
                </span>
              </Field>
              <Field label="Amount">
                <span
                  className={priced ? "tabular-nums" : "text-muted-foreground"}
                >
                  {money(proposal.amountMinor, proposal.currency)}
                </span>
              </Field>
              <Field label="Sized by">
                {label === null ? (
                  proposal.actualModel
                ) : (
                  <span title={proposal.actualModel}>{label}</span>
                )}
                <span className="text-muted-foreground">
                  {" "}
                  · {proposal.modelConfidence} confidence
                </span>
              </Field>
              <Field label="Ticket">
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
              </Field>
              <Field label="Revision">{String(proposal.revision)}</Field>
            </div>

            <div>
              <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                Why this size
              </p>
              <p className="text-sm leading-relaxed">
                {proposal.modelRationale}
              </p>
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

            {canDecide && proposal.status === "proposed" && (
              <p className="text-muted-foreground text-xs">
                {writeGranted
                  ? "Approving posts a comment on the ticket and adds the bounty label."
                  : "Approving records the decision here; this site was connected without write access, so nothing is posted to Jira."}
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="spec" className="mt-2">
          {ticketError !== null ? (
            <div className="flex min-h-48 flex-col items-start justify-center gap-3">
              <ErrorBanner className="mt-0">{ticketError}</ErrorBanner>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryTicket}
              >
                <RefreshCw />
                Try again
              </Button>
            </div>
          ) : ticket === null ? (
            <IssueSpecSkeleton />
          ) : (
            <IssueSpec issue={ticket} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * What an owner or admin may do to the open proposal, in the peek's footer.
 *
 * Two states, two footers. Proposed: the decision (Approve) on the left,
 * the adjustments (Resize, Re-price) and the way out (Remove) on the right.
 * Approved: Unapprove on the left, Re-price on the right — removal comes
 * after unapproving, because that is what owes Jira the withdrawal. A
 * decision needs a current ticket; a re-price or an unapprove does not.
 */
function ProposalActions({
  proposal,
  busy,
  mutate,
  onRemoved,
}: {
  proposal: EnrichedProposal;
  busy: boolean;
  mutate: (path: string, body: object) => Promise<boolean>;
  onRemoved: () => void;
}) {
  const open = proposal.status === "proposed";
  const key = proposal.liveKey ?? proposal.issueKey;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      data-testid="proposal-actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          proposal.complexity !== "unsized" && (
            <Button
              size="sm"
              disabled={busy || proposal.freshness !== "current"}
              onClick={() =>
                void mutate(`/proposals/${proposal.id}/approve`, {
                  expectedRevision: proposal.revision,
                })
              }
            >
              Approve
            </Button>
          )
        ) : (
          <Button
            size="sm"
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
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {open && (
          <div
            role="group"
            aria-label="Resize"
            className="flex items-center gap-1.5"
          >
            <span className="text-muted-foreground mr-0.5 text-xs">Resize</span>
            {PRICED_BOUNTY_COMPLEXITIES.map((size) => (
              <Button
                key={size}
                size="sm"
                variant={proposal.complexity === size ? "secondary" : "outline"}
                className="min-w-10 px-2 font-mono"
                disabled={
                  busy ||
                  proposal.freshness !== "current" ||
                  proposal.complexity === size
                }
                aria-pressed={proposal.complexity === size}
                onClick={() =>
                  void mutate(`/proposals/${proposal.id}/resize`, {
                    expectedRevision: proposal.revision,
                    complexity: size,
                  })
                }
              >
                {size}
              </Button>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void mutate(`/proposals/${proposal.id}/reprice`, {
              expectedRevision: proposal.revision,
              requestId: crypto.randomUUID(),
            })
          }
        >
          <RefreshCw />
          Re-price
        </Button>
        {open && (
          <ConfirmDialog
            trigger={
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
              >
                Remove
              </Button>
            }
            title={`Remove the proposal for ${key}?`}
            description="The ticket will have no proposal, and the next sizing run may propose it again. Nothing is posted to Jira."
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
        )}
      </div>
    </div>
  );
}

function DeliveryStatus({
  operation,
  busy,
  mutate,
}: {
  operation: BountyWritebackDto;
  busy: boolean;
  mutate: (path: string, body: object) => Promise<boolean>;
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
