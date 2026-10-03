// The real modules a test runs in a separate process, bundled by bundle.ts:
// lock races, state write overlap and an activation stopped part way need
// two processes or a process that can be killed.
export { withLock } from "../src/agents/record.js";
export { activate, reconcile } from "../src/update/activate.js";
export { readState, updateState } from "../src/update/state.js";
export { takeLock } from "../src/agents/lock.js";
