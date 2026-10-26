Box returns its class type parameter.
Repo arguments bind find through one or two result calls.
A second parameter verifies argument positions.
Raw boxes and external lists provide no result type.
Wildcard arguments and method parameter shadowing must not bind Repo.find.
Subclass receivers cannot supply the declaring class's parameter arguments.
SBox and P<Other> leave find unresolved and record no miss. Both calls truly reach Repo.find, so that edge is not forbidden; an edge to Other.find would be a wrong guess and stays forbidden.
