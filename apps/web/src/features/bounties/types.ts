import type {
  BountyCategoryMatch,
  BountyProposalDto,
  BountyWritebackDto,
  ProposalLiveSpecDto,
} from "@sandbox-factory/shared";
export type EnrichedProposal = BountyProposalDto & {
  /**
   * Why the run picked the ticket: each category it fit, with the reason.
   * Stored with the run like the title. Empty for a ticket someone added by
   * hand, and absent on a row read by id rather than from the list.
   */
  categories?: BountyCategoryMatch[];
  freshness?: "current" | "stale" | "missing" | "unknown";
  checkedAt?: string;
  code?: string;
  liveTitle?: string;
  liveKey?: string;
  liveUrl?: string;
  writebackOperations?: BountyWritebackDto[];
};

/** A line of the titles stream: a row's live title, or why it has none. */
export type ProposalTitle =
  { id: string; key: string; title: string } | { id: string; code: string };

/** A titles-stream line, or null for one this page does not understand. */
export function titleLine(value: unknown): ProposalTitle | null {
  if (typeof value !== "object" || value === null) return null;
  const line = value as Record<string, unknown>;
  const id = line["id"];
  if (typeof id !== "string") return null;
  const key = line["key"];
  const title = line["title"];
  if (typeof key === "string" && typeof title === "string") {
    return { id, key, title };
  }
  const code = line["code"];
  return typeof code === "string" ? { id, code } : null;
}

export interface ProposalDetail {
  proposal: BountyProposalDto;
  freshness: {
    freshness: "current" | "stale" | "missing" | "unknown";
    checkedAt: string;
    code?: string;
  };
  /**
   * What the ticket says now: Jira's text for a ticket following an issue,
   * and the ticket as stored otherwise. Null when it could not be read.
   */
  liveSpec?: ProposalLiveSpecDto | null;
  writebackOperations: BountyWritebackDto[];
}
