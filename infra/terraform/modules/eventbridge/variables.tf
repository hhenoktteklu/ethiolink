# EthioLink — EventBridge module inputs.
#
# Wires the scheduled-send-reminders Lambda to a 15-minute cron.
# Single rule per environment; the Lambda is the only target.
#
# Timezone:
#   The cron is evaluated in UTC by EventBridge (no `Etc/UTC` vs
#   local-time toggle here). The Lambda handler does its own
#   `Africa/Addis_Ababa` timezone math for the reminder-window
#   arithmetic, so this module doesn't need to know about
#   timezones at all.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in the rule name and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form the rule name like \"ethiolink-dev-reminders\"."
  type        = string
  default     = "ethiolink"
}

variable "scheduled_reminders_function_name" {
  description = "Name of the Lambda the rule invokes. Sourced from `module.lambda.scheduled_reminders_function_name`."
  type        = string
}

variable "scheduled_reminders_function_arn" {
  description = "ARN of the Lambda the rule invokes. Sourced from `module.lambda.scheduled_reminders_function_arn`. Used as the rule target."
  type        = string
}

variable "schedule_expression" {
  description = "EventBridge schedule expression. Default `cron(0/15 * * * ? *)` (every 15 minutes in UTC, starting at minute 0). Matches the Lambda's window arithmetic — two consecutive runs scan adjacent 15-min slices without overlap."
  type        = string
  default     = "cron(0/15 * * * ? *)"
}

variable "enabled" {
  description = "Whether the rule is active. `true` in both dev and prod by default; the operator can flip this to `false` for env-level temporary disable without removing the resource (e.g. while debugging a stuck reminder batch)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
