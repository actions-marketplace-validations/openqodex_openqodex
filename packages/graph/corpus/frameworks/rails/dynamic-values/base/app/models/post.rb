class Post < ApplicationRecord
  self.table_name = TABLE
  has_many :things, class_name: thing_class
end
