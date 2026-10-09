import "./global-setup.js";
import "../../packages/scanners/test/adapters.subprocess.test.js";
// The nine scanners of the catalog: workflows and SQL, infrastructure files,
// Kubernetes and Rust dependencies.
import "../../packages/scanners/test/adapters-workflow-sql.subprocess.test.js";
import "../../packages/scanners/test/adapters-iac.subprocess.test.js";
import "../../packages/scanners/test/adapters-kube-rust.subprocess.test.js";
// What ruff and SQLFluff read from files other tools share (pyproject.toml,
// setup.cfg), by meaning.
import "../../packages/scanners/test/settings-shared.subprocess.test.js";
// What a scanner may be handed: no link out of the repository, no module,
// crate or settings file outside it.
import "../../packages/scanners/test/inputs-boundary.subprocess.test.js";
// Two server runs at once, each in its own scratch root, reading one
// install root; and strict preinstall of every scanner with its check case.
import "../../packages/scanners/test/server-roots.subprocess.test.js";
import "../../packages/scanners/test/preinstall.subprocess.test.js";
