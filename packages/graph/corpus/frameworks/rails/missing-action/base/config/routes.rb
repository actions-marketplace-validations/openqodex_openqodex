Rails.application.routes.draw do
  resources :posts, only: [:index, :destroy]
end
