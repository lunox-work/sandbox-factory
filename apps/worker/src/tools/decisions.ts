/**
 * Whether a run may quote its spec's decisions as confirmed. The API names
 * the confirmed decisions by hash in the run's parameters
 * (`decisionsSha256`) only once a person confirmed exactly those; the
 * worker checks the hash against the spec the version's task froze, so a
 * run never quotes decisions other than the ones confirmed. A run with no
 * hash (a spec with no decisions, or queued before decisions gated builds)
 * quotes none as confirmed.
 */

import { createHash } from "node:crypto";
import { decisionsText, specDecisions } from "sandbox-factory";
import type { SpecDraft } from "sandbox-factory";
import { AnalysisError } from "../errors.js";

/** The spec's decisions, when the run names them confirmed; else none. */
export function confirmedDecisions(
  spec: SpecDraft | null,
  decisionsSha256: string | undefined,
): readonly string[] {
  if (spec === null || decisionsSha256 === undefined) return [];
  const decisions = specDecisions(spec);
  const sha256 = createHash("sha256")
    .update(decisionsText(decisions), "utf8")
    .digest("hex");
  // Named, but not these: the task moved under the run.
  if (decisions.length === 0 || sha256 !== decisionsSha256)
    throw new AnalysisError("tool_failed");
  return decisions.map(({ text }) => text);
}
