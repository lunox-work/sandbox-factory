import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { isAtLeastAdmin } from "../src/access.js";
import {
  redirectTarget,
  safePath,
  signState,
  verifyState,
} from "../src/connect-state.js";

const secret = "0123456789abcdef0123456789abcdef";
const base = {
  organizationId: "org_1",
  userId: "user_1",
  returnTo: "/settings/jira",
};

test("a freshly signed state verifies", () => {
  const signed = signState(secret, "jira", base);

  const result = verifyState(secret, "jira", signed, "user_1");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.state.organizationId, "org_1");
  assert.equal(result.ok && result.state.returnTo, "/settings/jira");
});

test("the organization id survives the round trip", () => {
  // The reason it travels in the state at all: taking it from the callback's
  // query string would let anyone attach a Jira site to an organization the
  // membership check never approved.
  const signed = signState(secret, "jira", {
    ...base,
    organizationId: "org_9",
  });

  const result = verifyState(secret, "jira", signed, "user_1");

  assert.equal(result.ok && result.state.organizationId, "org_9");
});

test("two states signed together differ", () => {
  // The nonce. Identical states would otherwise be interchangeable.
  assert.notEqual(
    signState(secret, "jira", base),
    signState(secret, "jira", base),
  );
});

test("a tampered payload is refused", () => {
  // The attack: swap the organization for one the attacker controls and hope
  // the signature is not checked against the body.
  const signed = signState(secret, "jira", base);
  const [body = "", signature = ""] = signed.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      organizationId: "org_attacker",
    }),
    "utf8",
  ).toString("base64url");

  const result = verifyState(
    secret,
    "jira",
    `${forged}.${signature}`,
    "user_1",
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "bad-signature");
});

test("a state signed with another secret is refused", () => {
  const signed = signState("f".repeat(32), "jira", base);

  const result = verifyState(secret, "jira", signed, "user_1");

  assert.equal(!result.ok && result.reason, "bad-signature");
});

test("a state belonging to another session is refused", () => {
  // The CSRF case: a victim following an attacker's callback link would
  // otherwise connect the attacker's Jira site to their own account.
  const signed = signState(secret, "jira", base);

  const result = verifyState(secret, "jira", signed, "user_2");

  assert.equal(!result.ok && result.reason, "wrong-user");
});

test("an expired state is refused", () => {
  const signed = signState(secret, "jira", { ...base, issuedAt: 1_000_000 });

  // Eleven minutes later; the window is ten.
  const result = verifyState(
    secret,
    "jira",
    signed,
    "user_1",
    1_000_000 + 11 * 60_000,
  );

  assert.equal(!result.ok && result.reason, "expired");
});

test("a state just inside the window is accepted", () => {
  const signed = signState(secret, "jira", { ...base, issuedAt: 1_000_000 });

  const result = verifyState(
    secret,
    "jira",
    signed,
    "user_1",
    1_000_000 + 9 * 60_000,
  );

  assert.equal(result.ok, true);
});

test("a state from the future is refused rather than trusted forever", () => {
  // A clock that ran backwards would otherwise mint a state that never
  // expires.
  const signed = signState(secret, "jira", { ...base, issuedAt: 2_000_000 });

  const result = verifyState(secret, "jira", signed, "user_1", 1_000_000);

  assert.equal(!result.ok && result.reason, "expired");
});

test("a missing or empty state is refused", () => {
  for (const value of [undefined, ""]) {
    const result = verifyState(secret, "jira", value, "user_1");
    assert.equal(!result.ok && result.reason, "malformed");
  }
});

test("a state with no signature is refused", () => {
  for (const value of ["no-dot", ".onlysignature", "body."]) {
    const result = verifyState(secret, "jira", value, "user_1");
    assert.equal(result.ok, false, `expected ${value} to be refused`);
  }
});

test("a signed payload that is not JSON is refused", () => {
  // Reachable only with the secret, so this is our own bug rather than an
  // attack — but it must not throw out of the handler.
  // Signed properly, so the signature check passes and the parse is what
  // fails.
  const body = Buffer.from("not json", "utf8").toString("base64url");
  const ownSignature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");

  const result = verifyState(
    secret,
    "jira",
    `${body}.${ownSignature}`,
    "user_1",
  );

  assert.equal(!result.ok && result.reason, "malformed");
});

