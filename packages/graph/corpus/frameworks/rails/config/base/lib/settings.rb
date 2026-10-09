class Settings
  def config
    @config
  end

  def read
    config.x.payments.enabled
  end

  def write
    config.x.payments.enabled = 1
  end
end
