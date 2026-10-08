module Api
  class DeprecatedController < ApplicationController
    def index
      head :not_found
    end
  end
end
