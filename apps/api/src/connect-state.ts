/**
 * The `state` parameter for the connection flows: Jira's and GitHub's.
 *
 * `state` exists to stop CSRF: without it, an attacker can send a victim a
 * callback URL carrying *the attacker's* authorization code, and the victim's
 * organization silently ends up connected to the attacker's Jira site or
 * GitHub account — or, in the other direction, the victim's freshly granted
 * code is redeemed by a request the victim did not start.
 *
 * Four things have to survive the round trip, and all four are in here
 * rather than in a cookie or a table:
 *
 * - **Which organization** the connection is for. It cannot come from the
 *   callback's query string, or anyone could swap it and attach a site or an
 *   installation to an organization they merely belong to — the membership
 *   check happens when the flow *starts*, and the callback must honour that
 *   same decision.
 * - **Who started it**, so a code cannot be redeemed under a different
 *   session.
 * - **When**, so an abandoned flow cannot be completed days later.
 * - **Which flow** (`purpose`), so a state minted to connect Jira cannot be
 *   replayed into GitHub's callback, or the reverse. Both are signed with the
 *   same secret, so without it the two would be interchangeable.
 *
 * Signed with HMAC-SHA256 under `BETTER_AUTH_SECRET` rather than stored: the
 * API runs as more than one task, and a value held in one task's memory would
 * fail whenever the callback landed on another. A signature needs no shared
 * storage and cannot be forged without the secret.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a started flow stays completable. */
const TTL_MS = 10 * 60 * 1000;

/** Which callback a state was minted for. */
export type ConnectPurpose = "jira" | "github";

export interface ConnectState {
  readonly purpose: ConnectPurpose;
  readonly organizationId: string;
  readonly userId: string;
  /** Where to send the browser afterwards, within the web app. */
  readonly returnTo: string;
  /** Milliseconds since the epoch, when the flow started. */
  readonly issuedAt: number;
  /** Random, so two flows started in the same millisecond differ. */
  readonly nonce: string;
}

/** Why a returned `state` was refused. Reported without detail to the caller. */
export type StateFailure =
  "malformed" | "bad-signature" | "expired" | "wrong-user" | "wrong-purpose";

export type StateResult =
  { ok: true; state: ConnectState } | { ok: false; reason: StateFailure };

/**
 * Signs the state into an opaque, URL-safe string.
 *
 * The payload is readable by anyone who receives it — it is base64url, not
 * encryption — so nothing secret goes in it. An organization id and a user id
 * are both already known to the person in the browser.
 */
export function signState(
  secret: string,
  purpose: ConnectPurpose,
  state: Omit<ConnectState, "purpose" | "issuedAt" | "nonce"> &
    Partial<Pick<ConnectState, "issuedAt" | "nonce">>,
): string {
  const payload: ConnectState = {
    purpose,
    organizationId: state.organizationId,
    userId: state.userId,
    returnTo: state.returnTo,
    issuedAt: state.issuedAt ?? Date.now(),
    nonce: state.nonce ?? randomBytes(9).toString("base64url"),
  };
  const body = toBase64Url(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verifies a returned `state`.
 *
 * `expectedUserId` is the session the callback arrived on. A mismatch means
 * the flow was started by someone else, which is the CSRF case this exists to
 * catch. `purpose` is the callback doing the verifying.
 */
export function verifyState(
  secret: string,
  purpose: ConnectPurpose,
  value: string | undefined,
  expectedUserId: string,
  now: number = Date.now(),
): StateResult {
  if (value === undefined || value === "") {
    return { ok: false, reason: "malformed" };
  }

  const separator = value.lastIndexOf(".");
  if (separator <= 0) {
    return { ok: false, reason: "malformed" };
  }
  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  // Constant-time, so a forger learns nothing from how long the check took.
  if (!equals(signature, sign(secret, body))) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(body));
  } catch {
    // Signed but unreadable: our own bug rather than an attack, since the
    // signature held. Reported the same way regardless.
    return { ok: false, reason: "malformed" };
  }

  const state = asState(parsed);
  if (state === undefined) {
    return { ok: false, reason: "malformed" };
  }

  // Checked after the signature: an unsigned value's timestamp means nothing.
  if (now - state.issuedAt > TTL_MS || state.issuedAt > now + 60_000) {
    // The upper bound catches a clock that ran backwards, rather than
    // treating a future timestamp as indefinitely valid.
    return { ok: false, reason: "expired" };
  }

  if (state.purpose !== purpose) {
    return { ok: false, reason: "wrong-purpose" };
  }

  if (!equals(state.userId, expectedUserId)) {
    return { ok: false, reason: "wrong-user" };
  }

  return { ok: true, state };
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function equals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Shape check on the decoded payload; every field must be what it claims. */
function asState(value: unknown): ConnectState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const purpose = candidate["purpose"];
  if (
    (purpose !== "jira" && purpose !== "github") ||
    typeof candidate["organizationId"] !== "string" ||
    typeof candidate["userId"] !== "string" ||
    typeof candidate["returnTo"] !== "string" ||
    typeof candidate["issuedAt"] !== "number" ||
    !Number.isFinite(candidate["issuedAt"]) ||
    typeof candidate["nonce"] !== "string"
  ) {
    return undefined;
  }
  return {
    purpose,
    organizationId: candidate["organizationId"],
    userId: candidate["userId"],
    returnTo: candidate["returnTo"],
    issuedAt: candidate["issuedAt"],
    nonce: candidate["nonce"],
  };
}

/**
 * Whether a role may connect or disconnect a tool.
 *
 * Owners and admins only: a connection grants the platform access to a
 * client's tickets or repositories for as long as it lives, which is not a
 * decision an ordinary member should make for the organization. A member may
 * hold several comma-separated roles — the organization plugin splits on `,`
 * when it checks permissions — so any one of them being high enough is
 * enough.
 */
export { isAtLeastAdmin } from "./access.js";

/**
 * Reduces a caller-supplied `returnTo` to a path within the web app, or to
 * `fallback`.
 *
 * Anything absolute, protocol-relative or otherwise odd becomes the fallback.
 * This is the open-redirect guard: `returnTo` reaches us as a query parameter
 * on a route anyone signed in can call.
 */
export function safePath(value: string, fallback: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  // No scheme, no host, no backslash (which some browsers normalise to `/`).
  if (/[\\:]/.test(value)) {
    return fallback;
  }
  return value;
}

/**
 * Where a finished flow sends the browser.
 *
 * Always the web app, never a URL from the request: `returnTo` is carried in
 * the signed state, and even then only its path and query are used. An open
 * redirect here would be reachable by anyone who can start a flow.
 *
 * The query is kept apart from the path. The web app sends its own location,
 * query included (`/o/acme/settings?connection=github`), and assigning that
 * whole to `pathname` percent-encodes the `?` into the path. `params` are set
 * after, so an outcome replaces any stale one the path carried.
 */
export function redirectTarget(
  appUrl: string,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(appUrl);
  const [withoutFragment = ""] = path.split("#");
  const queryAt = withoutFragment.indexOf("?");
  const pathname =
    queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);
  // A path, not an origin. `new URL(path, appUrl)` would honour an absolute
  // URL and send the browser off-site.
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (queryAt !== -1) {
    url.search = withoutFragment.slice(queryAt + 1);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
