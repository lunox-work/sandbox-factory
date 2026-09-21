/**
 * A fake for Drizzle's query builder, so the Postgres store is tested without
 * a container. Drizzle's builders are thenable chains, so the fake returns
 * objects that are both chainable and awaitable. It records calls rather than
 * interpreting SQL: the target is the store's own logic, not Postgres.
 */

import type { Database } from "../src/errors.js";

export interface FakeCall {
  readonly kind: "select" | "insert" | "update" | "delete";
  readonly values?: Record<string, unknown>;
  /**
   * The `set` clause of an upsert's conflict branch, when there was one.
   *
   * Recorded because it is not the same as `values`, and the difference is
   * load-bearing: an upsert whose conflict branch is narrower than its insert
   * is how a row keeps settings somebody chose while its other columns are
   * refreshed. A fake that dropped this would let that distinction vanish.
   */
  readonly conflictSet?: Record<string, unknown>;
  readonly ordered?: boolean;
  /**
   * Whether a `where` was applied at all. Owner scoping is otherwise invisible
   * to a fake that only sees rows; this at least catches a store that stops
   * filtering entirely.
   */
  readonly filtered?: boolean;
  readonly limited?: number;
  readonly ignoredConflict?: boolean;
}

export interface FakeDb {
  readonly db: Database;
  readonly calls: FakeCall[];
}

type FakeResponse = readonly unknown[] | Error;
type RowsProvider = () => FakeResponse;

/** A chain that resolves to `rows` however far it is followed. */
function chain(
  response: FakeResponse,
  onOrder?: () => void,
  onWhere?: () => void,
  onConflict?: (set: Record<string, unknown>) => void,
  onLimit?: (limit: number) => void,
  onConflictNothing?: () => void,
): unknown {
  const result: Record<string, unknown> = {
    from: () => result,
    where: () => {
      onWhere?.();
      return result;
    },
    returning: () => result,
    set: () => result,
    values: () => result,
    onConflictDoUpdate: (config: { set?: Record<string, unknown> }) => {
      onConflict?.(config.set ?? {});
      return result;
    },
    onConflictDoNothing: () => {
      onConflictNothing?.();
      return result;
    },
    innerJoin: () => result,
    leftJoin: () => result,
    orderBy: () => {
      onOrder?.();
      return result;
    },
    limit: (limit: number) => {
      onLimit?.(limit);
      return result;
    },
    then: (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) =>
      response instanceof Error ? reject?.(response) : resolve([...response]),
  };
  return result;
}

/**
 * @param rows what every query resolves to; pass `[]` to simulate a miss.
 *
 * Deliberately `readonly unknown[]` rather than one table's row type: the fake
 * never inspects a row, it only hands it back, and typing it to a single
 * table's row would mean a second copy of this file for every table added.
 */
function createFakeDbWith(rowsForQuery: RowsProvider): FakeDb {
  const calls: FakeCall[] = [];

  /** Marks the recorded call as having had a `where` applied. */
  function markFiltered(call: FakeCall): () => void {
    return () => {
      Object.assign(call, { filtered: true });
    };
  }

  const db = {
    select: () => {
      const response = rowsForQuery();
      const call: FakeCall = { kind: "select" };
      calls.push(call);
      return chain(
        response,
        () => {
          Object.assign(call, { ordered: true });
        },
        markFiltered(call),
        undefined,
        (limit) => Object.assign(call, { limited: limit }),
      );
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const response = rowsForQuery();
        const call: FakeCall = { kind: "insert", values };
        calls.push(call);
        return chain(
          response,
          undefined,
          markFiltered(call),
          (set) => Object.assign(call, { conflictSet: set }),
          undefined,
          () => Object.assign(call, { ignoredConflict: true }),
        );
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const response = rowsForQuery();
        const call: FakeCall = { kind: "update", values };
        calls.push(call);
        return chain(response, undefined, markFiltered(call));
      },
    }),
    delete: () => {
      const response = rowsForQuery();
      const call: FakeCall = { kind: "delete" };
      calls.push(call);
      return chain(response, undefined, markFiltered(call));
    },
    transaction: async (work: (transaction: unknown) => Promise<unknown>) =>
      work(db),
  };

  return { db: db as unknown as Database, calls };
}

export function createFakeDb(rows: readonly unknown[]): FakeDb {
  return createFakeDbWith(() => rows);
}

/** Different rows for successive queries, useful for transactional stores. */
export function createSequencedFakeDb(
  responses: readonly FakeResponse[],
): FakeDb {
  let index = 0;
  return createFakeDbWith(() => responses[index++] ?? []);
}
