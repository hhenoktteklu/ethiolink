# EthioLink — KMS module inputs.
#
# Phase 9 Track 4 — provisions one customer-managed KMS key + alias
# per consuming service. The module is intentionally narrow: it
# only creates keys + aliases + key policies. Wiring those keys
# into the existing RDS / S3 / Secrets / Lambda resources happens
# in a follow-up commit so each step is reviewable independently.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Threaded into key aliases (`alias/ethiolink-<environment>-<service>`) and resource tags so a CloudTrail log query can attribute key usage back to a single env."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment + service to form alias names (`alias/<name_prefix>-<environment>-<service>`)."
  type        = string
  default     = "ethiolink"
}

variable "deletion_window_in_days" {
  description = "Pending-deletion window applied when a key is scheduled for deletion. AWS minimum is 7, maximum 30. We default to 30 in prod-leaning envs (longer recovery window) and lean on the env stack to override to 7 in dev for faster teardown of throwaway stacks. Note: this is the WAIT period AFTER `terraform destroy` calls `ScheduleKeyDeletion`; during the window the key is recoverable via `CancelKeyDeletion`."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_in_days >= 7 && var.deletion_window_in_days <= 30
    error_message = "deletion_window_in_days must be between 7 and 30 (AWS-enforced bounds)."
  }
}

variable "enable_key_rotation" {
  description = "Whether AWS-managed annual key rotation is enabled on every key in this module. Defaults to `true` and should stay there — disabling rotation forfeits the main operational benefit of customer-managed keys vs. AWS-managed ones. The knob exists only so an operator can flip it off temporarily during a key-policy debug session without ripping the module out."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags applied to every key in this module on top of the provider's `default_tags`. Useful for `cost-center` / `compliance-tier` / `data-classification` annotations that an org-wide cost or audit tool slices on."
  type        = map(string)
  default     = {}
}
