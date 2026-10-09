require "test_helper"

class SearchTest < ActionDispatch::IntegrationTest
  test "searches" do
    get search_url
  end
end
