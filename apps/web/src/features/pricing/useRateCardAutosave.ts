import { ApiError } from "@sandbox-factory/client";
import type { RateCardDto } from "@sandbox-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_RATE_CARD,
  maximumRateCardMinor,
  rankAtLeast,
} from "sandbox-factory";
import { clients, queryKeys, useUserId } from "../../data/query";
import { editableRateAmount, fractionDigits } from "../../lib/format";

import { parseRateAmount } from "@/lib/rate-amount";

/** Who may change a rate card: owners and admins. */
export function canManage(role: string) {
  return rankAtLeast(role, "admin");
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

// The card the API saves on an organization's first run, so what the editor
// shows before anyone edits it is what that run prices with.
const DEFAULT_RATE_AMOUNTS = {
  XS: editableRateAmount(DEFAULT_RATE_CARD.xsMinor, 2),
  S: editableRateAmount(DEFAULT_RATE_CARD.sMinor, 2),
  M: editableRateAmount(DEFAULT_RATE_CARD.mMinor, 2),
  L: editableRateAmount(DEFAULT_RATE_CARD.lMinor, 2),
  XL: editableRateAmount(DEFAULT_RATE_CARD.xlMinor, 2),
};

export function useRateCardAutosave(organizationId: string, role: string) {
  const queryClient = useQueryClient();
  const userId = useUserId();
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
      const next = await queryClient.fetchQuery({
        queryKey: queryKeys.resource(userId, organizationId, "rate-card"),
        queryFn: ({ signal }) =>
          clients.pricing.rateCard(organizationId, signal),
        staleTime: 0,
      });
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
  }, [organizationId, queryClient, userId]);

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
        const card = await clients.pricing.saveRateCard(organizationId, {
          expectedRevision: savedCard.current?.revision ?? 0,
          ...next,
        });
        if (request !== generation.current) return;
        if (card === null) throw new Error("Missing saved rate card.");
        queryClient.setQueryData(
          queryKeys.resource(userId, organizationId, "rate-card"),
          card,
        );
        savedCard.current = card;
        setCard(card);
        wrote = true;
      }
      if (wrote && request === generation.current) setShowSaved(true);
    } catch (error) {
      if (request === generation.current) {
        pending.current = null;
        if (error instanceof ApiError && error.status === 409) {
          const reloaded = await load();
          if (reloaded)
            setError(
              "The rate card changed elsewhere. The latest rates have been reloaded.",
            );
        } else {
          setError(
            error instanceof ApiError
              ? error.message
              : "Could not save changes. Check your connection and retry.",
          );
          setSaveFailed(true);
        }
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
  const saveStatus:
    "saving" | "failed" | "saved" | "incomplete" | "automatic" | null = saving
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
  return {
    currency,
    setCurrency,
    values,
    setValues,
    loading,
    saving,
    error,
    loadFailed,
    saveFailed,
    load,
    save,
    saveStatus,
  };
}
