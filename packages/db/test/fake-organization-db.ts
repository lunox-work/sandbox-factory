/**
 * An in-memory stand-in for Drizzle, to exercise `createOrganizationStore`
 * without a container.
 *
 * Goes one step beyond `fake-email-db.ts` because this store joins: it models
 * `select(projection).from(a).innerJoin(b, on).where(...)` by building a row
 * per matching pair and then reading the projection's column references off
 * it. That keeps the assertions about the store's own logic — which rows it
 * asks for, and how it shapes them — rather than about SQL.
 *
 * Only the query shapes `organizations.ts` issues are modelled. A new shape
 * needs a new branch here.
 */

import type { Database } from "../src/store.js";

export interface OrganizationRowLite {
  id: string;
  name: string;
  slug: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MemberRowLite {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export interface InvitationRowLite {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface MemberUserRowLite {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  /** Only the invite lookup reads it, so seeds may leave it out. */
  email?: string;
}

interface Condition {
  readonly table: string;
  readonly column: string;
  readonly value: unknown;
}

/**
 * Recovers `(table, column, value)` triples from a Drizzle `where` clause.
 * Unlike the email fake this keeps the table, because a joined row carries
 * columns of the same name from both sides.
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

  let column: { table: string; column: string } | undefined;

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

    const reference = columnRef(chunk);
    if (reference !== undefined) {
      column = reference;
      continue;
    }

    // A literal fragment: the operator. Only `=` is used by this store.
    if (Array.isArray(record["value"])) {
      continue;
    }

    if ("value" in record && column !== undefined) {
      out.push({ ...column, value: record["value"] });
      column = undefined;
    }
  }
}

/** A Drizzle column reference, as `{ table, column }`, or undefined. */
function columnRef(
  value: unknown,
): { table: string; column: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["name"] !== "string" || !("table" in record)) {
    return undefined;
  }
  const table = tableName(record["table"]);
  return table === undefined ? undefined : { table, column: record["name"] };
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

/** A row of one table, keyed by its snake_case column names. */
type Columns = Record<string, unknown>;

export interface FakeOrganizationDb {
  readonly db: Database;
  readonly organizations: OrganizationRowLite[];
  readonly members: MemberRowLite[];
  readonly invitations: InvitationRowLite[];
  readonly users: MemberUserRowLite[];
  /** Every `update` the store issued, so `touch` can be asserted on. */
  readonly updates: Array<{ table: string; patch: Columns }>;
}

export function createFakeOrganizationDb(
  seed: {
    organizations?: OrganizationRowLite[];
    members?: MemberRowLite[];
    invitations?: InvitationRowLite[];
    users?: MemberUserRowLite[];
  } = {},
): FakeOrganizationDb {
  const organizations = [...(seed.organizations ?? [])];
  const members = [...(seed.members ?? [])];
  const invitations = [...(seed.invitations ?? [])];
  const users = [...(seed.users ?? [])];
  const updates: Array<{ table: string; patch: Columns }> = [];

  /** Each table's rows, in the column names Drizzle would use. */
  function rowsOf(table: string): Columns[] {
    switch (table) {
      case "organization":
        return organizations.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          created_at: row.createdAt ?? new Date(0),
          updated_at: row.updatedAt ?? new Date(0),
        }));
      case "member":
        return members.map((row) => ({
          id: row.id,
          organization_id: row.organizationId,
          user_id: row.userId,
          role: row.role,
          created_at: row.createdAt,
        }));
      case "invitation":
        return invitations.map((row) => ({
          id: row.id,
          organization_id: row.organizationId,
          email: row.email,
          role: row.role,
          status: row.status,
          inviter_id: row.inviterId,
          expires_at: row.expiresAt,
          created_at: row.createdAt,
        }));
      case "user":
        return users.map((row) => ({
          id: row.id,
          name: row.name,
          username: row.username,
          image: row.image,
          email: row.email ?? `${row.id}@example.test`,
        }));
      default:
        return [];
    }
  }

