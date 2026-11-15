/**
 * The flow's second half, after `PUBLISH_STEPS`: the published version
 * downloaded as a contributor gets it, built and tested on a machine with
 * no platform variable, graded through the API and the worker (a partial
 * answer, then its one retry with the solution), merged back as a pull
 * request on the fake GitHub in the repository's own names, and those
 * files passing the repository's own test. Then a bounty imported from
 * Jira and sized. Same `flow` object and helpers as `steps.mjs`.
 *
 * The answers are the worker round trip's (`apps/worker/scripts/roundtrip.mjs`),
 * written against whatever names the build gave the fee module.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { runProcess } from "../../apps/worker/dist/evaluation/local-process.js";
import { FIXTURE, JIRA, WRITE_PERMISSIONS } from "./fakes.mjs";
import { fixtureRoot } from "./seed.mjs";
import { api, noFaults, say } from "./steps.mjs";
import { unzip } from "./unzip.mjs";

/** The workspace's own name, which nothing handed out may carry. */
const VOCABULARY = /orvanta/i;
/** The starter's fee: a flat charge on every debit, in any names. */
const STARTER = /return (\w+)\.kind === "debit" \? (\w+) : 0;/;
/** One percent, rounded, never under the flat charge; a credit is free. */
const SOLUTION = (entry, charge) =>
  `if (${entry}.kind === "credit") return 0;\n  return Math.max(${charge}, Math.round(${entry}.amountCents / 100));`;
/** One percent, rounded, and no minimum: scenario s3 fails. */
const PARTIAL = (entry) =>
  `if (${entry}.kind === "credit") return 0;\n  return Math.round(${entry}.amountCents / 100);`;

/** A fee module's text with its starter body replaced. */
function answer(text, body) {
  const match = STARTER.exec(text);
  assert.ok(match, `the fee module has the starter's body:\n${text}`);
  return text.replace(STARTER, body(match[1], match[2]));
}

const signal = new AbortController().signal;
/** A command with exactly the environment given, and its output on failure. */
async function sh(argv, cwd, env, timeoutMs = 300_000) {
  const result = await runProcess(
    { argv, limits: { timeoutMs, maxOutputBytes: 4_000_000 } },
    { cwd, env, signal },
  );
  return {
    ...result,
    ok: result.exitCode === 0 && !result.timedOut,
    output: `$ ${argv.join(" ")} (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})\n${result.stdout}\n${result.stderr}`,
  };
}

/**
 * A contributor's machine: PATH to find node and npm, a home of its own,
 * and the flow's npm cache, kept between runs; no platform variable.
 */
async function machine(flow, name) {
  const home = join(flow.scratch, `${name}-home`);
  await mkdir(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    npm_config_cache: flow.npmCache,
    npm_config_prefer_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}

/** Every file under a folder, by relative path, skipping `node_modules`. */
async function walk(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else out.push(relative(root, path).split("\\").join("/"));
  }
  return out.sort();
}

/** No hidden test and no workspace name in any path or file under `root`. */
async function assertClean(root, label) {
  for (const path of await walk(root)) {
    assert.ok(!path.startsWith("tests/private"), `${label}: ${path} is hidden`);
    assert.doesNotMatch(path, VOCABULARY, `${label}: ${path} names it`);
    const text = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(text, VOCABULARY, `${label}: ${path} names it`);
  }
}

/** A submission as the API answers it, read as an owner reads it. */
const submissionOf = async (flow, id) =>
  (await api(flow, "GET", `/api/v1/orgs/:org/sandboxes/submissions/${id}`))
    .submission;

/**
 * Each status a submission's grading run finds it in when the worker
 * claims the run: what moving to `running` looks like from the store.
 */
function watchClaims(flow, seen) {
  const listener = async (run) => {
    if (run.tool !== "submission_grade") return;
    const found = await flow.platform.stores.submissions.get(
      run.organizationId,
      run.params.submissionId,
    );
    seen.push(found?.status ?? "missing");
  };
  flow.platform.claimed.add(listener);
  return () => flow.platform.claimed.delete(listener);
}

