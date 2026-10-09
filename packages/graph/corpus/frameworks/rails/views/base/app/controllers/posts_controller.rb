class PostsController < ApplicationController
  def index
  end

  def show
    render "posts/detail"
  end

  def edit
    render :form_page
  end

  def preview
    render partial: "card"
    render partial: "shared/footer"
  end

  def legacy
    render "missing/template"
  end

  def summary
    render template: "reports/summary"
  end

  def card
    render Posts::CardComponent.new(post: 1)
  end

  def gone
    render GoneComponent.new
  end
end
