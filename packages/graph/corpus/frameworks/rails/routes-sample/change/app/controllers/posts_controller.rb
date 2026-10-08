class PostsController < ApplicationController
  before_action :set_post, only: %i[show edit update destroy]

  def index
    @posts = Post.all
  end

  def show
    @title = @post.title.upcase
  end

  def new
    @post = Post.new
  end

  def create
    @post = Post.new
    redirect_to post_path(@post)
  end

  def edit
  end

  def update
    redirect_to post_path(@post)
  end

  def destroy
    redirect_to posts_path
  end

  private

  def set_post
    @post = Post.find(params[:id])
  end
end
