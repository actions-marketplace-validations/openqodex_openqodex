# Rails: a routes file without Rails is not an application

Guards against detecting a Rails application from a file that only looks like one. The Gemfile declares sinatra, not rails, so config/routes.rb with a `Rails.application.routes.draw` block and an app/controllers folder make no application, no registration, no handler link and no role.
