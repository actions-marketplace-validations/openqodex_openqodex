class ApplicationController < ActionController::Base
  def respond_to_timeout
    render action: "timeout"
  end

  def nothing
    render :nothing_here
  end
end
