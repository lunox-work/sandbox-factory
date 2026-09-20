/**
 * Tests for `useOrganizations`, the hook that decides which organization the
 * app is showing.
 *
 * It had no test of its own: the nav suite exercised it incidentally, which
 * meant a hook that invented an organization out of a malformed response
 * still passed everything. What it decides is which tenant's data fills the
 * screen, so it is worth pinning directly.
 *
 * The server is faked at `fetch`, and the auth client at the module boundary,
 * as in the other web suites.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const setActive = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    organization: {
      setActive: (input: unknown) => setActive(input),
    },
  },
}));

const { useOrganizations } = await import("../src/useOrganizations");

const acme = { id: "org_1", name: "Acme", slug: "acme", role: "owner" };
const globex = {
  id: "org_2",
  name: "Globex",
  slug: "globex",
  role: "member",
};

/** Renders the hook and exposes what it decided, plus its `select`. */
function Probe({ slug }: { slug?: string | undefined }) {
  const organizations = useOrganizations(slug);
  return (
    <div>
      <span data-testid="active">{organizations.active?.slug ?? "none"}</span>
      <button type="button" onClick={() => organizations.clear()}>
        step out
      </button>
      <span data-testid="count">{organizations.organizations.length}</span>
      <span data-testid="error">{organizations.error ?? "none"}</span>
      <span data-testid="loading">{String(organizations.loading)}</span>
      <button type="button" onClick={() => organizations.select("org_2")}>
        pick globex
      </button>
    </div>
  );
}

function serverReturning(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    ),
  );
}

beforeEach(() => {
  setActive.mockReset().mockResolvedValue({ data: {}, error: null });
});

test("the first organization is active once the list arrives", async () => {
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );
});

test("a handle in the URL wins over the first in the list", async () => {
  // A link to an organization must open that one, not whichever sorts first.
  serverReturning({ organizations: [acme, globex] });
  render(<Probe slug="globex" />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("globex"),
  );
});

test("a handle naming an organization you are not in is ignored", async () => {
  // Falls back to one you do belong to rather than showing an empty shell for
  // a tenant that is not yours.
  serverReturning({ organizations: [acme] });
  render(<Probe slug="somebody-else" />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );
});

test("belonging to none leaves nothing active", async () => {
  serverReturning({ organizations: [] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("loading").textContent).toBe("false"),
  );
  expect(screen.getByTestId("active").textContent).toBe("none");
});

test("a malformed response yields no organizations, not an invented one", async () => {
  // The regression this exists for: trusting `body.organizations` crashed the
  // app shell, and defaulting it to anything but empty would show a tenant
  // that does not exist.
  serverReturning({});
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("loading").textContent).toBe("false"),
  );
  expect(screen.getByTestId("count").textContent).toBe("0");
  expect(screen.getByTestId("active").textContent).toBe("none");
});

test("a failed request reports an error and shows no organizations", async () => {
  serverReturning({ error: "nope" }, 500);
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("error").textContent).toMatch(/organizations/i),
  );
  expect(screen.getByTestId("count").textContent).toBe("0");
  expect(screen.getByTestId("active").textContent).toBe("none");
});

test("a network failure is reported rather than thrown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("error").textContent).toMatch(/organizations/i),
  );
});

test("selecting switches the screen and remembers the choice", async () => {
  // Two jobs, deliberately separate: local state decides what this tab
  // renders, and `setActive` is what a reload restores.
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "pick globex" }).click();
  });

  expect(screen.getByTestId("active").textContent).toBe("globex");
  expect(setActive).toHaveBeenCalledWith({ organizationId: "org_2" });
});

test("a failed setActive does not undo the switch", async () => {
  // The screen has already moved; a write that fails only means the next
  // reload starts somewhere else.
  setActive.mockRejectedValue(new Error("offline"));
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "pick globex" }).click();
  });

  expect(screen.getByTestId("active").textContent).toBe("globex");
});

test("the list is read from the caller's own endpoint", async () => {
  // Not the plugin's `organization.list`, which carries no role.
  serverReturning({ organizations: [acme] });
  render(<Probe />);

  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("/api/v1/me/orgs");
});

// ---- stepping out ---------------------------------------------------------

test("clearing steps out of the organization", async () => {
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });

  expect(screen.getByTestId("active").textContent).toBe("none");
});

test("stepping out survives the auto-select effect", async () => {
  // The bug this guards: the effect fills an empty slot with the first
  // organization, so a naive deselect bounces straight back. "Stepped out" is
  // a choice, not an empty slot — and the assertion has to outlive a tick for
  // the re-select to have had its chance to run.
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(screen.getByTestId("active").textContent).toBe("none");
  // Still a member of both; stepping out is a view, not a departure.
  expect(screen.getByTestId("count").textContent).toBe("2");
});

test("stepping out unsets the organization on the server", async () => {
  // `null` is the plugin's documented way to unset it, so a reload comes back
  // to personal context.
  serverReturning({ organizations: [acme] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });

  expect(setActive).toHaveBeenCalledWith({ organizationId: null });
});

test("selecting after stepping out works again", async () => {
  // The flag has to clear, or the switcher would be stuck on personal.
  serverReturning({ organizations: [acme, globex] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });
  expect(screen.getByTestId("active").textContent).toBe("none");

  await act(async () => {
    screen.getByRole("button", { name: "pick globex" }).click();
  });

  expect(screen.getByTestId("active").textContent).toBe("globex");
});

test("a URL naming an organization overrides having stepped out", async () => {
  // Following a link should open what it points at, not silently show
  // personal context because of an earlier choice.
  serverReturning({ organizations: [acme, globex] });
  const view = render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });
  expect(screen.getByTestId("active").textContent).toBe("none");

  view.rerender(<Probe slug="globex" />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("globex"),
  );
});

test("a failed unset does not put the organization back", async () => {
  // The screen has already stepped out; a failed write only means the next
  // reload starts somewhere else.
  setActive.mockRejectedValue(new Error("offline"));
  serverReturning({ organizations: [acme] });
  render(<Probe />);

  await waitFor(() =>
    expect(screen.getByTestId("active").textContent).toBe("acme"),
  );

  await act(async () => {
    screen.getByRole("button", { name: "step out" }).click();
  });

  expect(screen.getByTestId("active").textContent).toBe("none");
});
