variable "region" {
  type        = string
  description = "AWS region for the shop stack"
  default     = "eu-west-1"
}

variable "environment" {
  type        = string
  description = "Name of the environment, such as staging or production"
}
