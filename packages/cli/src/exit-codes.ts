// Exit codes for the whole CLI.
// 0: clean, or warnings only.
// 1: a finding at or above the block threshold.
// 2: the tool itself failed (usage, config, not a git repo, internal error).
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_TOOL_FAILED = 2;