  /** A row of the join so far: table name to that table's columns. */
  type Joined = Record<string, Columns>;

  function selectChain(projection: Record<string, unknown>) {
    let joined: Joined[] = [];
    let where: unknown;
    let limit: number | undefined;

    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        const name = tableName(table) ?? "";
        joined = rowsOf(name).map((row) => ({ [name]: row }));
        return chain;
      },

      innerJoin: (table: unknown, on: unknown) => {
        const name = tableName(table) ?? "";
        const right = rowsOf(name);
        // `on` is `eq(left.col, right.col)`: two column references and no
        // bound value, so read them as a pair rather than as conditions.
        const [a, b] = onColumns(on);
        const next: Joined[] = [];
        for (const row of joined) {
          for (const candidate of right) {
            const combined: Joined = { ...row, [name]: candidate };
            if (a === undefined || b === undefined) {
              next.push(combined);
              continue;
            }
            const left = combined[a.table]?.[a.column];
            const rightValue = combined[b.table]?.[b.column];
            if (left === rightValue) {
              next.push(combined);
            }
          }
        }
        joined = next;
        return chain;
      },

      where: (value: unknown) => {
        where = value;
        return chain;
      },

      limit: (value: number) => {
        limit = value;
        return chain;
      },

      then: (resolve: (value: unknown) => unknown) => {
        const found = conditions(where);
        const matched = joined.filter((row) =>
          found.every((condition) => {
            const columns = row[condition.table];
            // A condition on a table this query did not touch cannot be
            // evaluated; treat it as satisfied rather than silently dropping
            // every row, which would hide a store bug behind an empty result.
            if (columns === undefined || !(condition.column in columns)) {
              return true;
            }
            return columns[condition.column] === condition.value;
          }),
        );
        const projected = matched.map((row) => project(projection, row));
        return resolve(
          limit === undefined ? projected : projected.slice(0, limit),
        );
      },
    };
    return chain;
  }

  /** The two column references in an `eq(a, b)` join condition. */
  function onColumns(
    on: unknown,
  ): [
    { table: string; column: string } | undefined,
    { table: string; column: string } | undefined,
  ] {
    const chunks =
      typeof on === "object" && on !== null
        ? (on as { queryChunks?: unknown }).queryChunks
        : undefined;
    if (!Array.isArray(chunks)) {
      return [undefined, undefined];
    }
    const refs = chunks
      .map((chunk) => columnRef(chunk))
      .filter(
        (ref): ref is { table: string; column: string } => ref !== undefined,
      );
    return [refs[0], refs[1]];
  }

  /** Reads each projected column off the joined row. */
  function project(
    projection: Record<string, unknown>,
    row: Joined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [alias, column] of Object.entries(projection)) {
      const reference = columnRef(column);
      out[alias] =
        reference === undefined
          ? undefined
          : row[reference.table]?.[reference.column];
    }
    return out;
  }

  const db: Record<string, unknown> = {
    select: (projection: Record<string, unknown>) => selectChain(projection),

    update: (table: unknown) => {
      const name = tableName(table) ?? "";
      let patch: Columns = {};
      const chain: Record<string, unknown> = {
        set: (value: Columns) => {
          patch = value;
          return chain;
        },
        where: (value: unknown) => {
          updates.push({ table: name, patch });
          if (name === "organization") {
            const found = conditions(value);
            for (const row of organizations) {
              const matches = found.every(
                (condition) =>
                  condition.column !== "id" || row.id === condition.value,
              );
              if (matches && patch["updatedAt"] instanceof Date) {
                row.updatedAt = patch["updatedAt"];
              }
            }
          }
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => resolve([]),
      };
      return chain;
    },
  };

  return {
    db: db as unknown as Database,
    organizations,
    members,
    invitations,
    users,
    updates,
  };
}
