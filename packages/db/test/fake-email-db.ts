/**
 * An in-memory stand-in for Drizzle, good enough to exercise `createEmailStore`
 * without a container.
 *
 * Unlike `fake-db.ts`, which returns one fixed row set, this one keeps actual
 * state: the email store's interesting behaviour is *conditional* — is this
 * address already taken, is this the first address, is the target primary —
 * and a fake that cannot answer those questions differently per query proves
 * nothing about it.
 *
 * It models only the shapes `emails.ts` actually issues. It is not a general
 * Drizzle emulator, and a new query shape will need a new branch here.
 */

import type { Database } from "../src/store.js";

export interface EmailRow {
  id: string;
  userId: string;
  email: string;
  providerId: string;
  isPrimary: boolean;
  createdAt: Date;
}

export interface UserRowLite {
  id: string;
  email: string;
  updatedAt: Date;
  username?: string | null;
  displayUsername?: string | null;
}

interface Condition {
  readonly column: string;
  readonly value: unknown;
  readonly negated: boolean;
}

/**
 * Recovers the conditions from a Drizzle `where` clause.
 *
 * `eq`/`ne`/`and` build SQL objects whose `queryChunks` alternate between
 * column references, literal operator fragments (`" = "`, `" <> "`) and bound
 * parameters. Walking that array is enough to learn "column X equals Y", which
 * is all the store's queries express. Parsing this rather than emulating SQL
 * keeps the fake honest about what it does and does not model.
 */
function conditions(where: unknown): Condition[] {
  const out: Condition[] = [];
  collect(where, out);
  return out;
}

function collect(node: unknown, out: Condition[]): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (!Array.isArray(chunks)) {
    return;
  }

  let column: string | undefined;
  let negated = false;

  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) {
      continue;
    }
    const record = chunk as Record<string, unknown>;

    // Nested condition (an `and(...)` operand) — recurse and move on.
    if (Array.isArray(record["queryChunks"])) {
      collect(chunk, out);
      continue;
    }

    // A column reference: it carries a name and the table it belongs to.
    if (typeof record["name"] === "string" && "table" in record) {
      column = record["name"];
      continue;
    }

    // A literal fragment carries the operator.
    const literal = record["value"];
    if (Array.isArray(literal)) {
      const text = literal.join("");
      if (text.includes("<>")) {
        negated = true;
      }
      continue;
    }

    // Anything else holding a `value` is the bound parameter.
    if ("value" in record && column !== undefined) {
      out.push({ column, value: record["value"], negated });
      column = undefined;
      negated = false;
    }
  }
}

/**
 * Reads a Drizzle table's name.
 *
 * It lives on a `Symbol(drizzle:Name)` rather than a plain property, so the
 * symbol has to be looked up by description — there is no exported accessor
 * for it and importing Drizzle's internals into a test double would be worse.
 */
function tableName(table: unknown): string | undefined {
  if (typeof table !== "object" || table === null) {
    return undefined;
  }
  const symbol = Object.getOwnPropertySymbols(table).find(
    (candidate) => candidate.description === "drizzle:Name",
  );
  if (symbol === undefined) {
    return undefined;
  }
  const value = (table as Record<symbol, unknown>)[symbol];
  return typeof value === "string" ? value : undefined;
}

export interface FakeEmailDb {
  readonly db: Database;
  readonly emails: EmailRow[];
  readonly users: UserRowLite[];
}

/**
 * Builds the fake.
 *
 * The filtering is intentionally simple: it matches on whichever of
 * `id`/`user_id`/`email` the condition names. That covers every query the
 * store makes and keeps this file readable, which matters more than
 * generality for a test double.
 */
