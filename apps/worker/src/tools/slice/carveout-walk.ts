/**
 * The slice walk from carveout (`carveout/api` `walk`, pinned exactly in
 * package.json), as the slice tool's `ReachResult`: the TypeScript
 * compiler's resolution of each import (path aliases, project references,
 * barrels followed only to the modules that supply the names taken, type-only
 * imports passed over) rather than graphify's graph. The slice tool keeps
 * everything after the walk: reading the files, stubs, mocks, the boundary
 * contract and its checks.
 *
 * What the two walks do not share: graphify's communities (none here) and
 * carveout's `path` dependencies, literal paths read at runtime that name
 * no file a slice can copy (a migrations folder). graphify reports none, and
 * the slice tool has no way to carry one, so they are left out as before;
 * read as an import, a root-relative path would look like a package.
 */

import { createRequire } from "node:module";
import { walk } from "carveout/api";
import type {
  CutEdge,
  ReachResult,
  SliceDependency,
  SliceParams,
} from "sandbox-factory";

export const CARVEOUT_WALK_ENGINE = `carveout@${
  (
    createRequire(import.meta.url)("carveout/package.json") as {
      version: string;
    }
  ).version
}`;

/** Entry points as carveout names them: repository paths, never `file:` node ids. */
const entryOf = (entry: string) =>
  entry.startsWith("file:") ? entry.slice(5) : entry;

export function walkWithCarveout(
  root: string,
  params: Pick<SliceParams, "entryPoints" | "budget">,
): ReachResult {
  const walked = walk({
    root,
    entries: params.entryPoints.map(entryOf),
    depth: params.budget.maxDepth,
    maxFiles: params.budget.maxFiles,
    withTests: false,
  });
  const edge = (cut: (typeof walked.cuts.outbound)[number]): CutEdge => ({
    from: cut.from,
    to: cut.to,
    relation: cut.relation,
    specifier: cut.specifier,
    location: cut.location,
    targetSymbol: null,
  });
  return {
    entries: walked.entries,
    unknownEntryPoints: walked.unknownEntryPoints,
    included: walked.included,
    depthOf: walked.depthOf,
    cuts: {
      outbound: walked.cuts.outbound.map(edge),
      inbound: walked.cuts.inbound.map(edge),
    },
    internal: walked.internal.map(edge),
    dependencies: walked.dependencies.flatMap(
      (dependency): SliceDependency[] =>
        dependency.status === "path"
          ? []
          : [
              {
                file: dependency.file,
                specifier: dependency.specifier,
                status: dependency.status,
                location: dependency.location,
              },
            ],
    ),
    communities: [],
  };
}
