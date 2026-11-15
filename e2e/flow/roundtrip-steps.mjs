/**
 * The flow's second half, after `PUBLISH_STEPS`: the owner invites someone
 * outside the workspace, who claims the invite and, as that contributor,
 * downloads the published version, builds and tests it on a machine with
 * no platform variable, and is graded through the API and the worker (a
 * partial answer as `files[]`, then its one retry as the zipped project
 * folder: the solution applied, the build's output and an editor's
 * `.vscode/settings.json` change in it, previewed first); the owner merges
 * the pass back as a pull request on the fake GitHub in the repository's
 * own names, those files pass the repository's own test, and the
 * contributor's access is revoked. Then a bounty imported from Jira and
 * sized. Same `flow` object and helpers as `steps.mjs`.
 *
 * The answers are the worker round trip's (`apps/worker/scripts/roundtrip.mjs`),
 * written against whatever names the build gave the fee module.
 */

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
import { zip } from "../../apps/api/dist/sandbox/zip.js";
import { runProcess } from "../../apps/worker/dist/evaluation/local-process.js";
import { FIXTURE, JIRA, WRITE_PERMISSIONS } from "./fakes.mjs";
import { CONTRIBUTOR, fixtureRoot } from "./seed.mjs";
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

/**
 * A folder zipped as a contributor zips it, everything under its own name
 * (`node_modules/` left out, as most do; the API would skip it unread).
 */
