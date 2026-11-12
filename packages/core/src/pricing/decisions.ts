/**
 * A spec's decisions: what its draft decided where the bounty was silent
 * (`SpecDraft.assumptions`), the items a person confirms before hidden tests
 * are written to them. Keyed `d1`, `d2`… in the spec's order, stable within
 * a spec revision.
 *
 * `renderSpecDocument` is the spec as duediligence reads one: the Gherkin,
 * then a `Decided:` heading over one list item per decision, which its
 * `decisionItems` (duediligence/api) parses back item for item.
 */

import { renderGherkin, type SpecDraft } from "./spec.js";

export interface SpecDecision {
  readonly key: string;
  readonly text: string;
}

export function specDecisions(draft: SpecDraft): SpecDecision[] {
  return draft.assumptions.map((text, index) => ({
    key: `d${index + 1}`,
    text: text.replace(/\s+/g, " ").trim(),
  }));
}

/**
 * The text a decisions confirmation is bound to: each decision's key and
 * text, one per line, in order. The API hashes it, so a confirmation names
 * exactly the decisions a person read.
 */
export function decisionsText(decisions: readonly SpecDecision[]): string {
  return decisions.map(({ key, text }) => `${key}\t${text}\n`).join("");
}

export function renderSpecDocument(draft: SpecDraft): string {
  const decisions = specDecisions(draft);
  const gherkin = renderGherkin(draft);
  if (decisions.length === 0) return gherkin;
  return `${gherkin}\nDecided:\n\n${decisions.map(({ text }) => `- ${text}`).join("\n")}\n`;
}
