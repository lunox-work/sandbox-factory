# Secrets. Terraform creates the containers, never the values: no credential is
# a Terraform variable, so none reaches terraform.tfstate, a plan output, or
# this public repository.
#
# `make secrets-push` (scripts/secrets-push.sh) pushes values from a local
# .env.production. Rotation is an AWS-side operation that Terraform neither
# sees nor overwrites. DATABASE_URL is included: Neon lives outside AWS, so its
# connection string is a credential like any other.

locals {
  # Each key becomes one secret, injected into the task as the environment
  # variable of the same name.
  app_secrets = {
    DATABASE_URL            = "Neon Postgres connection string. Must include ?sslmode=require"
    BETTER_AUTH_SECRET      = "Signing secret for session tokens. openssl rand -base64 32"
    GOOGLE_CLIENT_ID        = "Google OAuth client ID"
    GOOGLE_CLIENT_SECRET    = "Google OAuth client secret"
    GITHUB_CLIENT_ID        = "GitHub OAuth client ID"
    GITHUB_CLIENT_SECRET    = "GitHub OAuth client secret"
    ATLASSIAN_CLIENT_ID     = "Atlassian OAuth client ID (sign-in app)"
    ATLASSIAN_CLIENT_SECRET = "Atlassian OAuth client secret (sign-in app)"
    # A second Atlassian 3LO app, for connecting a client's Jira site. Separate
    # from the sign-in one because a grant is per app and a new grant overwrites
    # the previous one's scopes, so sharing an app would make signing in and
    # connecting Jira break each other.
    JIRA_CLIENT_ID     = "Atlassian OAuth client ID (Jira connection app)"
    JIRA_CLIENT_SECRET = "Atlassian OAuth client secret (Jira connection app)"
    # The GitHub App, for connecting a client's repositories. Not the sign-in
    # OAuth app above: that one only says who someone is. All six or none;
    # with any left as the placeholder the GitHub routes stay unmounted.
    GITHUB_APP_ID             = "GitHub App ID (numeric, from the App's settings page)"
    GITHUB_APP_SLUG           = "GitHub App slug, as in github.com/apps/<slug>"
    GITHUB_APP_PRIVATE_KEY    = "GitHub App private key: base64 of the PEM GitHub generates"
    GITHUB_APP_WEBHOOK_SECRET = "GitHub App webhook secret. openssl rand -hex 32"
    GITHUB_APP_CLIENT_ID      = "GitHub App client ID (the App's own OAuth half)"
    GITHUB_APP_CLIENT_SECRET  = "GitHub App client secret (the App's own OAuth half)"
    # Encrypts the tokens in `jira_connection` and `github_grant`. Rotating
    # it means re-encrypting both tables' rows, not just replacing the value:
    # each has a `key_id` column recording which key wrote the row, so both
    # keys can be readable at once.
    TOKEN_ENCRYPTION_KEY = "AES-256 key for stored Jira tokens. openssl rand -base64 32"
    ANTHROPIC_API_KEY    = "Anthropic API key for optional Jira sizing"
    SIZING_MODEL         = "Explicit Anthropic model identifier for Jira sizing"
    # The sizing fallback. Answers when an Anthropic call fails, or serves
    # sizing alone when the pair above is unset.
    DEEPSEEK_API_KEY      = "DeepSeek API key for the Jira sizing fallback"
    DEEPSEEK_SIZING_MODEL = "Explicit DeepSeek model identifier for Jira sizing"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name        = "${local.name}/${lower(replace(each.key, "_", "-"))}"
  description = each.value

  # The shortest recovery window AWS allows; 0 deletes immediately with no
  # way back. After a destroy the name stays reserved for these seven days.
  recovery_window_in_days = 7
}

# A placeholder version, written once so the secret is never empty. Keep this
# resource after creation rather than removing it: removal would schedule the
# *secret* for deletion.
resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.app_secrets

  secret_id = aws_secretsmanager_secret.app[each.key].id
  # Deliberately invalid: apps/api/src/env.ts validates each of these at boot,
  # so the task crash-loops with a readable Zod error until real values arrive
  # rather than serving a sign-in that fails later.
  secret_string = "REPLACE_ME"

  lifecycle {
    # Load-bearing: without it every apply would reset the real credentials
    # to the placeholder above.
    ignore_changes = [secret_string]
  }
}
