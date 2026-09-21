import type {
  BountyProposalDto,
  BountyRunDto,
  BountyWritebackDto,
  RateCardDto,
} from "@sandbox-factory/shared";
import { formatMinorUnits, parseMinorUnits } from "sandbox-factory";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

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
import { Input } from "@/components/ui/input";

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

export function RateCardEditor({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const [card, setCard] = useState<RateCardDto | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [values, setValues] = useState<Record<string, string>>({
    S: "",
    M: "",
    L: "",
    XL: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error();
      const next = ((await response.json()) as { rateCard: RateCardDto | null })
        .rateCard;
      setCard(next);
      if (next !== null) {
        const digits = fractionDigits(next.currency);
        setCurrency(next.currency);
        setValues({
          S: formatMinorUnits(next.sMinor, digits) ?? "",
          M: formatMinorUnits(next.mMinor, digits) ?? "",
          L: formatMinorUnits(next.lMinor, digits) ?? "",
          XL: formatMinorUnits(next.xlMinor, digits) ?? "",
        });
      }
      setError(null);
    } catch {
      setError("Could not load the rate card.");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const digits = fractionDigits(currency);
    const amounts = ["S", "M", "L", "XL"].map((size) =>
      parseMinorUnits(values[size] ?? "", digits),
    );
    if (amounts.some((amount) => amount === null || amount <= 0)) {
      setError(
        `Enter positive ${currency} amounts with no more than ${digits} decimal places.`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: card?.revision ?? 0,
            currency: currency.toUpperCase(),
            sMinor: amounts[0],
            mMinor: amounts[1],
            lMinor: amounts[2],
            xlMinor: amounts[3],
          }),
        },
      );
      const body = (await response.json()) as {
        rateCard?: RateCardDto;
        error?: string;
      };
      if (!response.ok || body.rateCard === undefined) {
        setError(
          response.status === 409
            ? "The rate card changed. It has been reloaded."
            : (body.error ?? "Could not save the rate card."),
        );
        if (response.status === 409) await load();
        return;
      }
      setCard(body.rateCard);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

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
          <form className="flex flex-col gap-4" onSubmit={save}>
            {error !== null && (
              <ErrorBanner className="mt-0">{error}</ErrorBanner>
            )}
            <label className="grid gap-1 text-sm font-medium">
              Currency
              <Input
                value={currency}
                maxLength={3}
                disabled={!canManage(role) || saving}
                onChange={(event) =>
                  setCurrency(event.target.value.toUpperCase())
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {["S", "M", "L", "XL"].map((size) => (
                <label key={size} className="grid gap-1 text-sm font-medium">
                  {size}
                  <Input
                    inputMode="decimal"
                    value={values[size]}
                    disabled={!canManage(role) || saving}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [size]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            {canManage(role) && (
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save rate card"}
              </Button>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function BoardBounties({
  organizationId,
  boardId,
  role,
  writebackEnabled,
}: {
  organizationId: string;
  boardId: string;
  role: string;
  writebackEnabled: boolean;
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
  const [writeback, setWriteback] = useState(writebackEnabled);
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
    setWriteback(writebackEnabled);
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh, writebackEnabled]);
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

  async function toggleWriteback() {
    setBusy(true);
    try {
      const returnTo = window.location.pathname + window.location.search;
      const response = await fetch(
        `${base}/jira/boards/${encodeURIComponent(boardId)}?returnTo=${encodeURIComponent(returnTo)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ writebackEnabled: !writeback }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        consentUrl?: string;
      };
      if (!response.ok) {
        if (body.consentUrl !== undefined)
          window.location.href = body.consentUrl;
        else setError(body.error ?? "Could not update Jira write-back.");
        return;
      }
      setWriteback(!writeback);
      setError(null);
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">
            Jira write-back: {writeback ? "On" : "Off"}
          </p>
          <p className="text-muted-foreground text-xs">
            When on, future approvals post a fixed comment and add the bounty
            label.
          </p>
        </div>
        {canManage(role) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void toggleWriteback()}
          >
            {writeback ? "Turn off" : "Grant access and turn on"}
          </Button>
        )}
      </div>
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
                    (["S", "M", "L", "XL"] as const).map((size) => (
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
