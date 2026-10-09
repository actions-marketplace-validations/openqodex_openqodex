RSpec.describe "Dynamic", type: :request do
  it "requests a computed path" do
    get path_for_the_test
  end
end
