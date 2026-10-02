Asset name lists of the latest release of each repo, saved 2026-10-02 with:
  gh api repos/<owner>/<repo>/releases/latest --jq '{repo: "<owner>/<repo>", tag: .tag_name, assets: [.assets[].name]}'
Unchanged output. The asset matcher test reads only the names.
