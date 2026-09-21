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
}

export interface FakeDb {
  readonly db: Database;
  readonly calls: FakeCall[];
}

/** A chain that resolves to `rows` however far it is followed. */
function chain(
  rows: readonly unknown[],
  onOrder?: () => void,
  onWhere?: () => void,
  onConflict?: (set: Record<string, unknown>) => void,
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
    innerJoin: () => result,
    leftJoin: () => result,
    orderBy: () => {
      onOrder?.();
      return result;
    },
    then: (resolve: (value: unknown) => unknown) => resolve([...rows]),
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
export function createFakeDb(rows: readonly unknown[]): FakeDb {
  const calls: FakeCall[] = [];

  /** Marks the recorded call as having had a `where` applied. */
  function markFiltered(call: FakeCall): () => void {
    return () => {
      Object.assign(call, { filtered: true });
    };
  }

  const db = {
    select: () => {
      const call: FakeCall = { kind: "select" };
      calls.push(call);
      return chain(
        rows,
        () => {
          Object.assign(call, { ordered: true });
        },
        markFiltered(call),
      );
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const call: FakeCall = { kind: "insert", values };
        calls.push(call);
        return chain(rows, undefined, markFiltered(call), (set) => {
          Object.assign(call, { conflictSet: set });
        });
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const call: FakeCall = { kind: "update", values };
        calls.push(call);
        return chain(rows, undefined, markFiltered(call));
      },
    }),
    delete: () => {
      const call: FakeCall = { kind: "delete" };
      calls.push(call);
      return chain(rows, undefined, markFiltered(call));
    },
  };

  return { db: db as unknown as Database, calls };
}
