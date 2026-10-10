import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  MembershipClient,
  BountyClient,
  JiraManagementClient,
  GithubManagementClient,
  PricingClient,
  BountyRunClient,
} from "../src/index.js";
const options = {
  baseUrl: "",
  fetch: (async () =>
    Response.json({
      organizations: [],
      invitations: [],
      members: [],
      user: { id: "1", username: null },
      emails: [],
      connections: [],
      boards: [],
      repositories: [],
      rateCard: null,
      proposals: [],
      nextCursor: null,
      total: 0,
      uncategorized: 0,
      categories: [],
      profiles: [],
      spec: null,
    })) as typeof fetch,
};

test("feature reads validate their success envelopes", async () => {
  const memberships = new MembershipClient(options);
  assert.deepEqual(await memberships.memberships(), []);
  assert.deepEqual(await memberships.invitations(), []);
  assert.deepEqual(await memberships.members("owner /"), []);
  assert.deepEqual(await memberships.account(), { id: "1", username: null });
  assert.deepEqual(await memberships.emails(), []);
  const jira = new JiraManagementClient(options);
  assert.deepEqual(await jira.connections("owner"), []);
  assert.deepEqual(await jira.boards("owner"), []);
  await jira.disconnect("owner", "1");
  const github = new GithubManagementClient(options);
  assert.deepEqual(await github.connections("owner"), []);
  assert.deepEqual(await github.repositories("owner"), []);
  await github.disconnect("owner", "1");
  const pricing = new PricingClient(options);
  assert.equal(await pricing.rateCard("owner"), null);
  assert.deepEqual(await pricing.profiles("owner", "1"), []);
  assert.deepEqual(await pricing.proposals("owner"), {
    proposals: [],
    nextCursor: null,
  });
  assert.deepEqual(await pricing.categories("owner"), {
    total: 0,
    uncategorized: 0,
    categories: [],
  });
  assert.deepEqual(await pricing.spec("owner", "1"), { spec: null });
});

