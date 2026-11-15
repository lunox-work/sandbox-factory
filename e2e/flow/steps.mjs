/**
 * The flow's steps, each `[name, async (flow) => {...}]` over one shared
 * `flow` object: the platform, the seeded ids and credentials, and what
 * earlier steps made (the bounty, proposal, profile, sandbox, version,
 * build run, handout). A later part adds its own list beside
 * `PUBLISH_STEPS` and `flow.mjs` runs them in order.
 *
 * Every step drives the API over HTTP (`api`), as the web app or a token
 * holder would, then lets the platform's background work finish
 * (`settle`) and checks what it left.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  assessRubric,
  priceFor,
  resolveStepSettings,
  stepUp,
} from "sandbox-factory";
import {
  rubricPrice,
  rubricTakesOver,
} from "../../apps/api/dist/pricing/rubric.js";
import { BUILD_TRANSFORM_PATH } from "../../apps/worker/dist/tools/sandbox-build.js";
import { BOUNTY, FIXTURE, SIZING } from "./fakes.mjs";
import { PERSON } from "./seed.mjs";

export const RATE_CARD = {
  currency: "USD",
  xsMinor: 5_000,
  sMinor: 10_000,
  mMinor: 20_000,
  lMinor: 40_000,
  xlMinor: 80_000,
};
/** The workspace's own name, which nothing handed out may carry. */
const VOCABULARY = /orvanta/i;
export const say = (line) => console.log(`flow: ${line}`);

/**
 * A request to the API as a client makes it, answered `expected` or the
 * step fails with the body. `as` is the credential: the session's (the
 * default) or the workspace token's headers.
 */
