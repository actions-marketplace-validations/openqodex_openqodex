A and B declare defaults with the same name and parameter count. B extends A.
Calls on C must bind only to B, regardless of the implements order.
Leaf overrides A through Bridge. Calls on Transitive must bind only to Leaf.
Two unrelated defaults must stay possible. The diamond is a syntax fixture, not valid Java.
A class override and a superclass method must keep winning zero-argument calls.
Defaults with different parameter counts must remain available.
The existing java-inherited-overload case guards class overloads with the same count and different parameter types.
B2 redeclares m and n as abstract. Both implements orders must bind only to these abstract declarations.
Neither A default may run at these sites. There are no concrete implementations to list as dispatch candidates.
