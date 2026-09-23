# Two-state proposals

Date: 2026-09-22. Status: approved.

## Problem

A proposal could be proposed, approved, rejected, or superseded. Rejection
was a terminal state with nothing to do from it, and superseding — a re-price
creating a new proposal row and retiring the old one — produced history rows
that needed a filter, a History section, a replacement link, and a Jira
comment explaining the replacement. Four states for what a reviewer
experiences as two: not yet approved, and approved.

## Decision

A proposal is `proposed` or `approved`. Nothing else.

### Actions

- Proposed: Approve · Resize · Re-price · Remove.
- Approved: Unapprove · Re-price.
- **Re-price** sizes the ticket again and updates the same proposal in place
  — new model sizing, amount, spec hash, run — and puts it back to Proposed.
  The id is stable, so links keep working. No replacement row.
- **Unapprove** puts an approved proposal back to Proposed without
  re-sizing.
- **Resize** changes the size and the amount it prices to, nothing else. It
  does not read Jira: the ticket is checked at approval, the decision that
  depends on it, and the web applies the returned proposal to the row
  rather than re-reading the board.
- **Remove** deletes the proposal, so the next sizing run may propose the
  ticket again. Offered on Proposed only. An approved bounty is unapproved
  or re-priced first: those are what owe Jira a withdrawal, and a write-back
  is delivered by loading its proposal, so the row must still exist while a
  withdrawal is pending.

### Jira

Write-back kinds are `approved` and `withdrawn`. Unapproving or re-pricing an
approved proposal whose approval comment was posted queues one `withdrawn`
comment — "The approved bounty was withdrawn." — with the same payload the
approval carried. The label stays. Nothing changes an approval while its
Jira update is pending, running, or uncertain, as today.

### API

`POST /proposals/:id/unapprove` and `POST /proposals/:id/remove`, both taking
`expectedRevision`. `POST /proposals/:id/reject` is removed. The list's
`status` filter accepts `proposed` or `approved`. The detail response no
longer carries `history`.

### Database

`bounty_proposal.status` is checked against `('proposed', 'approved')`;
`bounty_writeback.kind` against `('approved', 'withdrawn')`. The
`replaces_proposal_id` column and its foreign key go. A custom migration
first deletes any proposal in a retired status (none exist in any
environment that has the tables), then the generated migration tightens the
constraints.

### Web

Two filter tabs, Proposed and Approved. The peek's Bounty card offers the
actions for the proposal's state: Re-price, labelled Re-analyze, beside the
status; the resize as the size control itself, level with the amount;
Approve or Unapprove after the model's reasoning, on a row with the ticket's
freshness and revision; and Remove under Approve. Remove asks for confirmation. The History section goes; the
revision number stays.

### Tests

API routes, delivery, and executor; the db stores, unit and Postgres
integration; the web board and proposals tests.
