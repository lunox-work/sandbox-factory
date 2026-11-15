/**
 * What exists before the flow's first request, written the way the product
 * writes it wherever it can: the fixture's files and source archive, a
 * signed-in person (the user and session rows Better Auth writes at sign-in;
 * test-only, never a product route) and a second one outside the workspace
 * (the contributor the owner invites), the first's workspace made through Better
 * Auth's own organization endpoint, an API token minted as the token
 * route mints one, and the GitHub installation, repository and snapshot
 * through the stores and the snapshotter the install, sync and push flows
 * call, reading the fake GitHub.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { sourceArchiveKey } from "@sandbox-factory/db";
import { API_SCOPES } from "sandbox-factory";
import {
  displayPrefix,
  generateSecret,
  hashSecret,
} from "../../apps/api/dist/api-tokens/secret.js";
import { APP_URL } from "./compose.mjs";
import { FIXTURE } from "./fakes.mjs";

const run = promisify(execFile);
/** The fixture repository on disk, as its own `npm test` runs it. */
export const fixtureRoot = fileURLToPath(
  new URL("../../apps/worker/fixtures/roundtrip/", import.meta.url),
);

/** The fixture's files by path, and the commit the flow says they are at. */
export async function fixtureFiles() {
  const files = new Map();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.isDirectory()) await walk(path);
      else
        files.set(
          relative(fixtureRoot, path).split("\\").join("/"),
          await readFile(path),
        );
    }
  };
  await walk(fixtureRoot);
  const digest = createHash("sha1");
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    digest.update(path).update("\0").update(bytes);
  return { files, commitSha: digest.digest("hex") };
}

/** GitHub's archive of the commit: one top folder, as codeload serves it. */
export async function sourceArchive(commitSha) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-factory-flow-src-"));
  try {
    const top = `orvanta-labs-payments-${commitSha.slice(0, 7)}`;
    await cp(fixtureRoot, join(directory, top), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|dist)$/.test(source),
    });
    const archive = join(directory, "source.tar.gz");
    await run("tar", ["-czf", archive, "-C", directory, top], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return await readFile(archive);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const PERSON = {
  id: "usr_flow_owner",
  name: "Ada Lovelace",
  email: "ada@flow.test",
  username: "ada-flow",
  sessionToken: "flowsessiontoken0000000000000001",
};
/** Someone outside the workspace, signed in, whom its owner invites. */
export const CONTRIBUTOR = {
  id: "usr_flow_contributor",
  name: "Grace Hopper",
  email: "grace@flow.test",
  username: "grace-flow",
  sessionToken: "flowsessiontoken0000000000000002",
};
export const WORKSPACE = { name: "Orvanta", slug: "orvanta" };

/**
 * The person signed in, their workspace, a token for it, and the GitHub
 * repository at the fixture's commit, snapshotted, with its archive in the
 * bucket. Returns the ids every later step names.
 */
export async function seed(platform, { commitSha, archive }) {
  const { db, stores, app } = platform;
  // The rows a Google sign-in leaves: the user, and its session.
  await db.execute(sql`
    insert into "user" (id, name, email, email_verified, username, display_username)
    values (${PERSON.id}, ${PERSON.name}, ${PERSON.email}, true, ${PERSON.username}, ${PERSON.username})
  `);
  await db.execute(sql`
    insert into session (id, token, expires_at, user_id, created_at, updated_at)
    values ('ses_flow_owner', ${PERSON.sessionToken}, now() + interval '1 day', ${PERSON.id}, now(), now())
  `);
  const session = { authorization: `Bearer ${PERSON.sessionToken}` };
  // The contributor's sign-in, the same rows; no membership in the
  // owner's workspace, now or later.
  await db.execute(sql`
    insert into "user" (id, name, email, email_verified, username, display_username)
    values (${CONTRIBUTOR.id}, ${CONTRIBUTOR.name}, ${CONTRIBUTOR.email}, true, ${CONTRIBUTOR.username}, ${CONTRIBUTOR.username})
  `);
  await db.execute(sql`
    insert into session (id, token, expires_at, user_id, created_at, updated_at)
    values ('ses_flow_contributor', ${CONTRIBUTOR.sessionToken}, now() + interval '1 day', ${CONTRIBUTOR.id}, now(), now())
  `);
  const contributorSession = {
    authorization: `Bearer ${CONTRIBUTOR.sessionToken}`,
  };

  // The workspace, made as the web app makes one.
  const created = await app.request("/api/auth/organization/create", {
    method: "POST",
    headers: {
      ...session,
      origin: APP_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify(WORKSPACE),
  });
  const organization = await created.json().catch(() => null);
  if (!created.ok || typeof organization?.id !== "string")
    throw new Error(
      `Creating the workspace answered ${created.status}: ${JSON.stringify(organization)}`,
    );
  const organizationId = organization.id;

  // A workspace API token, as `POST /api-tokens` stores one.
  const token = generateSecret();
  await stores.apiTokens.create(organizationId, {
    createdBy: PERSON.id,
    name: "flow harness",
    prefix: displayPrefix(token),
    hash: hashSecret(token),
    scopes: [...API_SCOPES],
    expiresAt: null,
  });
  // One made before `decisions:confirm`: it posts, and confirms nothing.
  const olderToken = generateSecret();
  await stores.apiTokens.create(organizationId, {
    createdBy: PERSON.id,
    name: "flow harness, before decisions:confirm",
    prefix: displayPrefix(olderToken),
    hash: hashSecret(olderToken),
    scopes: API_SCOPES.filter((scope) => scope !== "decisions:confirm"),
    expiresAt: null,
  });

  // GitHub: the installation linked, the repository registered and read at
  // its head, then snapshotted through the fake GitHub.
  const linked = await stores.githubConnections.link(organizationId, {
    installationId: FIXTURE.installationId,
    accountLogin: "orvanta-labs",
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { contents: "read", metadata: "read", issues: "read" },
    suspendedAt: null,
  });
  if (linked.status !== "linked")
    throw new Error(`GitHub link: ${linked.status}`);
  const registered = await stores.githubRepos.register(organizationId, {
    connectionId: linked.connection.id,
    externalId: FIXTURE.externalId,
    role: "source",
    fullName: FIXTURE.fullName,
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: Math.ceil(archive.byteLength / 1024),
    pushedAt: new Date().toISOString(),
  });
  await stores.githubRepos.recordSync(
    organizationId,
    registered.id,
    {
      fullName: FIXTURE.fullName,
      defaultBranch: "main",
      isPrivate: true,
      sizeKb: Math.ceil(archive.byteLength / 1024),
      pushedAt: new Date().toISOString(),
    },
    { sha: commitSha, etag: null },
  );
  const outcome = await platform.snapshotter.snapshot({
    organizationId,
    repoId: registered.id,
    installationId: FIXTURE.installationId,
  });
  if (outcome !== "created") throw new Error(`Snapshot: ${outcome}`);
  const snapshot = await stores.repoSnapshots.findByCommit(
    organizationId,
    registered.id,
    commitSha,
  );
  // The archive the worker reads before it would ask GitHub.
  await platform.objects.put(
    sourceArchiveKey(registered.id, commitSha),
    archive,
    {
      contentType: "application/gzip",
    },
  );
  return {
    organizationId,
    repoId: registered.id,
    snapshotId: snapshot.id,
    session,
    contributorSession,
    token: { authorization: `Bearer ${token}` },
    olderToken: { authorization: `Bearer ${olderToken}` },
  };
}
