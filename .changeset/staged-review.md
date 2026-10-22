---
"openqodex": minor
---

The review runs in stages. Two finder sessions read each changed file with the code around the change, a fresh verifier session checks every candidate, and only confirmed ones become findings. Style, naming, docs and test items are shown as observations, apart from the findings and outside the verdict. `review.stages: false` runs the single pass. Every file in the repository is given the code around the change, whatever its language.
