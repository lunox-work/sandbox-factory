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
import { ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

import { IssueSpec, IssueSpecSkeleton } from "./IssueSpec";
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
  history: BountyProposalDto[];
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

  async function mutate(path: string, body: object) {
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
        return;
      }
      setError(null);
      await refresh();
    } catch {
      setError("Could not reach the server.");
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
        The filter on the left and the one action on the right: what is
        being looked at, and what can be done about it. The pills are the
        list's own state, so they sit with it rather than under a heading.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" aria-label="Proposal status">
          {(["proposed", "approved", "rejected", "superseded"] as const).map(
            (candidate) => (
              <Button
                key={candidate}
                type="button"
                size="sm"
                variant={status === candidate ? "secondary" : "outline"}
                onClick={() => setStatus(candidate)}
              >
                {candidate[0]!.toUpperCase() + candidate.slice(1)}
              </Button>
            ),
          )}
        </div>
        {canManage(role) && (
          <Button
            disabled={busy || active !== undefined || !sizingAvailable}
            onClick={() =>
              void mutate(`/jira/boards/${encodeURIComponent(boardId)}/runs`, {
                requestId: crypto.randomUUID(),
              })
            }
          >
            {active === undefined ? "Run sizing" : "Sizing…"}
          </Button>
        )}
      </div>

      <div className="text-muted-foreground flex flex-col gap-1 text-sm">
        <p data-testid="jira-writeback">
          {writeGranted
            ? "Approvals post a comment to the ticket and add the bounty label."
            : "Approvals stay here: this site was connected without write access. Connect it again from the Jira page to grant it."}
        </p>
        {!sizingAvailable && (
          <p>Sizing is not configured for this deployment.</p>
        )}
        {latest !== undefined && (
          <p>
            Latest run:{" "}
            <span className="text-foreground font-medium">{latest.status}</span>{" "}
            · {latest.outcomes.length} result
            {latest.outcomes.length === 1 ? "" : "s"}
            {latestModels.length > 0 && (
              <> · sized by {latestModels.join(", ")}</>
            )}
          </p>
        )}
      </div>

      {/*
        The list at full width, with the proposal opening over it rather than
        beside it or inside it. See `PeekPanel` for why. The rows carry only
        what a scan needs — which ticket, at what size, for how much — and
        everything a decision needs is in the peek.
      */}
      <div className="overflow-hidden rounded-md border">
        <div className="bg-muted/25 border-b px-3 py-2.5 text-xs font-medium">
          {visibleProposals.length} {status}
        </div>
        {visibleProposals.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">
            No proposals match this view.
          </p>
        ) : (
          <ul className="divide-y" data-testid="proposal-list">
            {visibleProposals.map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  aria-current={selectedId === proposal.id ? "true" : undefined}
                  className={`hover:bg-muted/50 grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors sm:flex sm:py-2.5 ${
                    selectedId === proposal.id ? "bg-muted" : ""
                  }`}
                  onClick={() => openProposal(proposal.id)}
                >
                  <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
                    {proposal.liveKey ?? proposal.issueKey}
                  </span>
                  <span className="min-w-0 text-sm sm:flex-1 sm:truncate">
                    {proposal.liveTitle ?? "Jira ticket"}
                  </span>
                  <span className="col-start-1 row-start-2 flex shrink-0 items-center gap-2 text-xs sm:order-none sm:col-auto sm:row-auto">
                    <Badge variant="outline" className="font-mono">
                      {proposal.complexity}
                    </Badge>
                    <span className="text-muted-foreground tabular-nums">
                      {money(proposal.amountMinor, proposal.currency)}
                    </span>
                  </span>
                  <ChevronRight className="text-muted-foreground col-start-3 row-span-2 row-start-1 size-4 shrink-0 sm:order-none sm:col-auto sm:row-auto" />
                </button>
              </li>
            ))}
          </ul>
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
        title={selected?.liveKey ?? selected?.issueKey ?? "Proposal"}
        description={selected?.liveTitle ?? "Jira ticket"}
        data-testid="proposal-panel"
        footer={
          canManage(role) && selected !== null ? (
            <ProposalActions proposal={selected} busy={busy} mutate={mutate} />
          ) : undefined
        }
      >
        {selected === null ? (
          <LoadingLine>Loading the proposal…</LoadingLine>
        ) : (
          <ProposalPeek
            proposal={selected}
            history={detail === null ? null : detail.history}
            ticket={ticket}
            ticketError={ticketError}
            onRetryTicket={() => {
              if (selectedKey !== null) loadTicket(selectedKey);
            }}
            onSelectRevision={openProposal}
            busy={busy}
            mutate={mutate}
          />
        )}
      </PeekPanel>
    </div>
  );
}