export async function api(
  flow,
  method,
  path,
  { as, body, expected = [200] } = {},
) {
  // Bytes go as they are, as a zipped folder; anything else as JSON.
  const raw = body instanceof Uint8Array;
  const response = await flow.platform.app.request(
    path.replace(":org", flow.organizationId),
    {
      method,
      headers: {
        ...(as ?? flow.session),
        ...(body === undefined
          ? {}
          : { "content-type": raw ? "application/zip" : "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: raw ? body : JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  if (!expected.includes(response.status))
    throw new Error(
      `${method} ${path} answered ${response.status}: ${text.slice(0, 2_000)}`,
    );
  return text === "" ? null : JSON.parse(text);
}

/** A run's artifact, read through the analysis routes, as text. */
export async function artifactText(flow, runId, path) {
  const { artifacts } = await api(
    flow,
    "GET",
    `/api/v1/orgs/:org/github/runs/${runId}/artifacts`,
  );
  const artifact = artifacts.find((each) => each.path === path);
  assert.ok(artifact, `run ${runId} wrote ${path}`);
  const content = await api(
    flow,
    "GET",
    `/api/v1/orgs/:org/github/artifacts/${artifact.id}/content`,
  );
  assert.equal(
    typeof content.text,
    "string",
    `${path} is readable: ${content.omitted}`,
  );
  return content.text;
}

/** Nothing went wrong out of sight since the last check. */
export function noFaults(flow) {
  assert.deepEqual(flow.platform.faults.splice(0), [], "no background errors");
  assert.deepEqual(
    flow.agents.unexpected.splice(0),
    [],
    "no agent off its script",
  );
  const corrected = flow.agents.errors.splice(0);
  if (corrected.length > 0)
    say(`agent tool errors, corrected: ${corrected.join(" | ")}`);
  assert.deepEqual(
    flow.github.unexpected,
    [],
    "no GitHub call outside the fake's routes",
  );
  const failed = flow.platform.ranRuns.filter(
    (run) => run.status !== "succeeded",
  );
  assert.deepEqual(failed, [], "every worker run succeeded");
}

/** An empty workspace with a repository, to a published sandbox version. */
export const PUBLISH_STEPS = [
  [
    "rate card",
    async (flow) => {
      const { rateCard } = await api(
        flow,
        "PUT",
        "/api/v1/orgs/:org/rate-card",
        {
          body: { ...RATE_CARD, expectedRevision: 0 },
        },
      );
      assert.equal(rateCard.sMinor, RATE_CARD.sMinor);
    },
  ],
  [
    "build the repository's context (Build all)",
    async (flow) => {
      const { runs } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/github/repositories/${flow.repoId}/builds`,
        { body: {}, expected: [202] },
      );
      assert.deepEqual(runs.map((run) => run.tool).sort(), [
        "abstractions",
        "brief",
        "data_model",
        "documents",
        "graphify",
      ]);
      await flow.platform.settle();
      for (const run of runs) {
        const { run: ended } = await api(
          flow,
          "GET",
          `/api/v1/orgs/:org/github/runs/${run.id}`,
        );
        assert.equal(
          ended.status,
          "succeeded",
          `${run.tool} ${ended.errorCode ?? ""}`,
        );
      }
      const built = await flow.platform.stores.repoSnapshots.built(
        flow.organizationId,
        flow.repoId,
      );
      assert.deepEqual(
        built.map((snapshot) => snapshot.id),
        [flow.snapshotId],
        "the snapshot is built, so sizing reads its brief",
      );
      noFaults(flow);
    },
  ],
  [
    "create the bounty and approve its scope (API token)",
    async (flow) => {
      const { bounty } = await api(flow, "POST", "/api/v1/orgs/:org/bounties", {
        as: flow.token,
        body: BOUNTY,
        expected: [201],
      });
      const { bounty: approved } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${bounty.id}/approve`,
        { as: flow.token, body: { expectedRevision: bounty.revision } },
      );
      assert.ok(approved.approval, "the scope is approved");
      flow.bounty = approved;
    },
  ],
  [
    "propose: the sizing run drafts the spec and prices it",
    async (flow) => {
      const { run } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${flow.bounty.id}/propose`,
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
      // The sizing model was shown the repository's brief, the build's.
      const draftPrompt =
        flow.caller.calls.find((call) => call.tool === "draft_spec")?.prompt ??
        "";
      assert.match(draftPrompt, /Repository briefs:/);
      const { bounty } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${flow.bounty.id}`,
      );
      const proposalId = bounty.proposal?.id;
      assert.ok(
        proposalId,
        `the bounty has a proposal: ${JSON.stringify(bounty.proposal)}`,
      );
      const { proposal } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${proposalId}`,
      );
      const { spec } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${proposalId}/spec`,
      );
      assert.deepEqual(
        spec.draft.scenarios.map((scenario) => scenario.id),
        ["s1", "s2", "s3"],
      );
      assert.deepEqual(
        proposal.repositories.map((repository) => repository.snapshotId),
        [flow.snapshotId],
        "the draft touches the fixture's repository",
      );
      // The price the rubric gives the stored draft beside the model's
      // size, as the executor prices a fresh proposal whose code is
      // pending (`pricing/executor.ts`).
      const settings = resolveStepSettings({});
      const rubric = assessRubric({
        spec: spec.draft,
        code: { status: "pending" },
        weightPoints: settings.weightPoints,
      });
      const step = stepUp(SIZING.complexity, spec.draft, spec.draft, settings);
      const byRubric = rubricTakesOver(rubric, {
        sizedBy: "model",
        complexity: SIZING.complexity,
      })
        ? rubricPrice(rubric, { rateCard: proposal.rateCard })
        : null;
      const expected =
        byRubric?.amountMinor ??
        priceFor(step?.complexity ?? SIZING.complexity, RATE_CARD);
      assert.equal(
        proposal.amountMinor,
        expected,
        "the price is the rubric's at the fixed size",
      );
      assert.equal(proposal.currency, RATE_CARD.currency);
      assert.equal(proposal.pricedFrom, "spec", "the code is still pending");
      flow.proposalId = proposalId;
      flow.price = {
        sized: SIZING.complexity,
        proposed: proposal.amountMinor,
        complexity: proposal.complexity,
        revision: proposal.revision,
        currency: proposal.currency,
      };
      // Not approved while the code it may move to is being profiled.
      const held = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/proposals/${proposalId}/approve`,
        {
          body: {
            expectedRevision: proposal.revision,
            expectedPrice: {
              complexity: proposal.complexity,
              amountMinor: proposal.amountMinor,
              currency: proposal.currency,
            },
          },
          expected: [409],
        },
      );
      assert.equal(held.code, "profile_pending", JSON.stringify(held));
      assert.equal(held.profiles.length, 1);
      say(
        `sized ${SIZING.complexity}, priced ${proposal.complexity} (${proposal.sizedBy}) at ${proposal.amountMinor} ${proposal.currency} minor units; approval held: profile ${held.profiles[0].status}`,
      );
      noFaults(flow);
    },
  ],
  [
    "profile: the scope agent picks the slice, which cuts the ledger",
    async (flow) => {
      await flow.platform.settle();
      const { profiles } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${flow.proposalId}/profile`,
      );
      assert.equal(profiles.length, 1, "one repository is profiled");
      const [profile] = profiles;
      assert.equal(profile.status, "ready", JSON.stringify(profile));
      const manifest = JSON.parse(
        await artifactText(flow, profile.sliceRunId, "slice-manifest.json"),
      );
      const contract = JSON.parse(
        await artifactText(flow, profile.sliceRunId, "boundary-contract.json"),
      );
      assert.deepEqual(
        manifest.included.map((file) => file.path),
        [FIXTURE.feeModule],
      );
      assert.deepEqual(
        contract.outbound.map((module) => module.module),
        [FIXTURE.ledgerModule],
      );
      assert.deepEqual(contract.blockers, []);
      // The rubric scores the measured code once the profile settles.
      const { proposal } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${flow.proposalId}`,
      );
      assert.ok(proposal.rubric, "the proposal carries its rubric");
      assert.notEqual(
        proposal.rubric.code?.status,
        "pending",
        "the code is scored",
      );
      assert.equal(proposal.pricedFrom, "code", "the price saw the code");
      flow.price.profiled = proposal.amountMinor;
      flow.price.profiledComplexity = proposal.complexity;
      say(
        `profiled: code ${proposal.rubric.code?.status}, priced ${proposal.complexity} at ${proposal.amountMinor}`,
      );
      flow.profile = profile;
      noFaults(flow);
    },
  ],
  [
    "confirm the decisions (session; a token is refused); approval waits for them",
    async (flow) => {
      const path = `/api/v1/orgs/:org/proposals/${flow.proposalId}/decisions`;
      const decisions = await api(flow, "GET", path);
      assert.equal(decisions.confirmation, null);
      assert.ok(decisions.decisions.length > 0, "the spec decided something");
      // The price it would approve, refused until a person confirms what
      // its hidden tests are written to, with the page to do it on.
      const { proposal } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${flow.proposalId}`,
      );
      const early = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/proposals/${flow.proposalId}/approve`,
        {
          body: {
            expectedRevision: proposal.revision,
            expectedPrice: {
              complexity: proposal.complexity,
              amountMinor: proposal.amountMinor,
              currency: proposal.currency,
            },
          },
          expected: [409],
        },
      );
      assert.equal(early.code, "decisions_unconfirmed", JSON.stringify(early));
      assert.equal(early.confirmUrl, decisions.confirmUrl);
      const body = {
        specRevision: decisions.specRevision,
        decisionsSha256: decisions.decisionsSha256,
      };
      await api(flow, "POST", `${path}/confirm`, {
        as: flow.token,
        body,
        expected: [403],
      });
      const confirmed = await api(flow, "POST", `${path}/confirm`, { body });
      assert.equal(confirmed.confirmation?.confirmedBy, flow.userId);
    },
  ],
  [
    "approve the price; the preparer cuts and builds the sandbox",
    async (flow) => {
      // A page loaded before the profile landed names the spec's price:
      // refused, with both, not approved unseen.
      const path = `/api/v1/orgs/:org/proposals/${flow.proposalId}/approve`;
      const stale = await api(flow, "POST", path, {
        body: {
          expectedRevision: flow.price.revision,
          expectedPrice: {
            complexity: flow.price.complexity,
            amountMinor: flow.price.proposed,
            currency: flow.price.currency,
          },
        },
        expected: [409],
      });
      assert.equal(stale.code, "price_changed", JSON.stringify(stale));
      assert.equal(stale.previous.amountMinor, flow.price.proposed);
      assert.equal(stale.current.amountMinor, flow.price.profiled);
      // The price that saw the code is the one approved.
      const { proposal } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${flow.proposalId}`,
      );
      const approval = await api(flow, "POST", path, {
        body: {
          expectedRevision: proposal.revision,
          expectedPrice: {
            complexity: proposal.complexity,
            amountMinor: proposal.amountMinor,
            currency: proposal.currency,
          },
        },
      });
      assert.equal(approval.pricedFrom, "code");
      assert.equal(approval.proposal.status, "approved");
      assert.equal(
        approval.proposal.amountMinor,
        flow.price.profiled,
        "the approved price is the code-informed one",
      );
      // The fixture: the spec alone prices XS (5000); its code, XS+.
      assert.equal(flow.price.proposed, RATE_CARD.xsMinor);
      assert.equal(approval.proposal.complexity, "XS+");
      assert.equal(approval.proposal.amountMinor, 7_500);
      flow.price.approved = approval.proposal.amountMinor;
      await flow.platform.settle();
      const { sandboxes } = await api(
        flow,
        "GET",
        "/api/v1/orgs/:org/sandboxes",
      );
      const sandbox = sandboxes.find(
        (each) => each.bountyId === flow.bounty.id,
      );
      assert.ok(sandbox, "the preparer made the bounty's sandbox");
      assert.equal(sandbox.sourceRepoId, flow.repoId);
      const { versions } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/${sandbox.id}/versions`,
      );
      assert.equal(versions.length, 1);
      const versionPath = `/api/v1/orgs/:org/sandboxes/versions/${versions[0].id}`;
      const held = await api(flow, "GET", versionPath);
      assert.ok(
        held.source?.buildRunId,
        `the version records its build: ${JSON.stringify(held.source)}`,
      );
      assert.equal(
        held.source.sliceRunId,
        flow.profile.sliceRunId,
        "cut from the profile's slice",
      );
      // The fee module's comment links the workspace's wiki and gives its
      // author's address, which no table rule renames: the disclosure scan
      // holds the build before its baseline, and publishing says why.
      const blocked = JSON.parse(
        await artifactText(flow, held.source.buildRunId, "build-manifest.json"),
      );
      assert.deepEqual(
        blocked.blockers.map((blocker) => blocker.code),
        ["disclosure_findings"],
        JSON.stringify(blocked.blockers),
      );
      const findings = blocked.gates.disclosure.findings;
      assert.deepEqual(
        findings.map((finding) => finding.kind),
        ["url", "email", "author"],
      );
      const refused = await api(flow, "POST", `${versionPath}/publish`, {
        body: {
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        expected: [409],
      });
      // A blocked build settles nothing it wrote, so its evidence is stale
      // too; the disclosure scan's findings are named whatever comes first.
      assert.ok(
        refused.reasons.includes("The disclosure scan has blocking findings."),
        JSON.stringify(refused),
      );
      assert.deepEqual(
        refused.findings.map((finding) => finding.value),
        findings.map((finding) => finding.value),
      );
      // An API token cannot acknowledge them; the owner, signed in, does,
      // and the draft is built again with them.
      const acknowledgements = findings.map(({ kind, value }) => ({
        kind,
        value,
        note: "The fixture's own wiki and author, public here.",
      }));
      await api(flow, "PUT", `${versionPath}/disclosure-acknowledgements`, {
        as: flow.token,
        body: { acknowledgements },
        expected: [401, 403, 404],
      });
      const acknowledged = await api(
        flow,
        "PUT",
        `${versionPath}/disclosure-acknowledgements`,
        { body: { acknowledgements } },
      );
      assert.equal(acknowledged.source.buildRunId, null, "evidence cleared");
      assert.deepEqual(
        acknowledged.source.disclosureAcknowledgements.map((item) => item.by),
        [PERSON.id, PERSON.id, PERSON.id],
      );
      await api(flow, "POST", `${versionPath}/build`, { expected: [202] });
      await flow.platform.settle();
      const stored = await api(flow, "GET", versionPath);
      const buildRunId = stored.source?.buildRunId;
      assert.ok(buildRunId, "the version records its new build");
      assert.notEqual(buildRunId, held.source.buildRunId);
      const manifest = JSON.parse(
        await artifactText(flow, buildRunId, "build-manifest.json"),
      );
      assert.deepEqual(manifest.blockers, []);
      assert.equal(manifest.gates.disclosure.status, "passed");
      assert.equal(manifest.gates.disclosure.acknowledged, 3);
      assert.equal(
        manifest.ready,
        true,
        JSON.stringify(manifest.baseline?.reasons),
      );
      const transform = JSON.parse(
        await artifactText(flow, buildRunId, BUILD_TRANSFORM_PATH),
      );
      assert.equal(transform.acceptanceTests.length, 3, "three hidden tests");
      assert.deepEqual(
        transform.acceptanceTests.map((test) =>
          test.path.split("/").at(-1).slice(0, 2),
        ),
        ["s1", "s2", "s3"],
        "one per scenario",
      );
      const calibration = transform.hiddenTests?.calibration;
      assert.equal(calibration?.status, "ok", JSON.stringify(calibration));
      assert.equal(calibration.kept.length, 3);
      assert.deepEqual(calibration.dropped, []);
      // The table was drafted by rule; no pseudonyms or fixtures agent ran.
      assert.deepEqual(flow.agents.agents, [
        "submit_scope",
        "submit_hidden_tests",
        "submit_reference",
      ]);
      assert.doesNotMatch(
        flow.agents.learned.feesPath,
        VOCABULARY,
        "the project is renamed",
      );
      // Every model reply is on the workspace's token ledger: the sizing
      // run's two, and each agent turn of the scope and build runs.
      const ledger = await flow.platform.db.execute(sql`
        select run_family, run_id, count(*)::int as replies from model_usage
        where organization_id = ${flow.organizationId}
        group by run_family, run_id
      `);
      const families = ledger.map((row) => row.run_family).sort();
      assert.deepEqual(
        families,
        ["analysis", "analysis", "sizing"],
        JSON.stringify(ledger),
      );
      assert.ok(
        ledger.some((row) => row.run_id === buildRunId),
        "the build's agents are metered",
      );
      flow.sandbox = sandbox;
      flow.version = stored;
      flow.buildRunId = buildRunId;
      say(
        `built ${versions[0].id} as ${flow.agents.learned.feesPath}: ${calibration.kept.length} hidden tests calibrated by ${calibration.engine}`,
      );
      noFaults(flow);
    },
  ],
  [
    "publish; the handout lists the project and nothing private",
    async (flow) => {
      const versionId = flow.version.version.id;
      const expiresAt = new Date(
        Date.now() + 30 * 24 * 3_600_000,
      ).toISOString();
      const published = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/publish`,
        {
          body: { expiresAt },
        },
      );
      assert.equal(published.sandbox.status, "published");
      assert.equal(published.sandbox.currentVersionId, versionId);
      // Both publication gates passed on its build, and are recorded.
      assert.deepEqual(published.gates, { status: "passed", reason: null });
      assert.ok(published.source.buildRunId);
      assert.equal(
        published.source.roundTripRunId,
        published.source.buildRunId,
      );
      assert.equal(
        published.source.disclosureRunId,
        published.source.buildRunId,
      );
      assert.deepEqual(
        flow.platform.published.map((each) => each.versionId),
        [versionId],
        "the publication is announced",
      );
      const handout = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/handout`,
      );
      const paths = (handout.files ?? []).map((file) => file.path);
      for (const path of [
        "package.json",
        "README.md",
        "TASK.md",
        flow.agents.learned.feesPath,
      ])
        assert.ok(
          paths.includes(path),
          `the handout lists ${path}: ${paths.join(", ")}`,
        );
      assert.ok(
        !paths.some((path) => path.startsWith("tests/private")),
        "no hidden test is handed out",
      );
      assert.ok(
        !paths.some((path) => VOCABULARY.test(path)),
        "no path names the workspace",
      );
      const manifest = JSON.parse(
        await artifactText(flow, flow.buildRunId, "build-manifest.json"),
      );
      // The repository's own test of the fee module, carried as a
      // read-only public test and handed out; its other test names the
      // ledger's balance, which the table drafted for the slice leaves in
      // the workspace's name, so the scan drops it, with why, for owners
      // alone (the worker round trip's table renames it, and it is
      // dropped there for not compiling against the ledger's stub).
      assert.deepEqual(
        manifest.carriedTests?.kept,
        [
          {
            path: "tests/public/carried/test/credit.test.ts",
            from: "test/credit.test.ts",
          },
        ],
        JSON.stringify(manifest.carriedTests),
      );
      assert.deepEqual(
        manifest.carriedTests.dropped.map(({ from, reason }) => [from, reason]),
        [["test/fees.test.ts", "disclosure"]],
      );
      assert.ok(
        paths.includes("tests/public/carried/test/credit.test.ts"),
        `the handout lists the carried test: ${paths.join(", ")}`,
      );
      // The three hidden tests, not the name table beside them, and the
      // commitment the build recorded over them.
      const recorded = manifest.hiddenCommitment;
      assert.equal(handout.hiddenTests, 3, "three hidden tests are counted");
      assert.equal(handout.hiddenSha256Version, 2);
      assert.equal(recorded?.hiddenTests, 3);
      assert.equal(handout.hiddenSha256, recorded.hiddenSha256);
      flow.handout = handout;
      noFaults(flow);
    },
  ],
];

/** After the whole flow: what it spent, as the Usage page reads it. */
export const USAGE_STEPS = [
  [
    "usage meters the flow's model tokens, evaluator seconds and gradings",
    async (flow) => {
      const usage = await api(flow, "GET", "/api/v1/orgs/:org/usage");
      assert.ok(usage.modelTokens.used > 0, JSON.stringify(usage.modelTokens));
      // Every evaluation job the build and the gradings ran is on the ledger.
      const evaluator = usage.evaluatorSeconds;
      assert.ok(evaluator.used > 0, JSON.stringify(evaluator));
      assert.ok(evaluator.jobs > 0);
      assert.equal(evaluator.remaining, evaluator.limit - evaluator.used);
      const kinds = evaluator.byKind.map((row) => row.kind);
      for (const kind of ["sandbox_build", "submission_grade"])
        assert.ok(kinds.includes(kind), `${kind} is metered: ${kinds}`);
      assert.equal(
        evaluator.byKind.reduce((sum, row) => sum + row.jobs, 0),
        evaluator.jobs,
      );
      // Each grading run the round trip queued is an attempt.
      assert.ok(
        usage.thisMonth.gradingAttempts > 0,
        JSON.stringify(usage.thisMonth),
      );
      say(
        `usage: ${usage.modelTokens.used} model tokens, ${evaluator.used} evaluator seconds over ${evaluator.jobs} jobs, ${usage.thisMonth.gradingAttempts} grading attempts`,
      );
      noFaults(flow);
    },
  ],
  [
    "a spent evaluator month refuses the next grading with 429 and Retry-After",
    async (flow) => {
      // Lowered under what the flow spent, as server.ts's store reads it.
      const { evaluatorQuota } = flow.platform.limits;
      const generous = evaluatorQuota.monthlySeconds;
      evaluatorQuota.monthlySeconds = 1;
      try {
        const response = await flow.platform.app.request(
          `/api/v1/orgs/${flow.organizationId}/sandboxes/versions/${flow.version.version.id}/submissions`,
          {
            method: "POST",
            headers: { ...flow.session, "content-type": "application/json" },
            body: JSON.stringify({
              files: [
                {
                  path: flow.agents.learned.feesPath,
                  text: "// over the month's evaluator time\n",
                },
              ],
            }),
          },
        );
        const body = await response.json();
        assert.equal(response.status, 429, JSON.stringify(body));
        assert.equal(body.code, "quota_exceeded");
        assert.equal(body.kind, "evaluator_seconds");
        assert.ok(Number(response.headers.get("retry-after")) >= 1);
      } finally {
        evaluatorQuota.monthlySeconds = generous;
      }
      noFaults(flow);
    },
  ],
];
