class PostsController < ApplicationController
  before_action -> { authenticate }

  def index
  end

  def show
    render template_name_for(params)
  end
end
