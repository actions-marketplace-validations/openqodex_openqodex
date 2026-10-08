class User < ApplicationRecord
  validates :email, presence: true, uniqueness: true

  after_save :send_welcome_email

  private

  def send_welcome_email
    UserMailer.welcome(self).deliver_later
  end
end
