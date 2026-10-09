Rails.application.routes.draw do
  selected_module = ENV.fetch("AREA", "admin")
  scope module: selected_module do
    get "/x", to: "posts#index"
  end
  get "/y", to: "posts#index"
end
