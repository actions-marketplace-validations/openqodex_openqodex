class ApiClient
  include HTTParty

  def posts
    get "/posts?page=1"
    get "/x", to: "posts#index"
  end

  def self.routes
    resources :posts
  end
end
