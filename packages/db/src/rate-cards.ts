import type { RateCardValues } from "sandbox-factory";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { rateCard } from "./schema.js";
import type { RateCardRow } from "./schema.js";

export type PutRateCardResult =
  | { readonly ok: true; readonly rateCard: StoredRateCard }
  | { readonly ok: false; readonly current: StoredRateCard | null };

export interface StoredRateCard extends RateCardValues {
  readonly organizationId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface RateCardStore {
  get(organizationId: string): Promise<StoredRateCard | null>;
  put(
    organizationId: string,
    updatedBy: string,
    values: RateCardValues,
    expectedRevision: number,
  ): Promise<PutRateCardResult>;
}

function toDto(row: RateCardRow): StoredRateCard {
  return {
    organizationId: row.organizationId,
    currency: row.currency,
    xsMinor: row.xsMinor ?? row.sMinor,
    sMinor: row.sMinor,
    mMinor: row.mMinor,
    lMinor: row.lMinor,
    xlMinor: row.xlMinor,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function first(
  db: Database,
  organizationId: string,
): Promise<RateCardRow | undefined> {
  const rows = (await db
    .select()
    .from(rateCard)
    .where(eq(rateCard.organizationId, organizationId))) as RateCardRow[];
  return rows[0];
}

export function createRateCardStore(db: Database): RateCardStore {
  return {
    async get(organizationId) {
      const row = await first(db, organizationId);
      return row === undefined ? null : toDto(row);
    },

    async put(organizationId, updatedBy, values, expectedRevision) {
      if (expectedRevision === 0) {
        const rows = (await db
          .insert(rateCard)
          .values({
            organizationId,
            ...values,
            revision: 1,
            updatedBy,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({ target: rateCard.organizationId })
          .returning()) as RateCardRow[];
        const inserted = rows[0];
        if (inserted !== undefined)
          return { ok: true, rateCard: toDto(inserted) };
        const current = await first(db, organizationId);
        return {
          ok: false,
          current: current === undefined ? null : toDto(current),
        };
      }

      const rows = (await db
        .update(rateCard)
        .set({
          ...values,
          revision: sql`${rateCard.revision} + 1`,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(rateCard.organizationId, organizationId),
            eq(rateCard.revision, expectedRevision),
          ),
        )
        .returning()) as RateCardRow[];
      const updated = rows[0];
      if (updated !== undefined) return { ok: true, rateCard: toDto(updated) };
      const current = await first(db, organizationId);
      return {
        ok: false,
        current: current === undefined ? null : toDto(current),
      };
    },
  };
}
