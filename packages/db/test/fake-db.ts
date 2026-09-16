/**
 * A fake standing in for Drizzle's query builder.
 *
 * The repo forbids tests that depend on a container, so the Postgres store is
 * exercised against this instead. Drizzle's builders are thenable chains
 * (`db.select().from(t).where(c)` resolves to rows), so the fake returns
 * objects that are both chainable and awaitable.
 *
 * It records the calls rather than interpreting the SQL: the goal is to prove
 * the store's own logic — which branch it takes, what it maps, when it throws
 * NotFoundError — not to reimplement Postgres.
 */

import type { TodoRow } from "../src/schema.js";
import type { Database } from "../src/store.js";

export interface FakeCall {
  readonly kind: "select" | "insert" | "update" | "delete";
  readonly values?: Record<string, unknown>;
  readonly ordered?: boolean;
  /**
   * Whether a `where` clause was applied at all.
   *
   * Recorded because owner scoping is the one property that is invisible to a
   * fake which only sees rows: the store could drop `user_id` from every query
   * and each assertion about mapping or ordering would still pass. Proving the
   * predicate exists is the closest this can get to proving it is enforced
   * without reimplementing SQL — the real guarantee is the `not null` column
   * and the integration path, but a store that stops filtering entirely is
   * caught here.
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
    orderBy: () => {
      onOrder?.();
      return result;
    },
    then: (resolve: (value: unknown) => unknown) => resolve([...rows]),
  };
  return result;
}

/**
 * @param rows what every query resolves to. Pass `[]` to simulate a miss,
 *   which is how the store is told an id does not exist.
 */
export function createFakeDb(rows: readonly TodoRow[]): FakeDb {
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
        calls.push({ kind: "insert", values });
        return chain(rows);
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

export function row(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: "todo_1",
    userId: "user_1",
    title: "write tests",
    done: false,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    ...overrides,
  };
}
