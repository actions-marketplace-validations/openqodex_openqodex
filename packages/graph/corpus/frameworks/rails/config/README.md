# Rails: config keys by name, where they are set and where they are read

Guards against losing which code reads a config key a change sets. `config.x.payments.enabled` is set in config/application.rb and config/environments/production.rb, and read through `Rails.application.config` in `PaymentGate.open?`; `Rails.configuration.x.region`, `ENV["PAYMENTS_KEY"]` and `ENV.fetch("BETA")` are reads too. Keys are recorded by name, never by value. A class of its own with a `config` method (lib/settings.rb) is not Rails' config: its reads and assignments are never linked.
