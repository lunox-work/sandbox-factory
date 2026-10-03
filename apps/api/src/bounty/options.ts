import {
  type BountyProfileStore,
  type BountyProposalStore,
  type BountyRunStore,
  type BountySpecStore,
  type BountyWritebackStore,
  type JiraBoardStore,
  type JiraConnectionStore,
  type JiraIssueStore,
  type RateCardStore,
  type TicketStore,
} from "@sandbox-factory/db";

import type { BountyDelivery } from "./delivery.js";
import type { BountyExecutor, RunClientResult } from "./executor.js";

export interface BountyRouteOptions {
  readonly rateCards: RateCardStore;
  readonly runs: BountyRunStore;
  readonly boards: JiraBoardStore;
  readonly proposals: BountyProposalStore;
  readonly specs: BountySpecStore;
  readonly issues: JiraIssueStore;
  /** The organization's tickets, which every proposal prices. */
  readonly tickets: TicketStore;
  /** Complexity profiles; absent, a proposal reads as never profiled. */
  readonly profiles?: Pick<BountyProfileStore, "latest">;
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
   * ticket following its issue cannot be read, but every other ticket is
   * sized and reviewed all the same.
   */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly requestedModel?: string;
  readonly promptVersion?: string;
  readonly supportedCurrencies?: ReadonlySet<string>;
}
