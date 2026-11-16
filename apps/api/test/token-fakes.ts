/**
 * Fakes for the credential tests: in-memory API token and OAuth grant
 * stores, an organization store that answers roles, and a Better Auth
 * stand-in that knows a browser session (a cookie) and a device sign-in's
 * session (`Bearer device-…`).
 */

import type {
  ApiTokenStore,
  ContributorTokenStore,
  GrantOwner,
  NewApiToken,
  OAuthGrant,
  OAuthGrantStore,
  OrganizationStore,
  ResolvedApiToken,
  StoredApiToken,
  StoredContributorToken,
} from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";

export const ada = {
  id: "user_1",
  email: "ada@example.test",
  name: "Ada Lovelace",
};

export const ORG = "org_1";
export const OTHER_ORG = "org_2";

export const signedIn = { cookie: "better-auth.session_token=test-token" };

/** A device sign-in's session for `client`, as the fake auth reads it. */
export function deviceSession(client: string) {
  return { authorization: `Bearer device-${client}` };
}

export function fakeAuth(signOuts: Headers[] = []): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const device = /^Bearer device-(\S+)$/.exec(
          headers.get("authorization") ?? "",
        )?.[1];
        if (device !== undefined)
          return Promise.resolve({
            user: ada,
            session: { id: `session_${device}`, deviceClientId: device },
          });
        return Promise.resolve(
          headers.get("cookie") !== null
            ? { user: ada, session: { id: "session_1", deviceClientId: null } }
            : null,
        );
      },
      signOut: ({ headers }: { headers: Headers }) => {
        signOuts.push(headers);
        return Promise.resolve({ success: true });
      },
    },
    handler: () => Promise.resolve(Response.json({})),
  } as unknown as Auth;
}

interface Row extends StoredApiToken {
  readonly hash: string;
  readonly isDefault?: boolean;
  /** A default token's secret, as it would decrypt; null for unreadable. */
  readonly secret?: string | null;
}

