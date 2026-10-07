/**
 * Reading the bounded summary a run's artifact row carries in `meta`: the
 * figures the repository page draws. The documents themselves open in the
 * context viewer.
 */

import type { ArtifactDto } from "@sandbox-factory/shared";
import type { ArtifactKind } from "sandbox-factory";

/**
 * What a shared schema offers; named structurally so this app needs no
 * dependency on the schema library behind it.
 */
interface Summary<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * The summary an artifact's `meta` carries, or null when it carries none
 * or not one of this shape. The first artifact of `kinds` with a readable
 * summary wins: a builder writes the same summary onto more than one row.
 */
export function summaryOf<T>(
  artifacts: readonly ArtifactDto[],
  kinds: readonly ArtifactKind[],
  schema: Summary<T>,
): T | null {
  for (const kind of kinds) {
    for (const artifact of artifacts) {
      if (artifact.kind !== kind || artifact.meta === null) continue;
      const parsed = schema.safeParse(artifact.meta);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}
