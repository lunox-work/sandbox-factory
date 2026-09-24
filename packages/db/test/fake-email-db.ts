/**
 * An in-memory stand-in for Drizzle, to exercise `createEmailStore` without a
 * container. Unlike `fake-db.ts` it keeps state, because the email store's
 * behaviour depends on what earlier queries wrote. It models only the query
 * shapes `emails.ts` issues; a new shape needs a new branch here.
 */

import type { Database } from "../src/errors.js";

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
  /** The picture column; selects return whole rows, so it is read as is. */
  image?: string | null;
}

/** A team's claim in the shared `handle` table. */
export interface TeamHandleLite {
  handle: string;
  organizationId: string;
}

interface Condition {
  readonly column: string;
  readonly value: unknown;
  readonly negated: boolean;
}

/**
 * Recovers the conditions from a Drizzle `where` clause. `eq`/`ne`/`and` build
 * SQL objects whose `queryChunks` alternate between column references,
 * operator fragments (`" = "`, `" <> "`) and bound parameters.
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

    // A nested condition (an `and(...)` operand).
    if (Array.isArray(record["queryChunks"])) {
      collect(chunk, out);
      continue;
    }

    // A column reference: it carries a name and its table.
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
 * Reads a Drizzle table's name. It lives on `Symbol(drizzle:Name)` with no
 * exported accessor, so the symbol is found by description.
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
 * Builds the fake. Filtering matches only the columns the store's queries
 * name: `id`, `user_id`, `email`, `username` and `handle`.
 *
 * The `handle` table is not stored: it is derived, as the triggers in
 * migration 0030 keep it — one row per username, plus the teams seeded here.
 * A username update onto a handle someone else holds fails with Postgres'
 * `23505`, as the trigger does.
 *
 * `racingTeam` is claimed at the moment a username update reaches for it,
 * after the store has already checked and found it free: the race the
 * primary key, not the check, has to win.
 */
export function createFakeEmailDb(
  seed: {
    emails?: EmailRow[];
    users?: UserRowLite[];
    teams?: TeamHandleLite[];
    racingTeam?: TeamHandleLite;
  } = {},
): FakeEmailDb {
  const emails: EmailRow[] = [...(seed.emails ?? [])];
  const users: UserRowLite[] = [...(seed.users ?? [])];
  const teams: TeamHandleLite[] = [...(seed.teams ?? [])];

  /** The `handle` table as the triggers would have it. */
  function handles(): Array<{
    handle: string;
    userId: string | null;
    organizationId: string | null;
  }> {
    return [
      ...users.flatMap((row) =>
        typeof row.username === "string"
          ? [
              {
                handle: row.username.toLowerCase(),
                userId: row.id,
                organizationId: null,
              },
            ]
          : [],
      ),
      ...teams.map((team) => ({
        handle: team.handle,
        userId: null,
        organizationId: team.organizationId,
      })),
    ];
  }

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
    let from: string | undefined;
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        from = tableName(table);
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
        const rows =
          from === "user"
            ? users.filter((row) => matchUser(row, where))
            : from === "handle"
              ? handles().filter((row) =>
                  conditions(where).every(
                    (condition) =>
                      condition.column !== "handle" ||
                      row.handle === condition.value,
                  ),
                )
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
                const username = patch["username"];
                if (typeof username === "string") {
                  if (seed.racingTeam?.handle === username) {
                    teams.push(seed.racingTeam);
                  }
                  const holder = handles().find(
                    (claim) => claim.handle === username.toLowerCase(),
                  );
                  if (holder !== undefined && holder.userId !== row.id) {
                    throw Object.assign(
                      new Error(`handle ${username} is already taken`),
                      { code: "23505" },
                    );
                  }
                  row.username = username;
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

      // Runs the callback against the same state: these tests cover the
      // store's logic, not Postgres' isolation. Returns the callback's value,
      // which `record` resolves to.
      transaction: async (fn: (tx: Database) => Promise<unknown>) =>
        fn(makeDb()),
    };
    return db as unknown as Database;
  }

  return { db: makeDb(), emails, users };
}
