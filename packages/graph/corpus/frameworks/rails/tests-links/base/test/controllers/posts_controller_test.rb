class PostsControllerTest < ActionController::TestCase
  test "shows" do
    get :show, params: { id: 1 }
  end
end
