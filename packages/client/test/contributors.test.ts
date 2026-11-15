import assert from "node:assert/strict";
import { test } from "node:test";

import { ContributorClient, SandboxClient } from "../src/index.js";

const stamp = "2026-11-15T00:00:00.000Z";
const contribution = {
  assignmentId: "cas_1",
  versionId: "sbv_1",
  version: 1,
  root: "sbx_1-v1",
  title: "Statement fees",
  specSummary: "Show each debit's fee.",
  complexity: "S",
  tags: ["typescript"],
  commands: null,
  editablePaths: [],
  nodeRange: null,
  open: true,
  closesAt: stamp,
  joinedAt: stamp,
};
const submission = {
  id: "sbm_1",
  sandboxVersionId: "sbv_1",
  status: "queued",
  errorCode: null,
  verdict: null,
  public: null,
  hidden: null,
  failedScenarios: [],
  refused: [],
  retryOf: null,
  createdAt: stamp,
  updatedAt: stamp,
};
const handout = {
  versionId: "sbv_1",
  run: { id: "arn_build", status: "succeeded" },
  files: [{ path: "README.md", sizeBytes: 5, sha256: "a".repeat(64) }],
  hiddenTests: 3,
  hiddenSha256: "b".repeat(64),
  hiddenSha256Version: 2,
};
const page = {
  versionId: "sbv_1",
  root: "sbx_1-v1",
  sha256: "c".repeat(64),
  total: 1,
  files: [],
  nextCursor: null,
};
const invite = {
  id: "cin_1",
  sandboxVersionId: "sbv_1",
  label: "Grace",
  emailHint: null,
  state: "active",
  maxClaims: 1,
  claims: 0,
  expiresAt: stamp,
  revokedAt: null,
  claimedAt: null,
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: stamp,
};
const assignment = {
  id: "cas_1",
  sandboxVersionId: "sbv_1",
  user: { id: "user_c", name: "Grace Hopper", email: "g@example.test" },
  inviteId: "cin_1",
  createdAt: stamp,
  revokedAt: null,
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function recording(answer: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/archive"))
      return new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="sbx_1-v1.zip"',
          ETag: '"e1"',
        },
      });
    return Response.json(answer(url, method));
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("a contributor claims an invite, reads their version and submits to it", async () => {
  const { calls, fetch } = recording((url) => {
    if (url.endsWith("/invites/claim") || /contributions\/[^/]+$/.test(url))
      return { contribution };
    if (url.endsWith("/api/v1/contributions"))
      return { contributions: [contribution] };
    if (url.endsWith("/handout")) return handout;
    if (url.includes("/handout/files")) return page;
    if (url.endsWith("/submissions") && !url.includes("sbm"))
      return { submissions: [submission], submission };
    return { submission };
  });
  const client = new ContributorClient({ baseUrl: "https://api.test", fetch });
  assert.deepEqual(await client.claimInvite("lnxinv_x"), contribution);
  assert.deepEqual(await client.contributions(), [contribution]);
  assert.deepEqual(await client.contribution("sbv 1"), contribution);
  assert.deepEqual(await client.contributionHandout("sbv_1"), handout);
  const archive = await client.contributionArchive("sbv_1");
  assert.equal(archive.filename, "sbx_1-v1.zip");
  assert.deepEqual(await client.contributionFiles("sbv_1"), page);
  await client.contributionFiles("sbv_1", { cursor: "a.1", maxBytes: 2000 });
  assert.deepEqual(await client.contributionSubmissions("sbv_1"), [submission]);
  assert.deepEqual(
    await client.contributionSubmission("sbv_1", "sbm_1"),
    submission,
  );
  const files = [{ path: "src/fees.ts", text: "x" }];
  assert.deepEqual(await client.submitContribution("sbv_1", files), submission);
  assert.deepEqual(
    await client.retryContribution("sbv_1", "sbm_1", files),
    submission,
  );
  assert.deepEqual(
    await client.regradeContribution("sbv_1", "sbm_1"),
    submission,
  );
  const base = "https://api.test/api/v1/contributions";
  assert.deepEqual(
    calls.map(({ method, url }) => `${method} ${url}`),
    [
      "POST https://api.test/api/v1/invites/claim",
      `GET ${base}`,
      `GET ${base}/sbv%201`,
      `GET ${base}/sbv_1/handout`,
      `GET ${base}/sbv_1/archive`,
      `GET ${base}/sbv_1/handout/files`,
      `GET ${base}/sbv_1/handout/files?cursor=a.1&maxBytes=2000`,
      `GET ${base}/sbv_1/submissions`,
      `GET ${base}/sbv_1/submissions/sbm_1`,
      `POST ${base}/sbv_1/submissions`,
      `POST ${base}/sbv_1/submissions/sbm_1/retry`,
      `POST ${base}/sbv_1/submissions/sbm_1/regrade`,
    ],
  );
  // The secret is a body field, never part of the URL.
  assert.deepEqual(calls[0]?.body, { token: "lnxinv_x" });
  assert.deepEqual(calls[9]?.body, { files });
  // A file name that is not given falls back to the version's id.
  const bare = new ContributorClient({
    baseUrl: "https://api.test",
    fetch: (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
      })) as typeof globalThis.fetch,
  });
  assert.equal((await bare.contributionArchive("sbv_1")).filename, "sbv_1.zip");
});

