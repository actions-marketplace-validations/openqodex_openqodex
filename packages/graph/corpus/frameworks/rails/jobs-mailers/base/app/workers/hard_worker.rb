class HardWorker
  include Sidekiq::Job

  def perform(n)
    @n = n
  end
end
