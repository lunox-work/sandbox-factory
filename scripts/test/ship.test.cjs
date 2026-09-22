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
  assert.match(help.stdout, /Exit 0 means the PR is open/);
});

for (const flags of [[], ["--draft"], ["--no-wait"]]) {
  test(`ship ${flags.join(" ") || "default"} opens PR and returns to main without background work`, (t) => {
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
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      SHIP_COAUTHOR: "",
    };
    function run(command, args, cwd = repo) {
      const r = spawnSync(command, args, { cwd, env, encoding: "utf8" });
      assert.equal(
        r.status,
        0,
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
    const output = run("bash", [
      "scripts/ship.sh",
      "--title",
      "fix: shipping regression",
      "--yes",
      ...flags,
    ]);
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
  });
}
