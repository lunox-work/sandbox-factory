/**
 * The GitHub tables' rules that live in SQL (migrations 0034-0038), against
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
 * - deleting an organization takes all three tables with it.
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
  createGithubConnectionStore,
  createGithubGrantStore,
  createGithubRepoStore,
  createTokenCipher,
  type GithubConnectionStore,
  type GithubGrantStore,
  type GithubRepoStore,
} from "../src/index.js";
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
});
