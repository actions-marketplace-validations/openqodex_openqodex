RSpec.describe "Blog", type: :request do
  it "shows a blog post through the mount" do
    get "/blog/posts/1"
  end
end
