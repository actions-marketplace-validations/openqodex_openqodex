import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // The real-binary adapter checks need every scanner installed; the
    // end-to-end config runs them.
    exclude: ["**/node_modules/**", "packages/scanners/test/adapters.subprocess.test.ts"],
    passWithNoTests: true,
  },
});