export function createFakeEmailDb(
  seed: { emails?: EmailRow[]; users?: UserRowLite[] } = {},
): FakeEmailDb {
  const emails: EmailRow[] = [...(seed.emails ?? [])];
  const users: UserRowLite[] = [...(seed.users ?? [])];

  function match(row: EmailRow, where: unknown): boolean {
    const found = conditions(where);
    if (found.length === 0) {
      return true;
    }
    return found.every((condition) => {
      const actual =
        condition.column === "id"
          ? row.id
          : condition.column === "user_id"
            ? row.userId
            : condition.column === "email"
              ? row.email
              : undefined;
      if (actual === undefined || condition.value === undefined) {
        return true;
      }
      return condition.negated
        ? actual !== condition.value
        : actual === condition.value;
    });
  }

  function matchUser(row: UserRowLite, where: unknown): boolean {
    const found = conditions(where);
    if (found.length === 0) {
      return true;
    }
    return found.every((condition) => {
      const actual =
        condition.column === "id"
          ? row.id
          : condition.column === "email"
            ? row.email
            : condition.column === "username"
              ? (row.username ?? null)
              : undefined;
      if (actual === undefined || condition.value === undefined) {
        return true;
      }
      return condition.negated
        ? actual !== condition.value
        : actual === condition.value;
    });
  }

  function selectChain() {
    let where: unknown;
    let limit: number | undefined;
    let fromUser = false;
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        fromUser = tableName(table) === "user";
        return chain;
      },
      where: (w: unknown) => {
        where = w;
        return chain;
      },
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) => {
        const rows = fromUser
          ? users.filter((row) => matchUser(row, where))
          : emails.filter((row) => match(row, where));
        return resolve(limit === undefined ? rows : rows.slice(0, limit));
      },
    };
    return chain;
  }

  function makeDb(): Database {
    const db: Record<string, unknown> = {
      select: () => selectChain(),

      insert: () => {
        let inserted: EmailRow | undefined;
        const chain: Record<string, unknown> = {
          values: (value: EmailRow) => {
            inserted = { ...value, createdAt: value.createdAt ?? new Date() };
            emails.push(inserted);
            return chain;
          },
          returning: () => chain,
          then: (resolve: (value: unknown) => unknown) =>
            resolve(inserted === undefined ? [] : [inserted]),
        };
        return chain;
      },

      update: (table: unknown) => {
        const isUserTable = tableName(table) === "user";
        let patch: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          set: (value: Record<string, unknown>) => {
            patch = value;
            return chain;
          },
          where: (where: unknown) => {
            if (isUserTable) {
              for (const row of users) {
                if (!matchUser(row, where)) {
                  continue;
                }
                if (typeof patch["email"] === "string") {
                  row.email = patch["email"];
                }
                if (typeof patch["username"] === "string") {
                  row.username = patch["username"];
                }
                if (typeof patch["displayUsername"] === "string") {
                  row.displayUsername = patch["displayUsername"];
                }
              }
            } else {
              for (const row of emails) {
                if (!match(row, where)) {
                  continue;
                }
                if ("isPrimary" in patch) {
                  row.isPrimary = patch["isPrimary"] === true;
                }
                if (typeof patch["providerId"] === "string") {
                  row.providerId = patch["providerId"];
                }
              }
            }
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) => resolve([]),
        };
        return chain;
      },

      delete: () => {
        const chain: Record<string, unknown> = {
          where: (where: unknown) => {
            for (let i = emails.length - 1; i >= 0; i -= 1) {
              const row = emails[i];
              if (row !== undefined && match(row, where)) {
                emails.splice(i, 1);
              }
            }
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) => resolve([]),
        };
        return chain;
      },

      // The store wraps `record` and `setPrimary` in transactions; running the
      // callback against the same fake is the right model, since these tests
      // are about the store's logic rather than Postgres' isolation
      // guarantees. The callback's value is returned because `record` resolves
      // to whatever its transaction produced.
      transaction: async (fn: (tx: Database) => Promise<unknown>) =>
        fn(makeDb()),
    };
    return db as unknown as Database;
  }

  return { db: makeDb(), emails, users };
}
