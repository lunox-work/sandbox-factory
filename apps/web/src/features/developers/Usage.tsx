/**
 * Usage: the runs the workspace started in the last 7, 30 or 90 days,
 * counted by family, kind and state, from `GET /orgs/:orgId/usage`. A bar
 * on each row shows its share of the largest; no chart, since a table of a
 * dozen rows reads faster than one.
 */

import { useState } from "react";

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
        description="Runs this workspace started, by family, kind and state."
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
