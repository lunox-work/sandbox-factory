/**
 * A tech stack on the wire: the names a repository was detected to use, and
 * the ones a bounty adds to them. See `packages/core/src/stack.ts`.
 */

import { normalizeStack, STACK_LIMITS } from "sandbox-factory";
import { z } from "zod";

/** A stack as stored and sent: names, each once. */
export const stackDtoSchema = z.array(z.string().min(1));

/**
 * A stack as a person writes it: each name trimmed and within the limit,
 * then stored as `normalizeStack` keeps it, so `postgres` arrives as
 * `PostgreSQL` and a repeat arrives once.
 */
export const stackInputSchema = z
  .array(z.string().trim().min(1).max(STACK_LIMITS.name))
  .max(STACK_LIMITS.items)
  .transform((names) => normalizeStack(names));
