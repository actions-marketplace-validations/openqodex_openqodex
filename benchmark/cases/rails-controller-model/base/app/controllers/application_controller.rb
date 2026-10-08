class ApplicationController < ActionController::API
  before_action :authenticate!

  private

  def authenticate!
    @current_user = User.find_by(api_token: request.headers["X-Api-Token"])
    head :unauthorized unless @current_user
  end

  def require_admin
    head :forbidden unless @current_user&.admin?
  end
end
