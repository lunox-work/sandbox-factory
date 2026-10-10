/**
 * Where a workspace stands on the way to its first bounty, and what home
 * offers next.
 *
 * Home is one page that changes with the workspace rather than a page per
 * case, and this is the one place the cases are decided, so every surface
 * that reacts to them — the checklist, the body of home, the board page —
 * agrees about which one a workspace is in. Pure: the hook in
 * `useWorkspaceSetup` reads the facts, and this only reasons about them.
 *
 * **The stage is what is connected.** Each integration earns its place on
 * home with something it shows for free: Jira a scan of the backlog for the
 * six kinds of work worth outsourcing (rules over ticket metadata, no model
 * call), GitHub an x-ray of a repository (the tree and stack a snapshot
 * already read). Sizing — the model call, slow and paid for — is offered one
 * ticket at a time once there is something to size, never on connect.
 *
 * - `barebone`: neither. Home explains the six kinds of work and offers the
 *   two connections, and writing a bounty by hand.
 * - `jira`: a site, no repository. The backlog scan, with sizing a ticket as
 *   the way on and GitHub as the way to size it better.
 * - `github`: a repository, or an account to pick one from, and no site.
 *   The x-ray, with writing a bounty about it as the way on.
 * - `both`: the scan, sized beside the repository's code.
 */

export type SetupStage = "barebone" | "jira" | "github" | "both";

export interface SetupFacts {
  readonly jira: {
    /** The server mounts Jira at all. */
    readonly available: boolean;
    /** Sites that can be read. One needing reconnection is not counted. */
    readonly connected: number;
    /** Sites that need reconnecting before anything can be read. */
    readonly broken: number;
    readonly boards: number;
  };
  readonly github: {
    readonly available: boolean;
    /** Linked installations that GitHub still honours. */
    readonly connected: number;
    /** Registered source repositories GitHub has not lost. */
    readonly repositories: number;
  };
  /** Proposals the workspace holds: whether anything has been sized. */
  readonly proposals: number;
  /** Bounties the workspace holds, sized or not. */
  readonly bounties: number;
  /** Owner or admin: the roles that may connect tools and start sizing. */
  readonly canManage: boolean;
}

export function setupStage(facts: SetupFacts): SetupStage {
  const jira = facts.jira.connected > 0;
  // An account with nothing picked from it is still GitHub: home's GitHub
  // body is where the first repository is picked.
  const github = facts.github.repositories > 0 || facts.github.connected > 0;
  return jira && github
    ? "both"
    : jira
      ? "jira"
      : github
        ? "github"
        : "barebone";
}

export type SetupStepId = "jira" | "github" | "size";

export interface SetupStep {
  readonly id: SetupStepId;
  readonly done: boolean;
  /**
   * The step to take now: the first one not done, in the order the stage
   * makes sense of. Exactly one step is current until every one is done.
   */
  readonly current: boolean;
}

/**
 * The checklist: find work, add code, size a first bounty — less any tool
 * the server does not offer.
 *
 * GitHub is done at a repository, not at an account: the account is a
 * permission, the repository is what a bounty is sized beside and cut from.
 *
 * The order is the stage's. A workspace that came in through GitHub has its
 * code already and is closer to a first bounty than to Jira — it can write
 * one by hand now — so sizing comes before Jira there; everywhere else the
 * order is the one a backlog-first team walks.
 */
export function setupSteps(facts: SetupFacts): SetupStep[] {
  const done: Record<SetupStepId, boolean> = {
    jira: facts.jira.connected > 0,
    github: facts.github.repositories > 0,
    size: facts.proposals > 0,
  };
  const order: SetupStepId[] =
    setupStage(facts) === "github"
      ? ["github", "size", "jira"]
      : ["jira", "github", "size"];
  const offered = order.filter(
    (id) =>
      (id !== "jira" || facts.jira.available) &&
      (id !== "github" || facts.github.available),
  );
  const current = offered.find((id) => !done[id]);
  return offered.map((id) => ({ id, done: done[id], current: id === current }));
}

/**
 * Every step is done: the checklist has nothing left to say. Until then
 * onboarding is the only destination the rail offers, and where home lands;
 * after, it gives way to home and the bounties.
 */
export function setupComplete(facts: SetupFacts): boolean {
  return setupSteps(facts).every(({ done }) => done);
}
