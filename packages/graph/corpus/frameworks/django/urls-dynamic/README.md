# Django: computed routes, includes and views

Guards against guessing: a route built with an f-string, an include of a computed module name, a view that is the result of a call and a test request to a computed path are each reported as a gap with cause `dynamic`; the registrations stay listed, with no pattern or no handler, and nothing is bound by a guess.
