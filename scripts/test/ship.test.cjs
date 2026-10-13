const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ship = fs.readFileSync(path.join(__dirname, "../ship.sh"), "utf8");
const STUB_PR_URL = "https://github.com/test/repo/pull/1";

test("ship has no local watcher, review overrides or force merge", () => {
  assert.doesNotMatch(
    ship,
    /nohup|resolveReviewThread|@coderabbitai|--admin|gh pr merge/,
  );
  const help = spawnSync(
    "bash",
    [path.join(__dirname, "../ship.sh"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Exit 0 means merged into main/);
});

const BRANCH = "fix/shipping-regression";

// `view` is the PR state the gh stub reports; `failing` a failed required check.
for (const { flags, view, failing, status, merged } of [
  { flags: [], view: "MERGED CLEAN", status: 0, merged: true },
  { flags: [], view: "OPEN BLOCKED", failing: "ci", status: 3 },
  { flags: [], view: "OPEN DIRTY", status: 3 },
  { flags: ["--draft"], status: 0 },
  { flags: ["--no-wait"], status: 0 },
]) {
  const name = [...flags, view ?? ""].join(" ").trim();
  test(`ship ${name} returns to main without background work`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const remote = path.join(dir, "remote.git");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TEST_LOG: path.join(dir, "gh.log"),
      GH_TEST_VIEW: view ?? "",
      GH_TEST_FAILING: failing ?? "",
      SHIP_POLL_INTERVAL: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      SHIP_COAUTHOR: "",
    };
    function run(command, args, cwd = repo, expected = 0) {
      const r = spawnSync(command, args, { cwd, env, encoding: "utf8" });
      assert.equal(
        r.status,
        expected,
        `${command} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`,
      );
      return r.stdout.trim();
    }
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
case "$1 $2" in
  "auth status"|"pr list") exit 0 ;;
  "pr create") echo '${STUB_PR_URL}' ;;
  "pr view") printf '%s %s\\n' "$GH_TEST_VIEW" "$(git rev-parse refs/remotes/origin/${BRANCH})" ;;
  "pr checks") printf '%s\\n' "$GH_TEST_FAILING" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    run("git", ["init", "--bare", remote], dir);
    run("git", ["init", "-b", "main"]);
    run("git", ["config", "user.name", "Ship Test"]);
    run("git", ["config", "user.email", "test@example.invalid"]);
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.writeFileSync(path.join(repo, "scripts/ship.sh"), ship, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "file.txt"), "initial\n");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "initial"]);
    run("git", ["remote", "add", "origin", remote]);
    run("git", ["push", "-u", "origin", "main"]);
    fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");
    const output = run(
      "bash",
      [
        "scripts/ship.sh",
        "--title",
        "fix: shipping regression",
        "--yes",
        ...flags,
      ],
      repo,
      status,
    );
    // ship.sh reports the URL as the final field of a decorated line
    // ("==> <url>"), so compare whole tokens rather than testing for a
    // substring: an arbitrary host could embed this URL as its own prefix.
    assert.ok(
      output
        .split("\n")
        .some((line) => line.trim().split(/\s+/).pop() === STUB_PR_URL),
      `expected ${STUB_PR_URL} to be reported in:\n${output}`,
    );
    assert.equal(run("git", ["branch", "--show-current"]), "main");
    assert.equal(run("git", ["status", "--porcelain"]), "");
    assert.equal(
      fs.readFileSync(path.join(repo, "file.txt"), "utf8"),
      "initial\n",
    );
    assert.equal(fs.existsSync(path.join(repo, ".git/ship")), false);
    const calls = fs.readFileSync(env.GH_TEST_LOG, "utf8");
    assert.match(calls, /pr create/);
    assert.doesNotMatch(calls, /pr merge|pr comment|graphql/);
    if (flags.includes("--draft")) assert.match(calls, /--draft/);
    if (view) assert.match(calls, /pr view 1/);
    else assert.doesNotMatch(calls, /pr view/);
    // A merged branch is deleted locally and on origin; any other stays.
    const ref = `refs/heads/${BRANCH}`;
    const local = spawnSync("git", ["show-ref", "--verify", ref], {
      cwd: repo,
    });
    const remoteRef = spawnSync("git", ["show-ref", "--verify", ref], {
      cwd: remote,
    });
    assert.equal(local.status === 0, !merged, `local ${BRANCH}`);
    assert.equal(remoteRef.status === 0, !merged, `origin ${BRANCH}`);
  });
}