test("a proposal's profiles are read one per repository its work touches", async () => {
  const urls: string[] = [];
  const stored = {
    id: "bpf_1",
    proposalId: "bpr 1",
    specRevision: 2,
    repository: "acme/app",
    status: "scoping",
    errorCode: null,
    runErrorCode: null,
    snapshotId: "rsn_1",
    scopeRunId: null,
    sliceRunId: null,
    profile: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const pricing = new PricingClient({
    baseUrl: "",
    fetch: (async (input) => {
      urls.push(String(input));
      return Response.json({
        profiles: [stored, { ...stored, id: "bpf_2", repository: null }],
      });
    }) as typeof fetch,
  });
  assert.deepEqual(
    (await pricing.profiles("owner", "bpr 1")).map(
      ({ repository }) => repository,
    ),
    ["acme/app", null],
  );
  assert.deepEqual(urls, ["/api/v1/orgs/owner/proposals/bpr%201/profile"]);
});

test("bounty transport retains conflicts and cancels without dispatch", async () => {
  const paths: string[] = [];
  const client = new BountyClient({
    baseUrl: "",
    fetch: (async (input) => {
      paths.push(String(input));
      return Response.json({ bounties: [], nextCursor: null });
    }) as typeof fetch,
  });
  assert.deepEqual(
    await client.bounties("owner /", { limit: 50, cursor: "page /" }),
    { bounties: [], nextCursor: null },
  );
  assert.match(paths[0] ?? "", /owner%20%2F.*limit=50.*cursor=page/);
  await client.bounties("owner");
  assert.deepEqual(await client.myBounties({ cursor: "page /" }), {
    bounties: [],
    nextCursor: null,
  });
  assert.match(paths[2] ?? "", /^\/api\/v1\/me\/bounties\?cursor=page/);
  await client.myBounties();
  // An answer with no versions is not a list of them.
  await assert.rejects(client.scopeVersions("owner", "1"));
  assert.match(paths.at(-1) ?? "", /\/bounties\/1\/versions$/);
  // Nor is an empty answer a source's context, or a sync's.
  await assert.rejects(client.bountyContext("owner", "1"));
  assert.match(paths.at(-1) ?? "", /\/bounties\/1\/context$/);
  await assert.rejects(client.syncBountyContext("owner", "1", "github"));
  assert.match(paths.at(-1) ?? "", /\/bounties\/1\/context\/github\/sync$/);
  await assert.rejects(client.bounty("owner", "1"));
  await assert.rejects(client.decideBounty("owner", "1", "approve", 2));
  assert.match(paths.at(-1) ?? "", /\/bounties\/1\/approve$/);
  await client.deleteBounty("owner", "1");
  const malformed = new BountyRunClient(options);
  await assert.rejects(malformed.run("owner", "1"));
  await assert.rejects(malformed.runs("owner", "1"));
  // A board run is started by name, and an answer with no run is refused.
  const started: { url: string; init: RequestInit | undefined }[] = [];
  const starter = new BountyRunClient({
    baseUrl: "",
    fetch: (async (input, init) => {
      started.push({ url: String(input), init });
      return Response.json({});
    }) as typeof fetch,
  });
  await assert.rejects(starter.start("owner /", "board /", "req_1"));
  assert.equal(
    started[0]?.url,
    "/api/v1/orgs/owner%20%2F/jira/boards/board%20%2F/runs",
  );
  assert.equal(started[0]?.init?.method, "POST");
  assert.equal(started[0]?.init?.body, JSON.stringify({ requestId: "req_1" }));
  const conflicts = new BountyClient({
    baseUrl: "",
    fetch: (async () =>
      Response.json(
        { error: "changed", code: "bounty_changed", bounty: { revision: 3 } },
        { status: 409 },
      )) as typeof fetch,
  });
  for (const action of [
    () =>
      conflicts.createBounty("owner", {
        title: "Task",
        description: "",
        stack: [],
      }),
    () =>
      conflicts.updateBounty("owner", "1", {
        expectedRevision: 1,
        title: "Task",
      }),
  ]) {
    await assert.rejects(
      action(),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "bounty_changed" &&
        JSON.stringify(error.details).includes('"revision":3'),
    );
  }
  await assert.rejects(
    client.bounties("owner", {}, AbortSignal.abort(new Error("stopped"))),
    /stopped/,
  );
  assert.equal(paths.length, 10);
});

test("pricing detail and revision envelopes fail explicitly when malformed", async () => {
  const pricing = new PricingClient(options);
  await assert.rejects(pricing.detail("owner", "id", "board"));
  await assert.rejects(pricing.detail("owner", "id"));
  await assert.rejects(pricing.revisions("owner", "id"));
  await pricing.spec("owner", "id", undefined, 2);
  await pricing.categories("owner", "board");
  assert.deepEqual(
    await pricing.action("owner", "/proposals/id/remove", {}),
    {},
  );
  assert.equal(
    await pricing.saveRateCard("owner", {
      expectedRevision: 1,
      currency: "USD",
      xsMinor: 1,
      sMinor: 2,
      mMinor: 3,
      lMinor: 4,
      xlMinor: 5,
    }),
    null,
  );
  const jira = new JiraManagementClient(options);
  await assert.rejects(jira.search("owner", "board", "a /"));
  assert.deepEqual(
    await jira.proposeIssue("owner", "board", "1", "request"),
    {},
  );
});

test("GitHub management validates installation and write envelopes", async () => {
  const client = new GithubManagementClient(options);
  await assert.rejects(client.available("owner"));
  await assert.rejects(client.link("owner", "1"));
  await assert.rejects(client.register("owner", "1", "2"));
  assert.deepEqual(await client.installationRepositories("owner", "1"), []);
  await client.remove("owner", "1");
});

test("account and membership writes validate envelopes and preserve paths", async () => {
  const requests: string[] = [];
  const client = new MembershipClient({
    baseUrl: "",
    fetch: (async (input) => {
      requests.push(String(input));
      return Response.json({
        name: "Ada",
        username: "ada",
        invitation: { id: "invite" },
      });
    }) as typeof fetch,
  });
  assert.equal(await client.saveName("Ada"), "Ada");
  assert.equal(await client.saveUsername("ada"), "ada");
  assert.deepEqual(await client.invite("owner /", { handle: "ada" }), {
    id: "invite",
  });
  await client.makeEmailPrimary("email /");
  assert.equal(requests[3], "/api/v1/me/emails/email%20%2F/primary");
  const malformed = new MembershipClient(options);
  await assert.rejects(malformed.saveName("Ada"));
  await assert.rejects(malformed.saveUsername("ada"));
  await assert.rejects(malformed.invite("o", { email: "ada@example.test" }));
});
test("Jira writes and detail reads validate their envelopes", async () => {
  const client = new JiraManagementClient(options);
  assert.deepEqual(await client.sync("o", "id"), []);
  await assert.rejects(client.issue("o", "board", "ISSUE-1"));
  await assert.rejects(client.preview("o", "board"));
  await assert.rejects(
    client.updateBoard("o", "board", { selection: { unassignedOnly: false } }),
  );
  assert.deepEqual(
    await new BountyClient(options).proposeBounty("o", "id", "request"),
    {},
  );
  // A bounty's sizing must say whether a run is in flight, even as null.
  await assert.rejects(new BountyClient(options).bountySizing("o", "id"));
  const requested: string[] = [];
  const sizing = new BountyClient({
    baseUrl: "",
    fetch: (async (input: string) => {
      requested.push(input);
      return Response.json({ run: null });
    }) as typeof fetch,
  });
  assert.equal(await sizing.bountySizing("o /", "b /"), null);
  assert.equal(requested[0], "/api/v1/orgs/o%20%2F/bounties/b%20%2F/sizing");
});
