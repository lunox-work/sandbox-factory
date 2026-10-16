import { sql, type SQL } from "drizzle-orm";

import type { QueryExecutor } from "./errors.js";

/**
 * What a page following a run is told, with Postgres `NOTIFY`: something it
 * may show has changed. Sent beside the queue's own channels, inside the
 * write that made the change, so it arrives once the change is visible.
 * Like them it is a hint: the page reads the run again, and keeps a slow
 * timer for a notification lost to a reconnect.
 */
export const RUN_CHANGED_CHANNEL = "run_changed";

/**
 * What changed: an analysis run, a bounty run, or a proposal's profiles
 * (named by the proposal, as the page reads them).
 */
export const RUN_CHANGE_KINDS = ["analysis", "bounty", "profile"] as const;
export type RunChangeKind = (typeof RUN_CHANGE_KINDS)[number];

export interface RunChange {
  readonly organizationId: string;
  readonly kind: RunChangeKind;
  readonly id: string;
}

export function runChangePayload(change: RunChange): string {
  return JSON.stringify({
    o: change.organizationId,
    k: change.kind,
    i: change.id,
  });
}

/** The change a payload names, or null for one this build cannot read. */
export function parseRunChange(payload: string): RunChange | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { o, k, i } = value as Record<string, unknown>;
  if (typeof o !== "string" || typeof i !== "string") return null;
  const kind = RUN_CHANGE_KINDS.find((each) => each === k);
  return kind === undefined ? null : { organizationId: o, kind, id: i };
}

/** The `pg_notify` call, for a statement that sends another beside it. */
export function notifyChange(change: RunChange): SQL {
  return sql`pg_notify(${RUN_CHANGED_CHANNEL}, ${runChangePayload(change)})`;
}

export async function announceChange(
  tx: QueryExecutor,
  change: RunChange,
): Promise<void> {
  await tx.execute(sql`select ${notifyChange(change)}`);
}
