# GitHub Apps and repository setup

What is installed beyond the workflows, what it takes to reproduce this
setup on a new repository, and how the product's own GitHub App is
registered.

## CodeRabbit

The only third-party GitHub App. Installed at the **`lunox-work` organization**
level with `repository_selection: selected`, so adding another repository means
adding it to the existing installation, not installing the app again.

CodeRabbit is an advisory reviewer. It comments on every PR, but merging waits
only for CI; see [ci.md](./ci.md#branch-protection).

[.coderabbit.yaml](../.coderabbit.yaml) enables incremental automatic review
without title exclusions or auto-pause, a `CodeRabbit` commit status, autofix
and CI repair. Generated output and the lockfile remain excluded from review
content.

Enabling autofix only makes it available; nothing requests it automatically.
Ask with `@coderabbitai autofix` on the PR, or `@coderabbitai fix-ci commit`
for a CI repair.

Review and finishing-touch entitlements depend on the installed CodeRabbit
plan. In particular, `fix-ci` requires Team-level access. If a command is
unavailable or declined, nothing is fixed; configuration alone does not
grant that capability.

## Dependabot

A native GitHub feature, enabled by
[`.github/dependabot.yml`](../.github/dependabot.yml). Nothing to install. See
[ci.md](./ci.md) for its configuration.

## The Sandbox Factory App (the product's own)

Not a tool this repository uses, but the App the product asks clients to
install, so the platform can read which repositories exist and where their
default branches point. Registered under the **`lunox-work` organization**
(Settings → Developer settings → GitHub Apps → New GitHub App). How the code
uses it is in [architecture.md](./architecture.md#github).

It is **not** the sign-in OAuth app (`GITHUB_CLIENT_ID` / `_SECRET`), which is
a plain OAuth app asking for `read:user user:email`. Keep the two apart: the
App's client id and secret are `GITHUB_APP_CLIENT_ID` / `_SECRET`.

| Setting                                                | Value                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Homepage URL                                           | `https://platform.lunox.work`                                                            |
| Callback URL                                           | `https://platform.lunox.work/api/v1/github/callback`                                     |
| Expire user authorization tokens                       | **On**                                                                                   |
| Request user authorization (OAuth) during installation | **On**                                                                                   |
| Setup URL                                              | the callback URL again, if the form allows one (see below)                               |
| Redirect on update                                     | **On**                                                                                   |
| Webhook → Active                                       | On                                                                                       |
| Webhook URL                                            | `https://platform.lunox.work/api/github/webhook`                                         |
| Webhook secret                                         | `openssl rand -hex 32` → `GITHUB_APP_WEBHOOK_SECRET`                                     |
| Repository permissions                                 | Contents: **Read**, Metadata: **Read**; nothing else                                     |
| Organization and account permissions                   | none                                                                                     |
| Subscribe to events                                    | Push, Repository (Installation and Installation repositories arrive without subscribing) |
| Where can this GitHub App be installed?                | Any account                                                                              |

Why the less obvious ones:

- **User authorization during installation must be on.** A callback's
  `installation_id` is a small integer anyone can type, so the API links an
  installation only when it appears in the person's own
  `GET /user/installations`, and then only when it is theirs: their own
  personal account, or an organization's installation covering nothing they
  cannot read themselves. Without the user token there is nothing to check.
- **No organization permissions, on purpose.** Members: read would let the
  API check that the person administers an organization instead of the
  repository count above, at the cost of every client approving one more
  permission. Adding it later means a new permission request on every
  installation.
- **Redirect on update is on**, so changing the repository selection on
  GitHub's settings page also comes back to us (`setup_action=update`) and
  the stored selection is refreshed. GitHub's form may grey out the Setup URL
  once user authorization during installation is on; it then returns to the
  Callback URL instead, which is the same route, so nothing is lost. The
  webhook's `installation_repositories` event refreshes the selection too.
- **The callback lives under `/api/v1`, the webhook does not.** The callback
  needs the person's session; GitHub has none, so the webhook sits outside
  the session guard and is authenticated by its signature. Both reach the API
  through CloudFront like every other `/api/*` call.

Then, from the App's page:

1. Note the **App ID** → `GITHUB_APP_ID`, and the slug from
   `github.com/apps/<slug>` → `GITHUB_APP_SLUG`.
2. **Generate a client secret** → `GITHUB_APP_CLIENT_SECRET`; the client id
   beside it → `GITHUB_APP_CLIENT_ID`.
3. **Generate a private key.** Store base64 of the PEM, on one line:
   `base64 < <app>.private-key.pem | tr -d '\n'` → `GITHUB_APP_PRIVATE_KEY`.
   The API parses it at boot, so a mangled key fails the deploy, not the first
   connect.
4. Put all six in `.env.production` and `make secrets-push`. They are optional
   as a set: with any of them unset or left as `REPLACE_ME`, the GitHub routes
   and the webhook are not mounted and everything else is served.

Rotating any of them: `scripts/rotate-token.sh` carries a hint per key.

### Local development

A webhook URL can point at one place only, so local development uses a
**second App** registered the same way except:

- Callback URL and Setup URL: `http://localhost:4000/api/v1/github/callback`.
- **Webhook: not active.** `localhost` is unreachable from GitHub, and the
  reconcile sweep reads every registered repository at least every fifteen
  minutes anyway, so a local head moves without deliveries — just not within
  seconds. The handlers themselves are covered by unit tests against recorded
  payloads (`apps/api/test/github-webhook.test.ts`), which is the part that
  must not depend on a tunnel.
- For seconds-fast local deliveries, activate the webhook and point it at a
  tunnel to `http://localhost:4000/api/github/webhook` (any HTTPS tunnel will
  do). `gh webhook forward` is not enough on its own: it forwards repository
  events for a repository you own, but installation events come only from the
  App's own webhook.

Put the dev App's six values in `.env.development`; `make up` passes them to
the API container.

## Settings that are not in any file

These will **not** come along if you copy the files into a new repository:

| Setting                   | Current value                 | Where                       |
| ------------------------- | ----------------------------- | --------------------------- |
| Visibility                | Public                        | Settings → General          |
| Default branch            | `main`                        | Settings → Branches         |
| Delete branch on merge    | Enabled                       | Settings → General          |
| Ruleset "main protection" | Active — see [ci.md](./ci.md) | Settings → Rules → Rulesets |
| Classic branch protection | Removed after ruleset rollout | Settings → Branches         |
| `AUTO_MERGE_TOKEN` secret | Fine-grained PAT              | Settings → Secrets          |
| Discussions               | **Disabled**                  | Settings → General          |

Visibility matters: CodeQL and Scorecard are gated on the repository being
public, CodeRabbit's free tier requires it, and code scanning upload needs
Advanced Security.

Discussions is off, and
[`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml) does
not link to it. If you enable it later, add the contact link back at the same
time — a link to a disabled tab 404s.

## Labels

Beyond the defaults: `dependencies`, `github_actions`, `javascript` (from
Dependabot); `ci`, `tests`, `source`, `documentation` (labeler); and `accessibility`. The two
`autorelease:` labels are left over from release-please and unused.

The labeler cannot create labels — it holds `pull-requests: write`, not
`issues: write` — so create a label by hand before referencing it in
`labeler.yml`.

## Reproducing this setup

1. Copy the repository contents. Replace `sandbox-factory` with the new name and
   the owner in every URL — `lunox-work` owns the repo, `@feversoul` is the
   maintainer named in `.github/CODEOWNERS`, `package.json`'s `author`, and the
   README copyright.
2. Replace the contact address in `SECURITY.md`.
3. Make the repository public, or expect CodeQL and Scorecard to skip and
   CodeRabbit to need a paid plan.
4. Create the `main protection` ruleset with its required checks, _after_ the
   first CI run so the check names exist to select from. Add the
   `AUTO_MERGE_TOKEN` secret — see [scripts/README.md](../scripts/README.md).
5. Add the repository to the org's CodeRabbit installation.
6. Enable "Automatically delete head branches".
7. Leave Discussions off, or enable it and add a contact link back to
   `.github/ISSUE_TEMPLATE/config.yml`.
8. Decide whether you want npm publishing. Nothing publishes today.
