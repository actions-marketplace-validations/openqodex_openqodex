Blog::Engine.routes.draw do
  resources :posts, only: [:index, :show]
end