test("a signed payload missing a field is refused", () => {
  const body = Buffer.from(
    JSON.stringify({ organizationId: "org_1" }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");

  const result = verifyState(secret, "jira", `${body}.${signature}`, "user_1");

  assert.equal(!result.ok && result.reason, "malformed");
});

test("the state carries nothing secret", () => {
  // It is base64url, not encryption: anyone holding it can read the payload.
  const signed = signState(secret, "jira", base);
  const [body = ""] = signed.split(".");

  const payload = Buffer.from(body, "base64url").toString("utf8");

  assert.ok(!payload.includes(secret));
  assert.match(payload, /org_1/);
});

test("a signed payload that is valid JSON but not an object is refused", () => {
  // `42` and `null` both parse cleanly, so the JSON guard does not catch them
  // and the shape check has to.
  for (const payload of ["42", "null", '"a string"', "[]"]) {
    const body = Buffer.from(payload, "utf8").toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(body)
      .digest("base64url");

    const result = verifyState(
      secret,
      "jira",
      `${body}.${signature}`,
      "user_1",
    );

    assert.equal(
      !result.ok && result.reason,
      "malformed",
      `expected ${payload} to be refused`,
    );
  }
});

test("a signed payload with a non-finite issuedAt is refused", () => {
  // JSON has no NaN literal, but a hand-built payload can still carry a
  // string where the number belongs, and `now - NaN` would compare false.
  const body = Buffer.from(
    JSON.stringify({
      // Everything else well-formed, so the issuedAt check is what refuses.
      purpose: "jira",
      organizationId: "org_1",
      userId: "user_1",
      returnTo: "/",
      issuedAt: "recently",
      nonce: "n",
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");

  const result = verifyState(secret, "jira", `${body}.${signature}`, "user_1");

  assert.equal(!result.ok && result.reason, "malformed");
});

test("a state minted for one flow is refused by the other", () => {
  // Both flows sign with the same secret; the purpose is what keeps a Jira
  // state from completing a GitHub connection, and the reverse.
  const jira = signState(secret, "jira", base);
  const github = signState(secret, "github", base);

  const intoGithub = verifyState(secret, "github", jira, "user_1");
  const intoJira = verifyState(secret, "jira", github, "user_1");

  assert.equal(!intoGithub.ok && intoGithub.reason, "wrong-purpose");
  assert.equal(!intoJira.ok && intoJira.reason, "wrong-purpose");
  assert.equal(verifyState(secret, "github", github, "user_1").ok, true);
});

test("a signed payload naming no purpose, or an unknown one, is refused", () => {
  for (const purpose of [undefined, "slack"]) {
    const body = Buffer.from(
      JSON.stringify({
        purpose,
        organizationId: "org_1",
        userId: "user_1",
        returnTo: "/",
        issuedAt: Date.now(),
        nonce: "n",
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(body)
      .digest("base64url");

    const result = verifyState(
      secret,
      "jira",
      `${body}.${signature}`,
      "user_1",
    );

    assert.equal(!result.ok && result.reason, "malformed", String(purpose));
  }
});

test("only owners and admins may connect, whatever else they hold", () => {
  assert.equal(isAtLeastAdmin("owner"), true);
  assert.equal(isAtLeastAdmin("member, admin"), true);
  assert.equal(isAtLeastAdmin("member"), false);
  assert.equal(isAtLeastAdmin(""), false);
});

test("a returnTo is a path in the web app, or the fallback", () => {
  assert.equal(
    safePath("/o/acme/settings?connection=github", "/"),
    "/o/acme/settings?connection=github",
  );
  for (const evil of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "o/acme",
  ]) {
    assert.equal(safePath(evil, "/fallback"), "/fallback", evil);
  }
});

test("the redirect keeps the return path's query rather than encoding it into the path", () => {
  // The web app returns to its own location, query included. Assigned whole
  // to `pathname`, the `?` became `%3F` and the tab it named was lost.
  const target = new URL(
    redirectTarget(
      "https://app.test",
      "/o/acme/settings?connection=github&github=stale#top",
      {
        github: "connected",
      },
    ),
  );

  assert.equal(target.origin, "https://app.test");
  assert.equal(target.pathname, "/o/acme/settings");
  assert.equal(target.searchParams.get("connection"), "github");
  // The outcome replaces a stale one rather than sitting beside it.
  assert.deepEqual(target.searchParams.getAll("github"), ["connected"]);
  assert.equal(target.hash, "");
});

test("a path without a leading slash still stays on the web app", () => {
  const target = new URL(
    redirectTarget("https://app.test", "settings", { jira: "state" }),
  );

  assert.equal(target.href, "https://app.test/settings?jira=state");
});
