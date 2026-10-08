# Django: two applications with the same route

Guards against merging applications: two projects in one repository each register `health/`. Each registration belongs to its own application, and a change to the first project's view lists only the first project's route.