/** A published version to a merged-back pull request that passes there. */
export const ROUND_TRIP_STEPS = [
  [
    "download the published version's archive (API token)",
    async (flow) => {
      const versionId = flow.version.version.id;
      const response = await flow.platform.app.request(
        `/api/v1/orgs/${flow.organizationId}/sandboxes/versions/${versionId}/archive`,
        { headers: flow.token },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("content-type"), "application/zip");
      const entries = unzip(new Uint8Array(await response.arrayBuffer()));
      const tops = new Set(entries.map((entry) => entry.name.split("/")[0]));
      assert.equal(tops.size, 1, `one top folder: ${[...tops].join(", ")}`);
      const [top] = tops;
      assert.doesNotMatch(top, VOCABULARY, "the folder is not named for it");
      const contributor = join(flow.scratch, "contributor");
      const paths = [];
      for (const { name, bytes } of entries) {
        if (name.endsWith("/")) continue;
        const path = name.slice(top.length + 1);
        assert.ok(
          path !== "" && !path.split("/").includes(".."),
          `${name} stays in its folder`,
        );
        paths.push(path);
        await mkdir(dirname(join(contributor, path)), { recursive: true });
        await writeFile(join(contributor, path), bytes);
      }
      paths.sort();
      // The archive is the handout the API listed, file for file.
      assert.deepEqual(
        paths,
        flow.handout.files.map((file) => file.path).sort(),
        "the archive holds the handout's files",
      );
      for (const path of [
        "package.json",
        "package-lock.json",
        "README.md",
        "TASK.md",
        "AGENTS.md",
        ".vscode/settings.json",
        ".vscode/launch.json",
        ".vscode/tasks.json",
        flow.agents.learned.feesPath,
      ])
        assert.ok(paths.includes(path), `the archive has ${path}`);
      await assertClean(contributor, "as downloaded");
      const task = await readFile(join(contributor, "TASK.md"), "utf8");
      assert.match(task, /# s3\n/, "TASK.md holds the renamed spec");
      flow.contributor = contributor;
      say(`downloaded ${paths.length} files under ${top}/`);
    },
  ],
  [
    "contributor: npm ci, build, test and dev pass; so does the solution",
    async (flow) => {
      const env = await machine(flow, "contributor");
      for (const argv of [
        ["npm", "ci"],
        ["npm", "run", "build"],
        ["npm", "test"],
        ["npm", "run", "dev"],
      ]) {
        const at = performance.now();
        const result = await sh(argv, flow.contributor, env);
        assert.ok(result.ok, result.output);
        say(`  ${argv.join(" ")} (${Math.round(performance.now() - at)} ms)`);
      }
      await assertClean(flow.contributor, "after npm ci, build, test, dev");
      // The solution, written into the downloaded tree in its public names.
      const feesPath = join(flow.contributor, flow.agents.learned.feesPath);
      const starter = await readFile(feesPath, "utf8");
      await writeFile(feesPath, answer(starter, SOLUTION));
      const solved = await sh(["npm", "test"], flow.contributor, env);
      assert.ok(solved.ok, solved.output);
      await writeFile(feesPath, starter);
      flow.publicFees = starter;
    },
  ],
  [
    "submit a partial answer: overfit, told only scenario s3 (API token)",
    async (flow) => {
      const versionId = flow.version.version.id;
      const seen = [];
      const unwatch = watchClaims(flow, seen);
      try {
        const { submission } = await api(
          flow,
          "POST",
          `/api/v1/orgs/:org/sandboxes/versions/${versionId}/submissions`,
          {
            as: flow.token,
            body: {
              files: [
                {
                  path: flow.agents.learned.feesPath,
                  text: answer(flow.publicFees, PARTIAL),
                },
              ],
            },
            expected: [202],
          },
        );
        assert.equal(submission.status, "queued");
        await flow.platform.settle();
        const graded = await submissionOf(flow, submission.id);
        assert.deepEqual(seen, ["running"], "graded from running");
        assert.equal(graded.status, "failed", JSON.stringify(graded));
        assert.equal(graded.verdict, "overfit");
        assert.deepEqual(graded.hidden, { passed: 2, total: 3 });
        assert.equal(graded.public.passed, graded.public.total);
        assert.deepEqual(graded.failedScenarios, ["s3"]);
        assert.deepEqual(graded.refused, []);
        assert.doesNotMatch(
          JSON.stringify(graded),
          /tests\/private|minimum/,
          "no hidden test's path or name leaves the run",
        );
        flow.partial = graded;
      } finally {
        unwatch();
      }
      noFaults(flow);
    },
  ],
  [
    "retry with the solution: passed, 3/3 hidden, carried back (API token)",
    async (flow) => {
      const seen = [];
      const unwatch = watchClaims(flow, seen);
      try {
        const { submission } = await api(
          flow,
          "POST",
          `/api/v1/orgs/:org/sandboxes/submissions/${flow.partial.id}/retry`,
          {
            as: flow.token,
            body: {
              files: [
                {
                  path: flow.agents.learned.feesPath,
                  text: answer(flow.publicFees, SOLUTION),
                },
              ],
            },
            expected: [202],
          },
        );
        assert.equal(submission.retryOf, flow.partial.id);
        await flow.platform.settle();
        const graded = await submissionOf(flow, submission.id);
        assert.deepEqual(seen, ["running"], "graded from running");
        assert.equal(graded.status, "passed", JSON.stringify(graded));
        assert.equal(graded.verdict, "passed");
        assert.deepEqual(graded.hidden, { passed: 3, total: 3 });
        assert.equal(graded.public.passed, graded.public.total);
        assert.deepEqual(graded.failedScenarios, []);
        assert.notEqual(graded.carryBack, "failed", "it carries back");
        assert.equal(graded.merge, null);
        // The retry was the one: another is refused.
        await api(
          flow,
          "POST",
          `/api/v1/orgs/:org/sandboxes/submissions/${flow.partial.id}/retry`,
          {
            as: flow.token,
            body: {
              files: [{ path: flow.agents.learned.feesPath, text: "x" }],
            },
            expected: [409],
          },
        );
        flow.passed = graded;
      } finally {
        unwatch();
      }
      noFaults(flow);
    },
  ],
  [
    "merge back: refused without write access, then one pull request in the repository's names (session)",
    async (flow) => {
      const versionId = flow.version.version.id;
      const statusPath = `/api/v1/orgs/:org/sandboxes/versions/${versionId}/merge-back`;
      const mergePath = `/api/v1/orgs/:org/sandboxes/submissions/${flow.passed.id}/merge`;
      const { pulls, installation } = flow.github;

      // The installation has accepted write access; the stored copy, from
      // when it was linked, has not, so the status asks GitHub.
      const ready = await api(flow, "GET", statusPath);
      assert.deepEqual(ready.mergeBack, {
        code: null,
        error: null,
        missing: [],
        acceptUrl: null,
      });
      // A person's act: a token is refused, at the public API's gate (the
      // route is not in its registry) before the route's own check.
      const byToken = await api(flow, "POST", mergePath, {
        as: flow.token,
        expected: [403],
      });
      assert.equal(byToken.code, "not_public");

      // An installation that has not accepted write access: the merge asks
      // GitHub, is refused before anything is written, and the status says
      // so from then on.
      installation.permissions = {
        contents: "read",
        metadata: "read",
        issues: "read",
      };
      const missing = ["contents:write", "pull_requests:write"];
      const refused = await api(flow, "POST", mergePath, { expected: [409] });
      assert.equal(refused.code, "app_permissions_missing");
      assert.deepEqual(refused.missing, missing);
      const blocked = await api(flow, "GET", statusPath);
      assert.equal(blocked.mergeBack.code, "app_permissions_missing");
      assert.deepEqual(blocked.mergeBack.missing, missing);
      assert.match(blocked.mergeBack.acceptUrl, /installations/);
      assert.equal(pulls.length, 0, "nothing was opened");
      assert.equal(flow.github.refs.size, 0, "no branch was made");

      // Accepted: one pull request, opened once.
      installation.permissions = { ...WRITE_PERMISSIONS };
      const opened = await api(flow, "POST", mergePath, { expected: [201] });
      const merge = opened.submission.merge;
      assert.ok(merge, JSON.stringify(opened));
      assert.equal(merge.branch, `lunox/${flow.passed.id}`);
      assert.equal(pulls.length, 1);
      const [pull] = pulls;
      assert.equal(merge.pullRequestNumber, pull.number);
      assert.equal(merge.pullRequestUrl, pull.url);
      assert.equal(pull.base, "main");
      assert.equal(pull.head, merge.branch);
      // One commit on the one the version was cut at.
      assert.deepEqual(flow.github.commits.get(pull.commitSha).parents, [
        flow.commitSha,
      ]);
      // Its files: the solution, carried back to the repository's names.
      const original = flow.fixture.get(FIXTURE.feeModule).toString("utf8");
      const expected = answer(original, SOLUTION);
      assert.deepEqual(pull.files, [
        { path: FIXTURE.feeModule, text: expected },
      ]);
      assert.match(expected, /orvantaFee/);
      assert.match(expected, /orvantaCharge/);
      const pseudonym = flow.agents.learned.feesPath.split("/").at(-2);
      for (const { text } of pull.files) {
        assert.ok(!text.toLowerCase().includes(pseudonym), "no public name");
        assert.ok(!text.includes(flow.agents.learned.fn), "no public name");
      }
      // Pressed again: the same answer, and no second pull request.
      const again = await api(flow, "POST", mergePath, { expected: [200] });
      assert.deepEqual(again, opened);
      assert.equal(pulls.length, 1, "one pull request");
      const after = await api(flow, "GET", statusPath);
      assert.equal(after.mergeBack.code, null);
      flow.pull = pull;
      say(`opened pull request #${pull.number} from ${pull.head}`);
      noFaults(flow);
    },
  ],
  [
    "the pull request's files pass the repository's own test",
    async (flow) => {
      const repository = join(flow.scratch, "repository");
      await cp(fixtureRoot, repository, {
        recursive: true,
        filter: (source) => !/[/\\](node_modules|dist)$/.test(source),
      });
      // Its `tsc` is the worker's pinned compiler, as the round trip runs it.
      const bin = join(flow.scratch, "bin");
      await mkdir(bin, { recursive: true });
      const typescript = dirname(
        createRequire(
          new URL("../../apps/worker/package.json", import.meta.url),
        ).resolve("typescript-compiler/package.json"),
      );
      await symlink(join(typescript, "bin", "tsc"), join(bin, "tsc"));
      const base = await machine(flow, "repository");
      const env = { ...base, PATH: `${bin}:${base.PATH}` };
      const before = await sh(["npm", "test"], repository, env);
      assert.equal(before.ok, false, `fails before:\n${before.output}`);
      for (const { path, text } of flow.pull.files)
        await writeFile(join(repository, path), text);
      const after = await sh(["npm", "test"], repository, env);
      assert.ok(after.ok, after.output);
      assert.match(after.stdout, /# pass 3|ℹ pass 3/, after.output);
    },
  ],
];

/** A bounty imported from a Jira issue, then sized. */
export const JIRA_STEPS = [
  [
    "import a Jira issue as a bounty and size it (API token)",
    async (flow) => {
      // The connection and board an Atlassian sign-in and a board sync
      // record, through their stores.
      const { jiraConnections, jiraBoards } = flow.platform.stores;
      const connection = await jiraConnections.upsert(flow.organizationId, {
        cloudId: JIRA.cloudId,
        siteUrl: JIRA.siteUrl,
        siteName: "Orvanta",
        accessToken: "flow-access",
        refreshToken: "flow-refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["read:jira-work", "offline_access"],
      });
      const board = await jiraBoards.register(flow.organizationId, {
        connectionId: connection.id,
        externalId: JIRA.boardExternalId,
        name: "Payments",
        boardType: "scrum",
        projectKey: JIRA.projectKey,
      });
      flow.jira.connectionId = connection.id;

      // `import_jira_issue`'s route.
      const importPath = `/api/v1/orgs/:org/jira/boards/${board.id}/import`;
      const imported = await api(flow, "POST", importPath, {
        as: flow.token,
        body: { issueId: JIRA.issue.id },
      });
      assert.deepEqual(
        { ...imported, bountyId: undefined },
        { created: 1, refreshed: 0, failed: 0, bountyId: undefined },
      );
      const { bountyId } = imported;
      assert.ok(bountyId, JSON.stringify(imported));
      const { bounty } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${bountyId}`,
      );
      assert.equal(bounty.title, JIRA.issue.summary);
      assert.equal(
        bounty.description,
        "Each debit line on a statement shows the fee it paid, in cents.\n\nCredits show no fee.",
        "the issue's rich text, flattened",
      );
      assert.equal(bounty.jira?.key, JIRA.issue.key);
      assert.equal(bounty.jira?.boardId, board.id);
      assert.equal(bounty.jira?.connectionId, connection.id);
      assert.deepEqual(bounty.components, ["statements"]);
      assert.equal(bounty.origin, "jira");
      // Its Jira fields are the scope's first context version.
      const context = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${bountyId}/context`,
      );
      assert.equal(context.jira.linked?.ref, JIRA.issue.key);
      assert.ok(context.jira.latest, JSON.stringify(context.jira));
      // Imported again: the same bounty, refreshed.
      const again = await api(flow, "POST", importPath, {
        as: flow.token,
        body: { issueId: JIRA.issue.id },
      });
      assert.deepEqual(again, {
        created: 0,
        refreshed: 1,
        failed: 0,
        bountyId,
      });

      // Its scope approved, as any bounty's is before it is priced.
      const { bounty: current } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${bountyId}`,
      );
      await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${bountyId}/approve`,
        {
          as: flow.token,
          body: { expectedRevision: current.revision },
        },
      );

      // Sized: the run reads the issue through Jira and drafts from it.
      const drafts = flow.caller.calls.length;
      const { run } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/bounties/${bountyId}/propose`,
        {
          as: flow.token,
          body: { requestId: randomUUID() },
          expected: [202],
        },
      );
      const ended = await flow.platform.waitForBountyRun(
        flow.organizationId,
        run.id,
      );
      assert.equal(ended.status, "succeeded", JSON.stringify(ended));
      const draft = flow.caller.calls
        .slice(drafts)
        .find((call) => call.tool === "draft_spec");
      assert.ok(draft, "the spec was drafted");
      assert.ok(
        draft.prompt.includes(JIRA.issue.summary),
        "drafted from the issue",
      );
      assert.ok(
        flow.jira.calls.includes(`issueSpec ${JIRA.issue.id}`),
        "the run read the issue",
      );
      const { bounty: sized } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/bounties/${bountyId}`,
      );
      assert.ok(sized.proposal?.id, JSON.stringify(sized.proposal));
      const { proposal } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/proposals/${sized.proposal.id}`,
      );
      assert.ok(proposal.amountMinor > 0, JSON.stringify(proposal));
      // The profile the draft asked for, so nothing is left in flight.
      await flow.platform.settle();
      assert.deepEqual(flow.jira.unexpected, [], "no Jira read off its script");
      say(
        `imported ${JIRA.issue.key} as ${bountyId}; priced ${proposal.complexity} at ${proposal.amountMinor}`,
      );
      noFaults(flow);
    },
  ],
];
