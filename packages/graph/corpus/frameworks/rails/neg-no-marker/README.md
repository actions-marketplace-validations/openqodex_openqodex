# Rails: rails in the Gemfile and no application marker

Guards against making an application from a dependency alone. The Gemfile declares rails (a library that builds on it), but there is no config/application.rb, no config/routes.rb and no bin/rails; the draw block lives in lib/my_gem/routes.rb. No application is detected, so nothing is registered, bound, given a role or linked to a test.
