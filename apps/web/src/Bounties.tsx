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
import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorBanner, LoadingLine } from "@/components/Message";
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

  useEffect(() => {
    setLoading(true);
    setRuns([]);
    setProposals([]);
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

  function selectProposal(proposalId: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "proposals");
    params.set("proposal", proposalId);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
    setSelectedId(proposalId);
  }

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

  if (loading) return <LoadingLine>Loading proposals…</LoadingLine>;
  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Bounty proposals</p>
          <p className="text-muted-foreground text-sm">
            Sizing creates drafts. An owner or admin reviews each one before
            approval.
          </p>
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
      <p className="text-muted-foreground text-sm" data-testid="jira-writeback">
        {writeGranted
          ? "Approvals post a comment to the ticket and add the bounty label."
          : "Approvals stay here: this site was connected without write access. Connect it again from the Jira page to grant it."}
      </p>
      {!sizingAvailable && (
        <p className="text-muted-foreground text-sm">
          Sizing is not configured for this deployment.
        </p>
      )}
      {runs[0] !== undefined && (
        <p className="text-muted-foreground text-sm">
          Latest run:{" "}
          <span className="font-medium text-foreground">{runs[0].status}</span>{" "}
          · {runs[0].outcomes.length} result
          {runs[0].outcomes.length === 1 ? "" : "s"}
        </p>
      )}
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
      {visibleProposals.length === 0 ? (
        <p className="text-muted-foreground rounded-md border px-4 py-8 text-sm">
          No proposals match this view.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {visibleProposals.map((proposal) => (
            <li
              key={proposal.id}
              id={`proposal-${proposal.id}`}
              className={`flex flex-col gap-3 p-4 ${selectedId === proposal.id ? "ring-primary ring-2 ring-inset" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => selectProposal(proposal.id)}
                  >
                    {proposal.liveKey ?? proposal.issueKey} ·{" "}
                    {proposal.liveTitle ?? "Jira ticket"}
                  </button>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {proposal.modelRationale}
                  </p>
                </div>
                <Badge
                  variant={
                    proposal.freshness === "current" ? "secondary" : "outline"
                  }
                >
                  {proposal.freshness ?? "unknown"}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>{proposal.complexity}</Badge>
                <span>{money(proposal.amountMinor, proposal.currency)}</span>
                <span className="text-muted-foreground">
                  Model: {proposal.modelComplexity} · {proposal.modelConfidence}
                </span>
                {proposal.complexity === "XL" && (
                  <span className="text-amber-600">Consider splitting</span>
                )}
              </div>
              {proposal.writebackOperations?.at(-1) !== undefined && (
                <DeliveryStatus
                  operation={proposal.writebackOperations.at(-1)!}
                  busy={busy}
                  mutate={mutate}
                />
              )}
              {selectedId === proposal.id && detail !== null && (
                <div className="bg-muted/40 rounded-md p-3 text-sm">
                  <p className="font-medium">Proposal history</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {detail.history.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground hover:underline"
                          onClick={() => selectProposal(entry.id)}
                        >
                          {entry.status} · {entry.complexity} · revision{" "}
                          {entry.revision}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canManage(role) && (
                <div className="flex flex-wrap gap-2">
                  {proposal.status === "proposed" &&
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
                  {(proposal.status === "proposed" ||
                    proposal.status === "approved") && (
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
              )}
            </li>
          ))}
        </ul>
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
