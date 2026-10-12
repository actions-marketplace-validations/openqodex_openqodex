---
"openqodex": patch
---

- On Windows, `openqodex review` failed with `EINVAL: invalid argument, mkdir 'F:\F:'` before it could save a report. The checked writer walked every path from `\` and took the drive letter for a folder name. It now walks from the path's own root, such as `F:\`, and takes either slash between names.
- A lens file saved with Windows line ends (`\r\n`) failed to parse with "lens file is missing YAML frontmatter". It now parses the same as one with `\n`.
- On Windows, `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set to a full path such as `C:\Users\me\.claude` was taken as relative and put under the current folder. It is now taken as given.
