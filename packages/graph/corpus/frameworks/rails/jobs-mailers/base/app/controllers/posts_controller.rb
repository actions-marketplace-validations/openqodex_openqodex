class PostsController < ApplicationController
  def create
    PublishJob.perform_later(1)
    PublishJob.set(wait: 5).perform_later(2)
    HardWorker.perform_async(3)
    UserMailer.welcome(current_user).deliver_later
    UserMailer.with(user: current_user).welcome.deliver_now
    MissingJob.perform_later
    Notifier.perform_later
  end
end
