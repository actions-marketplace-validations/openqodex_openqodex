class PublishJob < ApplicationJob
  queue_as :default

  def perform(post_id)
    @id = post_id
  end
end
