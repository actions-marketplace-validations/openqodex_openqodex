<!-- openqodex:start -->
## Review with OpenQodex
- When a feature or fix is done, and before any push, review it with the openqodex skill: "review my change with openqodex".
- OpenQodex starts its own reviewer process for the review: the agent that wrote the code does not judge its own work.
- After the review, show the developer the receipt with the path of `report.html`, ask "Fix all, or tell me which?", and fix only the findings they name.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
