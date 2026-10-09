import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // benchmark/test: the review benchmark's generator and scorer (no reviewer runs there).
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "benchmark/test/**/*.test.mjs"],
    // The real-binary adapter checks need every scanner installed; the
    // end-to-end config runs them.
    exclude: ["**/node_modules/**", "packages/scanners/test/adapters.subprocess.test.ts"],
    passWithNoTests: true,
    // Every temp folder a test makes is removed by its file; the run fails
    // when one is left (tests/temp-guard.ts).
    globalSetup: ["tests/temp-guard.ts"],
    // Many tests start the real CLI and git several times; a busy CI runner
    // takes more than the 5 second default for those.
    testTimeout: 30_000,
    // A setup step that makes a disk image or a git repo also needs room
    // there, and so does a file's last step, which removes every home and
    // runtime copy its tests made (a minute and more on a busy machine).
    hookTimeout: 300_000,
  },
});