test("a refused claim throws with the API's code", async () => {
  const client = new ContributorClient({
    baseUrl: "https://api.test",
    fetch: (async () =>
      Response.json(
        { error: "This invite is not valid.", code: "invite_unavailable" },
        { status: 404 },
      )) as typeof globalThis.fetch,
  });
  await assert.rejects(client.claimInvite("lnxinv_gone"), {
    status: 404,
    code: "invite_unavailable",
  });
});

test("a workspace invites, lists and revokes contributors", async () => {
  const { calls, fetch } = recording((url) => {
    if (url.endsWith("/invites"))
      return { invite, token: "lnxinv_x", claimUrl: "https://app/invite#x" };
    if (url.endsWith("/contributors"))
      return { invites: [invite], contributors: [assignment] };
    if (url.includes("/invites/")) return { invite };
    return { contributor: assignment };
  });
  const client = new SandboxClient({ baseUrl: "https://api.test", fetch });
  const created = await client.createContributorInvite("org 1", "sbv_1", {
    label: "Grace",
  });
  assert.equal(created.token, "lnxinv_x");
  await client.createContributorInvite("org_1", "sbv_1");
  assert.deepEqual(await client.versionContributors("org_1", "sbv_1"), {
    invites: [invite],
    contributors: [assignment],
  });
  assert.deepEqual(
    await client.revokeContributorInvite("org_1", "cin_1"),
    invite,
  );
  assert.deepEqual(
    await client.revokeContributor("org_1", "cas_1"),
    assignment,
  );
  const base = "https://api.test/api/v1/orgs";
  assert.deepEqual(
    calls.map(({ method, url }) => `${method} ${url}`),
    [
      `POST ${base}/org%201/sandboxes/versions/sbv_1/invites`,
      `POST ${base}/org_1/sandboxes/versions/sbv_1/invites`,
      `GET ${base}/org_1/sandboxes/versions/sbv_1/contributors`,
      `POST ${base}/org_1/sandboxes/invites/cin_1/revoke`,
      `POST ${base}/org_1/sandboxes/contributors/cas_1/revoke`,
    ],
  );
  assert.deepEqual(calls[0]?.body, { label: "Grace" });
  assert.deepEqual(calls[1]?.body, {});
});

