class UsersController < ApplicationController
  before_action :require_admin, except: [:index, :show]

  def index
    render json: User.order(:email).limit(50).as_json(only: [:id, :email])
  end

  def show
    render json: User.find(params[:id]).as_json(only: [:id, :email])
  end
end
