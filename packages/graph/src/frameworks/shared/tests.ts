// The test mapper's shared part: once a plugin has said which symbols and
// files are tests, every call a test makes into code that is not a test
// becomes a `tests` edge of category "direct-call", with the call's own
// evidence and tier. A static call is a reference, never proof that the
// test ran the code.
import { TIER_RANK } from "../../model/records.js";
import type { FrameworkEdge, PluginIndex, RoleAssignment } from "../plugin.js";

export const TEST_CALL_RULE = { id: "test-direct-call", version: 1 };

export function deriveTestCalls(plugin: string, roles: readonly RoleAssignment[], index: PluginIndex): FrameworkEdge[] {
  const tests = roles.filter((r) => r.role === "test");
  const testIds = new Set(tests.map((r) => r.target));
  const testFiles = new Set(tests.filter((r) => !r.target.includes("#")).map((r) => r.target));
  const callers = new Map<string, string | null>(); // caller id to its application
  // The symbols of a file by each owner path their id starts with
  // (`file#Owner.` for `file#Owner.method@...` and `file#Owner.Inner.m@...`),
  // built once per file, so a file of many test classes reads its symbols once.
  const byOwner = new Map<string, Map<string, string[]>>();
  const membersOf = (file: string, owner: string): string[] => {
    let m = byOwner.get(file);
    if (!m) {
      m = new Map();
      for (const s of index.symbols(file)) {
        const hash = s.id.indexOf("#");
        const at = s.id.lastIndexOf("@");
        const inner = s.id.slice(hash + 1, at > hash ? at : undefined);
        for (let dot = inner.indexOf("."); dot !== -1; dot = inner.indexOf(".", dot + 1)) {
          const key = inner.slice(0, dot);
          (m.get(key) ?? m.set(key, []).get(key))?.push(s.id);
        }
      }
      byOwner.set(file, m);
    }
    return m.get(owner) ?? [];
  };
  for (const r of tests) {
    callers.set(r.target, r.app);
    const node = index.node(r.target);
    // A test class: its methods are the callers.
    if (node && node.kind === "class") for (const id of membersOf(node.file, node.name)) if (!callers.has(id)) callers.set(id, r.app);
  }
  const out: FrameworkEdge[] = [];
  const seen = new Set<string>();
  for (const [from, app] of callers) {
    for (const e of index.callsFrom(from)) {
      const target = index.node(e.to);
      if (!target || testIds.has(e.to) || testFiles.has(target.file)) continue;
      const key = `${from}\0${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const site = [...e.sites].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      if (!site) continue;
      out.push({
        from,
        to: e.to,
        kind: "tests",
        plugin,
        app,
        category: "direct-call",
        evidence: {
          kind: "test-direct-call",
          tier: site.tier,
          site: { file: site.file, line: site.line, column: site.column },
          via: site.via,
          premises: [],
          rule: TEST_CALL_RULE,
          note: site.tier === "certain" ? null : (site.note ?? `the test's call is ${site.tier}, not proved`),
        },
      });
    }
  }
  return out;
}
