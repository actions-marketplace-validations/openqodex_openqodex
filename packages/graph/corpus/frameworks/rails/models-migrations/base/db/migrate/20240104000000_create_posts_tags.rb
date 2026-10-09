class CreatePostsTags < ActiveRecord::Migration[7.1]
  def change
    create_join_table :posts, :tags
  end
end
