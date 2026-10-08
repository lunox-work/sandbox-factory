/**
 * The GitHub tables' rules that live in SQL (migrations 0034-0039), against
 * a real Postgres. The fake records calls but cannot run a `WHERE`, an
 * `ON CONFLICT … WHERE`, a foreign key or a trigger, so a guard written
 * wrongly — or not at all — passes there. These are the ones it would hide:
 *
 * - `claimed`: a second organization's link writes nothing;
 * - nothing but `register` and `revive` brings a `gone` repository back;
 * - a late push does not move the head, and a same-second one asks for a
 *   re-read;
 * - a re-grant moves the revision on, fencing a refresh from the old grant;
 * - a repository cannot sit under one organization on another's connection;
 * - a grant goes when the membership does, however it ends;
 * - deleting an organization takes all three tables with it;
 * - a snapshot is one per commit, and a `gone` repository takes no new one;
 * - pruning keeps the newest and whatever a proposal was drafted beside;
 * - a board links only a repository of its own organization.
 *
 * Skips when no server is reachable, as `handle-registry.test.ts` does, and
 * refuses a server that is not local outside CI, since it drops and
 * recreates its scratch database.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import {
  createConnection,
  createAnalysisRunStore,
  createArtifactStore,
  createBountyProposalStore,
  createGithubConnectionStore,
  createGithubGrantStore,
  createGithubRepoStore,
  createJiraBoardStore,
  createRepoSnapshotStore,
  createTokenCipher,
  type GithubConnectionStore,
  type GithubGrantStore,
  type GithubRepoStore,
  type JiraBoardStore,
  type NewRepoSnapshot,
  type RepoSnapshotStore,
  createSandboxStore,
  RepositoryInUseError,
} from "../src/index.js";
import { treeFacts } from "sandbox-factory";
import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
/** A fixed name, so a crashed run leaves one database to drop. */
const SCRATCH_DB = "sandbox_factory_github_test";

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

