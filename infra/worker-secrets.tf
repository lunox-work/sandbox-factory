# The worker's own secrets, apart from secrets.tf: every parameter there is
# injected into the API task and kept in step with the push and rotation
# scripts, and the API never needs these. Each is created with a placeholder
# and filled by hand (apps/worker/README.md, Deployment order).

locals {
  worker_secrets = {
    # The isolated evaluation provider (apps/worker/src/evaluation/e2b.ts).
    # The worker refuses to start with EVALUATION_PROVIDER=e2b while this is
    # still the placeholder.
    E2B_API_KEY = "E2B API key for the worker's evaluation sandboxes"
  }
}

resource "aws_ssm_parameter" "worker" {
  for_each = local.worker_secrets

  name        = "/${local.name}/${lower(replace(each.key, "_", "-"))}"
  description = each.value
  type        = "SecureString"
  tier        = "Standard"

  # A placeholder, as in secrets.tf: the value never passes through Terraform.
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}
