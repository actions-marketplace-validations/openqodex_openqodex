class PostsController < ApplicationController
  def index
  end

  def destroy
    redirect_to posts_path
  end
end
