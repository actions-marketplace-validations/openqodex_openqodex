// Incremental review: with a previously reviewed commit that the clone proves
// is an ancestor of the head, the review's obligation (the brief, the scan,
// the coverage) is what changed since then, inside the change; findings are
// still anchored and checked on the whole change. Every other case is an
// explicit full review with its reason, and a merge base that cannot be
// proved ends the review as incomplete.
//
// Ways it could fail, written before the code:
//  1. With the previous commit an ancestor, the obligation holds lines that
//     were reviewed before, or misses a line changed since; or the whole
//     change (what findings anchor on) is narrowed too.
//  2. A shallow clone that cannot show the ancestry is reported as diverged,
//     or narrows the review anyway.
//  3. A rewritten branch (the previous commit is not an ancestor) narrows
//     the review, or is reported as unknown history.
//  4. A full review the host asked for is narrowed.
//  5. No previous commit given, and the reason says nothing.
//  6. Lines a merge of the base branch brought in after the previous review
//     become part of the obligation.
//  7. A previous commit the clone does not hold throws or passes as diverged.
//  8. A previous id that is not a commit (a tree, a blob, a short or made up
//     id) narrows the review.
//  9. A merge base that fails a proof (the target branch's tip given, a cut
//     history, a missing commit, not a commit, no repository) does not end
//     the review as incomplete with the proof's own reason.
//  10. The merge base is not recorded as the host's.
//  11. The previous commit equal to the head leaves an obligation.
//  12. The brief's diff of the obligation carries hunks with no line changed
//     since the previous review, or loses one that has.
//  13. The obligation's change id differs from the whole change's, so the
//     brief and the check disagree on which change this is.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decideIncremental, reviewChanges } from "../src/incremental.js";
import { admitted } from "../src/scopes.js";
import { git, write } from "./scope-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const commit = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
};

// main: B. feature: P1 (a.ts line 5, adds c.ts), then P2 (a.ts line 25, b.ts line 3).
function history() {
  const dir = tempDir("oq-inc-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "s/a.ts", lines(40));
  write(dir, "s/b.ts", lines(10));
  const base = commit(dir, "B");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "s/a.ts", lines(40, { 5: "changed before the previous review" }));
  write(dir, "s/c.ts", "export const c = 1;\n");
  const previous = commit(dir, "P1");
  write(dir, "s/a.ts", lines(40, { 5: "changed before the previous review", 25: "changed since the previous review" }));
  write(dir, "s/b.ts", lines(10, { 3: "changed since too" }));
  const head = commit(dir, "P2");
  return { dir, base, previous, head };
}

const all = admitted(undefined, []);

async function changes(dir: string, mergeBaseSha: string, headSha: string, previousReviewedSha?: string, fullReviewRequested?: boolean) {
  const decision = await decideIncremental({ clonePath: dir, mergeBaseSha, headSha, previousReviewedSha, fullReviewRequested });
  if (!decision.ok) throw new Error(decision.reason);
  const got = await reviewChanges({ clonePath: dir, baseRef: "main", mergeBaseSha, headSha, admit: all, exclude: [], decision });
  return { decision, ...got };
}

const sorted = (s: Set<number> | undefined) => [...(s ?? [])].sort((a, b) => a - b);

