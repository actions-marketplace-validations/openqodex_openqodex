module Shop
  class Application < Rails::Application
    config.x.payments.enabled = true
    config.time_zone = "UTC"
  end
end
