class AddBodyToPosts < ActiveRecord::Migration[7.1]
  def change
    add_column :posts, :body, :string
  end
end
