resource "aws_db_subnet_group" "orders" {
  name       = "shop-orders-${var.environment}"
  subnet_ids = [aws_subnet.private.id, aws_subnet.private_b.id]
}

resource "aws_db_instance" "orders" {
  identifier              = "shop-orders-${var.environment}"
  engine                  = "postgres"
  engine_version          = "16.4"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 50
  db_name                 = "orders"
  username                = "shop"
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.orders.name
  vpc_security_group_ids  = [aws_security_group.app.id]
  publicly_accessible     = true
  storage_encrypted       = true
  backup_retention_period = 7
  deletion_protection     = true
  skip_final_snapshot     = false
}
