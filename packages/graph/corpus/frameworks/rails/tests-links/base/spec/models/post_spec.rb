require "rails_helper"

RSpec.describe Post do
  it "measures the title" do
    Post.new.title_length
  end
end
