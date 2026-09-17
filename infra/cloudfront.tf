# CloudFront.
#
# One distribution, one hostname, two origins — which is what makes the whole
# design work. apps/web/nginx.conf and the Vite dev proxy both put the API under
# /api on the same origin as the SPA, and the comments there say why: so cookie
# and CORS behaviour never differ between development and production. Serving
# both from platform.lunox.work reproduces that shape exactly, with no
# cross-subdomain cookie and no CORS preflight on any request.

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
  # North America and Europe. PriceClass_All adds South America, Asia-Pacific
  # and Africa edges at a higher per-GB rate; worth revisiting once traffic
  # shows where users actually are.
  price_class = "PriceClass_100"

  # ---- origins -------------------------------------------------------------

  origin {
    origin_id                = "s3-web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id = "alb-api"
    # Maintained by the origin-dns function in discovery.tf, which points it at
    # the running task's public IP on every task state change.
    domain_name = local.origin_record

    custom_origin_config {
      http_port  = var.api_port
      https_port = 443
      # HTTP to the origin. Viewers always reach CloudFront over HTTPS — the
      # viewer_protocol_policy below redirects them — but this hop is plain
      # HTTP because terminating TLS on the task would mean shipping a
      # certificate inside the container and changing server.ts to serve it.
      # The trade is deliberate: it keeps the application code untouched, and
      # the hop it exposes runs inside AWS between CloudFront and an EC2-hosted
      # task. Put the ALB back (or move to a Function URL) when this is not an
      # acceptable trade.
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    # What actually protects the origin now that no listener rule does. The
    # task's port is open to the internet because CloudFront publishes no stable
    # IP range to pin; this header is the thing that distinguishes a CDN request
    # from a stranger who resolved the discovery record.
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
    # immutable and can be cached hard; index.html is handled by the ordered
    # behaviour below.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # index.html must never be cached at the edge, or a deploy leaves browsers
  # holding a document that references asset hashes that no longer exist. The
  # nginx config this replaces made the same distinction with Cache-Control.
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

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Nothing authenticated may be cached, and every header, cookie and query
    # string has to reach the origin intact — Better Auth reads the session
    # cookie, and the OAuth callback carries its state in the query string.
    #
    # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader. The Host
    # exception matters: forwarding the viewer's Host would break the ALB's
    # certificate matching.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # /health and /version are unauthenticated and cheap, but CD polls /version
  # to confirm a deploy landed — a cached answer would report the previous
  # build and either pass a failed deploy or fail a good one.
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
  # try_files $uri $uri/ /index.html, in CloudFront terms. A deep link to
  # /settings is not an object in the bucket, and S3 answers 403 through an OAC
  # rather than 404 — so both are rewritten to the app shell, which then routes
  # client-side. 200, not 302, so the URL the user typed survives.

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
# The record you asked for. An A-record alias rather than a CNAME, because the
# zone apex convention aside, an alias costs nothing to resolve and Route53
# charges for CNAME queries.
#
# This ADDS platform.lunox.work to the zone. Nothing here touches the MX, TXT or
# DKIM records that carry your Zoho mail.

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
