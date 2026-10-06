/**
 * Reading a run's artifacts: finding one by kind or path, and reading the
 * bounded summary its row carries in `meta`. The summaries are what the
 * page draws; the documents themselves open through signed URLs.
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

export function artifactOfKind(
  artifacts: readonly ArtifactDto[],
  kind: ArtifactKind,
): ArtifactDto | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

export function artifactAtPath(
  artifacts: readonly ArtifactDto[],
  path: string,
): ArtifactDto | undefined {
  return artifacts.find((artifact) => artifact.path === path);
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
