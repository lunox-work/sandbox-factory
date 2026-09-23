const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CHECKS, CONTEXT } = require("../review-gate.cjs");
const root = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("required checks and controller agree, without bypass or weaker thread policy", () => {
  const policy = JSON.parse(read(".github/main-ruleset.json"));
  assert.equal(policy.enforcement, "active");
  assert.deepEqual(policy.bypass_actors, []);
  const checks = policy.rules.find(
    (r) => r.type === "required_status_checks",
  ).parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.deepEqual(
    checks.required_status_checks.map((c) => c.context),
    [...CHECKS, CONTEXT],
  );
  assert.ok(
    checks.required_status_checks.every(
      (c) => c.integration_id === (c.context === "CodeQL" ? 57789 : 15368),
    ),
  );
  const review = policy.rules.find((r) => r.type === "pull_request").parameters;
  assert.equal(review.required_review_thread_resolution, true);
  assert.equal(review.dismiss_stale_reviews_on_push, true);
  assert.equal(review.require_extra_approval_for_unattributed_changes, false);
  assert.deepEqual(review.allowed_merge_methods, ["squash"]);
});

test("privileged controller only loads default-branch code and has serialized recovery", () => {
  const workflow = read(".github/workflows/review-gate.yml");
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /require\('\.\/trusted-controller\/scripts\/review-gate\.cjs'\)/,
  );
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(
    workflow,
    /pull_request\.head|npm (ci|install)|refs\/pull/,
  );
});

test("auto-merge cannot silently use a token that suppresses downstream CD", () => {
  const workflow = read(".github/workflows/auto-merge.yml");
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.AUTO_MERGE_TOKEN \}\}/);
  assert.doesNotMatch(
    workflow,
    /FALLBACK_TOKEN|GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN/,
  );
  assert.match(workflow, /exit 1/);
});

test("auto-merge trusts a same-repository branch, not the author's association", () => {
  // The Actions token cannot see a private org membership, so an
  // association check skipped every PR its own maintainer opened.
  const workflow = read(".github/workflows/auto-merge.yml");
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.doesNotMatch(workflow, /author_association/);
});
