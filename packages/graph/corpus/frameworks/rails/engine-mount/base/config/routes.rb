Rails.application.routes.draw do
  mount Blog::Engine => "/blog"
  mount Sidekiq::Web, at: "/sidekiq"
  resources :posts, only: :index
end
