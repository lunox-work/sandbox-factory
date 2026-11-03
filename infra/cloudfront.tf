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

# The S3 origin's cache policy. One policy serves both kinds of object:
#
#   hashed assets  Cache-Control: public, max-age=31536000, immutable (CD sets
#                  it) — cached at the edge for the year the origin asks for.
#   index.html     Cache-Control: no-cache, must-revalidate — the origin's
#                  no-cache would mean never cached, but min_ttl wins and holds
#                  the shell for 60 s per edge. Browsers still see no-cache and
#                  revalidate with the edge on every open, so a deploy, which
#                  invalidates /index.html and /, reaches them within the
#                  minute. Old chunks stay in the bucket (CD syncs without
#                  --delete), so a shell from that minute still loads.
#
# The alternative, never caching the shell, cost a round trip to us-east-1 on
# every page open: about a second from Asia, a fifth of that from the US.
resource "aws_cloudfront_cache_policy" "web" {
  name    = "${local.name}-web"
  comment = "S3 origin: honour origin headers, hold the shell 60 s"

  min_ttl     = 60
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Extension-less paths serve the app shell; see spa-rewrite.js"
  publish = true
  code    = file("${path.module}/spa-rewrite.js")
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} — ${var.domain_name}"
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  # Every edge: visitors come from everywhere, and the extra per-GB price
  # outside North America and Europe is cents at this traffic. HTTP/3 for
  # faster handshakes on mobile and lossy links.
  price_class  = "PriceClass_All"
  http_version = "http2and3"

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

    # Assets and the shell alike; see aws_cloudfront_cache_policy.web for how
    # one policy gives each the right lifetime. No separate /index.html
    # behaviour: the root request (/ via default_root_object) would not match
    # it, and it is the one that matters.
    cache_policy_id = aws_cloudfront_cache_policy.web.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
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
  # nginx's `try_files $uri /index.html`, in CloudFront terms, as the fallback.
  # spa-rewrite.js turns an extension-less path such as /settings into
  # /index.html before the cache lookup, so these only catch what it lets
  # through: a path with an extension that is not in the bucket. S3 behind an
  # OAC answers 403 rather than 404, so both map to the shell. 200, not 302,
  # so the typed URL survives. Held 60 s per edge like the shell.

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
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
