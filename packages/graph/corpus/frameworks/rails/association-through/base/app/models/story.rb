class Story < ApplicationRecord
  has_many :votes
  has_many :voters, -> { where(vote: 1) }, through: :votes, source: :user
  has_many :tags, through: :taggings
  has_many :taggings
end
