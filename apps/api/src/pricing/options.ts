import {
  type BountyContextStore,
  type BountyPostedSpecStore,
  type BountyProfileStore,
  type BountyProposalStore,
  type BountyRunStore,
  type BountySpecStore,
  type DecisionConfirmationStore,
  type BountyWritebackStore,
  type JiraBoardStore,
  type JiraConnectionStore,
  type JiraIssueStore,
  type RateCardStore,
  type BountyStore,
  type GithubRepoSummary,
  type StoredBountyProfile,
} from "@sandbox-factory/db";

import type { GithubContextSource } from "../bounties/context.js";
import type { GithubIssueSource } from "../bounties/github-issue.js";
import type { BountyDelivery } from "./delivery.js";
import type { BountyExecutor, RunClientResult } from "./executor.js";

export interface PricingRouteOptions {
  readonly rateCards: RateCardStore;
  readonly runs: BountyRunStore;
  readonly boards: JiraBoardStore;
  readonly proposals: BountyProposalStore;
  readonly specs: BountySpecStore;
  /** Confirmations of specs' decisions; absent, none can be made. */
  readonly decisions?: DecisionConfirmationStore;
  /** Specs posted with bounties, which a bounty's page names. */
  readonly postedSpecs?: Pick<BountyPostedSpecStore, "get">;
  readonly issues: JiraIssueStore;
  /** The organization's bounties, which every proposal prices. */
  readonly bounties: BountyStore;
  /**
   * Bounties' synced context. Absent, the context routes are not mounted
   * and every bounty holds none.
   */
  readonly contexts?: BountyContextStore;
  /**
   * The workspace's repositories. A whole board is sized only once one is
   * connected; absent, none is.
   */
  readonly repos?: {
    list(organizationId: string): Promise<readonly GithubRepoSummary[]>;
  };
  /** Reads a repository's documents; absent without GitHub and storage. */
  readonly githubContext?: GithubContextSource;
  /** Reads an issue a bounty is imported from; absent without GitHub. */
  readonly githubIssues?: GithubIssueSource;
  /**
   * Complexity profiles; absent, a proposal reads as never profiled, and
   * its approval waits on none.
   */
  readonly profiles?: Pick<BountyProfileStore, "latest">;
  /**
   * Scores a proposal's spec with a settled profile's code, as the
   * profiler's settle does (`RubricPricer.settled`; never throws). An
   * approval runs it when every profile has settled and the stored rubric
   * still waits on the code, so the price approved is the one that saw it.
   */
  readonly rescore?: (
    organizationId: string,
    profile: StoredBountyProfile,
  ) => Promise<void>;
  readonly connections?: JiraConnectionStore;
  readonly writebacks?: BountyWritebackStore;
  readonly delivery?: BountyDelivery;
  readonly appUrl?: string;
  readonly organizationSlug?: (
    organizationId: string,
  ) => Promise<string | undefined>;
  readonly executor?: BountyExecutor;
  /**
   * A Jira site's client. Where Jira is not configured it answers
   * `reconnect`, as for a site that needs reconnecting, and where it is
   * absent the same is assumed: a board's runs then cannot start, and a
   * bounty following its issue cannot be read, but every other bounty is
   * sized and reviewed all the same.
   */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  /**
   * Called once a proposal is approved, or its spec's decisions are
   * confirmed (which a sandbox's preparation waits for), so its sandbox's
   * preparation is queued without waiting for the preparer's timer. Must
   * not throw.
   */
  readonly onApproved?: () => void;
  readonly requestedModel?: string;
  readonly promptVersion?: string;
  readonly supportedCurrencies?: ReadonlySet<string>;
}
