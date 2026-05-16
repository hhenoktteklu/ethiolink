# EthioLink — EventBridge module.
#
# Three resources per environment:
#
#   * `aws_cloudwatch_event_rule.send_reminders` — schedule rule
#     firing every 15 minutes (UTC). The Lambda handler does its
#     own Africa/Addis_Ababa timezone math for the window
#     arithmetic, so the rule's UTC schedule is correct as-is.
#   * `aws_cloudwatch_event_target.send_reminders` — points the
#     rule at the `scheduled-send-reminders` Lambda.
#   * `aws_lambda_permission.allow_eventbridge` — grants the
#     EventBridge service principal `lambda:InvokeFunction` rights
#     on the Lambda, scoped to this specific rule ARN. Without it,
#     the rule fires but the invocation 403s.
#
# Out of scope here:
#   - CloudWatch alarm on `FailedInvocations` — lands in the
#     cloudwatch module commit alongside the rest of the alarms.
#   - DLQ for failed invocations — also a CloudWatch / SNS
#     follow-up.
#
# Disabling:
#   Setting `enabled = false` flips the rule to `DISABLED` state
#   without removing the resource. Useful when an operator wants
#   to halt reminder dispatch for a single environment while
#   debugging — flipping the flag in Terraform is reversible and
#   leaves no orphaned permission to clean up.

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
  base_name = "${var.name_prefix}-${var.environment}"
  rule_name = "${local.base_name}-reminders"

  common_tags = merge(
    {
      Component = "eventbridge"
      Module    = "eventbridge"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Schedule rule
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "send_reminders" {
  name                = local.rule_name
  description         = "EthioLink ${var.environment} 24h-ahead reminder dispatcher. Fires every 15 minutes; the Lambda scans `[now + 23h45m, now + 24h00m)` per `PHASE_6_NOTIFICATIONS.md`."
  schedule_expression = var.schedule_expression
  state               = var.enabled ? "ENABLED" : "DISABLED"

  tags = merge(local.common_tags, {
    Name = local.rule_name
  })
}

# -----------------------------------------------------------------------------
# Target — point the rule at the scheduled-send-reminders Lambda.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_event_target" "send_reminders" {
  rule      = aws_cloudwatch_event_rule.send_reminders.name
  target_id = "${local.rule_name}-target"
  arn       = var.scheduled_reminders_function_arn

  # No `input` / `input_transformer` — the Lambda's `ScheduledEvent`
  # handler doesn't read anything from the payload. EventBridge
  # passes the standard event envelope (`source = "aws.events"`,
  # `resources = [<rule arn>]`).
}

# -----------------------------------------------------------------------------
# Permission — let EventBridge invoke the Lambda.
# -----------------------------------------------------------------------------

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke-${var.environment}"
  action        = "lambda:InvokeFunction"
  function_name = var.scheduled_reminders_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.send_reminders.arn
}

# -----------------------------------------------------------------------------
# Phase 9 Track 6 — paid featuring sweep rule (15-minute cron).
#
# Only created when `var.featuring_sweep_function_name` is set —
# env stacks that have not yet wired the featuring Lambda set the
# var to "" and this block creates nothing.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "featuring_sweep" {
  count = var.featuring_sweep_function_name == "" ? 0 : 1

  name                = "${local.base_name}-featuring-sweep"
  description         = "EthioLink ${var.environment} paid-featuring sweep. Fires every 15 minutes; expires ACTIVE rows past ends_at, GCs PENDING_PAYMENT rows past the 10-minute TTL, and recomputes business_profiles.featured_until."
  schedule_expression = var.featuring_sweep_schedule_expression
  state               = var.featuring_sweep_enabled ? "ENABLED" : "DISABLED"

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-featuring-sweep"
  })
}

resource "aws_cloudwatch_event_target" "featuring_sweep" {
  count = var.featuring_sweep_function_name == "" ? 0 : 1

  rule      = aws_cloudwatch_event_rule.featuring_sweep[0].name
  target_id = "${local.base_name}-featuring-sweep-target"
  arn       = var.featuring_sweep_function_arn
}

resource "aws_lambda_permission" "allow_eventbridge_featuring_sweep" {
  count = var.featuring_sweep_function_name == "" ? 0 : 1

  statement_id  = "AllowEventBridgeInvokeFeaturingSweep-${var.environment}"
  action        = "lambda:InvokeFunction"
  function_name = var.featuring_sweep_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.featuring_sweep[0].arn
}
