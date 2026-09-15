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
}

export interface FakeDb {
  readonly db: Database;
  readonly calls: FakeCall[];
}

/** A chain that resolves to `rows` however far it is followed. */
function chain(rows: readonly unknown[], onOrder?: () => void): unknown {
  const result: Record<string, unknown> = {
    from: () => result,
    where: () => result,
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

  const db = {
    select: () => {
      const call: { kind: "select"; ordered?: boolean } = { kind: "select" };
      calls.push(call as FakeCall);
      return chain(rows, () => {
        Object.assign(call, { ordered: true });
      });
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        calls.push({ kind: "insert", values });
        return chain(rows);
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        calls.push({ kind: "update", values });
        return chain(rows);
      },
    }),
    delete: () => {
      calls.push({ kind: "delete" });
      return chain(rows);
    },
  };

  return { db: db as unknown as Database, calls };
}

export function row(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: "todo_1",
    title: "write tests",
    done: false,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    ...overrides,
  };
}
