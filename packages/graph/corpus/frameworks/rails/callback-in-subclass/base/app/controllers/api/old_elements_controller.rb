module Api
  class OldElementsController < ApplicationController
    before_action :lookup_old_element
    before_action :nowhere

    def show
      @shown = true
    end
  end
end
