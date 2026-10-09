require "rails_helper"

RSpec.describe PostsController, type: :controller do
  it "renders the index" do
    get :index
  end
end
