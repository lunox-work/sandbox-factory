const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("required checks are the CI contexts, without bypass actors", () => {
  const policy = JSON.parse(read(".github/main-ruleset.json"));
  assert.equal(policy.enforcement, "active");
  assert.deepEqual(policy.bypass_actors, []);
  const checks = policy.rules.find(
    (r) => r.type === "required_status_checks",
  ).parameters;
  // Nothing updates a PR branch for us, so requiring an up-to-date head
  // would strand a green PR the moment main moves.
  assert.equal(checks.strict_required_status_checks_policy, false);
  assert.deepEqual(
    checks.required_status_checks.map((c) => c.context),
    ["Test (Node 22)", "Test (Node 24)", "Analyze", "CodeQL"],
  );
  assert.ok(
    checks.required_status_checks.every(
      (c) => c.integration_id === (c.context === "CodeQL" ? 57789 : 15368),
    ),
  );
  const review = policy.rules.find((r) => r.type === "pull_request").parameters;
  // CodeRabbit is advisory; its open threads must not hold a green PR.
  assert.equal(review.required_review_thread_resolution, false);
  assert.equal(review.dismiss_stale_reviews_on_push, true);
  assert.equal(review.require_extra_approval_for_unattributed_changes, false);
  assert.deepEqual(review.allowed_merge_methods, ["squash"]);
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
