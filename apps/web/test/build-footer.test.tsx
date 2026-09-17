/**
 * Tests for the version readout.
 *
 * The property being defended is that the footer reports *this bundle*, and
 * reports the API's disagreement without acting on it. A readout that quietly
 * showed the API's version instead of its own would look right on every screen
 * and be wrong in exactly the case it exists for — a stale bundle talking to a
 * newer API.
 *
 * The server is faked at `fetch`, as in the other suites here, so what is
 * asserted is what actually reaches the screen.
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

// Guards the duplication between `vitest.config.ts` and `test/build.ts`: a
// config cannot import from the test graph, so this is what keeps them honest.
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
  // Opening the repository must not navigate away from an app the user may
  // have unsaved input in.
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

// The fixture is a build of `main`, which is what almost every build is. A
// release link here would point at a release this commit is not.
test("no release link on a build that is not a tagged release", async () => {
  render(<BuildFooter />);
  await screen.findByText("1.4.2+7f3a9c1");
  expect(screen.queryByText("release")).toBeNull();
});

// The tooltip is where the full sha lives, because that is the form provenance
// verification takes and the short one cannot be pasted into it.
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

// Reporting, not acting: a rolling deploy makes the two differ for a few
// seconds, and a reload prompt on every deploy trains people to dismiss it.
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

// A proxy serving an HTML error page is the realistic version of this, and it
// must not take the footer down with it.
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