describe("the obligation of an incremental review", () => {
  it("1, 12 and 13. with the previous commit an ancestor, only what changed since, inside the whole change", async () => {
    const h = history();
    const r = await changes(h.dir, h.base, h.head, h.previous);
    expect(r.decision.scope).toEqual({ kind: "delta", reason: `delta: only what changed since the previously reviewed commit ${h.previous.slice(0, 12)} is reviewed; findings are anchored on the whole change` });
    expect(r.obligation.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(sorted(r.obligation.coverage.get("s/a.ts"))).toEqual([25]);
    expect(sorted(r.obligation.coverage.get("s/b.ts"))).toEqual([3]);
    expect(r.obligation.coverage.has("s/c.ts")).toBe(false);
    // The whole change is untouched: findings anchor on it.
    expect(r.full.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts", "s/c.ts"]);
    expect(sorted(r.full.coverage.get("s/a.ts"))).toEqual([5, 25]);
    expect(r.obligation.id).toBe(r.full.id);
    expect(r.obligation.shortId).toBe(r.full.shortId);
    expect(r.obligation.baseSha).toBe(h.base);
    // The brief's diff: the hunk changed since, not the one reviewed before.
    expect(r.obligation.diff).toContain("+changed since the previous review");
    expect(r.obligation.diff).not.toContain("+changed before the previous review");
    expect(r.obligation.diff).toContain("+changed since too");
    expect(r.obligation.diffs?.map((d) => d.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(r.obligation.stats).toEqual({ files: 2, additions: 2, deletions: 2 });
  });

  it("11. the previous commit equal to the head leaves nothing to review", async () => {
    const h = history();
    const r = await changes(h.dir, h.base, h.head, h.head);
    expect(r.decision.scope.kind).toBe("delta");
    expect(r.obligation.files).toEqual([]);
    expect(r.full.files.length).toBe(3);
  });

  it("6. lines a merge of the base branch brought in after the previous review are not part of it", async () => {
    const h = history();
    git(h.dir, "checkout", "-q", "main");
    write(h.dir, "s/a.ts", lines(40, { 38: "changed on main" }));
    write(h.dir, "s/m.ts", "export const fromMain = 1;\n");
    const mainTip = commit(h.dir, "M");
    git(h.dir, "checkout", "-q", "feature");
    git(h.dir, "merge", "-q", "--no-edit", "main");
    write(h.dir, "s/a.ts", lines(40, { 5: "changed before the previous review", 25: "changed since the previous review", 38: "changed on main", 15: "changed after the merge" }));
    const head = commit(h.dir, "P3");
    // The host's comparison base moved to main's tip with the merge.
    const r = await changes(h.dir, mainTip, head, h.previous);
    expect(r.decision.scope.kind).toBe("delta");
    expect(r.obligation.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(sorted(r.obligation.coverage.get("s/a.ts"))).toEqual([15, 25]);
    expect(r.obligation.diff).not.toContain("fromMain");
    expect(r.obligation.diff).not.toContain("+changed on main");
  });
});

describe("an explicit full review, with its reason", () => {
  it("4. the host asked for one", async () => {
    const h = history();
    const r = await changes(h.dir, h.base, h.head, h.previous, true);
    expect(r.decision.scope).toEqual({ kind: "full", reason: "requested: the host asked for a full review" });
    expect(r.obligation).toBe(r.full);
  });

  it("5. no previous review", async () => {
    const h = history();
    const r = await changes(h.dir, h.base, h.head);
    expect(r.decision.scope).toEqual({ kind: "full", reason: "no previous review: the whole change is reviewed" });
    expect(r.obligation).toBe(r.full);
  });

  it("3. the branch was rewritten: diverged", async () => {
    const h = history();
    git(h.dir, "reset", "-q", "--hard", h.base);
    write(h.dir, "s/a.ts", lines(40, { 7: "rewritten" }));
    const head = commit(h.dir, "rewritten");
    const r = await changes(h.dir, h.base, head, h.previous);
    expect(r.decision.scope.kind).toBe("full");
    expect(r.decision.scope.reason).toMatch(/^diverged: the previously reviewed commit [0-9a-f]{12} is not an ancestor of the head [0-9a-f]{12}/);
  });

  it("2. a shallow clone that cannot show the ancestry: history unknown, not diverged", async () => {
    const h = history();
    git(h.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(tempDir("oq-inc-shallow-"), "clone");
    git(h.dir, "clone", "-q", "--depth", "1", "--branch", "feature", `file://${h.dir}`, clone);
    git(clone, "fetch", "-q", "--depth", "1", "origin", h.previous, h.base);
    const r = await changes(clone, h.base, h.head, h.previous).catch((e: Error) => ({ error: e.message }));
    // The merge base is not provable either: the review is incomplete.
    expect(r).toEqual({ error: expect.stringMatching(/^history unknown: the clone's history is cut \(a shallow clone\), so it cannot show that the merge base [0-9a-f]{12} is an ancestor of the head/) });
    const d = await decideIncremental({ clonePath: clone, mergeBaseSha: h.head, headSha: h.head, previousReviewedSha: h.previous });
    expect(d.ok && d.scope.kind).toBe("full");
    expect(d.ok && d.scope.reason).toMatch(/^history unknown: the clone's history is cut \(a shallow clone\), so it cannot show that the previously reviewed commit [0-9a-f]{12} is an ancestor of the head [0-9a-f]{12}; fetch the history between them/);
  });

  it("7. a previous commit the clone does not hold: history unknown, naming the fetch", async () => {
    const h = history();
    const missing = "1".repeat(40);
    const r = await changes(h.dir, h.base, h.head, missing);
    expect(r.decision.scope.kind).toBe("full");
    expect(r.decision.scope.reason).toBe(`history unknown: the previously reviewed commit ${missing.slice(0, 12)} is not in the clone (a force push removes it from the branch); fetch it (git fetch origin ${missing}) to review only what changed since; the whole change is reviewed`);
  });

  it("8. a previous id that is not a commit", async () => {
    const h = history();
    const tree = git(h.dir, "rev-parse", `${h.previous}^{tree}`);
    for (const id of [tree, "abc123", "not an id"]) {
      const r = await changes(h.dir, h.base, h.head, id);
      expect(r.decision.scope.kind, id).toBe("full");
      expect(r.decision.scope.reason, id).toMatch(/^not a commit: the previously reviewed commit .* the whole change is reviewed$/);
    }
  });
});

describe("the merge base proofs", () => {
  async function refused(dir: string, mergeBaseSha: string, headSha: string): Promise<string> {
    const d = await decideIncremental({ clonePath: dir, mergeBaseSha, headSha });
    if (d.ok) throw new Error("the merge base passed");
    return d.reason;
  }

  it("9. each failed proof ends the review as incomplete with its own reason", async () => {
    const h = history();
    git(h.dir, "checkout", "-q", "main");
    writeFileSync(join(h.dir, "later.txt"), "later on main\n");
    const tip = commit(h.dir, "later");
    git(h.dir, "checkout", "-q", "feature");
    expect(await refused(h.dir, tip, h.head)).toBe(`diverged: the merge base ${tip.slice(0, 12)} is not an ancestor of the head ${h.head.slice(0, 12)}; pass the merge base of the pull request, not the target branch's tip`);
    expect(await refused(h.dir, "2".repeat(40), h.head)).toBe(`missing commit: the merge base ${"2".repeat(12)} is not in the clone; fetch it before the review (git fetch origin ${"2".repeat(40)})`);
    const tree = git(h.dir, "rev-parse", `${h.base}^{tree}`);
    expect(await refused(h.dir, tree, h.head)).toBe(`not a commit: the merge base ${tree.slice(0, 12)} is a tree`);
    expect(await refused(h.dir, h.base, "head")).toBe('not a commit: the head "head" is not a full commit id');
    expect(await refused(tempDir("oq-inc-norepo-"), h.base, h.head)).toMatch(/^git failed: /);
  });

  it("10. a proved merge base is recorded as the host's", async () => {
    const h = history();
    const d = await decideIncremental({ clonePath: h.dir, mergeBaseSha: h.base, headSha: h.head });
    expect(d).toMatchObject({ ok: true, mergeBase: { sha: h.base, suppliedBy: "host" } });
  });
});
