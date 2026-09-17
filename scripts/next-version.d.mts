/**
 * Types for `next-version.mjs`.
 *
 * Plain JavaScript for the same reason as `build-info.mjs`: it runs from `node`
 * directly in CI, before anything is built. See that file's declaration for why
 * the `.d.mts` extension is load-bearing.
 */

export interface ParsedSubject {
  type: string;
  breaking: boolean;
  subject: string;
}

export type Bump = "major" | "minor" | "patch";

export function parseSubject(subject: string): ParsedSubject | null;
export function bumpFor(
  commits: readonly { subject: string; body?: string }[],
): Bump | null;
export function applyBump(version: string, bump: Bump): string;
