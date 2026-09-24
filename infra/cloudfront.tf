# CloudFront. One distribution, one hostname, two origins: the SPA from S3 and
# the API under /api. Same-origin matches apps/web/nginx.conf and the Vite dev
# proxy, so cookie and CORS behaviour never differs between development and
# production.

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} — ${var.domain_name}"
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  # North America and Europe edges only. Revisit once traffic shows where
  # users are.
  price_class = "PriceClass_100"

  # ---- origins -------------------------------------------------------------

  origin {
    origin_id                = "s3-web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id = "alb-api"
    # The origin id is historical; there is no ALB. The origin-dns function in
    # discovery.tf keeps this record pointed at the running task's public IP.
    domain_name = local.origin_record

    custom_origin_config {
      http_port  = var.api_port
      https_port = 443
      # Plain HTTP to the origin, deliberately: terminating TLS on the task
      # would mean shipping a certificate in the container and changing
      # server.ts. Viewers always get HTTPS (viewer_protocol_policy below). A
      # load balancer is the fix when this trade stops being acceptable.
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    # What protects the origin. The task's port is open to the internet (see
    # security-groups.tf); this header is how the API tells a CDN request from
    # a stranger who resolved the origin record.
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  # ---- default behaviour: the SPA ------------------------------------------

  default_cache_behavior {
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingOptimized. Vite emits hashed filenames, so assets are
    # immutable; index.html is handled by the ordered behaviour below.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # index.html must never be cached at the edge, or a deploy leaves browsers
  # holding a document that references asset hashes that no longer exist.
  ordered_cache_behavior {
    path_pattern           = "/index.html"
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingDisabled.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  }

  # ---- api behaviour -------------------------------------------------------

  # Avatars, cached at the edge. Declared before `/api/*` so it wins. The URL
  # names the picture by its hash and the API marks it immutable, so a cached
  # copy can never be stale; the route needs no session, so nothing from the
  # viewer is forwarded. The origin still sees X-Origin-Verify, which is an
  # origin header rather than a viewer one.
  ordered_cache_behavior {
    path_pattern           = "/api/avatars/*"
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    # Already compressed: WebP gains nothing from gzip.
    compress = false

    # Managed-CachingOptimized.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Nothing authenticated may be cached, and every header, cookie and query
    # string must reach the origin: Better Auth reads the session cookie, and
    # the OAuth callback carries its state in the query string.
    #
    # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # /version and /health must never be cached: CD polls /version to confirm a
  # deploy landed, and the uptime probe in monitoring.tf reads /health.
  ordered_cache_behavior {
    path_pattern           = "/version"
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  ordered_cache_behavior {
    path_pattern           = "/health"
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # ---- SPA routing ---------------------------------------------------------
  #
  # nginx's `try_files $uri /index.html`, in CloudFront terms. A deep link such
  # as /settings is not an object in the bucket, and S3 behind an OAC answers
  # 403 rather than 404, so both are rewritten to the app shell. 200, not 302,
  # so the typed URL survives.

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-cdn" }
}

# ---- DNS -------------------------------------------------------------------
#
# Alias records, not a CNAME: Route53 does not charge for alias queries. These
# add platform.lunox.work to the zone and touch none of the MX, TXT or DKIM
# records that carry live Zoho mail.

resource "aws_route53_record" "platform_a" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "platform_aaaa" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
