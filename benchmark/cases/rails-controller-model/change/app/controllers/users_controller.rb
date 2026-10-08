class UsersController < ApplicationController
  before_action :require_admin, except: [:index, :show, :profile, :destroy]

  def index
    users = User.order(:email).limit(50)
    users = users.where("email LIKE '%#{params[:q]}%'") if params[:q].present?
    render json: users.as_json(only: [:id, :email])
  end

  def show
    render json: User.find(params[:id]).as_json(only: [:id, :email])
  end

  # Each user edits their own profile.
  def profile
    @current_user.update!(params.require(:user).permit!)
    render json: @current_user.as_json(only: [:id, :email])
  end

  def destroy
    User.find(params[:id]).destroy!
    head :no_content
  end
end
