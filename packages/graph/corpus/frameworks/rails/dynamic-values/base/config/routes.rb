Rails.application.routes.draw do
  get "/p/#{PREFIX}", to: "posts#show"
  resources :posts, only: ALLOWED
  scope path: base_path do
    get "inner", to: "posts#index"
  end
  get "/x", to: ->(env) { [200, {}, ["ok"]] }
  match "/m", to: "posts#index", via: VERBS
end
