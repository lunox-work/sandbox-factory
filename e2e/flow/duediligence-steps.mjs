/**
 * A bounty posted with a spec confirmed in duediligence (`POST …/bounties`
 * with `spec`, as `duediligence push` sends it): sizing prices that spec
 * and drafts none, the proposal's spec reads back as the posted one by
 * duediligence's own parser, and its decisions stand confirmed by the
 * person who posted it, so the price is approved with no second
 * confirmation. It stops at the approval: the workspace's sandbox
 * preparation is turned off first, so no second sandbox is built. Last in
 * the flow, after `USAGE_STEPS`, so it leaves the setting off.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decisionItems, scenarios } from "duediligence/api";
import { PERSON } from "./seed.mjs";
import { api, noFaults, say } from "./steps.mjs";

/** A spec.md as duediligence writes and confirms one. */
const SPEC = `# Statement fee lines

Each debit on a statement shows the fee it paid.

\`\`\`gherkin
Feature: Statement fee lines

  Rule: R1. Every debit line carries its fee
    @happy
    Scenario: A debit line shows its fee
      Given a debit of 4250 cents that paid 43 cents
      When the statement is rendered
      Then its line reads "fee 0.43"

    @boundary
    Scenario Outline: Fees under a cent are shown as zero
      Given a debit that paid <fee> cents
      Then its line reads "<shown>"

      Examples:
        | fee | shown    |
        | 0   | fee 0.00 |

  Rule: R2. Credits carry none
    @unhappy
    Scenario: A credit line shows no fee
      Given a credit of 10000 cents
      When the statement is rendered
      Then its line has no fee
\`\`\`

Decided:

- The fee is shown with two decimals and no currency sign.
  Ticket: silent.
  Instead: show it in the account's currency format.
- A credit's line leaves the fee out rather than showing zero.
`;

