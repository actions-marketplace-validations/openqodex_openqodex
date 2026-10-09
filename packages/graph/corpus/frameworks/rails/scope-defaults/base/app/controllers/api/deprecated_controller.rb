module Api
  class DeprecatedController < ApplicationController
    def index
      head :gone
    end
  end
end