async function zipFolder(root, top) {
  const entries = [];
  for (const path of await walk(root))
    entries.push({
      name: `${top}/${path}`,
      bytes: await readFile(join(root, path)),
    });
  const archive = await zip(entries);
  return new Uint8Array(Buffer.concat(archive.chunks));
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

/** A contributor's own route for the published version. */
const contribution = (flow, rest = "") =>
  `/api/v1/contributions/${flow.version.version.id}${rest}`;

/** A published version to a merged-back pull request that passes there. */
export const ROUND_TRIP_STEPS = [
  [
    "invite someone outside the workspace; they claim it (sessions)",
    async (flow) => {
      const versionId = flow.version.version.id;
      const as = flow.contributorSession;
      // Not a member: nothing of the workspace answers them.
      await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/handout`,
        { as, expected: [404] },
      );
      await api(flow, "GET", contribution(flow), { as, expected: [404] });
      const made = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/invites`,
        {
          body: { label: CONTRIBUTOR.name, email: CONTRIBUTOR.email },
          expected: [201],
        },
      );
      assert.match(made.token, /^lnxinv_/);
      assert.ok(
        made.claimUrl.endsWith(`/invite#${made.token}`),
        "the secret rides in the link's fragment",
      );
      // Only its hash is kept.
      const kept = await flow.platform.stores.contributors.listInvites(
        flow.organizationId,
        versionId,
      );
      assert.equal(kept.length, 1);
      assert.match(kept[0].tokenSha256, /^[0-9a-f]{64}$/);
      assert.notEqual(kept[0].tokenSha256, made.token);
      // The owner is a member: claiming would only spend it.
      const member = await api(flow, "POST", "/api/v1/invites/claim", {
        body: { token: made.token },
        expected: [409],
      });
      assert.equal(member.code, "already_member");
      // A workspace's credential never claims.
      const byToken = await api(flow, "POST", "/api/v1/invites/claim", {
        as: flow.token,
        body: { token: made.token },
        expected: [403],
      });
      assert.equal(byToken.code, "workspace_credential");
      const claimed = await api(flow, "POST", "/api/v1/invites/claim", {
        as,
        body: { token: made.token },
        expected: [201],
      });
      const { contribution: mine } = claimed;
      assert.equal(mine.versionId, versionId);
      assert.equal(mine.open, true);
      assert.match(mine.root, /-v1$/);
      assert.ok(mine.title, JSON.stringify(mine));
      assert.doesNotMatch(
        JSON.stringify(claimed),
        VOCABULARY,
        "the contribution names no workspace",
      );
      assert.doesNotMatch(
        JSON.stringify(claimed),
        new RegExp(flow.organizationId),
      );
      // Spent: nobody else may use it, and it says so the same way.
      const listed = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/contributors`,
      );
      assert.equal(listed.invites[0].state, "claimed");
      assert.equal(listed.contributors[0].user.id, CONTRIBUTOR.id);
      const { contributions } = await api(
        flow,
        "GET",
        "/api/v1/contributions",
        { as },
      );
      assert.deepEqual(
        contributions.map((each) => each.versionId),
        [versionId],
      );
      // Their handout is the owner's, file for file.
      const handout = await api(flow, "GET", contribution(flow, "/handout"), {
        as,
      });
      assert.deepEqual(handout.files, flow.handout.files);
      assert.equal(handout.hiddenSha256, flow.handout.hiddenSha256);
      flow.assignmentId = mine.assignmentId;
      say(`${CONTRIBUTOR.name} claimed ${mine.root}: ${mine.title}`);
      noFaults(flow);
    },
  ],
  [
    "a contributor token (lnxc_) lists contributions and pages the project, over the API and MCP",
    async (flow) => {
      const versionId = flow.version.version.id;
      // Made from the contributor's own session, its secret answered once.
      const made = await api(flow, "POST", "/api/v1/me/contributor-tokens", {
        as: flow.contributorSession,
        body: { name: "Flow editor" },
        expected: [201],
      });
      assert.match(made.secret, /^lnxc_[0-9A-Za-z]{40}$/);
      const as = { authorization: `Bearer ${made.secret}` };
      const { contributions } = await api(
        flow,
        "GET",
        "/api/v1/contributions",
        { as },
      );
      assert.deepEqual(
        contributions.map((each) => each.versionId),
        [versionId],
      );
      // Every page of the public project: the handout's files exactly.
      const paths = [];
      let cursor = null;
      do {
        const page = await api(
          flow,
          "GET",
          contribution(
            flow,
            `/handout/files?maxBytes=20000${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
          ),
          { as },
        );
        paths.push(...page.files.map((file) => file.path));
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.deepEqual(
        paths.sort(),
        flow.handout.files.map((file) => file.path).sort(),
      );
      // Nothing of the workspace, its own handout route included.
      const refused = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/versions/${versionId}/handout`,
        { as, expected: [403] },
      );
      assert.equal(refused.code, "contributor_credential");
      // The same through MCP's contributor endpoint, one stateless call.
      const response = await flow.platform.app.request("/mcp/contribute", {
        method: "POST",
        headers: {
          ...as,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_contributions", arguments: {} },
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const reply = await response.json();
      assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
      assert.match(reply.result.content[0].text, new RegExp(versionId));
      assert.doesNotMatch(reply.result.content[0].text, VOCABULARY);
      say(
        `contributor token paged ${paths.length} files; MCP listed ${versionId}`,
      );
      noFaults(flow);
    },
  ],
  [
    "download the published version's archive (contributor session)",
    async (flow) => {
      const response = await flow.platform.app.request(
        contribution(flow, "/archive"),
        {
          headers: flow.contributorSession,
        },
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
      flow.contributorTop = top;
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
    "submit a partial answer: overfit, told only scenario s3 (contributor session)",
    async (flow) => {
      const seen = [];
      const unwatch = watchClaims(flow, seen);
      try {
        const { submission } = await api(
          flow,
          "POST",
          contribution(flow, "/submissions"),
          {
            as: flow.contributorSession,
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
        // The workspace sees who made it.
        assert.equal(graded.contributor?.userId, CONTRIBUTOR.id);
        assert.equal(graded.contributor?.name, CONTRIBUTOR.name);
        // The contributor reads the same verdict, without the workspace's
        // parts (its run, carry-back, merge-back).
        const theirs = (
          await api(
            flow,
            "GET",
            contribution(flow, `/submissions/${submission.id}`),
            { as: flow.contributorSession },
          )
        ).submission;
        assert.equal(theirs.verdict, "overfit");
        assert.deepEqual(theirs.hidden, graded.hidden);
        assert.deepEqual(theirs.failedScenarios, ["s3"]);
        for (const key of ["runId", "merge", "carryBack", "contributor"])
          assert.equal(key in theirs, false, `no ${key} for the contributor`);
        assert.doesNotMatch(JSON.stringify(theirs), /tests\/private|minimum/);
        // One first submission: other files are refused, naming it.
        const again = await api(
          flow,
          "POST",
          contribution(flow, "/submissions"),
          {
            as: flow.contributorSession,
            body: {
              files: [{ path: flow.agents.learned.feesPath, text: "x" }],
            },
            expected: [409],
          },
        );
        assert.deepEqual(
          [again.code, again.submissionId],
          ["already_submitted", submission.id],
        );
        flow.partial = graded;
      } finally {
        unwatch();
      }
      noFaults(flow);
    },
  ],
  [
    "retry with the solution as the zipped folder, previewed first: passed, 3/3 hidden, carried back (contributor session)",
    async (flow) => {
      const seen = [];
      const unwatch = watchClaims(flow, seen);
      try {
        // Their retry is theirs: the owner's token cannot spend it.
        const ownerRetry = await api(
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
            expected: [409],
          },
        );
        assert.equal(ownerRetry.code, "contributor_submission");
        // The solution in the downloaded folder, which its build, tests and
        // an editor have touched, zipped as a contributor would zip it.
        const feesPath = flow.agents.learned.feesPath;
        await writeFile(
          join(flow.contributor, feesPath),
          answer(flow.publicFees, SOLUTION),
        );
        const settings = join(flow.contributor, ".vscode/settings.json");
        await writeFile(
          settings,
          JSON.stringify({
            ...JSON.parse(await readFile(settings, "utf8")),
            "editor.formatOnSave": true,
          }),
        );
        const folder = await zipFolder(flow.contributor, flow.contributorTop);
        const { preview } = await api(
          flow,
          "POST",
          contribution(
            flow,
            `/submissions/${flow.partial.id}/retry/zip?dryRun=1`,
          ),
          { as: flow.contributorSession, body: folder },
        );
        assert.deepEqual(preview.files, [
          { path: feesPath, change: "changed" },
        ]);
        assert.deepEqual(preview.refused, []);
        assert.ok(
          preview.ignored.includes(".vscode/settings.json"),
          JSON.stringify(preview),
        );
        assert.ok(preview.skipped > 0, "the build's output is skipped");
        const { submission } = await api(
          flow,
          "POST",
          contribution(flow, `/submissions/${flow.partial.id}/retry/zip`),
          { as: flow.contributorSession, body: folder, expected: [202] },
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
        const used = await api(
          flow,
          "POST",
          contribution(flow, `/submissions/${flow.partial.id}/retry`),
          {
            as: flow.contributorSession,
            body: {
              files: [{ path: flow.agents.learned.feesPath, text: "x" }],
            },
            expected: [409],
          },
        );
        assert.equal(used.code, "retry_used");
        const { submissions: mine } = await api(
          flow,
          "GET",
          contribution(flow, "/submissions"),
          { as: flow.contributorSession },
        );
        assert.deepEqual(
          mine.map((each) => [each.id, each.status]),
          [
            [submission.id, "passed"],
            [flow.partial.id, "failed"],
          ],
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
        ciMissing: [],
      });
      // The owner's act: the contributor is not a member there.
      await api(flow, "POST", mergePath, {
        as: flow.contributorSession,
        expected: [404],
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
      // The workspace was told it opened, once.
      const told = flow.platform.events.filter(
        ([, type]) => type === "submission.merge_opened",
      );
      assert.equal(told.length, 1);
      assert.deepEqual(told[0][3], {
        submissionId: flow.passed.id,
        sandboxVersionId: versionId,
        pullRequestNumber: pull.number,
        pullRequestUrl: pull.url,
        when: "open",
      });
      flow.pull = pull;
      say(`opened pull request #${pull.number} from ${pull.head}`);
      noFaults(flow);
    },
  ],
  [
    "CI read-back: the sweep reads the pull request's CI; asked to merge when CI passes, a passing check suite's delivery merges it",
    async (flow) => {
      const { checkRuns } = flow.github;
      const pull = flow.pull;
      const submissionPath = `/api/v1/orgs/:org/sandboxes/submissions/${flow.passed.id}`;
      const read = async () =>
        (await api(flow, "GET", submissionPath)).submission.merge;
      /** A delivery as GitHub signs it, to the App's webhook. */
      const deliver = async (event, payload) => {
        const raw = JSON.stringify(payload);
        const signature = `sha256=${createHmac("sha256", flow.platform.webhookSecret).update(raw).digest("hex")}`;
        const response = await flow.platform.app.request(
          "/api/github/webhook",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": event,
              "x-github-delivery": randomUUID(),
              "x-hub-signature-256": signature,
            },
            body: raw,
          },
        );
        assert.equal(response.status, 202, await response.text());
      };
      const suite = (action) => ({
        action,
        check_suite: {
          head_sha: pull.commitSha,
          head_branch: pull.head,
          pull_requests: [{ number: pull.number }],
        },
        repository: {
          id: Number(FIXTURE.externalId),
          full_name: FIXTURE.fullName,
        },
        installation: { id: Number(FIXTURE.installationId) },
      });

      // No delivery yet: the sweep reads it. No checks reported so soon
      // after opening is pending, not "none".
      await flow.platform.settle();
      let merge = await read();
      assert.equal(merge.pullRequestState, "open");
      assert.equal(merge.ci.state, "pending");
      assert.equal(merge.ci.headSha, pull.commitSha);
      assert.equal(merge.ci.summary.total, 0);
      assert.ok(merge.ci.checkedAt);

      // A check suite starts: its delivery reads it back.
      checkRuns.set(pull.commitSha, [
        {
          name: "npm test",
          status: "in_progress",
          conclusion: null,
          html_url: "https://ci.flow.test/runs/1",
        },
      ]);
      await deliver("check_suite", suite("requested"));
      await flow.platform.settle();
      merge = await read();
      assert.equal(merge.ci.state, "pending");
      assert.equal(merge.ci.summary.pending, 1);
      assert.equal(merge.ci.summary.detailsUrl, "https://ci.flow.test/runs/1");

      // The owner asks for it to merge when CI passes: recorded, not merged.
      const asked = await api(flow, "POST", `${submissionPath}/merge`, {
        body: { when: "ci_passes" },
      });
      assert.equal(asked.submission.merge.when, "ci_passes");
      assert.equal(pull.state, "open");

      // The suite passes: the delivery reads it, and the platform merges,
      // squashed at the head whose CI it read.
      checkRuns.set(pull.commitSha, [
        {
          name: "npm test",
          status: "completed",
          conclusion: "success",
          html_url: "https://ci.flow.test/runs/1",
        },
      ]);
      await deliver("check_suite", suite("completed"));
      await flow.platform.settle();
      merge = await read();
      assert.equal(merge.pullRequestState, "merged");
      assert.equal(merge.ci.state, "passing");
      assert.equal(merge.mergeError, null);
      assert.equal(pull.state, "closed");
      assert.deepEqual(pull.mergedWith, {
        sha: merge.mergedCommitSha,
        method: "squash",
        title: `${pull.title} (#${pull.number})`,
        head: pull.commitSha,
      });

      // The workspace was told each change once: CI, then the merge.
      const told = flow.platform.events
        .filter(
          ([, type]) =>
            type === "submission.ci" || type === "submission.merged",
        )
        .map(([, type, , data]) => [type, data.state ?? data.by]);
      assert.deepEqual(told, [
        ["submission.ci", "passing"],
        ["submission.merged", "platform"],
      ]);
      // Followed no more: another delivery or sweep reads nothing.
      const pullCalls = () =>
        flow.github.calls.filter((call) =>
          /\/(pulls\/\d+|commits\/[0-9a-f]+\/)/.test(call),
        ).length;
      const calls = pullCalls();
      await deliver("check_suite", suite("completed"));
      await flow.platform.settle();
      assert.equal(pullCalls(), calls);
      say(`merged pull request #${pull.number} once its CI passed`);
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
  [
    "revoke the contributor: their access ends at once (sessions)",
    async (flow) => {
      const as = flow.contributorSession;
      const { contributor } = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/sandboxes/contributors/${flow.assignmentId}/revoke`,
      );
      assert.ok(contributor.revokedAt, JSON.stringify(contributor));
      // Revoked again: the first time stands.
      const again = await api(
        flow,
        "POST",
        `/api/v1/orgs/:org/sandboxes/contributors/${flow.assignmentId}/revoke`,
      );
      assert.equal(again.contributor.revokedAt, contributor.revokedAt);
      for (const rest of ["", "/handout", "/archive", "/submissions"])
        await api(flow, "GET", contribution(flow, rest), {
          as,
          expected: [404],
        });
      const { contributions } = await api(
        flow,
        "GET",
        "/api/v1/contributions",
        {
          as,
        },
      );
      assert.deepEqual(contributions, []);
      // Their submissions stay the workspace's record.
      const { submissions } = await api(
        flow,
        "GET",
        `/api/v1/orgs/:org/sandboxes/versions/${flow.version.version.id}/submissions`,
      );
      assert.ok(
        submissions.every(
          (each) => each.contributor?.userId === CONTRIBUTOR.id,
        ),
      );
      noFaults(flow);
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
