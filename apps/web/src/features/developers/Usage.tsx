/**
 * Usage, from `GET /orgs/:orgId/usage`: this month's model tokens and
 * evaluator time, each against the monthly limit new runs are refused at,
 * with its grading attempts and uploads; then the runs the workspace
 * started in the last 7, 30 or 90 days, counted by family, kind and state.
 * A bar on each row shows its share of the largest; no chart, since a
 * table of a dozen rows reads faster than one.
 */

import { useState } from "react";
import type { UsageDto } from "@sandbox-factory/shared";

import { LoadingLine, RetryableError } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

import { failureText, useUsage } from "./data";

const RANGES = [7, 30, 90] as const;

const FAMILY_LABEL: Record<string, string> = {
  sizing: "Sizing",
  analysis: "Analysis",
};

/** Seconds as a person reads them: `42 s`, `5 min`, `1 h 23 min`. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const count = (value: number) => value.toLocaleString("en-US");

/** One metered figure against its monthly limit, with how full it is. */
function Meter({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number;
  format: (value: number) => string;
}) {
  const share = Math.min(1, used / Math.max(1, limit));
  return (
    <div className="bg-background flex flex-col gap-2 px-4 py-3">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-sm tabular-nums">
        {format(used)}
        <span className="text-muted-foreground"> of {format(limit)}</span>
      </span>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${format(used)} of ${format(limit)}`}
        className="bg-muted h-1.5 overflow-hidden rounded-full"
      >
        <div
          className={cn(
            "h-full rounded-full",
            share >= 1 ? "bg-destructive" : "bg-foreground/70",
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/** A count over the month, with a line under it. */
function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="bg-background flex flex-col gap-2 px-4 py-3">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-sm tabular-nums">{count(value)}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </div>
  );
}

/** This month's metered use, against the limits that refuse new runs. */
function ThisMonth({ usage }: { usage: UsageDto }) {
  const resets = new Date(usage.modelTokens.resetsAt).toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric", timeZone: "UTC" },
  );
  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="This month"
        className="bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-4"
      >
        <Meter
          label="Model tokens"
          used={usage.modelTokens.used}
          limit={usage.modelTokens.limit}
          format={count}
        />
        <Meter
          label="Evaluator time"
          used={usage.evaluatorSeconds.used}
          limit={usage.evaluatorSeconds.limit}
          format={duration}
        />
        <Figure
          label="Grading attempts"
          value={usage.thisMonth.gradingAttempts}
          detail={`${count(usage.thisMonth.contributorGradingAttempts)} by invited contributors`}
        />
        <Figure
          label="Uploads"
          value={usage.thisMonth.uploads}
          detail="Hand-off folders uploaded as versions"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        This month (UTC). New runs are refused once a limit is reached; both
        reset on {resets}.
      </p>
    </div>
  );
}

export function Usage({ organizationId }: { organizationId: string }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const usage = useUsage(organizationId, days);
  const runs = [...(usage.data?.runs ?? [])].sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      b.count - a.count ||
      a.kind.localeCompare(b.kind),
  );
  const most = Math.max(1, ...runs.map((row) => row.count));
  const total = runs.reduce((sum, row) => sum + row.count, 0);

  return (
    <section aria-labelledby="developers-usage" className="flex flex-col gap-4">
      <SectionHeader
        id="developers-usage"
        title="Usage"
        description="This month's metered use, and the runs this workspace started, by family, kind and state."
        actions={
          <div
            role="group"
            aria-label="Window"
            className="bg-muted inline-flex rounded-md p-0.5"
          >
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={range === days}
                onClick={() => setDays(range)}
                className={cn(
                  "h-6 rounded-[5px] px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  range === days
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {range} days
              </button>
            ))}
          </div>
        }
      />

      {usage.data === undefined ? null : <ThisMonth usage={usage.data} />}

      {usage.isPending ? (
        <LoadingLine />
      ) : usage.isError ? (
        <RetryableError onRetry={() => void usage.refetch()}>
          {failureText(usage.error, "Could not load usage.")}
        </RetryableError>
      ) : runs.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No runs started in the last {days} days.
        </p>
      ) : (
        <div
          className={cn(
            "overflow-x-auto rounded-lg border transition-opacity",
            usage.isPlaceholderData && "opacity-60",
          )}
          aria-busy={usage.isFetching}
        >
          <table className="w-full text-sm">
            <caption className="sr-only">
              {`Runs in the last ${days} days`}
            </caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="eyebrow px-4 py-2 font-medium">
                  Family
                </th>
                <th scope="col" className="eyebrow px-4 py-2 font-medium">
                  Kind
                </th>
                <th scope="col" className="eyebrow px-4 py-2 font-medium">
                  State
                </th>
                <th
                  scope="col"
                  className="eyebrow px-4 py-2 text-right font-medium sm:w-[40%]"
                >
                  Runs
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((row) => (
                <tr key={`${row.family}:${row.kind}:${row.status}`}>
                  <td className="px-4 py-2">
                    {FAMILY_LABEL[row.family] ?? row.family}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs break-all">
                    {row.kind}
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {row.status}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-3">
                      <div
                        aria-hidden="true"
                        className="bg-muted hidden h-1.5 flex-1 overflow-hidden rounded-full sm:block"
                      >
                        <div
                          className="bg-foreground/70 h-full rounded-full"
                          style={{ width: `${(row.count / most) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs tabular-nums">
                        {row.count.toLocaleString("en-US")}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t">
                <th
                  scope="row"
                  colSpan={3}
                  className="px-4 py-2 text-left text-sm font-medium"
                >
                  Total
                </th>
                <td className="px-4 py-2 text-right font-mono text-xs font-medium tabular-nums">
                  {plural(total, "run")}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
