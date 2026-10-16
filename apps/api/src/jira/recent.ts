/**
 * Jira reads kept for a short while, so a page read again, or polled, does
 * not wait on Jira each time it asks. What is kept is at most `ttlMs` old,
 * which a reader that shows Jira's state says no more precisely than that.
 *
 * Only reads on the way to an answer are kept here. A decision that turns
 * on what Jira says now (approving a price, changing its scenarios) reads
 * Jira itself.
 */

/** A minute: a person reading a page sees Jira as it was a minute ago. */
export const RECENT_JIRA_READ_MS = 60_000;

export interface RecentReads<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function recentReads<T>(
  options: { ttlMs?: number; now?: () => number; max?: number } = {},
): RecentReads<T> {
  const ttlMs = options.ttlMs ?? RECENT_JIRA_READ_MS;
  const now = options.now ?? Date.now;
  const max = options.max ?? 1_000;
  const kept = new Map<string, { readonly value: T; readonly at: number }>();
  return {
    get(key) {
      const entry = kept.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.at >= ttlMs) {
        kept.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      kept.delete(key);
      // The oldest goes first: a Map iterates in insertion order.
      if (kept.size >= max) {
        const oldest = kept.keys().next();
        if (oldest.done !== true) kept.delete(oldest.value);
      }
      kept.set(key, { value, at: now() });
    },
  };
}

/** One bounty's issue, as a key no two organizations or issues share. */
export function issueKey(
  organizationId: string,
  connectionId: string,
  issueId: string,
): string {
  // Newlines: no id may contain one.
  return [organizationId, connectionId, issueId].join("\n");
}
