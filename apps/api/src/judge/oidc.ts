/**
 * GitHub Actions OIDC tokens, for the CI judge: a workflow run proves which
 * repository it runs in without any secret stored on either side.
 *
 * A token is a JWT GitHub signs with RS256 and a key it publishes at
 * `GITHUB_OIDC_ISSUER/.well-known/jwks`. Accepted only when it is signed by
 * one of those keys, issued by GitHub, meant for this platform (`aud`), and
 * within its lifetime. What it proves is the claims: `repository_id`, the
 * repository GitHub ran the workflow in.
 */

import {
  createPublicKey,
  verify,
  type JsonWebKeyInput,
  type KeyObject,
} from "node:crypto";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** How long GitHub's published keys are kept before they are read again. */
const KEYS_TTL_MS = 60 * 60_000;
/** Clock skew allowed on `exp`, `nbf` and `iat`. */
const LEEWAY_S = 60;

export interface GithubOidcClaims {
  /** GitHub's numeric id of the repository the workflow ran in. */
  readonly repositoryId: string;
  /** `owner/name`, as GitHub knew it then. */
  readonly repository: string;
  /** The commit the workflow ran on. */
  readonly sha: string;
  readonly ref: string;
}

export type OidcRefusal =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "keys_unavailable";

export interface GithubOidcVerifier {
  verify(
    token: string,
  ): Promise<
    | { readonly ok: true; readonly claims: GithubOidcClaims }
    | { readonly ok: false; readonly reason: OidcRefusal }
  >;
}

const decode = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

export function createGithubOidcVerifier(options: {
  /** The `aud` a workflow asks GitHub for: this platform's API origin. */
  readonly audience: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}): GithubOidcVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let keys: { at: number; byId: Map<string, KeyObject> } | null = null;
  const keysNow = async (refresh: boolean) => {
    if (keys !== null && !refresh && now() - keys.at < KEYS_TTL_MS)
      return keys.byId;
    const response = await fetchImpl(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`GitHub's keys answered ${response.status}.`);
    const body = (await response.json()) as {
      keys?: ({ kid?: string; kty?: string } & Record<string, unknown>)[];
    };
    const byId = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? [])
      if (typeof jwk.kid === "string" && jwk.kty === "RSA")
        byId.set(
          jwk.kid,
          createPublicKey({
            key: jwk as JsonWebKeyInput["key"],
            format: "jwk",
          }),
        );
    keys = { at: now(), byId };
    return byId;
  };
  return {
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const [head, body, signature] = parts as [string, string, string];
      const header = decode(head) as
        { alg?: unknown; kid?: unknown } | undefined;
      const claims = decode(body) as Record<string, unknown> | undefined;
      if (
        header === undefined ||
        claims === undefined ||
        header.alg !== "RS256" ||
        typeof header.kid !== "string"
      )
        return { ok: false, reason: "malformed" };
      let key: KeyObject | undefined;
      try {
        key = (await keysNow(false)).get(header.kid);
        // A key GitHub rotated in since the last read.
        if (key === undefined) key = (await keysNow(true)).get(header.kid);
      } catch {
        return { ok: false, reason: "keys_unavailable" };
      }
      if (key === undefined) return { ok: false, reason: "unknown_key" };
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${head}.${body}`),
        key,
        Buffer.from(signature, "base64url"),
      );
      if (!signed) return { ok: false, reason: "bad_signature" };
      if (claims["iss"] !== GITHUB_OIDC_ISSUER)
        return { ok: false, reason: "wrong_issuer" };
      const audience = claims["aud"];
      if (!(
        audience === options.audience ||
        (Array.isArray(audience) && audience.includes(options.audience))
      ))
        return { ok: false, reason: "wrong_audience" };
      const seconds = now() / 1000;
      const exp = claims["exp"];
      const nbf = claims["nbf"];
      if (
        typeof exp !== "number" ||
        exp + LEEWAY_S < seconds ||
        (typeof nbf === "number" && nbf - LEEWAY_S > seconds)
      )
        return { ok: false, reason: "expired" };
      const repositoryId = claims["repository_id"];
      const repository = claims["repository"];
      const sha = claims["sha"];
      const ref = claims["ref"];
      if (
        typeof repositoryId !== "string" ||
        typeof repository !== "string" ||
        typeof sha !== "string" ||
        typeof ref !== "string"
      )
        return { ok: false, reason: "malformed" };
      return { ok: true, claims: { repositoryId, repository, sha, ref } };
    },
  };
}
