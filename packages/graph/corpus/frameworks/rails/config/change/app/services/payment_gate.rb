class PaymentGate
  def self.open?
    Rails.application.config.x.payments.enabled && !ENV["PAYMENTS_KEY"]
  end

  def region
    Rails.configuration.x.region
  end
end
