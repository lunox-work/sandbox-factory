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
      profile: null,
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
  assert.equal(await pricing.profile("owner", "1"), null);
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
  await assert.rejects(client.bounty("owner", "1"));
  await client.deleteBounty("owner", "1");
  const malformed = new BountyRunClient(options);
  await assert.rejects(malformed.run("owner", "1"));
  await assert.rejects(malformed.runs("owner", "1"));
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
        repoId: null,
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
  assert.equal(paths.length, 6);
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

test("title streams deliver lines incrementally and release on abort", async () => {
  const controller = new AbortController();
  const lines: unknown[] = [];
  const encoder = new TextEncoder();
  const client = new PricingClient({
    baseUrl: "",
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              encoder.encode('{"id":"one"}\ninvalid\n \n{"id":"two"}'),
            );
            stream.close();
          },
        }),
      )) as typeof fetch,
  });
  await client.titles(
    "owner /",
    "board /",
    ["one /"],
    (value) => lines.push(value),
    controller.signal,
  );
  assert.deepEqual(lines, [{ id: "one" }, { id: "two" }]);
  const failed = new PricingClient({
    baseUrl: "",
    fetch: (async () =>
      Response.json(
        { error: "Expired", code: "auth" },
        { status: 401 },
      )) as typeof fetch,
  });
  await assert.rejects(
    failed.titles("o", "b", [], () => {}, controller.signal),
    (error: unknown) => error instanceof ApiError && error.isUnauthorized,
  );
  const empty = new PricingClient({
    baseUrl: "",
    fetch: (async () => new Response(null)) as typeof fetch,
  });
  await empty.titles("o", "b", [], () => {}, controller.signal);
  let cancelled = false;
  const pending = new PricingClient({
    baseUrl: "",
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(encoder.encode('{"id":"one"}\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(
    pending.titles(
      "o",
      "b",
      [],
      () => controller.abort(new Error("stopped")),
      controller.signal,
    ),
    /stopped/,
  );
  assert.equal(cancelled, true);
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
});
