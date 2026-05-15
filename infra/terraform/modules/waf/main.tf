# EthioLink — WAF module.
#
# Regional WAFv2 Web ACL sitting in front of the API Gateway
# stage. Three AWS-managed rule groups plus a rate-based rule
# scoped per source IP. CloudWatch metrics + sampled requests
# are enabled on the ACL itself and on every rule so the
# (future) `cloudwatch` module can attach alarms / dashboards
# without re-creating the ACL.
#
# Scope:
#   `REGIONAL` because API Gateway REST APIs are regional. A
#   CloudFront-fronted ACL would need `CLOUDFRONT` scope and live
#   in `us-east-1`; the admin SPA distribution doesn't get WAF
#   in this commit (low-traffic, low-priority — operators are
#   the only audience). Adding it later is a separate Web ACL +
#   association in a follow-up commit.
#
# Managed rule groups:
#   * `AWSManagedRulesCommonRuleSet` — OWASP-style baseline
#     (SQLi / XSS / path traversal / etc.).
#   * `AWSManagedRulesKnownBadInputsRuleSet` — known exploit
#     payloads (e.g. log4j signatures, common scanners).
#   * `AWSManagedRulesAmazonIpReputationList` — AWS-maintained
#     IP reputation feed.
#
#   Each is attached with `override_action { none {} }` —
#   meaning we honor the group's own block / count decisions
#   rather than forcing every match to `count`. If a managed
#   rule false-positives a legitimate request mid-incident, the
#   operator toggles the corresponding `enable_*` variable to
#   `false` and re-applies; the change is auditable in git.
#
# Rate-based rule:
#   Threshold defaults to 2000 requests / 5 min / IP. The block
#   action is `BLOCK` — the ACL returns 403 to the offending IP
#   for 5 minutes after the threshold is exceeded. Tune on the
#   first load test once we know what real per-IP rates look
#   like for the mobile + admin clients.
#
# Default action:
#   `allow {}` — anything not matched by the rules above passes
#   through. This is the standard "allow except matched" posture
#   for a baseline WAF; the alternative (default deny + explicit
#   allow-list) is a Phase 8 hardening choice.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  base_name   = "${var.name_prefix}-${var.environment}"
  web_acl_name = "${local.base_name}-api-waf"

  common_tags = merge(
    {
      Component = "waf"
      Module    = "waf"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Web ACL
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "this" {
  name        = local.web_acl_name
  description = "EthioLink ${var.environment} API Gateway protection. Managed rule groups + rate-based per-IP rule."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # ---------------------------------------------------------------------------
  # Managed rule: AWSManagedRulesCommonRuleSet (OWASP baseline)
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.enable_common_rule_set ? [1] : []

    content {
      name     = "AWS-AWSManagedRulesCommonRuleSet"
      priority = 10

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesCommonRuleSet"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-common-rule-set"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Managed rule: AWSManagedRulesKnownBadInputsRuleSet
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.enable_known_bad_inputs ? [1] : []

    content {
      name     = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
      priority = 20

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesKnownBadInputsRuleSet"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-known-bad-inputs"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Managed rule: AWSManagedRulesAmazonIpReputationList
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.enable_ip_reputation ? [1] : []

    content {
      name     = "AWS-AWSManagedRulesAmazonIpReputationList"
      priority = 30

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesAmazonIpReputationList"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-ip-reputation"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Rate-based rule — per source IP.
  # ---------------------------------------------------------------------------
  rule {
    name     = "rate-limit-per-ip"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.base_name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.base_name}-api-waf"
    sampled_requests_enabled   = true
  }

  tags = merge(local.common_tags, {
    Name = local.web_acl_name
  })
}

# -----------------------------------------------------------------------------
# Association — bind the Web ACL to the API Gateway stage.
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "api_gateway" {
  resource_arn = var.api_gateway_stage_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
