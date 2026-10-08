class User < ApplicationRecord
  has_many :votes
  has_many :voted_stories, through: :votes, source: :story
  has_many :ghosts, through: :votes
end
