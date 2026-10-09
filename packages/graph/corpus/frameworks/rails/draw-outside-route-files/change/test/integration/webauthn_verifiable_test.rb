require "test_helper"

class WebauthnVerifiableTest < ActionDispatch::IntegrationTest
  setup do
    Rails.application.routes.draw do
      get "webauthn_test", to: "webauthn_test#prompt"
    end
  end

  test "prompts" do
    get "/webauthn_test?x=1"
  end
end
