/**
 * The `state` parameter for the Jira connection flow.
 *
 * `state` exists to stop CSRF: without it, an attacker can send a victim a
 * callback URL carrying *the attacker's* authorization code, and the victim's
 * account silently ends up connected to the attacker's Jira site — or, in the
 * other direction, the victim's freshly granted code is redeemed by a request
 * the victim did not start.
 *
 * Three things have to survive the round trip, and all three are in here
 * rather than in a cookie or a table:
 *
 * - **Which organization** the connection is for. It cannot come from the
 *   callback's query string, or anyone could swap it and attach a Jira site
 *   to an organization they merely belong to — the membership check happens
 *   when the flow *starts*, and the callback must honour that same decision.
 * - **Who started it**, so a code cannot be redeemed under a different
 *   session.
 * - **When**, so an abandoned flow cannot be completed days later.
 *
 * Signed with HMAC-SHA256 under `BETTER_AUTH_SECRET` rather than stored: the
 * API runs as more than one task, and a value held in one task's memory would
 * fail whenever the callback landed on another. A signature needs no shared
 * storage and cannot be forged without the secret.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a started flow stays completable. */
const TTL_MS = 10 * 60 * 1000;

export interface JiraOAuthState {
  readonly organizationId: string;
  readonly userId: string;
  /** Where to send the browser afterwards, within the web app. */
  readonly returnTo: string;
  /** Milliseconds since the epoch, when the flow started. */
  readonly issuedAt: number;
  /** Random, so two flows started in the same millisecond differ. */
  readonly nonce: string;
  readonly intent?: "read" | "write";
  readonly connectionId?: string;
  readonly cloudId?: string;
  readonly scopeVersion?: number;
}

/** Why a returned `state` was refused. Reported without detail to the caller. */
export type StateFailure =
  "malformed" | "bad-signature" | "expired" | "wrong-user";

export type StateResult =
  { ok: true; state: JiraOAuthState } | { ok: false; reason: StateFailure };

/**
 * Signs the state into an opaque, URL-safe string.
 *
 * The payload is readable by anyone who receives it — it is base64url, not
 * encryption — so nothing secret goes in it. An organization id and a user id
 * are both already known to the person in the browser.
 */
export function signState(
  secret: string,
  state: Omit<JiraOAuthState, "issuedAt" | "nonce"> &
    Partial<Pick<JiraOAuthState, "issuedAt" | "nonce">>,
): string {
  const payload: JiraOAuthState = {
    organizationId: state.organizationId,
    userId: state.userId,
    returnTo: state.returnTo,
    issuedAt: state.issuedAt ?? Date.now(),
    nonce: state.nonce ?? randomBytes(9).toString("base64url"),
    ...(state.intent === undefined ? {} : { intent: state.intent }),
    ...(state.connectionId === undefined
      ? {}
      : { connectionId: state.connectionId }),
    ...(state.cloudId === undefined ? {} : { cloudId: state.cloudId }),
    ...(state.scopeVersion === undefined
      ? {}
      : { scopeVersion: state.scopeVersion }),
  };
  const body = toBase64Url(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verifies a returned `state`.
 *
 * `expectedUserId` is the session the callback arrived on. A mismatch means
 * the flow was started by someone else, which is the CSRF case this exists to
 * catch.
 */
export function verifyState(
  secret: string,
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
function asState(value: unknown): JiraOAuthState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["organizationId"] !== "string" ||
    typeof candidate["userId"] !== "string" ||
    typeof candidate["returnTo"] !== "string" ||
    typeof candidate["issuedAt"] !== "number" ||
    !Number.isFinite(candidate["issuedAt"]) ||
    typeof candidate["nonce"] !== "string"
  ) {
    return undefined;
  }
  if (
    candidate["intent"] !== undefined &&
    candidate["intent"] !== "read" &&
    candidate["intent"] !== "write"
  ) {
    return undefined;
  }
  if (
    candidate["intent"] === "write" &&
    (typeof candidate["connectionId"] !== "string" ||
      typeof candidate["cloudId"] !== "string" ||
      candidate["scopeVersion"] !== 1)
  ) {
    return undefined;
  }
  return {
    organizationId: candidate["organizationId"],
    userId: candidate["userId"],
    returnTo: candidate["returnTo"],
    issuedAt: candidate["issuedAt"],
    nonce: candidate["nonce"],
    ...(candidate["intent"] === "read" || candidate["intent"] === "write"
      ? { intent: candidate["intent"] }
      : {}),
    ...(typeof candidate["connectionId"] === "string"
      ? { connectionId: candidate["connectionId"] }
      : {}),
    ...(typeof candidate["cloudId"] === "string"
      ? { cloudId: candidate["cloudId"] }
      : {}),
    ...(typeof candidate["scopeVersion"] === "number"
      ? { scopeVersion: candidate["scopeVersion"] }
      : {}),
  };
}
