# Rails: only route files are route tables

Guards against reading a routes draw block anywhere as the application's routes. A test that redraws `Rails.application.routes` in its setup (test/integration/webauthn_verifiable_test.rb) declares no route of the application, and a file outside config/ with route calls at its top (lib/top.rb) declares none either. The route tables are config/routes.rb and the files under config/routes/ that it loads with `draw(:name)`: `draw(:admin)` inside `namespace :admin` reads config/routes/admin.rb under the namespace's path, name and module.
