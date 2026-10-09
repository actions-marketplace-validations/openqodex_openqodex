class CreatePosts < ActiveRecord::Migration[7.1]
  def change
    create_table :posts do |t|
      t.string :title
      t.references :author
      t.timestamps
    end
    add_index :posts, :title
  end
end
