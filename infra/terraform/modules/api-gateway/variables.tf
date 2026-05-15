# EthioLink — API Gateway module inputs.
#
# Provisions a single REST API per environment plus per-route
# integrations into the existing Lambda functions. The route list
# is fixed by the module (see `main.tf` `locals.routes`); the
# consumer only passes the Cognito user-pool ARN + the Lambda
# function ARN maps produced by the `lambda` module.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in API name + stage + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form the API name like \"ethiolink-dev-api\"."
  type        = string
  default     = "ethiolink"
}

variable "region" {
  description = "AWS region. Used in the constructed `invoke_url` output."
  type        = string
  default     = "eu-west-1"
}

variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito user pool. Authenticated routes use a `COGNITO_USER_POOLS` authorizer pointed at this pool."
  type        = string
}

variable "lambda_function_arns" {
  description = "Map of logical id → Lambda function ARN. Sourced from `module.lambda.function_arns`. Used to scope the per-route `aws_lambda_permission` source ARN."
  type        = map(string)
}

variable "lambda_function_invoke_arns" {
  description = "Map of logical id → Lambda invoke ARN. Sourced from `module.lambda.function_invoke_arns`. Used as the integration target."
  type        = map(string)
}

variable "lambda_function_names" {
  description = "Map of logical id → Lambda function name. Sourced from `module.lambda.function_names`. Used as the `function_name` field on `aws_lambda_permission`."
  type        = map(string)
}

variable "cors_allowed_origins" {
  description = "Allow-list of origins permitted by the CORS preflight (`OPTIONS`) responses and the 4xx/5xx gateway responses. Mobile clients are native — they don't enforce CORS — but the admin SPA's origin (`http://localhost:5173` in dev, `https://admin.ethiolink.app` in prod) MUST be on this list. Defaults to `[\"*\"]` only when the consumer doesn't pass a value; production should always pass an explicit list."
  type        = list(string)
  default     = ["*"]
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
