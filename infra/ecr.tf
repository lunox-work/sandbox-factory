# Container registry for the API image.

resource "aws_ecr_repository" "api" {
  name = "${local.name}-api"

  # Every deploy pushes a tag named for its commit SHA, and those tags must
  # never be reassigned — a rollback that redeploys :abc123 has to get the same
  # image the verification step once approved.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Storage is $0.10/GB-month, so an unpruned registry quietly becomes a line
# item. Ten images is several deploys' worth of rollback headroom.
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
