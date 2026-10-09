Rails.application.routes.draw do
  resources :posts, only: [:index, :show, :create, :destroy]
  get "/search", to: "search#index", as: :search
end
