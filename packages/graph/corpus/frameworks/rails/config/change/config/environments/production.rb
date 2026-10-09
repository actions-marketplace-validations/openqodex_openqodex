Rails.application.configure do
  config.x.payments.enabled = true
  config.cache_store = :memory_store
end
