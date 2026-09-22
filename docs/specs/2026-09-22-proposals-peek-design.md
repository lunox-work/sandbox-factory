# Proposals as the board page, with a Notion-style peek

Date: 2026-09-22. Status: approved.

## Problem

A board page has two tabs, Backlog and Proposals. The Backlog tab is a
Notion-like list whose rows open a peek panel over the list; the Proposals
tab is a different design: tall rows that carry the rationale, the model
line, delivery status, revision history and every action inline. The two
halves of one page do not look like one product, and the proposal rows are
too busy to scan.

## Decision

The board page shows proposals only. The Backlog tab, its ticket list, and
its filter strip go. What the backlog peek showed for a ticket — the spec
and the fields — moves into the proposal's peek as the Spec tab.

### Page

- Header as today.
- Toolbar: status filter pills (Proposed · Approved · Rejected · Superseded)
  on the left, "Run sizing" on the right for an owner or admin. One muted
  line under it: `Latest run: succeeded · 10 results · sized by DeepSeek V4
  Pro`. The write-back notice and the sizing-unavailable notice stay as
  one-liners.
- The list sits in the bordered container the backlog used, with a summary
  strip (`12 proposed`). A row is: key in mono · title, truncated ·
  complexity badge · amount (or "Unpriced") · chevron. The whole row is the
  button; the selected row is marked. Nothing else is in the row.

### Peek

Opened by a row click, over the list, with `PeekPanel`.

- Title is the key; the subtitle is the ticket title. Under them, the
  proposal status badge and the freshness badge.
- A tab strip, Bounty | Spec, with "Open in Jira" pinned to the right as the
  ticket peek has it.
- Bounty: complexity and amount ("Consider splitting" on XL); the model's
  sizing line (`M · high · DeepSeek V4 Pro`) and its rationale; delivery
  status when a write-back exists; the revision history as a list, where a
  click switches the peek to that revision. The panel footer holds the
  actions for an owner or admin — Approve, XS–XL, Reject, Re-price — with the
  enabled rules the rows have today.
- Spec: the ticket read live from Jira by key, through the same read the
  backlog peek used. One scroll: the description as Markdown, then the fields
  list beneath it as a section. No inner tabs. The same skeleton and
  error-with-retry. Fetched when the peek opens, so switching to the tab is
  instant.

### URL

`?proposal=<id>` opens the peek; it is the parameter the page already uses.
`?tab` and `?issue` go away. Back and forward close and reopen the peek.

### Removed

The tab strip, the backlog preview list and filter strip, and the backlog
fetch on page load. The API is untouched: the backlog preview endpoint stays.

### Code shape

The spec-and-fields rendering, its skeleton, and the field helpers move out
of `Jira.tsx` into `IssueSpec.tsx`, imported by the proposals component. The
board page passes its ticket reader into the proposals component, which owns
the list, the peek, and the URL state.

### Tests

The backlog peek tests (open on click, skeleton, error and retry, back
button, focus return) become proposal peek tests. The proposals tests cover
the minimal rows, the footer actions, the Spec tab, and the status filters.
