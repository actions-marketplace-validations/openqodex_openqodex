class PostsController < ApplicationController
  def index
  end

  def show
    @shown = true
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
end
