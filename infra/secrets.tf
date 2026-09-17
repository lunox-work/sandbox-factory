# Secrets.
#
# The rule: Terraform creates the containers, never the values. No credential is
# a Terraform variable, so none appears in terraform.tfstate, in a plan output,
# or in this public repository.
#
# Values are pushed once by `make secrets-push` (scripts/secrets-push.sh), which
# reads a local .env.production. Rotating one afterwards is an AWS-side
# operation that Terraform neither sees nor overwrites.
#
# DATABASE_URL is in this list now. Under the RDS design Terraform generated the
# password and wrote the connection string itself; with Neon the database lives
# outside AWS, so its connection string is a credential like any other and
# arrives the same way.

locals {
  # Each key becomes one secret, injected into the task as the environment
  # variable of the same name. Adding a provider later is two lines here.
  app_secrets = {
    DATABASE_URL            = "Neon Postgres connection string. Must include ?sslmode=require"
    BETTER_AUTH_SECRET      = "Signing secret for session tokens. openssl rand -base64 32"
    GOOGLE_CLIENT_ID        = "Google OAuth client ID"
    GOOGLE_CLIENT_SECRET    = "Google OAuth client secret"
    GITHUB_CLIENT_ID        = "GitHub OAuth client ID"
    GITHUB_CLIENT_SECRET    = "GitHub OAuth client secret"
    ATLASSIAN_CLIENT_ID     = "Atlassian OAuth client ID"
    ATLASSIAN_CLIENT_SECRET = "Atlassian OAuth client secret"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name        = "${local.name}/${lower(replace(each.key, "_", "-"))}"
  description = each.value

  # Zero would make the name unavailable for reuse after a destroy, turning a
  # rebuild into a week's wait. Seven days is the shortest window AWS allows.
  recovery_window_in_days = 7
}

# The placeholder version, written once so the secret is never empty.
#
# `ignore_changes` on the value is what lets `make secrets-push` replace it
# without the next apply reverting the real credential. The lifecycle block also
# carries `ignore_changes` alone rather than the resource being removed after
# creation, because removing it would schedule the *secret* for deletion.
resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.app_secrets

  secret_id = aws_secretsmanager_secret.app[each.key].id
  # Deliberately invalid. apps/api/src/env.ts validates every one of these at
  # boot — DATABASE_URL non-empty, BETTER_AUTH_SECRET at 32+ characters, each
  # OAuth field non-empty — so the task crash-loops with a readable Zod error
  # until real values arrive, rather than serving a sign-in that fails later.
  secret_string = "REPLACE_ME"

  lifecycle {
    # The line that makes this work: without it, every apply would reset your
    # real credentials back to the placeholder above.
    ignore_changes = [secret_string]
  }
}
