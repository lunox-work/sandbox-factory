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
    ATLASSIAN_CLIENT_ID     = "Atlassian OAuth client ID"
    ATLASSIAN_CLIENT_SECRET = "Atlassian OAuth client secret"
    # Encrypts the Jira tokens in `jira_connection`. Rotating it means
    # re-encrypting those rows, not just replacing the value: the `key_id`
    # column records which key wrote each row so both can be readable at once.
    TOKEN_ENCRYPTION_KEY = "AES-256 key for stored Jira tokens. openssl rand -base64 32"
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
