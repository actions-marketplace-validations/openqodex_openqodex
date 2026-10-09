class Post < ApplicationRecord
  belongs_to :author, class_name: "User"
  has_many :comments, dependent: :destroy
  has_and_belongs_to_many :tags
  has_one :cover_image

  def summary
    title.to_s[0, 20]
  end
end
