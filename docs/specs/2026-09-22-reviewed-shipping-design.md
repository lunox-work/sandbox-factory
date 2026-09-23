# Reviewed shipping

Approved in conversation on 2026-09-22.

`ship.sh` verifies, pushes, opens a PR and returns the checkout to main. It does
not watch, resolve discussions or merge. GitHub owns the remaining lifecycle.

The required `Review gate` status belongs to the current PR head. Success needs
passing CI and CodeQL, a completed CodeRabbit review and its approval of that
exact head, no unresolved threads, and no outstanding repair request. Missing
or stale evidence blocks; an API error cannot create a success.

A trusted default-branch controller requests `@coderabbitai autofix` for review
findings or `@coderabbitai fix-ci commit` for failing checks. Requests are
serialized and recorded in bot-authored PR comments. At most three repair
requests are allowed per PR. A request that produces no new head within one
hour stops for attention. Each new head reruns checks and review. Conflicts and
unsupported fixes remain blocked. Clean branches behind main are updated with
the event-producing merge token, never a force push.

Changes to workflows, review configuration, permissions and test policy need a
human maintainer's exact-head acknowledgement. The gate does not silently
approve its own policy changes. Forks need manual handling; no privileged
workflow executes PR code. The controller is loaded only from the default
branch, even while reviewing a PR that changes it.

Auto-merge uses only `AUTO_MERGE_TOKEN`; an absent/expired token is an error,
not a fallback that suppresses deployment events. Native protection independently
requires CI, CodeQL, Review gate, resolved conversations and an up-to-date head.
The target protection is one ruleset, no bypass actors, squash-only linear main.

Existing CD is preserved: eligible main pushes deploy, production verification
precedes release publication, and releasable Conventional Commit titles produce
release notes. Docs-only changes do not deploy; non-releasable changes do not
create a release. Local main is not refreshed when the eventual merge happens.

Rollout must not require a default-branch controller before it exists. Use
stronger native protection (completed CodeRabbit status, CodeQL and one fresh
approving review) to gate bootstrap, then activate the custom protection.
Never forge a passing Review gate to bypass the bootstrap dependency.
