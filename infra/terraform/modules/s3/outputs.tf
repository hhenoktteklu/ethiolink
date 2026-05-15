# EthioLink — S3 module outputs.
#
# Consumed by:
#   * `lambda` module — passes the two media-bucket names through
#     to every media-touching Lambda's environment
#     (`S3_BUCKET_MEDIA_PUBLIC`, `S3_BUCKET_MEDIA_PRIVATE`).
#   * `cloudwatch` module — the `target_prefix` per bucket is the
#     hint a future S3 access-log dashboard / metric filter
#     consumes.
#   * Manual operator surfaces — `aws s3 ls s3://<bucket>` for
#     smoke testing presigned uploads.

output "media_public_bucket_name" {
  description = "Name of the public media bucket. Maps to the `S3_BUCKET_MEDIA_PUBLIC` Lambda env var consumed by `S3StorageGateway`."
  value       = aws_s3_bucket.media_public.id
}

output "media_public_bucket_arn" {
  description = "ARN of the public media bucket. Useful for IAM policy scoping on the Lambda execution role."
  value       = aws_s3_bucket.media_public.arn
}

output "media_public_bucket_regional_domain_name" {
  description = "Regional domain name (`<bucket>.s3.<region>.amazonaws.com`). Useful when a future CloudFront distribution wants to use a virtual-hosted origin without the legacy path-style URL."
  value       = aws_s3_bucket.media_public.bucket_regional_domain_name
}

output "media_private_bucket_name" {
  description = "Name of the private media bucket. Maps to the `S3_BUCKET_MEDIA_PRIVATE` Lambda env var."
  value       = aws_s3_bucket.media_private.id
}

output "media_private_bucket_arn" {
  description = "ARN of the private media bucket. Useful for IAM policy scoping."
  value       = aws_s3_bucket.media_private.arn
}

output "logs_bucket_name" {
  description = "Name of the logs bucket. Server access logs from both media buckets land here under per-bucket prefixes."
  value       = aws_s3_bucket.logs.id
}

output "logs_bucket_arn" {
  description = "ARN of the logs bucket. Future audit-log writers reference this."
  value       = aws_s3_bucket.logs.arn
}
