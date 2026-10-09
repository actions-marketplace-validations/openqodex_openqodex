resources :users, only: :index
get "stats", to: "dashboard#stats"