export const DUEDILIGENCE_STEPS = [
  [
    "post a bounty with a spec confirmed in duediligence (API token)",
    async (flow) => {
      // Approving it must not start a second sandbox: preparation off.
      await api(flow, "PATCH", "/api/v1/orgs/:org/settings", {
        body: { prepareSandboxes: false },
      });
      // A document duediligence can read but the platform cannot store
      // as written is refused whole, with where.
      const refused = await api(flow, "POST", "/api/v1/orgs/:org/bounties", {
        as: flow.token,
        body: {
          title: "Statement fee lines",
          spec: {
            document: SPEC.replace("@unhappy", "@edge"),
            format: "duediligence",
            confirmed: true,
          },
        },
        expected: [422],
      });
      assert.equal(refused.code, "invalid_spec");
      assert.deepEqual(
        refused.problems.map((problem) => problem.path),
        ["scenarios[2].kind"],
      );
      // A token without decisions:confirm still posts, its decisions left
      // for a person, and the answer says why.
      const older = await api(flow, "POST", "/api/v1/orgs/:org/bounties", {
        as: flow.olderToken,
        body: {
          title: "Statement fee lines, unconfirmed",
          spec: { document: SPEC, format: "duediligence", confirmed: true },
        },
        expected: [201],
      });
      assert.equal(older.confirmation, "skipped_scope");
      assert.equal(older.bounty.postedSpec.confirmed, false);

      const { bounty } = await api(flow, "POST", "/api/v1/orgs/:org/bounties", {
        as: flow.token,
        body: {
          title: "Statement fee lines",
          spec: {
            document: SPEC,
            format: "duediligence",
            confirmed: true,
            engine: { name: "duediligence", version: "0.5.1" },
          },
        },
        expected: [201],
      });
      assert.equal(bounty.description, SPEC, "the spec is its description");
      assert.deepEqual(
        { ...bounty.postedSpec, createdAt: undefined },
        {
          source: "duediligence@0.5.1",
          confirmed: true,
          current: true,
          createdAt: undefined,
        },
      );
      const { bounty: approved } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${bounty.id}/approve`,
        { as: flow.token, body: { expectedRevision: bounty.revision } },
      );
      flow.posted = { bounty: approved };
    },
  ],
  [
    "size it: the posted spec is the proposal's, not drafted, its decisions confirmed by the poster",
    async (flow) => {
      const drafts = () =>
        flow.caller.calls.filter((call) => call.tool === "draft_spec").length;
      const sizes = () =>
        flow.caller.calls.filter((call) => call.tool === "size_bounty").length;
      const [draftsBefore, sizesBefore] = [drafts(), sizes()];
      const { run } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${flow.posted.bounty.id}/propose`,
        {
          as: flow.token,
          body: { requestId: randomUUID() },
          expected: [202],
        },
      );
      const ended = await flow.platform.waitForBountyRun(
        flow.organizationId,
        run.id,
      );
      assert.equal(ended.status, "succeeded", JSON.stringify(ended));
      assert.equal(drafts(), draftsBefore, "no spec was drafted");
      assert.equal(sizes(), sizesBefore + 1, "it was sized");

      const { bounty } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${flow.posted.bounty.id}`,
      );
      const proposalId = bounty.proposal?.id;
      assert.ok(proposalId, JSON.stringify(bounty.proposal));
      const path = `/api/v1/orgs/:org/proposals/${proposalId}`;
      const { spec } = await api(flow, "GET", `${path}/spec`);
      assert.equal(spec.revision, 1);
      assert.equal(spec.source, "duediligence@0.5.1");
      assert.equal(spec.createdBy, PERSON.id);
      // The spec as duediligence reads it back is the one posted.
      const { document } = await api(flow, "GET", `${path}/spec/gherkin`);
      const keyed = (text) =>
        scenarios(text).map(({ key, title }) => `${key} ${title}`);
      const decided = (text) => decisionItems(text).map(({ text }) => text);
      assert.deepEqual(keyed(document), keyed(SPEC));
      assert.deepEqual(decided(document), decided(SPEC));
      assert.deepEqual(spec.draft.assumptions, decided(SPEC));

      const decisions = await api(flow, "GET", `${path}/decisions`);
      assert.equal(decisions.specRevision, 1);
      assert.deepEqual(
        decisions.confirmation && {
          confirmedBy: decisions.confirmation.confirmedBy,
          confirmedByName: decisions.confirmation.confirmedByName,
          via: decisions.confirmation.via,
        },
        {
          confirmedBy: PERSON.id,
          confirmedByName: PERSON.name,
          via: "duediligence",
        },
      );
      assert.equal(
        decisions.confirmation.credential,
        "token",
        "recorded as an API token's",
      );
      flow.posted.proposalId = proposalId;
      noFaults(flow);
    },
  ],
  [
    "approve its price with no second confirmation",
    async (flow) => {
      // The profile its one repository asked for, so the price saw the code.
      // Its slice is the one the first bounty's profile built, found in the
      // cache: ready after one quiet pass, not left slicing until the
      // profiler's next timed sweep (approval would answer profile_pending).
      await flow.platform.settle({ quietPasses: 1 });
      const path = `/api/v1/orgs/:org/proposals/${flow.posted.proposalId}`;
      const { profiles } = await api(flow, "GET", `${path}/profile`);
      assert.deepEqual(
        profiles.map((profile) => profile.status),
        ["ready"],
        "its repository is profiled, on the slice already built",
      );
      assert.equal(
        profiles[0].sliceRunId,
        flow.profile.sliceRunId,
        "the first bounty's slice, reused",
      );
      const { proposal } = await api(flow, "GET", path);
      const approval = await api(flow, "POST", `${path}/approve`, {
        body: {
          expectedRevision: proposal.revision,
          expectedPrice: {
            complexity: proposal.complexity,
            amountMinor: proposal.amountMinor,
            currency: proposal.currency,
          },
        },
      });
      assert.equal(approval.proposal.status, "approved");
      await flow.platform.settle();
      const { sandboxes } = await api(
        flow,
        "GET",
        "/api/v1/orgs/:org/sandboxes",
      );
      assert.equal(
        sandboxes.some((each) => each.bountyId === flow.posted.bounty.id),
        false,
        "preparation is off: no second sandbox",
      );
      say(
        `posted spec ${flow.posted.bounty.id}: sized ${proposal.complexity} at ${proposal.amountMinor}, approved on its duediligence confirmation`,
      );
      noFaults(flow);
    },
  ],
];
