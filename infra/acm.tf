# TLS certificate.
#
# One, in us-east-1, because that is the only region CloudFront reads a
# certificate from — a hard service requirement, not a preference. It is free.
#
# There is no second certificate for the origin: CloudFront reaches the task
# over HTTP (see cloudfront.tf), so nothing there terminates TLS. Viewers still
# get HTTPS, terminated at the edge with this certificate.
#
# Validation is DNS, via Route53. The records are added to the existing
# lunox.work zone — which also carries live Zoho MX and DKIM records, so every
# record here is an addition and nothing in this file replaces a record set.

# ---- CloudFront certificate (us-east-1) ------------------------------------

resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cloudfront_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # The same validation CNAME satisfies both certificates when the regions
  # coincide; without this the second apply collides with the first's record.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_validation : r.fqdn]
}
