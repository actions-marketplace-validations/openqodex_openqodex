import { defineConfig } from "vitest/config";

// End-to-end tests run the built CLI as a real subprocess. Build first.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
