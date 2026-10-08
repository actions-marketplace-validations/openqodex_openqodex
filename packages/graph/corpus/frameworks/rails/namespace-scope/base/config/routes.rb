Rails.application.routes.draw do
  namespace :admin do
    resources :users, only: [:index, :show]
    root "dashboard#index"
    get "stats", to: "dashboard#stats"
  end
  scope "/v1", module: "api", as: "v1" do
    get "status", to: "health#show"
    resources :items, only: :index
  end
  scope module: "public" do
    get "help", to: "help#index"
  end
  controller :pages do
    get "about"
  end
  get "legal/terms"
end