/**
 * The open proposal: what it is, then two tabs.
 *
 * Bounty is the decision — size, price, what the model said and why, where
 * delivery to Jira stands, and the revisions before this one. Spec is the
 * ticket itself, read live, so the decision is made against what Jira says
 * now rather than what was stored at sizing time.
 */
function ProposalPeek({
  proposal,
  history,
  ticket,
  ticketError,
  onRetryTicket,
  onSelectRevision,
  busy,
  mutate,
}: {
  proposal: EnrichedProposal;
  /** `null` while the detail read is still in flight. */
  history: BountyProposalDto[] | null;
  ticket: JiraIssueDetail | null;
  ticketError: string | null;
  onRetryTicket: () => void;
  onSelectRevision: (proposalId: string) => void;
  busy: boolean;
  mutate: (path: string, body: object) => Promise<void>;
}) {
  const url = ticket?.url ?? proposal.liveUrl ?? null;
  const label = modelLabel(proposal.actualModel);
  const delivery = proposal.writebackOperations?.at(-1);
  return (
    <div className="flex flex-col gap-4" data-testid="proposal-detail">
      {/* What state the proposal is in, and whether the ticket has moved. */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{proposal.status}</Badge>
        <Badge
          variant={proposal.freshness === "current" ? "secondary" : "outline"}
        >
          {proposal.freshness ?? "unknown"}
        </Badge>
      </div>

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

        <TabsContent value="bounty">
          <div className="flex flex-col gap-4" data-testid="proposal-bounty">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{proposal.complexity}</Badge>
              <span className="font-medium tabular-nums">
                {money(proposal.amountMinor, proposal.currency)}
              </span>
              {proposal.complexity === "XL" && (
                <span className="text-amber-600">Consider splitting</span>
              )}
            </div>

            <div className="rounded-md border p-4 text-sm">
              <p className="text-muted-foreground text-xs">
                Model: {proposal.modelComplexity} · {proposal.modelConfidence}
                {label !== null && (
                  <>
                    {" "}
                    · <span title={proposal.actualModel}>{label}</span>
                  </>
                )}
              </p>
              <p className="mt-1.5">{proposal.modelRationale}</p>
            </div>

            {delivery !== undefined && (
              <DeliveryStatus
                operation={delivery}
                busy={busy}
                mutate={mutate}
              />
            )}

            {history !== null && (
              <div>
                <p className="text-sm font-medium">Proposal history</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {history.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-sm hover:underline"
                        aria-current={
                          entry.id === proposal.id ? "true" : undefined
                        }
                        onClick={() => onSelectRevision(entry.id)}
                      >
                        {entry.status} · {entry.complexity} · revision{" "}
                        {entry.revision}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="spec">
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
 * The enabled rules are the ones the list rows used to carry: a decision
 * needs a current ticket, a re-price does not.
 */
function ProposalActions({
  proposal,
  busy,
  mutate,
}: {
  proposal: EnrichedProposal;
  busy: boolean;
  mutate: (path: string, body: object) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="proposal-actions">
      {proposal.status === "proposed" && proposal.complexity !== "unsized" && (
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
      )}
      {proposal.status === "proposed" &&
        PRICED_BOUNTY_COMPLEXITIES.map((size) => (
          <Button
            key={size}
            size="sm"
            variant="outline"
            disabled={
              busy ||
              proposal.freshness !== "current" ||
              proposal.complexity === size
            }
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
      {(proposal.status === "proposed" || proposal.status === "approved") && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void mutate(`/proposals/${proposal.id}/reject`, {
                expectedRevision: proposal.revision,
              })
            }
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void mutate(`/proposals/${proposal.id}/reprice`, {
                expectedRevision: proposal.revision,
                requestId: crypto.randomUUID(),
              })
            }
          >
            Re-price
          </Button>
        </>
      )}
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
  mutate: (path: string, body: object) => Promise<void>;
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
