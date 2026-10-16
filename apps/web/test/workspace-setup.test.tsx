import { afterEach, expect, test, vi } from "vitest";

import { useWorkspaceSetup } from "../src/features/onboarding/useWorkspaceSetup";
import { cleanup, renderHook, waitFor } from "./render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const listed = {
  jira: { available: true, connected: 1, broken: 0, boards: 2 },
  github: { available: true, connected: 1, repositories: 1 },
  proposals: 3,
  bounties: 1,
  members: 2,
};

test("the workspace list's setup answers until the workspace's own reads do", async () => {
  // None of the six reads answers.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const { result } = renderHook(() =>
    useWorkspaceSetup({ id: "org_1", role: "admin", setup: listed }),
  );
  expect(result.current.ownFacts).toBe(true);
  expect(result.current.facts).toEqual({ ...listed, canManage: true });
});

test("the workspace's own reads take over once they answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      return Response.json(
        url.includes("/jira/connections")
          ? { connections: [] }
          : url.includes("/jira/boards")
            ? { boards: [] }
            : url.includes("/github/connections")
              ? { connections: [] }
              : url.includes("/github/repositories")
                ? { repositories: [] }
                : url.includes("/proposal-categories")
                  ? { total: 0, uncategorized: 0, categories: [] }
                  : { bounties: [], nextCursor: null },
      );
    }),
  );
  const { result } = renderHook(() =>
    useWorkspaceSetup({ id: "org_1", role: "member", setup: listed }),
  );
  await waitFor(() => expect(result.current.facts?.proposals).toBe(0));
  expect(result.current.facts?.jira.connected).toBe(0);
  expect(result.current.facts?.canManage).toBe(false);
});

test("a list that says nothing leaves the facts unknown until the reads answer", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const { result } = renderHook(() =>
    useWorkspaceSetup({ id: "org_1", role: "owner" }),
  );
  expect(result.current.facts).toBeNull();
  expect(result.current.ownFacts).toBe(false);
});
