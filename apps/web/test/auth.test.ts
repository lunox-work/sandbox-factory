/**
 * Tests for the sign-in redirect the auth client starts.
 *
 * Better Auth is faked at its module boundary: what is under test is what
 * this app hands it — where the provider sends the person back to — and what
 * it makes of a refusal, which Better Auth reports as `{ error }` rather than
 * by throwing.
 */

import { beforeEach, expect, test, vi } from "vitest";

const social = vi.fn();

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: { social: (input: unknown) => social(input) as unknown },
    useSession: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("better-auth/client/plugins", () => ({
  organizationClient: () => ({}),
}));

const { signInCallbackURL, signInWith } = await import("../src/auth");

beforeEach(() => {
  social.mockReset();
  window.history.replaceState(null, "", "/");
});

test("the callback returns to the page being opened, not just the origin", async () => {
  // A deep link opened while signed out used to land on home after signing in.
  window.history.replaceState(null, "", "/bounties?peek=acme/bty_1#spec");
  social.mockResolvedValue({ data: { redirect: true }, error: null });

  expect(await signInWith("github")).toBe(true);
  expect(social).toHaveBeenCalledWith({
    provider: "github",
    callbackURL: `${window.location.origin}/bounties?peek=acme%2Fbty_1#spec`,
  });
});

test("an earlier attempt's error is not carried back", () => {
  expect(
    signInCallbackURL({
      origin: "https://app.example.test",
      pathname: "/o/acme/settings",
      search: "?error=state_mismatch&connection=jira",
      hash: "",
    }),
  ).toBe("https://app.example.test/o/acme/settings?connection=jira");
  expect(
    signInCallbackURL({
      origin: "https://app.example.test",
      pathname: "/",
      search: "?error=state_mismatch",
      hash: "",
    }),
  ).toBe("https://app.example.test/");
});

test("a refusal resolves as not started rather than as a redirect", async () => {
  social.mockResolvedValue({
    data: null,
    error: { status: 400, message: "Invalid callbackURL" },
  });

  expect(await signInWith("google")).toBe(false);
});
