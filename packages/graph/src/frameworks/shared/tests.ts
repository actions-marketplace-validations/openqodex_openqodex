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
  for (const r of tests) {
    callers.set(r.target, r.app);
    const node = index.node(r.target);
    // A test class: its methods are the callers.
    if (node && node.kind === "class") {
      const prefix = `${node.file}#${node.name}.`;
      for (const s of index.symbols(node.file)) if (s.id.startsWith(prefix) && !callers.has(s.id)) callers.set(s.id, r.app);
    }
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
