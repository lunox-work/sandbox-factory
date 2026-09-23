# Proposals as the board page, with a Notion-style peek

Date: 2026-09-22. Status: shipped; revised to match the code.

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
- For an owner or admin, when sizing is configured: a ticket search on top,
  "Find a ticket to size — key or words from its title". Picking a ticket
  sizes it and opens its proposal when it lands. There is no status filter,
  no "Run sizing" button and no latest-run line: connecting a site sizes its
  boards on its own, and a run in progress streams ticket by ticket above the
  list instead.
- The notices appear only when there is something to say: sizing is not
  configured, or the site lacks the write grant (as a warning).
- One list of every status, in the bordered container the backlog used, with
  a header row (Ticket · Status · Size · Amount). A row is: key in mono ·
  title, truncated · status badge · complexity badge · amount (or
  "Unpriced"), right-aligned · chevron. The whole row is the button; the
  selected row is marked. Nothing else is in the row.

### Peek

Opened by a row click, over the list, with `PeekPanel`.

- Title is the ticket title; the subtitle is the key. Focus lands on the
  body, not on the close button.
- A tab strip, Bounty | Spec, with "Open in Jira" pinned to the right as the
  ticket peek has it.
- Bounty: a property list in the shape the Spec tab's fields use — Status,
  Size (with "Consider splitting" on XL, and "set by a reviewer" when it
  was), Amount, Sized by (model and confidence), Ticket (unchanged /
  changed / missing since sizing, in words), Revision — then the rationale
  as prose under "Why this size"; delivery status when a write-back exists;
  the revision history only when there is more than one, where a click
  switches the peek to that revision. The actions for an owner or admin, by
  state, sit inside the Bounty card, each beside the fact it changes; see the
  two-state proposals spec.
- Spec: the ticket read live from Jira by key, through the same read the
  backlog peek used. One scroll: the fields list first, then the description
  as Markdown beneath it. No inner tabs. The same skeleton and
  error-with-retry. Fetched when the peek opens, so switching to the tab is
  instant.
- A `?proposal=` id the board no longer has (a stale shared link) says so in
  the peek; a read that failed for another reason offers to try again.

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
the minimal rows, the actions in the Bounty card, the Spec tab, and the
absence of a status filter or run controls.
