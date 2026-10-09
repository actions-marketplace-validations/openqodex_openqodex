Rails.application.routes.draw do
  scope controller: "api/deprecated", action: "index" do
    get "api_key"
    put "api_key/reset"
    post "gems"
    scope path: "gems/:rubygem_id" do
      put "migrate"
    end
    get "own", action: "own"
  end
  scope defaults: { controller: "pages", action: "home" } do
    get "welcome"
  end
  controller :pages do
    get "about"
    get "faq", to: "help#faq"
  end
end
