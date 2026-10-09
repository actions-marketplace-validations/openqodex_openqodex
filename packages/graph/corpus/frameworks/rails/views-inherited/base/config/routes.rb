Rails.application.routes.draw do
  resources :nodes, only: :index
  resources :posts, only: :index
end
