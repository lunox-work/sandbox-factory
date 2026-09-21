/**
 * Id generation. Pure and separate from the stores, so it is testable without
 * Postgres.
 */

/**
 * The id prefixes in use, one per table that generates ids.
 *
 * Prefixed ids are worth the few bytes: an id that leaks into a log, a URL or
 * a support conversation says what it is, and passing a board id where an
 * issue id belongs is visible rather than a silent 404. The set is declared
 * here, rather than each caller passing a string, so that a typo is a compile
 * error and the full list is readable in one place.
 *
 * Most of Better Auth's tables are absent on purpose: the plugin generates
 * ids for `user`, `session`, `account`, `invitation` and for organizations it
 * creates itself. `org` and `mbr` are here because `createPersonal` writes
 * those two rows directly from the signup hook, which is the one write to
 * them the plugin does not own.
 */
export const ID_PREFIXES = [
  /** The personal organization minted at signup, and its sole membership. */
  "org",
  "mbr",
  /** Jira: connection, board, issue. */
  "jrc",
  "jrb",
  "jri",
  /** Commercials: bounty run, bounty proposal. */
  "brn",
  "bpr",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * Generated in the application, not by a sequence: `create` stays one round
 * trip and ids stay collision-free across replicas.
 *
 * The prefix is required. It used to default to `todo`, which was convenient
 * while one table generated ids and wrong the moment a second did.
 */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
