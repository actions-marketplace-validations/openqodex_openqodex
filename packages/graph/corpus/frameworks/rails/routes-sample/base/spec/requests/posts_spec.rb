require "rails_helper"

RSpec.describe "Posts", type: :request do
  it "shows a post" do
    get "/posts/1"
    expect(response).to have_http_status(:ok)
  end
end
