/**
 * Tests for the version readout, which lives in the avatar menu.
 *
 * It must report *this bundle*, and report the API's disagreement without
 * acting on it. Showing the API's version instead would be wrong in exactly
 * the case it exists for: a stale bundle talking to a newer API.
 *
 * The readout is rendered in a bare open menu rather than through the avatar;
 * see `renderDetails`.
 *
 * The server is faked at `fetch`, as in the other suites.
 */

import { releaseTag } from "@sandbox-factory/shared";
import type { BuildInfoDto } from "@sandbox-factory/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { fetchApiBuild, logBuild, webBuild } from "../src/build";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu";
import { BuildDetails } from "../src/UserMenu";
import { OTHER_BUILD, TEST_BUILD } from "./build";

/** What the next `GET /version` returns. */
let versionResponse: () => Promise<Response>;

const fetchMock = vi.fn(() => versionResponse());
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * Renders the readout inside an open menu.
 *
 * The menu is the minimum Radix context rather than the real `UserMenu`: the
 * links in the readout are `DropdownMenuItem`s, which throw outside a `Menu`,
 * and `defaultOpen` skips the trigger so nothing here depends on how the menu
 * is opened. That the readout is *in* the avatar menu, and absent from the
 * page until it opens, is pinned by `nav.test.tsx` instead.
 */
function renderDetails(element = <BuildDetails />) {
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger aria-label="build" />
      <DropdownMenuContent>{element}</DropdownMenuContent>
    </DropdownMenu>,
  );
}

beforeEach(() => {
  fetchMock.mockClear();
  versionResponse = () => jsonResponse(TEST_BUILD);
});

// Keeps `TEST_BUILD` in `vitest.config.ts` and `test/build.ts` in sync.
test("the injected build matches what the tests assert against", () => {
  expect(webBuild).toEqual(TEST_BUILD);
});

test("the menu shows this bundle's version and short sha", async () => {
  renderDetails();
  // Separate elements, not the one `1.4.2+7f3a9c1` string they used to share:
  // the version and the commit answer different questions.
  expect(await screen.findByText("v1.4.2")).toBeTruthy();
  expect(screen.getByText("7f3a9c1")).toBeTruthy();
});

test("the sha links to the exact commit on GitHub", async () => {
  renderDetails();
  const link = (await screen.findByText("7f3a9c1")) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(
    `https://github.com/lunox-work/sandbox-factory/commit/${TEST_BUILD.gitSha}`,
  );
  // Must not navigate away from an app that may hold unsaved input.
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

// The fixture is a build of `main`; a release link would point at a release
// this commit is not.
test("no release link on a build that is not a tagged release", async () => {
  renderDetails();
  await screen.findByText("7f3a9c1");
  expect(screen.queryByText("Release notes")).toBeNull();
});

/**
 * The other half of that case, which the fixture cannot reach.
 *
 * `webBuild` comes from a virtual module resolved once at config load, so a
 * test cannot make this bundle a release. Rendering the menu's own markup
 * against a released record is the closest check that the link survives —
 * `releaseUrl` itself is covered in `packages/shared`.
 */
test("a tagged release build offers the release notes link", async () => {
  vi.resetModules();
  const released: BuildInfoDto = {
    ...TEST_BUILD,
    gitRef: releaseTag(TEST_BUILD.version),
  };
  vi.doMock("../src/build", () => ({
    webBuild: released,
    fetchApiBuild: () => Promise.resolve(undefined),
    logBuild: vi.fn(),
  }));

  const { BuildDetails: Details } = await import("../src/UserMenu");
  renderDetails(<Details />);

  const link = (await screen.findByText("Release notes")).closest(
    "a",
  ) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(
    `https://github.com/lunox-work/sandbox-factory/releases/tag/${releaseTag(
      TEST_BUILD.version,
    )}`,
  );
  // Sits alongside the commit link rather than replacing it: they answer
  // different questions.
  expect(screen.getByText("7f3a9c1")).toBeTruthy();

  vi.doUnmock("../src/build");
  vi.resetModules();
});

// The tooltip carries the full sha, the form provenance verification takes.
test("the link title carries the full sha and build time", async () => {
  renderDetails();
  const link = await screen.findByText("7f3a9c1");
  const title = link.getAttribute("title") ?? "";
  expect(title).toContain(TEST_BUILD.gitSha);
  expect(title).toContain(TEST_BUILD.buildTime);
});

test("a matching API adds nothing to the readout", async () => {
  renderDetails();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/version"));
  expect(screen.queryByText(/^API /)).toBeNull();
});

test("a different API commit is surfaced", async () => {
  versionResponse = () => jsonResponse(OTHER_BUILD);
  renderDetails();
  expect(await screen.findByText("API on b2e881d")).toBeTruthy();
});

// Reporting, not acting: a reload prompt on every deploy is one users learn
// to dismiss. The menu's own commands are the only buttons in it.
test("a mismatch offers no reload button", async () => {
  versionResponse = () => jsonResponse(OTHER_BUILD);
  renderDetails();
  await screen.findByText("API on b2e881d");
  expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
});

test("the readout still shows this bundle when the API cannot be reached", async () => {
  versionResponse = () => Promise.reject(new Error("offline"));
  renderDetails();
  expect(await screen.findByText("7f3a9c1")).toBeTruthy();
  expect(screen.queryByText(/^API on /)).toBeNull();
});

test("an API error status is treated as no answer", async () => {
  versionResponse = () => jsonResponse({ error: "nope" }, 503);
  renderDetails();
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByText(/^API /)).toBeNull();
});

// Realistically a proxy's HTML error page; it must not take the readout down.
test("an unparseable body is treated as no answer", async () => {
  versionResponse = () =>
    Promise.resolve(new Response("<html>gateway</html>", { status: 200 }));
  renderDetails();
  expect(await screen.findByText("7f3a9c1")).toBeTruthy();
  expect(screen.queryByText(/^API on /)).toBeNull();
});

test("a body of the wrong shape is rejected rather than rendered", async () => {
  versionResponse = () => jsonResponse({ version: 42 });
  renderDetails();
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByText(/^API /)).toBeNull();
});

test("fetchApiBuild returns the parsed record", async () => {
  expect(await fetchApiBuild(() => jsonResponse(TEST_BUILD))).toEqual(
    TEST_BUILD,
  );
});

test("logBuild writes one line naming the build", () => {
  const info = vi.fn();
  logBuild({ info });
  expect(info).toHaveBeenCalledTimes(1);
  const line = String(info.mock.calls[0]?.[0]);
  expect(line).toContain("1.4.2+7f3a9c1");
  // The full sha, because this line is what gets pasted into a bug report.
  expect(line).toContain(TEST_BUILD.gitSha);
});

/*
 * Regression guard for the links' keyboard reachability.
 *
 * Radix walks the arrow keys over its own items and holds Tab inside the open
 * menu, so a link that is not a `DropdownMenuItem` is one no keyboard can
 * reach. Asserting the role is what pins that: it is the thing that goes away
 * if the `asChild` wrapper is dropped.
 */
test("the commit link is a menu item, so the keyboard can reach it", async () => {
  renderDetails();
  const link = await screen.findByText("7f3a9c1");
  expect(link.getAttribute("role")).toBe("menuitem");
  // Still a link, not a button wearing a link's clothes.
  expect(link.tagName).toBe("A");
});
