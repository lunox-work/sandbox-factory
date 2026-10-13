/**
 * The label the write-back adds to an approved bounty's issue. Ours, so a
 * context read leaves it out (`toJiraContext`): the platform's own write is
 * not a change in Jira.
 */
export const BOUNTY_LABEL = "bounty";
