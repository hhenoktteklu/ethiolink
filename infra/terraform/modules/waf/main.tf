# EthioLink — WAF module.
#
# Regional WAFv2 Web ACL sitting in front of the API Gateway
# stage. Managed rule groups + three rate-based rules layered
# from tightest-and-narrowest to widest-and-loosest.
# CloudWatch metrics + sampled requests are enabled on the ACL
# itself and on every rule so the `cloudwatch` module can
# attach alarms / dashboards without re-creating the ACL.
#
# Scope:
#   `REGIONAL` because API Gateway REST APIs are regional. A
#   CloudFront-fronted ACL would need `CLOUDFRONT` scope and live
#   in `us-east-1`; the admin SPA distribution doesn't get WAF
#   in this module (low-traffic, low-priority — operators are
#   the only audience). Adding it later is a separate Web ACL +
#   association in a follow-up commit.
#
# Managed rule groups (existing, kept identical to Phase 7):
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
#   operator has two knobs:
#     1. Drop the whole group by flipping the matching
#        `enable_*` variable to `false`.
#     2. Force one specific sub-rule to `COUNT` (observability
#        only, no block) via the per-group
#        `*_count_overrides` list — see "rule_action_override"
#        below.
#
# Phase 8 rate-based rule layering (new):
#   The Phase 7 baseline shipped a single 2000-req/5-min/IP
#   guard. That number is generous for legitimate clients but
#   permissive for two distinct abuse profiles we want to catch
#   earlier:
#
#     * Scrape of the public marketplace listing — anonymous
#       readers hammering `GET /v1/categories` or
#       `GET /v1/businesses[/...]` to slurp the catalog. These
#       endpoints are unauthenticated by design, so per-IP
#       rate-limiting is the only knob; we set it tighter so
#       a scraper trips the limit well before saturating the
#       Lambdas.
#
#     * Booking-write abuse — a malicious customer (or, more
#       likely, a misbehaving client) firing `POST
#       /v1/appointments` or any other write at high rate.
#       Authenticated, but Cognito-token cost is low enough
#       that auth alone isn't the rate limiter; we add a
#       per-IP cap on non-GET methods.
#
#   Layer order (lower priority = evaluated first):
#     50 → rate-limit-public-read   (tightest, scope-down on
#                                    path = /v1/categories or
#                                    /v1/businesses AND method
#                                    = GET)
#     60 → rate-limit-write         (next tightest, scope-down
#                                    on method != GET)
#     70 → rate-limit-per-ip        (existing global fallback,
#                                    no scope-down — every
#                                    request counts)
#
#   Each rule maintains its own per-IP counter; they're
#   independent. A request that violates the global rule but
#   not the scope-down rules trips priority 70 only. A request
#   that violates the public-read rule but not the others
#   trips priority 50 only. All three block on match with a
#   `block {}` action returning 403 to the offending IP for the
#   standard WAFv2 5-minute window. Tuning each threshold via
#   its `rate_limit_*` variable does not require a module
#   change.
#
# Bot Control (off by default):
#   `AWSManagedRulesBotControlRuleSet` is the next-step bot
#   defense beyond IP reputation — it inspects JA3/JA4
#   fingerprints + behavioral signals to classify clients.
#   Useful but priced per-request, so we gate it behind
#   `enable_bot_control = false` and ship it in a follow-up
#   that has real traffic numbers to justify the cost.
#
# Default action:
#   `allow {}` — anything not matched by the rules above passes
#   through. This is the standard "allow except matched" posture
#   for a baseline WAF; the alternative (default deny + explicit
#   allow-list) is a post-MVP hardening choice.
#
# WCU budget:
#   AWS caps every Web ACL at 1500 WCUs. With every managed
#   group enabled (CommonRuleSet 700 + KnownBadInputs 200 + IP
#   reputation 25 = 925) plus the three rate-based rules
#   (~5 each base + ~15 per scope-down statement = ~50) we sit
#   well under 1000 WCUs and have headroom for Bot Control
#   (50 base, up to 500 with all sub-rules) without
#   refactoring. The `web_acl_capacity` output surfaces the
#   live number for operator visibility.

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

          # Operator-configurable per-sub-rule action overrides.
          # Each entry forces the named sub-rule to `COUNT`
          # rather than letting the managed group block. Useful
          # mid-incident to keep observability on a noisy rule
          # without taking the block hit (e.g. when
          # `SizeRestrictions_BODY` false-positives a large
          # legitimate POST). Default empty list = no overrides.
          dynamic "rule_action_override" {
            for_each = toset(var.common_rule_set_count_overrides)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
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

          dynamic "rule_action_override" {
            for_each = toset(var.known_bad_inputs_count_overrides)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
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

          dynamic "rule_action_override" {
            for_each = toset(var.ip_reputation_count_overrides)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
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
  # Managed rule: AWSManagedRulesBotControlRuleSet (off by default).
  #
  # Behavioral bot detection beyond IP reputation. Disabled by
  # default — Bot Control is priced per-request and the MVP
  # traffic profile doesn't yet justify the cost. Operators flip
  # `enable_bot_control = true` once a real load profile shows
  # a residual bot share the existing rules don't catch.
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.enable_bot_control ? [1] : []

    content {
      name     = "AWS-AWSManagedRulesBotControlRuleSet"
      priority = 40

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesBotControlRuleSet"
          vendor_name = "AWS"

          # AWS exposes Bot Control's inspection level on the
          # `managed_rule_group_configs` block. `COMMON` (the
          # default) covers JA3 / common bot families and is
          # ~50 WCUs; `TARGETED` adds challenge actions and is
          # ~500 WCUs. We default to COMMON to stay well under
          # the 1500-WCU ACL ceiling.
          managed_rule_group_configs {
            aws_managed_rules_bot_control_rule_set {
              inspection_level = var.bot_control_inspection_level
            }
          }

          dynamic "rule_action_override" {
            for_each = toset(var.bot_control_count_overrides)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-bot-control"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Rate-based rule — public-read scrape guard.
  #
  # Tightest of the three rate-based rules. Counts only requests
  # with method=GET that target the public marketplace listing
  # paths (`/v1/categories*` or `/v1/businesses*`). Trips on
  # `rate_limit_public_read_per_5min` per source IP (default 600
  # — ~2 req/sec sustained). Generous for a real human browsing
  # the catalog, restrictive for a scraper. Skipped entirely
  # when the variable is null.
  #
  # The path match uses `CONTAINS` rather than `STARTS_WITH`
  # because API Gateway prefixes the stage name (`/dev/v1/...`,
  # `/prod/v1/...`). Containment match avoids per-env regex
  # without sacrificing precision — the only places `/v1/`
  # appears are at the API Gateway root.
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.rate_limit_public_read_per_5min != null ? [1] : []

    content {
      name     = "rate-limit-public-read"
      priority = 50

      action {
        block {}
      }

      statement {
        rate_based_statement {
          limit              = var.rate_limit_public_read_per_5min
          aggregate_key_type = "IP"

          scope_down_statement {
            and_statement {
              statement {
                byte_match_statement {
                  search_string         = "GET"
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    method {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }

              statement {
                or_statement {
                  statement {
                    byte_match_statement {
                      search_string         = "/v1/categories"
                      positional_constraint = "CONTAINS"
                      field_to_match {
                        uri_path {}
                      }
                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }

                  statement {
                    byte_match_statement {
                      search_string         = "/v1/businesses"
                      positional_constraint = "CONTAINS"
                      field_to_match {
                        uri_path {}
                      }
                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-rate-limit-public-read"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Rate-based rule — write-method guard.
  #
  # Counts only non-GET requests (POST, PATCH, PUT, DELETE).
  # Trips on `rate_limit_write_per_5min` per source IP (default
  # 300). Most legitimate clients hit a write a few times per
  # session; a tighter cap catches booking-write abuse + login
  # brute-force attempts without affecting normal traffic.
  # Skipped entirely when the variable is null.
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = var.rate_limit_write_per_5min != null ? [1] : []

    content {
      name     = "rate-limit-write"
      priority = 60

      action {
        block {}
      }

      statement {
        rate_based_statement {
          limit              = var.rate_limit_write_per_5min
          aggregate_key_type = "IP"

          scope_down_statement {
            not_statement {
              statement {
                byte_match_statement {
                  search_string         = "GET"
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    method {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.base_name}-rate-limit-write"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Rate-based rule — per source IP (existing global fallback).
  #
  # No scope-down. Every request counts. Catches volumetric
  # abuse that flies under the tighter scope-down rules above
  # (e.g. a botnet spreading writes thin enough to dodge the
  # write rule but hammering enough total endpoints to add up).
  # Priority 70 keeps it the last-evaluated rule among the
  # rate-based set.
  # ---------------------------------------------------------------------------
  rule {
    name     = "rate-limit-per-ip"
    priority = 70

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
