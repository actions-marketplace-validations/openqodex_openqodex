// The checked writer lives in the core package (packages/core/src/guarded-fs.ts),
// so the repository's .openqodex files go through it too. Every write,
// rename and delete of init, the update worker, the home receipts and the
// update state goes through it; test/guarded-writes.test.ts checks.
export { Guard, homeGuard, type Roots } from "@openqodex/core";
