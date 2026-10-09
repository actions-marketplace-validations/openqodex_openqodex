Rails.application.routes.draw do
  namespace :api do
    resources :old_nodes, only: :show
  end
end
