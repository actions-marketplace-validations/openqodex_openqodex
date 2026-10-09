Rails.application.configure do
  config.x.payments.enabled = false
  config.cache_store = :memory_store
end
