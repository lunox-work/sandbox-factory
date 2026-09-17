# Container registry for the API image.

resource "aws_ecr_repository" "api" {
  name = "${local.name}-api"

  # Deploys push a tag named for the commit SHA. Immutable, so a rollback to
  # :abc123 gets the same image the verification step approved.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Storage is $0.10/GB-month. Ten images is several deploys' worth of rollback
# headroom.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
