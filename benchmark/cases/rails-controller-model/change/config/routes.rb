Rails.application.routes.draw do
  resources :users, only: [:index, :show, :update, :destroy]
end