function isLocalOrCi(url: string): boolean {
  if (process.env["CI"] === "true") return true;
  const { hostname } = new URL(url);
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

async function serverReachable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function admin(statement: string): Promise<void> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

/** The error a write raised, or undefined if it was allowed. */
async function refusal(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const skip = !isLocalOrCi(ADMIN_URL)
  ? "DATABASE_URL is not a local server; set CI=true to run against it"
  : (await serverReachable())
    ? false
    : `no Postgres at ${ADMIN_URL}`;

const installation = (installationId: string) => ({
  installationId,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  permissions: { contents: "read", metadata: "read" },
  suspendedAt: null,
});

const metadata = {
  fullName: "acme/widgets",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: 1,
  pushedAt: null,
};

const tokens = {
  githubLogin: "dana",
  githubUserId: "1",
  accessToken: "ghu_access",
  refreshToken: "ghr_refresh",
  expiresAt: null,
};

describe("GitHub pointers in Postgres", { skip }, () => {
  let sql: postgres.Sql;
  let connection: ReturnType<typeof createConnection>;
  let connections: GithubConnectionStore;
  let grants: GithubGrantStore;
  let repos: GithubRepoStore;
  let snapshots: RepoSnapshotStore;
  let boards: JiraBoardStore;

  before(async () => {
    await admin(`drop database if exists ${SCRATCH_DB}`);
    await admin(`create database ${SCRATCH_DB}`);
    await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
    sql = postgres(scratchUrl(), { max: 4, onnotice: () => {} });
    connection = createConnection({ url: scratchUrl(), max: 4 });
    connections = createGithubConnectionStore(connection.db);
    grants = createGithubGrantStore(
      connection.db,
      createTokenCipher(Buffer.alloc(32, 7).toString("base64")),
    );
    repos = createGithubRepoStore(connection.db);
    snapshots = createRepoSnapshotStore(connection.db);
    boards = createJiraBoardStore(connection.db);

    for (const id of ["u_a", "u_b"]) {
      await sql`
        insert into "user" (id, name, email, username, display_username)
        values (${id}, ${id}, ${`${id}@example.test`}, ${id.replace("_", "-")}, ${id.replace("_", "-")})
      `;
    }
    for (const id of ["o_a", "o_b", "o_gone"]) {
      await sql`
        insert into organization (id, name, slug, kind)
        values (${id}, ${id}, ${id.replace("_", "-")}, 'team')
      `;
    }
  });

  after(async () => {
    await connection?.close();
    await sql?.end();
    await admin(`drop database if exists ${SCRATCH_DB}`);
  });

  /** A linked connection with one registered repository. */
  async function repoUnder(organizationId: string, installationId: string) {
    const linked = await connections.link(
      organizationId,
      installation(installationId),
    );
    assert.equal(linked.status, "linked");
    if (linked.status !== "linked") throw new Error("unreachable");
    const repo = await repos.register(organizationId, {
      ...metadata,
      connectionId: linked.connection.id,
      externalId: `${installationId}01`,
      role: "source",
    });
    return { connection: linked.connection, repo };
  }

  test("a second organization's link is claimed and writes nothing", async () => {
    const first = await connections.link("o_a", installation("100"));
    const second = await connections.link("o_b", installation("100"));

    assert.equal(first.status, "linked");
    assert.equal(second.status, "claimed");
    const owners = await connections.owners(["100"]);
    assert.equal(owners.get("100"), "o_a");
    // Re-linking by the owner still refreshes its own row.
    assert.equal(
      (await connections.link("o_a", installation("100"))).status,
      "linked",
    );
  });

  test("a gone repository is not revived by a late read, push or error", async () => {
    const { repo } = await repoUnder("o_a", "200");
    await repos.markGone("o_a", [repo.id]);

    assert.equal(
      await repos.recordSync("o_a", repo.id, metadata, {
        sha: "a".repeat(40),
        etag: null,
      }),
      null,
    );
    assert.equal(
      await repos.setHead("o_a", repo.id, {
        headSha: "b".repeat(40),
        pushedAt: "2026-10-01T00:00:00.000Z",
      }),
      false,
    );
    assert.equal(await repos.markSyncError("o_a", repo.id, "late"), false);
    assert.equal((await repos.get("o_a", repo.id))?.syncStatus, "gone");

    // Re-added on GitHub's side: revive is a way back, and then reads apply.
    assert.equal(await repos.revive("o_a", [repo.id]), 1);
    assert.equal(
      (await repos.recordSync("o_a", repo.id, metadata))?.syncStatus,
      "ok",
    );
  });

  test("an older push does not move the head; a same-second one asks for a re-read", async () => {
    const { repo } = await repoUnder("o_a", "300");
    const at = "2026-10-01T00:00:10.000Z";

    assert.equal(
      await repos.setHead("o_a", repo.id, {
        headSha: "1".repeat(40),
        pushedAt: at,
      }),
      true,
    );
    const stamped = await repos.get("o_a", repo.id);
    assert.notEqual(stamped?.lastSyncedAt, null);

    assert.equal(
      await repos.setHead("o_a", repo.id, {
        headSha: "0".repeat(40),
        pushedAt: "2026-10-01T00:00:09.000Z",
      }),
      false,
    );
    assert.equal((await repos.get("o_a", repo.id))?.headSha, "1".repeat(40));

    // The same second: applied, but due for the next sweep, which reads the
    // branch rather than trusting which delivery came last.
    assert.equal(
      await repos.setHead("o_a", repo.id, {
        headSha: "2".repeat(40),
        pushedAt: at,
      }),
      true,
    );
    const tied = await repos.get("o_a", repo.id);
    assert.equal(tied?.headSha, "2".repeat(40));
    assert.equal(tied?.lastSyncedAt, null);
    const due = await repos.dueForSync(new Date("2026-10-01T00:00:00Z"), 100);
    assert.ok(due.some((entry) => entry.id === repo.id));
  });

  test("a re-grant moves the revision on, so a refresh of the old one is refused", async () => {
    await sql`
      insert into member (id, organization_id, user_id, role)
      values ('m_rev', 'o_a', 'u_a', 'owner')
    `;
    const first = await grants.upsert("o_a", "u_a", tokens);
    const second = await grants.upsert("o_a", "u_a", tokens);

    assert.equal(second.credentialRevision, first.credentialRevision + 1);
    assert.equal(
      await grants.saveTokens("o_a", "u_a", first.credentialRevision, tokens),
      false,
    );
    assert.equal(
      await grants.saveTokens("o_a", "u_a", second.credentialRevision, tokens),
      true,
    );
    assert.equal(
      (await grants.tokens("o_a", "u_a"))?.accessToken,
      "ghu_access",
    );
  });

  test("a repository cannot sit under one organization on another's connection", async () => {
    const { connection: theirs } = await repoUnder("o_b", "400");

    const message = await refusal(sql`
      insert into github_repo (
        id, organization_id, connection_id, role, external_id, full_name,
        default_branch
      )
      values (
        'ghr_cross', 'o_a', ${theirs.id}, 'source', '1', 'acme/x', 'main'
      )
    `);

    assert.match(String(message), /github_repo_connection_owner_fk/);
  });

  test("a grant goes when the membership does, and only that one", async () => {
    await sql`
      insert into member (id, organization_id, user_id, role) values
        ('m_a_b', 'o_b', 'u_a', 'member'),
        ('m_b_b', 'o_b', 'u_b', 'owner')
    `;
    await grants.upsert("o_b", "u_a", tokens);
    await grants.upsert("o_b", "u_b", tokens);

    // What both the plugin's remove-member and its leave route come down to.
    await sql`delete from member where id = 'm_a_b'`;

    assert.equal(await grants.get("o_b", "u_a"), null);
    assert.notEqual(await grants.get("o_b", "u_b"), null);
    // The same person's grant in another organization is theirs to keep.
    assert.notEqual(await grants.get("o_a", "u_a"), null);
  });

  test("deleting an organization takes its GitHub rows with it", async () => {
    await sql`
      insert into member (id, organization_id, user_id, role)
      values ('m_gone', 'o_gone', 'u_b', 'owner')
    `;
    await repoUnder("o_gone", "500");
    await grants.upsert("o_gone", "u_b", tokens);

    await sql`delete from organization where id = 'o_gone'`;

    const [left] = await sql<{ count: string }[]>`
      select (
        (select count(*) from github_connection where organization_id = 'o_gone') +
        (select count(*) from github_grant where organization_id = 'o_gone') +
        (select count(*) from github_repo where organization_id = 'o_gone')
      )::text as count
    `;
    assert.equal(left?.count, "0");
  });

  test("the probe lists flagged connections, never uninstalled or healthy ones", async () => {
    const flagged = await repoUnder("o_a", "600");
    const uninstalled = await repoUnder("o_a", "601");
    await connections.update("o_a", flagged.connection.id, { healthy: false });
    await connections.update("o_a", uninstalled.connection.id, {
      healthy: false,
      uninstalledAt: "2026-10-01T00:00:00.000Z",
    });

    const listed = await connections.flaggedForProbe(50);

    const ids = listed.map((entry) => entry.installationId);
    assert.ok(ids.includes("600"));
    assert.ok(!ids.includes("601"));
    assert.ok(!ids.includes("100"));

    // Re-linking clears the uninstall, so a reconnect is always a way back.
    const relinked = await connections.link("o_a", installation("601"));
    assert.equal(
      relinked.status === "linked" ? relinked.connection.uninstalledAt : "",
      null,
    );
  });

  /** What a snapshot of `sha` records; the facts are from a one-file tree. */
  function snapshotOf(repoId: string, sha: string): NewRepoSnapshot {
    return {
      repoId,
      commitSha: sha,
      ref: "refs/heads/main",
      treeSha: `tree-${sha}`,
      treeKey: `trees/${repoId}/${sha}.json.gz`,
      treeTruncated: false,
      fileCount: 1,
      totalBytes: 10,
      languages: { TypeScript: 10 },
      facts: treeFacts([{ path: "src/a.ts", size: 10 }]),
    };
  }

  test("a snapshot is one per commit, and a gone repository takes no new one", async () => {
    const { repo } = await repoUnder("o_a", "900");
    const first = await snapshots.create("o_a", snapshotOf(repo.id, "c1"));
    assert.equal(first.status, "created");
    // The webhook and the sweep seeing the same head: the second is a no-op.
    assert.equal(
      (await snapshots.create("o_a", snapshotOf(repo.id, "c1"))).status,
      "exists",
    );
    // Another organization cannot write under this repository.
    assert.equal(
      (await snapshots.create("o_b", snapshotOf(repo.id, "c2"))).status,
      "refused",
    );
    assert.equal(
      await snapshots.get(
        "o_b",
        first.status === "created" ? first.snapshot.id : "",
      ),
      null,
    );

    await repos.markGone("o_a", [repo.id]);
    assert.equal(
      (await snapshots.create("o_a", snapshotOf(repo.id, "c3"))).status,
      "refused",
    );
    // What was taken before stays readable.
    const [only] = await snapshots.list("o_a", repo.id, 10);
    assert.equal(only?.commitSha, "c1");
  });

  test("the current snapshot is the head's, whenever it was taken", async () => {
    const { repo } = await repoUnder("o_a", "910");
    await repos.recordSync("o_a", repo.id, metadata, {
      sha: "head",
      etag: null,
    });
    await snapshots.create("o_a", snapshotOf(repo.id, "head"));
    // An older head's snapshot finishing later is not the current one.
    await snapshots.create("o_a", snapshotOf(repo.id, "older"));
    assert.equal((await snapshots.current("o_a", repo.id))?.commitSha, "head");
    assert.equal(await snapshots.current("o_b", repo.id), null);
  });

  test("proposal persistence tolerates a snapshot deleted during drafting and checks its owner", async () => {
    await sql`insert into jira_connection (id, organization_id, cloud_id, site_url, site_name) values ('jrc_sf', 'o_a', 'cloud-sf', 'https://acme.example', 'Acme')`;
    await sql`insert into jira_board (id, organization_id, connection_id, external_id, name, board_type) values ('jrb_sf', 'o_a', 'jrc_sf', '1', 'Board', 'scrum')`;
    const rateCard = {
      currency: "USD",
      xsMinor: 1,
      sMinor: 1,
      mMinor: 1,
      lMinor: 1,
      xlMinor: 1,
      revision: 1,
    };
    for (const [kind, owner, installationId] of [
      ["live", "o_a", "911"],
      ["deleted", "o_a", "912"],
      ["foreign", "o_b", "913"],
    ] as const) {
      const { repo } = await repoUnder(owner, installationId);
      const captured = await snapshots.create(owner, snapshotOf(repo.id, kind));
      assert.equal(captured.status, "created");
      if (captured.status !== "created") throw new Error("not created");
      if (kind === "deleted") await repos.remove(owner, repo.id);
      const runId = `brn_sf_${kind}`;
      const issueId = `jri_sf_${kind}`;
      const bountyId = `bty_sf_${kind}`;
      await sql`insert into bounty (id, organization_id, title, origin) values (${bountyId}, 'o_a', 'Bounty', 'jira')`;
      await sql`insert into jira_issue (id, organization_id, board_id, external_id, key, bounty_id) values (${issueId}, 'o_a', 'jrb_sf', ${kind}, 'ACME-1', ${bountyId})`;
      await sql`insert into bounty_run (id, organization_id, board_id, kind, request_id, selection, rate_card, requested_model, prompt_version, status, lease_token, lease_expires_at, deadline_at) values (${runId}, 'o_a', 'jrb_sf', 'issue', ${kind}, ${sql.json({})}, ${sql.json(rateCard)}, 'model', 'v', 'running', 'lease', now() + interval '1 hour', now() + interval '1 hour')`;
      const result = await createBountyProposalStore(
        connection.db,
      ).createForLease("o_a", "lease", {
        runId,
        bountyId,
        repoSnapshotId: captured.snapshot.id,
        specHash: "a".repeat(64),
        specHashVersion: 1,
        rateCard,
        sizing: { complexity: "M", confidence: "high", rationale: "why" },
        inputTruncated: false,
        actualModel: "model",
        promptVersion: "v",
        amountMinor: 1,
        currency: "USD",
      });
      assert.equal(result.status, "created");
      if (result.status === "created") {
        assert.equal(
          result.proposal.repoSnapshotId,
          kind === "live" ? captured.snapshot.id : null,
        );
      }
    }
  });

  test("a repository's context is one of its own snapshots, and is never pruned", async () => {
    const { repo, connection: linked } = await repoUnder("o_a", "912");
    const { repo: other } = await repoUnder("o_b", "913");
    const mine = await snapshots.create("o_a", snapshotOf(repo.id, "ctx"));
    const theirs = await snapshots.create("o_b", snapshotOf(other.id, "ctx"));
    if (mine.status !== "created" || theirs.status !== "created")
      throw new Error("unreachable");
    assert.equal((await repos.get("o_a", repo.id))?.contextSnapshotId, null);
    assert.equal(
      await repos.setContextSnapshot("o_a", repo.id, mine.snapshot.id),
      true,
    );
    assert.equal(
      (await repos.get("o_a", repo.id))?.contextSnapshotId,
      mine.snapshot.id,
    );
    // Another repository's snapshot, or another organization's repository,
    // is not written.
    assert.equal(
      await repos.setContextSnapshot("o_a", repo.id, theirs.snapshot.id),
      false,
    );
    assert.equal(
      await repos.setContextSnapshot("o_b", repo.id, mine.snapshot.id),
      false,
    );
    assert.equal(
      (await repos.get("o_a", repo.id))?.contextSnapshotId,
      mine.snapshot.id,
    );
    // Pruning keeps the context's snapshot, however old, and nothing else
    // that nothing names.
    await snapshots.create("o_a", snapshotOf(repo.id, "newer"));
    assert.deepEqual(await snapshots.prune("o_a", repo.id, 0), [
      `trees/${repo.id}/newer.json.gz`,
    ]);
    assert.deepEqual(
      (await snapshots.list("o_a", repo.id, 10)).map((s) => s.commitSha),
      ["ctx"],
    );
    assert.equal(
      (await connections.removeWithTrees("o_a", linked.id)).removed,
      true,
    );
    assert.equal(await repos.get("o_a", repo.id), null);
  });

  test("disconnect returns all snapshot tree keys before the cascade", async () => {
    const { repo, connection: linked } = await repoUnder("o_a", "914");
    await snapshots.create("o_a", snapshotOf(repo.id, "one"));
    await snapshots.create("o_a", snapshotOf(repo.id, "two"));
    assert.deepEqual(await connections.removeWithTrees("o_b", linked.id), {
      removed: false,
      treeKeys: [],
    });
    const removed = await connections.removeWithTrees("o_a", linked.id);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.treeKeys.sort(), [
      `trees/${repo.id}/one.json.gz`,
      `trees/${repo.id}/two.json.gz`,
    ]);
    assert.equal(await repos.get("o_a", repo.id), null);
    assert.deepEqual(await snapshots.list("o_a", repo.id, 10), []);
  });

  test("pruning keeps the newest and whatever a proposal was drafted beside", async () => {
    const { repo } = await repoUnder("o_a", "920");
    const ids: string[] = [];
    for (const sha of ["s1", "s2", "s3", "s4"]) {
      const created = await snapshots.create("o_a", snapshotOf(repo.id, sha));
      if (created.status !== "created") throw new Error("not created");
      ids.push(created.snapshot.id);
      // Distinct creation times, oldest first.
      await sql`update repo_snapshot set created_at = now() - make_interval(mins => ${10 - ids.length}) where id = ${created.snapshot.id}`;
    }
    // A proposal drafted beside the oldest.
    await sql`insert into jira_connection (id, organization_id, cloud_id, site_url, site_name) values ('jrc_p', 'o_a', 'cloud', 'https://acme.example', 'Acme')`;
    await sql`insert into jira_board (id, organization_id, connection_id, external_id, name, board_type) values ('jrb_p', 'o_a', 'jrc_p', '1', 'Board', 'scrum')`;
    await sql`insert into bounty (id, organization_id, title, origin) values ('bty_p', 'o_a', 'Bounty', 'jira')`;
    await sql`insert into jira_issue (id, organization_id, board_id, external_id, key, bounty_id) values ('jri_p', 'o_a', 'jrb_p', '10', 'ACME-1', 'bty_p')`;
    const rateCard = sql.json({
      currency: "USD",
      xsMinor: 1,
      sMinor: 1,
      mMinor: 1,
      lMinor: 1,
      xlMinor: 1,
      revision: 1,
    });
    await sql`insert into bounty_run (id, organization_id, board_id, request_id, selection, rate_card, requested_model, prompt_version) values ('brn_p', 'o_a', 'jrb_p', 'req', ${sql.json({})}, ${rateCard}, 'model', 'v')`;
    await sql`insert into bounty_proposal (id, organization_id, run_id, bounty_id, spec_hash, rate_card, model_complexity, model_confidence, model_rationale, actual_model, prompt_version, complexity, amount_minor, currency, repo_snapshot_id) values ('bpr_p', 'o_a', 'brn_p', 'bty_p', ${"a".repeat(64)}, ${rateCard}, 'M', 'high', 'why', 'model', 'v', 'M', 100, 'USD', ${ids[0] ?? ""})`;

    // Someone else's prune touches nothing.
    assert.deepEqual(await snapshots.prune("o_b", repo.id, 0), []);
    const removed = await snapshots.prune("o_a", repo.id, 2);
    // s1 is referenced, s4 and s3 are the newest two unreferenced; s2 goes.
    assert.deepEqual(removed, [`trees/${repo.id}/s2.json.gz`]);
    assert.deepEqual(
      (await snapshots.list("o_a", repo.id, 10)).map(
        ({ commitSha }) => commitSha,
      ),
      ["s4", "s3", "s1"],
    );

    // Removing the repository takes its snapshots and clears the pointer.
    assert.equal(await repos.remove("o_a", repo.id), true);
    const [proposal] =
      await sql`select repo_snapshot_id from bounty_proposal where id = 'bpr_p'`;
    assert.equal(proposal?.["repo_snapshot_id"], null);
  });

  test("a board links only a repository of its own organization", async () => {
    const own = await repoUnder("o_a", "930");
    const foreign = await repoUnder("o_b", "940");
    await sql`insert into jira_connection (id, organization_id, cloud_id, site_url, site_name) values ('jrc_l', 'o_a', 'cloud-l', 'https://acme.example', 'Acme')`;
    await sql`insert into jira_board (id, organization_id, connection_id, external_id, name, board_type) values ('jrb_l', 'o_a', 'jrc_l', '1', 'Board', 'scrum')`;

    assert.equal(
      await boards.update("o_a", "jrb_l", { sourceRepoId: foreign.repo.id }),
      null,
    );
    assert.equal(
      await boards.update("o_a", "jrb_l", { sourceRepoId: "ghr_nonexistent" }),
      null,
    );
    assert.equal((await boards.get("o_a", "jrb_l"))?.sourceRepoId, null);

    const linked = await boards.update("o_a", "jrb_l", {
      sourceRepoId: own.repo.id,
    });
    assert.equal(linked?.sourceRepoId, own.repo.id);
    // An edit that does not name the repository leaves the link alone.
    assert.equal(
      (await boards.update("o_a", "jrb_l", { pricing: {} }))?.sourceRepoId,
      own.repo.id,
    );

    // Removing the repository unlinks the board rather than failing.
    assert.equal(await repos.remove("o_a", own.repo.id), true);
    assert.equal((await boards.get("o_a", "jrb_l"))?.sourceRepoId, null);
    // And null unlinks explicitly.
    assert.equal(
      (await boards.update("o_a", "jrb_l", { sourceRepoId: null }))
        ?.sourceRepoId,
      null,
    );
  });
  test("analysis claims are exclusive, writes are fenced, artifacts are private and runs prevent pruning", async () => {
    const { repo } = await repoUnder("o_a", "960");
    const snapshot = await snapshots.create("o_a", {
      repoId: repo.id,
      commitSha: "9".repeat(40),
      ref: "refs/heads/main",
      treeSha: "8".repeat(40),
      treeKey: "trees/analysis.json.gz",
      treeTruncated: false,
      fileCount: 1,
      totalBytes: 1,
      languages: {},
      facts: treeFacts([{ path: "a.ts", size: 1 }]),
    });
    assert.equal(snapshot.status, "created");
    if (snapshot.status !== "created") throw new Error("snapshot missing");
    const runs = createAnalysisRunStore(connection.db);
    const artifacts = createArtifactStore(connection.db);
    const input = { requestedBy: "u_a", params: { deadlineMinutes: 30 } };
    const queued = await runs.enqueue("o_a", snapshot.snapshot.id, input);
    assert.equal(queued.ok, true);
    if (!queued.ok) throw new Error("run missing");
    assert.equal(
      (await runs.enqueue("o_a", snapshot.snapshot.id, input)).ok,
      true,
    );
    assert.equal((await runs.list("o_a", repo.id)).length, 1);
    assert.equal(await runs.get("o_b", queued.run.id), null);
    assert.deepEqual(
      await runs.enqueue("o_b", snapshot.snapshot.id, {
        ...input,
        requestedBy: "u_b",
      }),
      { ok: false, reason: "not-found" },
    );
    assert.deepEqual(await snapshots.prune("o_a", repo.id, 0), []);
    const now = new Date();
    const claims = await Promise.all([
      runs.claimNext("first", now),
      runs.claimNext("second", now),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find((claim) => claim !== null);
    if (!claimed) throw new Error("lease missing");
    assert.equal(
      await runs.heartbeat("o_b", claimed.id, claimed.leaseToken, now),
      false,
    );
    assert.equal(
      await runs.finish("o_a", claimed.id, "stale", [], "log", now),
      false,
    );
    const item = {
      kind: "graph_json" as const,
      path: "graph.json",
      objectKey: "runs/analysis/graph.json",
      contentType: "application/json",
      sizeBytes: 2,
      sha256: "a".repeat(64),
      meta: null,
    };
    assert.equal(
      await runs.finish(
        "o_a",
        claimed.id,
        claimed.leaseToken,
        [item],
        "logs/analysis.log",
        now,
      ),
      true,
    );
    const listed = await artifacts.list("o_a", claimed.id);
    assert.equal(listed.length, 1);
    assert.equal(await artifacts.get("o_b", listed[0]?.id ?? "missing"), null);
    assert.equal((await runs.get("o_a", claimed.id))?.status, "succeeded");
    assert.equal(await runs.logKey("o_a", claimed.id), "logs/analysis.log");
    const removed = await repos.removeWithObjects("o_a", repo.id);
    assert.equal(removed.removed, true);
    assert.deepEqual(
      removed.objectKeys.sort(),
      [
        "trees/analysis.json.gz",
        "runs/analysis/graph.json",
        "logs/analysis.log",
      ].sort(),
    );
    assert.deepEqual(await repos.removeWithObjects("o_b", repo.id), {
      removed: false,
      objectKeys: [],
    });
  });

  test("analysis retries obey the limit and concurrent enqueues cannot overspend", async () => {
    const { repo } = await repoUnder("o_a", "970");
    const snapshotsForRuns = [];
    for (const digit of ["a", "b", "c", "d"]) {
      const result = await snapshots.create("o_a", {
        repoId: repo.id,
        commitSha: digit.repeat(40),
        ref: "refs/heads/main",
        treeSha: "8".repeat(40),
        treeKey: `trees/${digit}`,
        treeTruncated: false,
        fileCount: 1,
        totalBytes: 1,
        languages: {},
        facts: treeFacts([{ path: "a.ts", size: 1 }]),
      });
      if (result.status !== "created") throw new Error("missing snapshot");
      snapshotsForRuns.push(result.snapshot.id);
    }
    const runs = createAnalysisRunStore(connection.db);
    const outcomes = await Promise.all(
      snapshotsForRuns.map((id) =>
        runs.enqueue("o_a", id, {
          requestedBy: "u_a",
          params: { deadlineMinutes: 30 },
          maxActive: 1,
        }),
      ),
    );
    assert.equal(outcomes.filter((result) => result.ok).length, 1);
    const first = await runs.claimNext("lease-1", new Date());
    if (!first) throw new Error("missing lease");
    const expiredAt = new Date(Date.now() + 61_000);
    assert.equal(await runs.failExpired("o_b", expiredAt), 0);
    assert.equal(await runs.failExpired("o_a", expiredAt), 1);
    assert.equal((await runs.get("o_a", first.id))?.attempt, 1);
    const second = await runs.claimNext("lease-2", new Date());
    assert.equal(second?.id, first.id);
    assert.equal(
      await runs.fail(
        "o_a",
        first.id,
        "lease-1",
        "tool_failed",
        null,
        new Date(),
      ),
      false,
    );
    await runs.failExpired("o_a", expiredAt);
    await runs.claimNext("lease-3", new Date());
    await runs.failExpired("o_a", expiredAt);
    assert.equal((await runs.get("o_a", first.id))?.status, "failed");
    const cached = await runs.enqueue("o_a", first.snapshotId, {
      requestedBy: "u_a",
      params: { deadlineMinutes: 30 },
    });
    assert.equal(cached.ok && cached.created, false);
    await repos.remove("o_a", repo.id);
  });

  test("a repository a sandbox is built from is not removed, alone or with its connection", async () => {
    const { repo, connection: linked } = await repoUnder("o_a", "995");
    const sandboxes = createSandboxStore(connection.db);
    await sql`insert into bounty (id, organization_id, title)
      values ('bty_pointer', 'o_a', 'Sandboxed')`;
    const created = await sandboxes.create("o_a", {
      bountyId: "bty_pointer",
      sourceRepoId: repo.id,
    });
    assert.equal(created.ok, true);
    await assert.rejects(
      repos.removeWithObjects("o_a", repo.id),
      RepositoryInUseError,
    );
    await assert.rejects(repos.remove("o_a", repo.id), RepositoryInUseError);
    await assert.rejects(
      connections.removeWithTrees("o_a", linked.id),
      RepositoryInUseError,
    );
    await assert.rejects(
      connections.remove("o_a", linked.id),
      RepositoryInUseError,
    );
    // Every refusal rolled back: the repository is still there.
    assert.equal((await repos.get("o_a", repo.id))?.id, repo.id);
    if (created.ok)
      await sql`delete from sandbox where id = ${created.sandbox.id}`;
    await sql`delete from bounty where id = 'bty_pointer'`;
    assert.equal((await repos.removeWithObjects("o_a", repo.id)).removed, true);
  });
});
