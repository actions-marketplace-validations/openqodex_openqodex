# Rails: computed values become gaps, never edges

Guards against a guessed route, template, table, class, config key or request. A route path built with interpolation, computed `only:`, a computed `scope path:`, a lambda handler and computed `via:` each keep their registration (pattern null where the path is computed, the handler "dynamic" for the lambda) and add a gap with cause "dynamic". A computed `render`, a lambda `before_action`, a computed `self.table_name`, a computed `class_name:`, a computed `create_table` name, `ENV[key]` and a test request to a computed path are gaps too.
