Rails.application.routes.draw do
  resources :articles, only: [:index, :show] do
    resources :comments, except: %i[destroy edit update]
    member do
      post :publish
    end
    collection do
      get :search
    end
    get :preview, on: :member
  end
  resource :profile, except: :destroy
  resources :photos, as: "images", path: "pictures", only: :show
  resources :tags, only: []
  resources :people, only: [:index, :show]
end
