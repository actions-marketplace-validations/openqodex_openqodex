Rails.application.routes.draw do
  resources :posts, only: :index
  namespace :admin do
    draw(:admin)
  end
end
