/**
 * Tests for the version readout.
 *
 * The footer must report this bundle, and report the API's disagreement
 * without acting on it. Showing the API's version instead would be wrong in
 * exactly the case it exists for: a stale bundle talking to a newer API.
 *
 * The server is faked at `fetch`, as in the other suites.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { BuildFooter } from "../src/BuildFooter";
import { fetchApiBuild, logBuild, webBuild } from "../src/build";
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

beforeEach(() => {
  fetchMock.mockClear();
  versionResponse = () => jsonResponse(TEST_BUILD);
});

// Keeps `TEST_BUILD` in `vitest.config.ts` and `test/build.ts` in sync.
test("the injected build matches what the tests assert against", () => {
  expect(webBuild).toEqual(TEST_BUILD);
});

test("the footer shows this bundle's version and short sha", async () => {
  render(<BuildFooter />);
  expect(await screen.findByText("1.4.2+7f3a9c1")).toBeTruthy();
});

test("the version links to the exact commit on GitHub", async () => {
  render(<BuildFooter />);
  const link = (await screen.findByText("1.4.2+7f3a9c1")) as HTMLAnchorElement;
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
  render(<BuildFooter />);
  await screen.findByText("1.4.2+7f3a9c1");
  expect(screen.queryByText("release")).toBeNull();
});

// The tooltip carries the full sha, the form provenance verification takes.
test("the link title carries the full sha and build time", async () => {
  render(<BuildFooter />);
  const link = await screen.findByText("1.4.2+7f3a9c1");
  const title = link.getAttribute("title") ?? "";
  expect(title).toContain(TEST_BUILD.gitSha);
  expect(title).toContain(TEST_BUILD.buildTime);
});

test("a matching API adds nothing to the footer", async () => {
  render(<BuildFooter />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/version"));
  expect(screen.queryByText(/^API /)).toBeNull();
});

test("a different API commit is surfaced", async () => {
  versionResponse = () => jsonResponse(OTHER_BUILD);
  render(<BuildFooter />);
  expect(await screen.findByText("API 1.4.2+b2e881d")).toBeTruthy();
});

// Reporting, not acting; see `BuildFooter.tsx`.
test("a mismatch offers no reload button", async () => {
  versionResponse = () => jsonResponse(OTHER_BUILD);
  render(<BuildFooter />);
  await screen.findByText("API 1.4.2+b2e881d");
  expect(screen.queryByRole("button")).toBeNull();
});

test("the footer still shows this bundle when the API cannot be reached", async () => {
  versionResponse = () => Promise.reject(new Error("offline"));
  render(<BuildFooter />);
  expect(await screen.findByText("1.4.2+7f3a9c1")).toBeTruthy();
  expect(screen.queryByText(/^API /)).toBeNull();
});

test("an API error status is treated as no answer", async () => {
  versionResponse = () => jsonResponse({ error: "nope" }, 503);
  render(<BuildFooter />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByText(/^API /)).toBeNull();
});

// Realistically a proxy's HTML error page; it must not take the footer down.
test("an unparseable body is treated as no answer", async () => {
  versionResponse = () =>
    Promise.resolve(new Response("<html>gateway</html>", { status: 200 }));
  render(<BuildFooter />);
  expect(await screen.findByText("1.4.2+7f3a9c1")).toBeTruthy();
  expect(screen.queryByText(/^API /)).toBeNull();
});

test("a body of the wrong shape is rejected rather than rendered", async () => {
  versionResponse = () => jsonResponse({ version: 42 });
  render(<BuildFooter />);
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