/** Keeps rows in memory, as Postgres would, hash and all. */
export function memoryTokens(): ApiTokenStore & {
  rows: Row[];
  touches: Array<{ id: string; at: Date }>;
} {
  const rows: Row[] = [];
  const touches: Array<{ id: string; at: Date }> = [];
  const stored = ({
    hash: _hash,
    isDefault: _isDefault,
    secret: _secret,
    ...row
  }: Row): StoredApiToken => row;
  const liveDefault = (organizationId: string, userId: string) =>
    rows.find(
      (row) =>
        row.organizationId === organizationId &&
        row.createdBy.id === userId &&
        row.isDefault === true &&
        row.revokedAt === null,
    );
  return {
    rows,
    touches,
    create(organizationId, input: NewApiToken) {
      const row: Row = {
        id: `tok_${rows.length + 1}`,
        organizationId,
        name: input.name,
        prefix: input.prefix,
        hash: input.hash,
        scopes: [...input.scopes],
        createdBy: { id: input.createdBy, name: ada.name },
        createdAt: new Date("2026-11-12T00:00:00.000Z"),
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      rows.push(row);
      return Promise.resolve(stored(row));
    },
    findDefault(organizationId, userId) {
      const row = liveDefault(organizationId, userId);
      return Promise.resolve(
        row === undefined
          ? undefined
          : { token: stored(row), secret: row.secret ?? null },
      );
    },
    createDefault(organizationId, input) {
      if (liveDefault(organizationId, input.createdBy) !== undefined)
        return Promise.resolve(undefined);
      const row: Row = {
        id: `tok_${rows.length + 1}`,
        organizationId,
        name: input.name,
        prefix: input.prefix,
        hash: input.hash,
        scopes: [...input.scopes],
        createdBy: { id: input.createdBy, name: ada.name },
        createdAt: new Date("2026-11-12T00:00:00.000Z"),
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        isDefault: true,
        secret: input.secret,
      };
      rows.push(row);
      return Promise.resolve(stored(row));
    },
    list(organizationId) {
      return Promise.resolve(
        rows.filter((row) => row.organizationId === organizationId).map(stored),
      );
    },
    revoke(organizationId, id) {
      const index = rows.findIndex(
        (row) => row.organizationId === organizationId && row.id === id,
      );
      const row = rows[index];
      if (row === undefined) return Promise.resolve(undefined);
      const revoked = {
        ...row,
        revokedAt: row.revokedAt ?? new Date("2026-11-13T00:00:00.000Z"),
      };
      rows[index] = revoked;
      return Promise.resolve(stored(revoked));
    },
    findByHash(hash) {
      const row = rows.find(
        (candidate) => candidate.hash === hash && candidate.revokedAt === null,
      );
      if (row === undefined) return Promise.resolve(undefined);
      const resolved: ResolvedApiToken = {
        ...stored(row),
        createdBy: { ...row.createdBy, email: ada.email },
      };
      return Promise.resolve(resolved);
    },
    touch(organizationId, id, at) {
      const index = rows.findIndex(
        (row) => row.organizationId === organizationId && row.id === id,
      );
      const row = rows[index];
      if (row !== undefined) rows[index] = { ...row, lastUsedAt: at };
      touches.push({ id, at });
      return Promise.resolve();
    },
  };
}

/** Contributor tokens in memory, as Postgres keeps them: a person's own. */
export function memoryContributorTokens(
  people: Record<string, { id: string; email: string; name: string }> = {
    [ada.id]: ada,
  },
): ContributorTokenStore & {
  rows: Array<StoredContributorToken & { hash: string }>;
  touches: Array<{ id: string; at: Date }>;
} {
  const rows: Array<StoredContributorToken & { hash: string }> = [];
  const touches: Array<{ id: string; at: Date }> = [];
  const stored = ({
    hash: _hash,
    ...row
  }: StoredContributorToken & { hash: string }): StoredContributorToken => row;
  return {
    rows,
    touches,
    create(userId, input) {
      const row = {
        id: `ctk_${rows.length + 1}`,
        userId,
        name: input.name,
        prefix: input.prefix,
        hash: input.hash,
        createdAt: new Date("2026-11-15T00:00:00.000Z"),
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      rows.push(row);
      return Promise.resolve(stored(row));
    },
    list(userId) {
      return Promise.resolve(
        rows.filter((row) => row.userId === userId).map(stored),
      );
    },
    revoke(userId, id) {
      const index = rows.findIndex(
        (row) => row.userId === userId && row.id === id,
      );
      const row = rows[index];
      if (row === undefined) return Promise.resolve(undefined);
      const revoked = {
        ...row,
        revokedAt: row.revokedAt ?? new Date("2026-11-16T00:00:00.000Z"),
      };
      rows[index] = revoked;
      return Promise.resolve(stored(revoked));
    },
    findByHash(hash) {
      const row = rows.find(
        (candidate) => candidate.hash === hash && candidate.revokedAt === null,
      );
      const person = row === undefined ? undefined : people[row.userId];
      if (row === undefined || person === undefined)
        return Promise.resolve(undefined);
      return Promise.resolve({ ...stored(row), user: person });
    },
    touch(userId, id, at) {
      const index = rows.findIndex(
        (each) => each.userId === userId && each.id === id,
      );
      const row = rows[index];
      if (row !== undefined) rows[index] = { ...row, lastUsedAt: at };
      touches.push({ id, at });
      return Promise.resolve();
    },
  };
}

/** Roles by `${userId}:${organizationId}`, changeable mid-test. */
export function roleStore(roles: Record<string, string>): OrganizationStore {
  const organizations = [
    { id: ORG, name: "Acme", slug: "acme", kind: "team" as const },
    { id: OTHER_ORG, name: "Globex", slug: "globex", kind: "team" as const },
  ];
  const unused = () => Promise.reject(new Error("not used in these tests"));
  return {
    roleOf: (userId, organizationId) =>
      Promise.resolve(roles[`${userId}:${organizationId}`]),
    listForUser: (userId) =>
      Promise.resolve(
        organizations.flatMap((organization) => {
          const role = roles[`${userId}:${organization.id}`];
          return role === undefined ? [] : [{ ...organization, role }];
        }),
      ),
    get: (organizationId) =>
      Promise.resolve(organizations.find(({ id }) => id === organizationId)),
    listMembers: () => Promise.resolve([]),
    createPersonal: unused,
    renamePersonal: unused,
    findBySlug: unused,
    slugOwner: unused,
    pendingFor: unused,
    findUserByHandle: unused,
    touch: unused,
    setLogo: unused,
  } as OrganizationStore;
}

interface OAuthTokenRow {
  readonly hash: string;
  readonly id: string;
  readonly grantId: string;
  readonly expiresAt: Date;
  revoked: boolean;
}

/**
 * OAuth grants and their access tokens in memory: what the provider
 * plugin would have written, read the way `OAuthGrantStore` reads it.
 */
export function memoryGrants(): OAuthGrantStore & {
  grants: Array<OAuthGrant & { organizationId: string | null }>;
  tokens: OAuthTokenRow[];
  touches: Array<{ grantId: string; at: Date }>;
  /**
   * A grant for Ada in `organizationId` (null: a contributor grant), and
   * the hash of one token for it.
   */
  issue(input: {
    organizationId: string | null;
    scopes: string[];
    hash: string;
    expiresAt: Date;
  }): string;
} {
  const grants: Array<OAuthGrant & { organizationId: string | null }> = [];
  const tokens: OAuthTokenRow[] = [];
  const touches: Array<{ grantId: string; at: Date }> = [];
  const listed = ({
    organizationId: _owner,
    ...grant
  }: OAuthGrant & {
    organizationId: string | null;
  }): OAuthGrant => grant;
  const owns = (
    owner: GrantOwner,
    grant: OAuthGrant & { organizationId: string | null },
  ) =>
    typeof owner === "string"
      ? grant.organizationId === owner
      : grant.organizationId === null && grant.user.id === owner.contributor;
  return {
    grants,
    tokens,
    touches,
    issue({ organizationId, scopes, hash, expiresAt }) {
      const grantId = `consent_${grants.length + 1}`;
      grants.push({
        id: grantId,
        organizationId,
        client: { id: "client_1", name: "Claude Code" },
        user: { id: ada.id, name: ada.name },
        scopes,
        createdAt: new Date("2026-11-12T00:00:00.000Z"),
        updatedAt: new Date("2026-11-12T00:00:00.000Z"),
        lastUsedAt: null,
      });
      tokens.push({
        hash,
        id: `at_${tokens.length + 1}`,
        grantId,
        expiresAt,
        revoked: false,
      });
      return grantId;
    },
    findAccessToken(hash) {
      const token = tokens.find(
        (candidate) => candidate.hash === hash && !candidate.revoked,
      );
      const grant = grants.find(({ id }) => id === token?.grantId);
      if (token === undefined || grant === undefined)
        return Promise.resolve(undefined);
      return Promise.resolve({
        id: token.id,
        clientId: grant.client.id,
        grantId: grant.id,
        organizationId: grant.organizationId,
        user: ada,
        scopes: grant.scopes,
        expiresAt: token.expiresAt,
        grantLastUsedAt: grant.lastUsedAt,
      });
    },
    touch(_owner, grantId, at) {
      touches.push({ grantId, at });
      return Promise.resolve();
    },
    list(owner) {
      return Promise.resolve(
        grants.filter((grant) => owns(owner, grant)).map(listed),
      );
    },
    revoke(owner, grantId) {
      const index = grants.findIndex(
        (grant) => owns(owner, grant) && grant.id === grantId,
      );
      const grant = grants[index];
      if (grant === undefined) return Promise.resolve(undefined);
      grants.splice(index, 1);
      for (const token of tokens)
        if (token.grantId === grantId) token.revoked = true;
      return Promise.resolve(listed(grant));
    },
    revokeAccessToken(owner, tokenId) {
      const token = tokens.find(({ id }) => id === tokenId);
      const grant = grants.find(({ id }) => id === token?.grantId);
      if (token === undefined || grant === undefined || !owns(owner, grant))
        return Promise.resolve(false);
      token.revoked = true;
      return Promise.resolve(true);
    },
  };
}