test("a zipped project folder is previewed and submitted as the body, typed as a zip", async () => {
  const preview = {
    files: [{ path: "src/fees.ts", change: "changed" }],
    ignored: [".vscode/settings.json"],
    skipped: 3,
    missing: [],
    refused: [],
  };
  const sent: { url: string; type: string | null; body: unknown }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      type: new Headers(init?.headers).get("Content-Type"),
      body: init?.body,
    });
    return Response.json(
      url.includes("dryRun")
        ? { preview }
        : url.includes("/orgs/")
          ? {
              submission: {
                ...submission,
                runId: null,
                merge: null,
                carryBack: null,
                contributor: null,
              },
            }
          : { submission },
    );
  }) as typeof globalThis.fetch;
  const folder = new Blob([new Uint8Array([80, 75, 5, 6])], {
    type: "application/zip",
  });
  const client = new ContributorClient({ baseUrl: "https://api.test", fetch });
  assert.deepEqual(
    await client.previewContributionFolder("sbv_1", folder),
    preview,
  );
  await client.previewContributionFolder("sbv_1", folder, "sbm_1");
  assert.deepEqual(
    await client.submitContributionFolder("sbv_1", folder),
    submission,
  );
  assert.deepEqual(
    await client.submitContributionFolder("sbv_1", folder, "sbm 1"),
    submission,
  );
  const owner = new SandboxClient({ baseUrl: "https://api.test", fetch });
  assert.deepEqual(
    await owner.submitFolderToSandbox("org_1", "sbv_1", folder, {
      dryRun: true,
    }),
    { preview },
  );
  const ownerMade = await owner.submitFolderToSandbox("org_1", "sbv_1", folder);
  assert.equal("submission" in ownerMade, true);
  const base = "https://api.test/api/v1/contributions/sbv_1/submissions";
  assert.deepEqual(
    sent.map(({ url }) => url),
    [
      `${base}/zip?dryRun=1`,
      `${base}/sbm_1/retry/zip?dryRun=1`,
      `${base}/zip`,
      `${base}/sbm%201/retry/zip`,
      "https://api.test/api/v1/orgs/org_1/sandboxes/versions/sbv_1/submissions/zip?dryRun=1",
      "https://api.test/api/v1/orgs/org_1/sandboxes/versions/sbv_1/submissions/zip",
    ],
  );
  for (const each of sent) {
    assert.equal(each.type, "application/zip");
    assert.equal(each.body, folder, "the archive is sent as it is");
  }
});

test("a contributor previews files and manages their own tokens and connected apps", async () => {
  const token = {
    id: "ctk_1",
    name: "Cursor",
    prefix: "lnxc_abcd1234",
    createdAt: stamp,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  const grant = {
    id: "consent_1",
    client: { id: "client_1", name: "Claude Code" },
    user: { id: "user_c", name: "Grace Hopper" },
    scopes: ["contributions:write", "offline_access"],
    createdAt: stamp,
    updatedAt: stamp,
    lastUsedAt: null,
  };
  const preview = {
    files: [{ path: "src/fees.ts", change: "changed" }],
    ignored: [],
    skipped: 0,
    missing: [],
    refused: [],
  };
  const { calls, fetch } = recording((url, method) => {
    if (url.includes("dryRun=1")) return { preview };
    if (url.endsWith("/contributor-tokens"))
      return method === "POST"
        ? { token, secret: `lnxc_${"a".repeat(40)}` }
        : { tokens: [token] };
    if (url.includes("/contributor-tokens/")) return { token };
    if (url.endsWith("/contributor-grants")) return { grants: [grant] };
    return { grant };
  });
  const client = new ContributorClient({ baseUrl: "https://api.test", fetch });
  const files = [{ path: "src/fees.ts", text: "x" }];
  assert.deepEqual(await client.previewContribution("sbv_1", files), preview);
  await client.previewContribution("sbv_1", files, "sbm_1");
  assert.deepEqual(await client.contributorTokens(), [token]);
  const made = await client.createContributorToken({ name: "Cursor" });
  assert.match(made.secret, /^lnxc_/);
  assert.deepEqual(await client.revokeContributorToken("ctk_1"), token);
  assert.deepEqual(await client.contributorGrants(), [grant]);
  assert.deepEqual(await client.revokeContributorGrant("consent_1"), grant);
  const me = "https://api.test/api/v1/me";
  assert.deepEqual(
    calls.map(({ method, url }) => `${method} ${url}`),
    [
      "POST https://api.test/api/v1/contributions/sbv_1/submissions?dryRun=1",
      "POST https://api.test/api/v1/contributions/sbv_1/submissions/sbm_1/retry?dryRun=1",
      `GET ${me}/contributor-tokens`,
      `POST ${me}/contributor-tokens`,
      `POST ${me}/contributor-tokens/ctk_1/revoke`,
      `GET ${me}/contributor-grants`,
      `POST ${me}/contributor-grants/consent_1/revoke`,
    ],
  );
  assert.deepEqual(calls[0]?.body, { files });
  assert.deepEqual(calls[3]?.body, { name: "Cursor" });
});
