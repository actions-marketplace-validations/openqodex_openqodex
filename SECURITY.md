# Security policy

## Report a vulnerability

Report it privately through GitHub: open the Security tab of this repository and choose "Report a vulnerability". GitHub calls this private vulnerability reporting.

Never report a vulnerability in a public issue, a discussion or a pull request.

A useful report holds:

- the OpenQodex version (`openqodex --version`) and your system;
- the steps that show the problem;
- what an attacker gains.

The maintainers answer in the private report and fix the problem there. The release that fixes it comes with an advisory.

## Supported versions

OpenQodex is on the way to 1.0. Only the newest release gets security fixes.

## Scope

In scope: the `openqodex` package, the skill, the Claude Code plugin, the GitHub Action and the pre-commit hook in this repository.

Out of scope: a vulnerability in a scanner itself. Report it to that scanner's project. `NOTICE` links to each one.

`docs/security.md` explains what OpenQodex runs, what it sends where, and the trust step for custom scanners.
