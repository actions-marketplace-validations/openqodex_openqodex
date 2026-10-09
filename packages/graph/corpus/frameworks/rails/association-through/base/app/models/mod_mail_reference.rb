class ModMailReference < ApplicationRecord
  belongs_to :mod_mail
  belongs_to :reference, polymorphic: true
end
