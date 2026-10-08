import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // benchmark/test: the review benchmark's generator and scorer (no reviewer runs there).
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "benchmark/test/**/*.test.mjs"],
    // The real-binary adapter checks need every scanner installed; the
    // end-to-end config runs them.
    exclude: ["**/node_modules/**", "packages/scanners/test/adapters.subprocess.test.ts"],
    passWithNoTests: true,
    // Many tests start the real CLI and git several times; a busy CI runner
    // takes more than the 5 second default for those.
    testTimeout: 30_000,
    // A setup step that makes a disk image or a git repo also needs room there.
    hookTimeout: 60_000,
  },
});
