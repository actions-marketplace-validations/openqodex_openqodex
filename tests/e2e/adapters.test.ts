import "./global-setup.js";
import "../../packages/scanners/test/adapters.subprocess.test.js";
// The nine scanners of the catalog: workflows and SQL, infrastructure files,
// Kubernetes and Rust dependencies.
import "../../packages/scanners/test/adapters-workflow-sql.subprocess.test.js";
import "../../packages/scanners/test/adapters-iac.subprocess.test.js";
import "../../packages/scanners/test/adapters-kube-rust.subprocess.test.js";
