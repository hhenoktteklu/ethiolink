# EthioLink — admin frontend module outputs.
#
# Consumed by:
#   * Cognito wiring — the CloudFront domain is one of the
#     `admin_callback_urls` registered on the user pool. Without
#     the URL in the allow-list, Cognito's hosted UI rejects the
#     OAuth redirect.
#   * S3 + API Gateway CORS — same URL must appear in
#     `admin_allowed_origins` so browser fetches succeed.
#   * Operator surfaces — `admin_url` is the link operators visit
#     to use the dashboard.

output "bucket_name" {
  description = "Name of the private S3 bucket holding the admin SPA artifacts."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the admin frontend S3 bucket."
  value       = aws_s3_bucket.this.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id. Required for `aws cloudfront create-invalidation` after a deploy."
  value       = aws_cloudfront_distribution.this.id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN. Useful for WAF association in the future `waf` module commit."
  value       = aws_cloudfront_distribution.this.arn
}

output "cloudfront_domain_name" {
  description = "CloudFront-assigned domain name (`<id>.cloudfront.net`). Operators hit this URL directly in dev; in prod the custom alias is preferred but this remains the canonical origin name."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "admin_url" {
  description = "Full `https://...` URL operators visit to use the admin dashboard. Returns the custom domain when configured, the CloudFront-assigned domain otherwise."
  value       = var.custom_domain != "" && var.acm_certificate_arn != "" ? "https://${var.custom_domain}" : "https://${aws_cloudfront_distribution.this.domain_name}"
}
