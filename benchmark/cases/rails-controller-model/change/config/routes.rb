Rails.application.routes.draw do
  resources :users, only: [:index, :show, :destroy]
  patch "profile", to: "users#profile"
end
