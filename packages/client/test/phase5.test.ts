import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BountyClient,
  BountyRunClient,
  GithubAnalysisClient,
  runEventsPath,
} from "../src/index.js";

/** A client whose every request answers `body`, recording what was asked. */
function answering(body: unknown) {
  const asked: string[] = [];
  return {
    asked,
    options: {
      baseUrl: "",
      fetch: (async (input: string | URL | Request) => {
        asked.push(String(input));
        return Response.json(body);
      }) as typeof fetch,
    },
  };
}

test("the events path is the workspace's", () => {
  assert.equal(runEventsPath("org /1"), "/api/v1/orgs/org%20%2F1/events");
});

test("typical waits ask for each flow, and answer them by name", async () => {
  const { asked, options } = answering({
    flows: { "run:sandbox_build": { p50: 90, samples: 4 } },
  });
  const flows = await new BountyRunClient(options).typicalWaits("org_1", [
    "run:sandbox_build",
    "sandbox_sliced",
  ]);
  assert.deepEqual(flows, { "run:sandbox_build": { p50: 90, samples: 4 } });
  assert.equal(
    asked[0],
    "/api/v1/orgs/org_1/flows/typical?flow=run%3Asandbox_build&flow=sandbox_sliced",
  );
});

test("a snapshot's runs come with their artifacts", async () => {
  const { asked, options } = answering({ runs: [], artifacts: {} });
  assert.deepEqual(
    await new GithubAnalysisClient(options).snapshotRunsWithArtifacts(
      "org_1",
      "ghr_1",
      "rsn_1",
    ),
    { runs: [], artifacts: {} },
  );
  assert.equal(
    asked[0],
    "/api/v1/orgs/org_1/github/repositories/ghr_1/runs?snapshotId=rsn_1&with=artifacts",
  );
});

test("a bounty asked with its live proposal says when it has none", async () => {
  const { asked, options } = answering({ bounty: {} });
  await assert.rejects(
    new BountyClient(options).bountyWithLive("org_1", "bty_1"),
  );
  assert.equal(asked[0], "/api/v1/orgs/org_1/bounties/bty_1?with=live");
});
