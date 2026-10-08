class ModMail < ApplicationRecord
  has_many :mod_mail_references
  has_many :comment_references, through: :mod_mail_references, source: :reference, source_type: "Comment"
  has_many :notifications, class_name: "Noticed::Notification"
end
