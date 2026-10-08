// The real modules scripts/check-self-update.mjs uses to check a release
// the way the updater does before anything of it runs, bundled by that
// script with esbuild: the registry fetch that stays on registry.npmjs.org,
// the Sigstore verification against this repository's release workflow on
// main, and the unpacking that refuses a link or a path that leaves the folder.
export { fetchAttestations, fetchTarball } from "../src/update/fetch.js";
export { verifyRelease } from "../src/update/verify.js";
export { extractArchive } from "../../scanners/src/toolchain/fetch.js";
