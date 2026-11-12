/**
 * Idempotency keys: the first answer to a create a machine credential
 * asked for under a key, replayed to its retries. See `schema/developer.ts`.
 *
 * Owner first, as every store, except `prune`, the retention pass.
 */

import { and, eq, isNull, lt, lte, or } from "drizzle-orm";

import type { TokenCipher } from "./cipher.js";
import type { Database } from "./errors.js";
import { idempotencyKey } from "./schema.js";

/** How long an answer is replayed. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export interface IdempotencyClaim {
  readonly organizationId: string;
  readonly route: string;
  readonly key: string;
}

export type IdempotencyBegin =
  /** The key is this request's: run it, then `complete` or `release`. */
  | { readonly state: "claimed" }
  /** Answered before: replay this, if the request is the same one. */
  | {
      readonly state: "answered";
      readonly requestHash: string;
      readonly status: number;
      readonly body: string;
    }
  /** Another request under the key is still running. */
  | { readonly state: "running"; readonly requestHash: string };

export interface IdempotencyStore {
  /**
   * Claims `claim` for a request hashing to `requestHash`, or says what
   * holds it. An answer past its expiry, or a claim older than
   * `abandonedBefore` that never answered (its process died), is cleared
   * and the key claimed afresh.
   */
  begin(
    claim: IdempotencyClaim,
    requestHash: string,
    at: Date,
    abandonedBefore: Date,
  ): Promise<IdempotencyBegin>;
  /** Keeps the answer to replay. */
  complete(
    claim: IdempotencyClaim,
    status: number,
    body: string,
  ): Promise<void>;
  /** Lets the key go unanswered, so a retry runs again. */
  release(claim: IdempotencyClaim): Promise<void>;
  /** Deletes keys expired before `before`; how many went. */
  prune(before: Date): Promise<number>;
}

export function createIdempotencyStore(
  db: Database,
  cipher: TokenCipher,
): IdempotencyStore {
  const one = (claim: IdempotencyClaim) =>
    and(
      eq(idempotencyKey.organizationId, claim.organizationId),
      eq(idempotencyKey.route, claim.route),
      eq(idempotencyKey.key, claim.key),
    );

  const insert = async (
    claim: IdempotencyClaim,
    requestHash: string,
    at: Date,
  ) =>
    (
      await db
        .insert(idempotencyKey)
        .values({
          ...claim,
          requestHash,
          createdAt: at,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoNothing()
        .returning({ key: idempotencyKey.key })
    ).length > 0;

  return {
    async begin(claim, requestHash, at, abandonedBefore) {
      if (await insert(claim, requestHash, at)) return { state: "claimed" };
      // Expired, or claimed and never answered: free it, then try again.
      const cleared = await db
        .delete(idempotencyKey)
        .where(
          and(
            one(claim),
            or(
              lte(idempotencyKey.expiresAt, at),
              and(
                isNull(idempotencyKey.status),
                lt(idempotencyKey.createdAt, abandonedBefore),
              ),
            ),
          ),
        )
        .returning({ key: idempotencyKey.key });
      if (cleared.length > 0 && (await insert(claim, requestHash, at)))
        return { state: "claimed" };
      const [held] = await db
        .select({
          requestHash: idempotencyKey.requestHash,
          status: idempotencyKey.status,
          bodyEnc: idempotencyKey.bodyEnc,
        })
        .from(idempotencyKey)
        .where(one(claim))
        .limit(1);
      // Gone between the statements: someone released it. Claim it now.
      if (held === undefined)
        return (await insert(claim, requestHash, at))
          ? { state: "claimed" }
          : { state: "running", requestHash };
      if (held.status === null)
        return { state: "running", requestHash: held.requestHash };
      return {
        state: "answered",
        requestHash: held.requestHash,
        status: held.status,
        body: cipher.decrypt(held.bodyEnc) ?? "",
      };
    },

    async complete(claim, status, body) {
      await db
        .update(idempotencyKey)
        .set({ status, bodyEnc: cipher.encrypt(body), keyId: cipher.keyId })
        .where(one(claim));
    },

    async release(claim) {
      await db
        .delete(idempotencyKey)
        .where(and(one(claim), isNull(idempotencyKey.status)));
    },

    async prune(before) {
      const removed = await db
        .delete(idempotencyKey)
        .where(lt(idempotencyKey.expiresAt, before))
        .returning({ key: idempotencyKey.key });
      return removed.length;
    },
  };
}
