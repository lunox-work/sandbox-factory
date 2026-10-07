import { useState } from "react";
import { fractionDigits } from "../../lib/format";
import { canManage, useRateCardAutosave } from "./useRateCardAutosave";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CurrencySelect } from "@/components/CurrencySelect";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { RateSlider } from "@/components/RateSlider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
  const {
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
  } = useRateCardAutosave(organizationId, role);
  /** A currency chosen and not yet confirmed. */
  const [nextCurrency, setNextCurrency] = useState<string | null>(null);
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
                if (next !== currency) setNextCurrency(next);
              }}
            />
            {/*
              Asked first: the amounts are kept as they are, not converted,
              so 200 dollars would become 200 rupiah the moment it saved.
            */}
            <ConfirmDialog
              open={nextCurrency !== null}
              onOpenChange={(open) => {
                if (!open) setNextCurrency(null);
              }}
              title={`Price in ${nextCurrency ?? ""}?`}
              description={`The amounts stay as they are; they are not converted from ${currency}. Change each rate afterwards if they should differ.`}
              confirmLabel="Change currency"
              pendingLabel="Changing…"
              onConfirm={async () => {
                if (nextCurrency === null) return;
                setCurrency(nextCurrency);
                await save(nextCurrency, values);
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
