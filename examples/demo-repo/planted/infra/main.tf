terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "vpc_id" {
  type        = string
  description = "The VPC the shop API runs in."
}

resource "aws_security_group" "api" {
  name        = "shop-api"
  description = "Traffic to the shop API hosts"
  vpc_id      = var.vpc_id

  ingress {
    description = "SSH from the office"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    # Open while the office VPN is down.
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTPS to the package mirrors"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

variable "subnet_id" {
  type        = string
  description = "The private subnet the shop API hosts run in."
}

resource "aws_network_interface" "api" {
  description     = "The shop API host's interface"
  subnet_id       = var.subnet_id
  security_groups = [aws_security_group.api.id]
}
