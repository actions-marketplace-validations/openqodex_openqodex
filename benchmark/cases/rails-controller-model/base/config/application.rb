require_relative "boot"

require "rails/all"

Bundler.require(*Rails.groups)

module Directory
  class Application < Rails::Application
    config.load_defaults 8.0
    config.api_only = true
  end
end
