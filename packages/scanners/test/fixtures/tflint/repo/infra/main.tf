variable "region" {
  type = string
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = "t2.micro"
  tags = {
    Name = "${var.name}"
  }
}

variable "name" {
  type = string
}
