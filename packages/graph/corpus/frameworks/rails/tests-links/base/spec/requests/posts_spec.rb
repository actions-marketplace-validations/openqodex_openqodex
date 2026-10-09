require "rails_helper"

RSpec.describe "Posts API", type: :request do
  it "lists posts" do
    get "/posts"
  end

  it "shows a post as JSON" do
    get "/posts/1.json?full=1"
  end

  it "creates a post" do
    post posts_path, params: { title: "x" }
  end

  it "deletes a post" do
    delete post_path(1)
  end
end
