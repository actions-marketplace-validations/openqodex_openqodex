// Ways the graph's folder in the owning repository could fail, each checked
// below on a real git repo in a temp folder, with real files and, where two
// processes matter, real child processes:
// 1. crash-between-files: a publisher killed after it wrote some files of a
//    generation leaves a folder that is listed, opened or pointed at, or
//    `current` moves; or the collector removes that folder while it may
//    still be in flight (under an hour old), or never removes it after.
// 2. A generation whose files do not match its manifest (a changed byte, a
//    missing file) is listed or opened, even when `current` names it.
// 3. concurrent-readers: two publishers in two processes at once lose a
//    generation, mix files of both into one, or leave `current` on the
//    older build; or a publisher waiting for the lock loses the folder it
//    wrote to a collection another process runs meanwhile.
// 4. collect-while-pinned: a leased generation is removed by a collection
//    that would otherwise remove it, or a released lease still protects it.
// 5. pin-versus-collect: a reader's lease taken while another process
//    publishes and collects lands on a generation that is being removed.
// 6. pid-reuse: a lease of a dead process past 24 hours, or of a pid that
//    now belongs to another process (alive, other start time), keeps its
//    generation; or a live reader past 24 hours, or a dead one under 24
//    hours, loses its generation.
// 7. quota-with-leases: over the size bound the collector removes leased
//    content, the newest build or `current`, removes newer content before
//    older, or fails the publish when protected content alone exceeds the
//    bound instead of reporting it.
// 8. disk-full: a full disk throws, moves `current`, leaves half a
//    generation visible, or the facts writer keeps trying after the first
//    failure.
// 9. A link at `.openqodex/graph`, at a facts folder, at a generation folder
//    or at `current` is followed by a read or a write.
// 10. A file under `.openqodex/graph` that git tracks (a commit could ship
//     forged facts or generations) is used instead of refused.
// 11. A file other users can read (not 0600) or a folder they can enter
//     (not 0700), including a graph folder an older version made 0755.
// 12. reopen-dirty-generation: the capture's ref is not kept while a
//     generation of its tree is kept, so `git show <tree>:<path>` loses a
//     dirty file's bytes after an edit and `git gc --prune=now`; or the ref
//     outlives the last generation of its tree.
// 13. two-partial-one-complete: three publishes of identical input share an
//     id or a folder, or `complete/<tree>` names a partial build or an older
//     complete one.
// 14. The 5, 2, 5 sequence: facts of a complete build are pruned by the
//     collection after a later partial build that did not visit them; or
//     facts no kept inventory names are never pruned once every kept build
//     is complete.
// 15. Facts: an entry with another key, a corrupt body, a body that fails
//     the schema or one over 32 MiB is returned; hasFacts says yes for a
//     link or a folder; a write leaves a temp file behind.
// 16. The folder lock: a lock of a dead process, of a reused pid, or older
//     than 60 seconds blocks the folder; a live lock is taken over; the wait
//     does not end in "busy" after 10 seconds, or leaves a timer that keeps
//     the process alive.
// 17. meta.json: two processes updating it at once lose an update.
// 18. A cache entry of the layout before this one (`graph/<sha1>.json`) or
//     a temp file a crash left in the graph folder stays forever and counts
//     against the size bound; or the folder's own files are removed.
// 19. Listing the builds reads every file of every build (seconds once a
//     build holds a 100 MB index), although a file left as it was published
//     needs no new check before it is read.
// 20. Over the size bound the facts the newest build names are removed
//     while an older kept build's large index stays (measured on vscode:
//     a 552 MB index kept, the facts of every file removed, and the next
//     build parsed everything again).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownStart } from "../src/store/lock.js";
import { openStore } from "../src/store/store.js";
import type { GraphStore, PublishResult } from "../src/store/types.js";
import { factsOf, keyOf, publishInput } from "./fixtures/store/input.js";
import { commitAll, git, makeRepo } from "./helpers.js";

const HOUR = 3600_000;
const here = dirname(fileURLToPath(import.meta.url));
const cleanup: string[] = [];
let bundle = "";

// store-child.ts bundled with esbuild (the bundler tsup uses) into one .mjs
// file a child `node` process runs; the code is this repo's own, unchanged.
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const tsup = dirname(require.resolve("tsup/package.json"));
  const esbuild = createRequire(join(tsup, "package.json"))("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
  const dir = mkdtempSync(join(tmpdir(), "oq-store-child-"));
  cleanup.push(dir);
  bundle = join(dir, "child.mjs");
  await esbuild.build({
    entryPoints: [join(here, "store-child.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundle,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
}, 60_000);

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

type ChildDone = { out: Record<string, unknown> | null; signal: NodeJS.Signals | null; startedAt: number; exitedAt: number; stderr: string };

function child(command: Record<string, unknown>): { proc: ChildProcess; done: Promise<ChildDone> } {
  const startedAt = Date.now();
  const proc = spawn(process.execPath, [bundle, JSON.stringify(command)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  proc.stderr!.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
  const done = new Promise<ChildDone>((resolve) => {
    let exitedAt = 0;
    let signal: NodeJS.Signals | null = null;
    proc.on("exit", (_code, s) => {
      exitedAt = Date.now();
      signal = s;
    });
    proc.on("close", () => {
      let out: Record<string, unknown> | null = null;
      try {
        out = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
      } catch {
        // killed, or crashed: stderr says why
      }
      resolve({ out, signal, startedAt, exitedAt, stderr });
    });
  });
  return { proc, done };
}

function repo(): string {
  const root = makeRepo({ "a.ts": "export const a = 1;\n" });
  commitAll(root);
  cleanup.push(root);
  return root;
}

function outside(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-store-out-"));
  cleanup.push(dir);
  return dir;
}

async function storeOf(root: string, opts: { maxCacheMb?: number; now?: () => number } = {}): Promise<GraphStore> {
  const opened = await openStore(root, opts);
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

function ok(r: PublishResult): string {
  if (!r.ok) throw new Error(`publish failed: ${r.error}: ${r.reason}`);
  return r.id;
}

const later = (ms: number) => (): number => Date.now() + ms;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const ids = (store: GraphStore): string[] => store.list().map((m) => m.id);
const folders = (store: GraphStore): string[] => readdirSync(join(store.dir, "generations")).sort();
const there = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out.push(path);
    if (lstatSync(path).isDirectory()) out.push(...walk(path));
  }
  return out;
}

// A lease file as a reader in another process would have written it.
function leaseBy(store: GraphStore, id: string, pid: number, start: string, ageMs: number): string {
  const name = `${pid}-0-${randomBytes(4).toString("hex")}.json`;
  writeFileSync(join(store.dir, "leases", name), JSON.stringify({ id, pid, start, purpose: "review", time: Date.now() - ageMs }), { mode: 0o600 });
  return name;
}

// A pid no process has: a child that has already ended.
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

const OTHER_START = "Mon Jan 1 00:00:00 2001";

describe("generations", () => {
  it("1. a publisher killed between files leaves a folder that is never listed, opened or pointed at, kept for an hour as a build in flight, then removed", async () => {
    const root = repo();
    const store = await storeOf(root);
    const first = ok(await store.publish(publishInput({ tag: "first" })));
    const run = child({ cmd: "publish", repo: root, tag: "crash", count: 1, at: 0, complete: true, files: 6000, bytes: 256 });
    const gens = join(store.dir, "generations");
    let half = "";
    const deadline = Date.now() + 20_000;
    while (half === "" && Date.now() < deadline) {
      for (const name of readdirSync(gens)) if (name !== first && readdirSync(join(gens, name)).length >= 20) half = name;
      if (half === "") await sleep(2);
    }
    run.proc.kill("SIGKILL");
    expect((await run.done).signal).toBe("SIGKILL");
    expect(half).not.toBe("");
    expect(there(join(gens, half, "manifest.json"))).toBe(false);
    expect(ids(store)).toEqual([first]);
    expect(store.open({ id: half })).toBeNull();
    expect(store.open("current")?.manifest.id).toBe(first);
    // Named by hand in `current`, it still does not open.
    writeFileSync(join(store.dir, "current"), `${half}\n`);
    expect(store.open("current")).toBeNull();
    expect(await store.lease("current", "cli")).toBeNull();
    writeFileSync(join(store.dir, "current"), `${first}\n`);
    // Under an hour old, it may be a build still writing.
    expect((await store.collect()).removedGenerations).toEqual([]);
    expect(there(join(gens, half))).toBe(true);
    const twoHoursOn = await storeOf(root, { now: later(2 * HOUR) });
    expect((await twoHoursOn.collect()).removedGenerations).toEqual([half]);
    expect(folders(store)).toEqual([first]);
  }, 60_000);

  it("2. a generation whose files no longer match its manifest is never listed or opened, even when current names it", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const b = ok(await store.publish(publishInput({ tag: "b" })));
    expect(ids(store)).toEqual([b, a]);
    const projects = join(store.dir, "generations", b, "projects.json");
    // One byte changed, the length kept.
    writeFileSync(projects, readFileSync(projects, "utf8").replace('"b"', '"c"'));
    expect(ids(store)).toEqual([a]);
    expect(store.open({ id: b })).toBeNull();
    expect(store.open("current")).toBeNull();
    expect(await store.lease("current", "review")).toBeNull();
    unlinkSync(join(store.dir, "generations", a, "coverage.json"));
    expect(store.list()).toEqual([]);
    // A generation opened before a file changed reads that file as missing.
    const c = ok(await store.publish(publishInput({ tag: "c" })));
    const g = store.open({ id: c })!;
    expect(g.read("projects.json")).toContain('"c"');
    expect(g.read("manifest.json")).toBeNull();
    expect(g.read("../../current")).toBeNull();
    const cProjects = join(store.dir, "generations", c, "projects.json");
    writeFileSync(cProjects, readFileSync(cProjects, "utf8").replace('"c"', '"d"'));
    expect(g.read("projects.json")).toBeNull();
    expect(await store.lease({ tree: "0".repeat(40) }, "cli")).toBeNull();
  });

  it("3. two publishers in two processes at once give two valid generations, one pointer to the newer, and no file of one in the other", async () => {
    const root = repo();
    const store = await storeOf(root);
    const at = Date.now() + 1500;
    const tags = ["left", "right"];
    const runs = tags.map((tag) => child({ cmd: "publish", repo: root, tag, count: 1, at, complete: true, files: 300, bytes: 64 }));
    const outs = await Promise.all(runs.map((r) => r.done));
    const published = outs.map((o) => {
      const r = (o.out?.results as PublishResult[] | undefined)?.[0];
      return r?.ok ? r.id : `failed: ${JSON.stringify(o.out)} ${o.stderr}`;
    });
    expect(published[0]).not.toBe(published[1]);
    expect(ids(store).sort()).toEqual([...published].sort());
    expect(store.open("current")?.manifest.id).toBe([...published].sort()[1]);
    for (const [i, tag] of tags.entries()) {
      const other = tags[1 - i]!;
      const g = store.open({ id: published[i]! })!;
      const texts = Object.keys(g.manifest.files)
        .filter((p) => p !== "inventory.json")
        .map((p) => g.read(p));
      expect(texts.length).toBe(302);
      expect(texts.every((t) => t !== null && t.includes(tag) && !t.includes(other))).toBe(true);
    }
  }, 60_000);

  it("3b. a publisher waiting for the lock keeps the folder it wrote through a collection another process runs meanwhile", async () => {
    const root = repo();
    const store = await storeOf(root);
    const first = ok(await store.publish(publishInput({ tag: "first", complete: false })));
    const lock = join(store.dir, "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: await ownStart(), time: Date.now() }), { mode: 0o600 });
    const run = child({ cmd: "publish", repo: root, tag: "waiting", count: 1, at: 0, complete: false, files: 50, bytes: 16 });
    const gens = join(store.dir, "generations");
    const deadline = Date.now() + 20_000;
    let waiting = "";
    while (waiting === "" && Date.now() < deadline) {
      for (const name of readdirSync(gens)) if (name !== first && readdirSync(join(gens, name)).length >= 53) waiting = name;
      if (waiting === "") await sleep(5);
    }
    expect(waiting).not.toBe("");
    rmSync(lock);
    expect((await store.collect()).removedGenerations).toEqual([]);
    const done = await run.done;
    const result = (done.out?.results as PublishResult[] | undefined)?.[0];
    expect(result, done.stderr).toMatchObject({ ok: true, id: waiting });
    expect(store.open("current")?.manifest.id).toBe(waiting);
  }, 60_000);

  it("13. three publishes of identical input get three ids in order, and complete/<tree> names the newest complete build", async () => {
    const root = repo();
    const store = await storeOf(root);
    const tree = git(root, "write-tree").trim();
    const same = (complete: boolean) => publishInput({ tag: "same", tree, complete });
    const pointer = (): string => readFileSync(join(store.dir, "complete", tree), "utf8").trim();
    // Made in one millisecond by one process.
    const three = (await Promise.all([store.publish(same(true)), store.publish(same(true)), store.publish(same(true))])).map(ok);
    expect(new Set(three).size).toBe(3);
    expect([...three].sort()).toEqual(three);
    expect(pointer()).toBe(three[2]);
    // Two partial builds and one complete build of the same capture.
    ok(await store.publish(same(false)));
    ok(await store.publish(same(false)));
    expect(pointer()).toBe(three[2]);
    const complete = ok(await store.publish(same(true)));
    expect(pointer()).toBe(complete);
    expect(store.open({ tree })?.manifest.id).toBe(complete);
    const partial = ok(await store.publish(same(false)));
    expect(store.open("current")?.manifest.id).toBe(partial);
    expect(store.open({ tree })?.manifest.id).toBe(complete);
  });
});

describe("leases", () => {
  it("4. a leased generation survives a collection that would remove it, and goes once the lease is released", async () => {
    const store = await storeOf(repo());
    const a = ok(await store.publish(publishInput({ tag: "a", complete: false })));
    const held = await store.lease("current", "review");
    expect(held?.lease.id).toBe(a);
    const b = ok(await store.publish(publishInput({ tag: "b", complete: false })));
    const c = ok(await store.publish(publishInput({ tag: "c", complete: false })));
    expect((await store.collect()).removedGenerations).toEqual([b]);
    expect(ids(store)).toEqual([c, a]);
    expect(held!.generation.read("projects.json")).toContain('"a"');
    held!.lease.release();
    held!.lease.release();
    expect((await store.collect()).removedGenerations).toEqual([a]);
    expect(readdirSync(join(store.dir, "leases"))).toEqual([]);
  });

  it("5. a reader leasing in one process while another publishes and collects never holds a generation being removed", async () => {
    const root = repo();
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "start", complete: false })));
    const reader = child({ cmd: "lease-loop", repo: root, rounds: 30, holdMs: 150 });
    const writer = child({ cmd: "publish-loop", repo: root, rounds: 60 });
    const [r, w] = await Promise.all([reader.done, writer.done]);
    expect(r.out?.failures, r.stderr).toEqual([]);
    expect(r.out?.leased).toBeGreaterThan(20);
    expect(w.out?.published, w.stderr).toBe(60);
    expect(w.out?.removed).toBeGreaterThan(10);
  }, 120_000);

  it("6. a lease of a dead process or a reused pid past 24 hours protects nothing; a dead reader under 24 hours and a live one past 24 hours keep theirs", async () => {
    const root = repo();
    const store = await storeOf(root);
    const publish = async (tag: string): Promise<string> => ok(await store.publish(publishInput({ tag, complete: false })));
    const dead = deadPid();
    const a = await publish("a");
    const deadOld = leaseBy(store, a, dead, OTHER_START, 25 * HOUR);
    const b = await publish("b");
    const reusedOld = leaseBy(store, b, process.pid, OTHER_START, 25 * HOUR);
    const c = await publish("c");
    const deadYoung = leaseBy(store, c, dead, OTHER_START, HOUR);
    const d = await publish("d");
    const live = (await store.lease({ id: d }, "mcp"))!;
    const e = await publish("e");
    await store.collect();
    expect(ids(store)).toEqual([e, d, c]);
    const leases = readdirSync(join(store.dir, "leases"));
    expect(leases).toContain(deadYoung);
    expect(leases).toContain(live.lease.file);
    expect(leases).not.toContain(deadOld);
    expect(leases).not.toContain(reusedOld);
    // A day on, the dead reader's lease is old; the live one's process still runs.
    const dayOn = await storeOf(root, { now: later(25 * HOUR) });
    await dayOn.collect();
    expect(ids(store)).toEqual([e, d]);
    live.lease.release();
    await dayOn.collect();
    expect(ids(store)).toEqual([e]);
  });
});

describe("size bound", () => {
  it("7. over a 1 MB bound the oldest facts no build names go first, then older builds no one holds, then facts no leased build names; leased builds stay and the overrun is reported", async () => {
    // Two hours on, so no fact counts as written by a build still running.
    // The facts are written under a larger bound (a writer holds the bound
    // as it writes); the 1 MB store then publishes and collects.
    const root = repo();
    const writer = await storeOf(root, { maxCacheMb: 64, now: later(2 * HOUR) });
    const store = await storeOf(root, { maxCacheMb: 1, now: later(2 * HOUR) });
    const keys = Array.from({ length: 30 }, (_, i) => keyOf(`q${i}`));
    const base = Date.now() / 1000 - 3 * 3600;
    for (const [i, k] of keys.entries()) {
      expect(writer.writeFacts(k, factsOf(`q${i}`, 300))).toBe("ok");
      utimesSync(join(store.dir, "facts", k.slice(0, 2), `${k}.json`), base + i, base + i);
    }
    // The 1 MB store writes nothing more: the folder is past its bound.
    expect(store.writeFacts(keyOf("over"), factsOf("over", 300))).toBe("over-budget");
    expect(store.hasFacts(keyOf("over"))).toBe(false);
    // A partial build names the five oldest; by the partial-build rule alone every fact would stay.
    const a = await store.publish(publishInput({ tag: "a", complete: false, keys: keys.slice(0, 5) }));
    const aId = ok(a);
    expect(a.ok && a.overBudget).toBeNull();
    expect(a.ok && a.collected.bytesAfter).toBeLessThanOrEqual(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    const gone = keys.slice(5).filter((k) => !store.hasFacts(k));
    expect(gone.length).toBeGreaterThan(0);
    expect(gone).toEqual(keys.slice(5, 5 + gone.length));

    // Leased and kept content alone exceeds the bound: the build still publishes.
    const held = (await store.lease("current", "review"))!;
    const big = { "index/big.jsonl": "z".repeat(1200 * 1024) };
    const b = await store.publish(publishInput({ tag: "b", complete: false, keys: keys.slice(0, 5), files: big }));
    const bId = ok(b);
    expect(b.ok && b.overBudget?.protected).toEqual([aId, bId].sort());
    expect(b.ok && b.overBudget!.totalBytes).toBeGreaterThan(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    expect(keys.slice(5).some((k) => store.hasFacts(k))).toBe(false);
    expect(ids(store)).toEqual([bId, aId]);

    // Released: the old build goes, then the older build no one holds now
    // (b, which c replaces as current); that is enough to be under the bound,
    // so the facts it named stay for the next build.
    held.lease.release();
    const c = await store.publish(publishInput({ tag: "c", complete: false }));
    const cId = ok(c);
    expect(c.ok && c.collected.removedGenerations).toEqual([aId, bId]);
    expect(c.ok && c.collected.bytesAfter).toBeLessThanOrEqual(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    expect(c.ok && c.overBudget).toBeNull();
    expect(ids(store)).toEqual([cId]);
  });
});

describe("disk full", () => {
  it("8. a full disk gives disk-full, leaves current where it was and no half generation, and stops the facts writer at the first failure", async () => {
    if (process.platform !== "darwin") {
      console.warn("skipped: the full-disk case makes a 2 MB disk image with hdiutil, which only macOS has");
      return;
    }
    const dir = outside();
    const image = join(dir, "full.dmg");
    const volume = join(dir, "mnt");
    mkdirSync(volume);
    for (const args of [
      ["create", "-quiet", "-size", "2m", "-fs", "HFS+", "-volname", "oqfull", image],
      ["attach", "-quiet", "-nobrowse", "-mountpoint", volume, image],
    ]) {
      const r = spawnSync("hdiutil", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`hdiutil ${args[0]}: ${r.stderr}`);
    }
    try {
      const root = join(volume, "repo");
      mkdirSync(root);
      git(root, "init", "-q", "--template=");
      const store = await storeOf(root);
      const first = ok(await store.publish(publishInput({ tag: "first" })));
      const big = await store.publish(publishInput({ tag: "big", files: { "index/big.jsonl": "z".repeat(3 * 1024 * 1024) } }));
      expect(big).toMatchObject({ ok: false, error: "disk-full" });
      expect(store.diskFull).toBe(true);
      expect(store.open("current")?.manifest.id).toBe(first);
      expect(ids(store)).toEqual([first]);
      expect(folders(store)).toEqual([first]);

      const fresh = await storeOf(root);
      let result = "ok";
      for (let n = 0; result === "ok" && n < 1000; n++) result = fresh.writeFacts(keyOf(`full${n}`), factsOf(`full${n}`, 300));
      expect(result).toBe("disk-full");
      expect(fresh.diskFull).toBe(true);
      expect(fresh.writeFacts(keyOf("after"), factsOf("after"))).toBe("disk-full");
      expect(fresh.hasFacts(keyOf("after"))).toBe(false);
      expect(walk(join(fresh.dir, "facts")).some((p) => p.endsWith(".tmp"))).toBe(false);
      expect(fresh.open("current")?.manifest.id).toBe(first);
    } finally {
      spawnSync("hdiutil", ["detach", "-force", volume]);
    }
  }, 120_000);
});

describe("links and tracked files", () => {
  it("9a. a link at .openqodex/graph or at one of its folders makes open refuse, and nothing is written where it points", async () => {
    const target = outside();
    const root = repo();
    mkdirSync(join(root, ".openqodex"), { mode: 0o700 });
    symlinkSync(target, join(root, ".openqodex", "graph"));
    const refused = await openStore(root);
    expect(!refused.ok && refused.reason).toMatch(/\.openqodex\/graph is a symbolic link/);
    const root2 = repo();
    const store = await storeOf(root2);
    rmSync(join(store.dir, "facts"), { recursive: true });
    symlinkSync(target, join(store.dir, "facts"));
    const refused2 = await openStore(root2);
    expect(!refused2.ok && refused2.reason).toMatch(/graph\/facts is a symbolic link/);
    expect(store.writeFacts(keyOf("through"), factsOf("through"))).toBe("refused");
    expect(readdirSync(target)).toEqual([]);
  });

  it("9b. a link at a facts folder is never followed: no read, no answer from hasFacts, no write", async () => {
    const store = await storeOf(repo());
    const target = outside();
    const key = keyOf("linked");
    writeFileSync(join(target, `${key}.json`), JSON.stringify({ key, facts: factsOf("linked") }));
    symlinkSync(target, join(store.dir, "facts", key.slice(0, 2)));
    expect(store.readFacts(key)).toBeNull();
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts(key, factsOf("other"))).toBe("refused");
    expect(readdirSync(target)).toEqual([`${key}.json`]);
    expect(JSON.parse(readFileSync(join(target, `${key}.json`), "utf8")).facts).toEqual(factsOf("linked"));
  });

  it("9c. a link at a generation folder is never listed or opened, and the collector removes the link, not what it points at", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const moved = join(outside(), a);
    renameSync(join(store.dir, "generations", a), moved);
    symlinkSync(moved, join(store.dir, "generations", a));
    const files = readdirSync(moved).sort();
    expect(store.list()).toEqual([]);
    expect(store.open({ id: a })).toBeNull();
    expect(store.open("current")).toBeNull();
    await (await storeOf(root, { now: later(2 * HOUR) })).collect();
    expect(there(join(store.dir, "generations", a))).toBe(false);
    expect(readdirSync(moved).sort()).toEqual(files);
  });

  it("9d. a link at current is never read or written through", async () => {
    const store = await storeOf(repo());
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const file = join(outside(), "pointer");
    writeFileSync(file, `${a}\n`);
    unlinkSync(join(store.dir, "current"));
    symlinkSync(file, join(store.dir, "current"));
    expect(store.open("current")).toBeNull();
    const b = await store.publish(publishInput({ tag: "b" }));
    expect(b.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`${a}\n`);
    expect(ids(store)).toEqual([a]);
  });

  it("10. a file under .openqodex/graph that git tracks makes open refuse", async () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex", "graph"), { recursive: true });
    writeFileSync(join(root, ".openqodex", "graph", "current"), "forged\n");
    git(root, "add", "-f", ".openqodex/graph/current");
    git(root, "commit", "-q", "-m", "forged");
    const refused = await openStore(root);
    expect(!refused.ok && refused.reason).toMatch(/holds files git tracks/);
  });

  it("11. every file is 0600 and every folder 0700, and a graph folder an older version made 0755 is closed", async () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex", "graph"), { recursive: true });
    chmodSync(join(root, ".openqodex", "graph"), 0o755);
    const store = await storeOf(root);
    expect(store.writeFacts(keyOf("m"), factsOf("m"))).toBe("ok");
    ok(await store.publish(publishInput({ tag: "m", tree: git(root, "write-tree").trim(), files: { "index/by-file/x.json": "{}" } })));
    const held = (await store.lease("current", "cli"))!;
    await store.updateMeta(() => ({ rate: 1 }));
    const all = [store.dir, ...walk(store.dir)];
    const wrong = all.filter((p) => (statSync(p).mode & 0o777) !== (statSync(p).isDirectory() ? 0o700 : 0o600));
    expect(wrong).toEqual([]);
    expect(all.length).toBeGreaterThan(12);
    held.lease.release();
  });
});

describe("git refs", () => {
  it("12. the capture's ref keeps a dirty file's bytes readable after an edit and git gc while a build of its tree is kept, and goes with the last one", async () => {
    const root = repo();
    const treeOf = (text: string): string => {
      writeFileSync(join(root, "a.ts"), text);
      git(root, "add", "a.ts");
      const tree = git(root, "write-tree").trim();
      git(root, "reset", "-q");
      return tree;
    };
    const refs = (): string[] =>
      git(root, "for-each-ref", "--format=%(refname)", "refs/openqodex/graph/")
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
    const dirty = "export const a = 2; // dirty\n";
    const t2 = treeOf(dirty);
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "dirty", tree: t2 })));
    expect(refs()).toEqual([`refs/openqodex/graph/${t2}`]);
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    git(root, "gc", "-q", "--prune=now");
    expect(git(root, "show", `${t2}:a.ts`)).toBe(dirty);
    // Two newer complete builds of other captures: the dirty one is no longer kept.
    const t3 = treeOf("export const a = 3;\n");
    const t4 = treeOf("export const a = 4;\n");
    ok(await store.publish(publishInput({ tag: "t3", tree: t3 })));
    ok(await store.publish(publishInput({ tag: "t4", tree: t4 })));
    expect(refs()).toEqual([t3, t4].map((t) => `refs/openqodex/graph/${t}`).sort());
    git(root, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["show", `${t2}:a.ts`], { cwd: root }).status).not.toBe(0);
  });
});

describe("facts", () => {
  it("14. facts a partial build did not visit survive its collection, and facts no build names go once every kept build is complete", async () => {
    const keys = [1, 2, 3, 4, 5].map((i) => keyOf(`f${i}`));
    // The sequence of T3: five files, then a partial build of two, then five.
    const store = await storeOf(repo(), { now: later(2 * HOUR) });
    for (const [i, k] of keys.entries()) store.writeFacts(k, factsOf(`f${i}`));
    ok(await store.publish(publishInput({ tag: "five", keys })));
    ok(await store.publish(publishInput({ tag: "two", complete: false, keys: keys.slice(0, 2) })));
    expect(keys.every((k) => store.readFacts(k) !== null)).toBe(true);
    ok(await store.publish(publishInput({ tag: "five-again", keys })));
    expect(keys.every((k) => store.hasFacts(k))).toBe(true);

    // The rule on its own: no complete build keeps these facts.
    const lone = await storeOf(repo(), { now: later(2 * HOUR) });
    for (const [i, k] of keys.entries()) lone.writeFacts(k, factsOf(`f${i}`));
    ok(await lone.publish(publishInput({ tag: "two", complete: false, keys: keys.slice(0, 2) })));
    await lone.collect();
    expect(keys.every((k) => lone.hasFacts(k))).toBe(true);
    // The partial build is still current when the first complete build collects.
    ok(await lone.publish(publishInput({ tag: "four", keys: keys.slice(0, 4) })));
    expect(keys.every((k) => lone.hasFacts(k))).toBe(true);
    ok(await lone.publish(publishInput({ tag: "four-again", keys: keys.slice(0, 4) })));
    expect(keys.map((k) => lone.hasFacts(k))).toEqual([true, true, true, true, false]);
  });

  it("15. a facts entry is returned only when its key, body and schema match, within 32 MiB; hasFacts says no for a link or a folder; a write leaves no temp file", async () => {
    const store = await storeOf(repo());
    const key = keyOf("one");
    const facts = factsOf("one", 3);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts(key, facts)).toBe("ok");
    expect(store.readFacts(key)).toEqual(facts);
    expect(store.hasFacts(key)).toBe(true);
    const folder = join(store.dir, "facts", key.slice(0, 2));
    expect(readdirSync(folder)).toEqual([`${key}.json`]);
    const file = join(folder, `${key}.json`);
    writeFileSync(file, JSON.stringify({ key: keyOf("two"), facts }));
    expect(store.readFacts(key)).toBeNull();
    writeFileSync(file, "{ not json");
    expect(store.readFacts(key)).toBeNull();
    writeFileSync(file, JSON.stringify({ key, facts: { ...facts, lang: "cobol" } }));
    expect(store.readFacts(key)).toBeNull();
    // Valid JSON padded past the bound.
    writeFileSync(file, `${JSON.stringify({ key, facts })}${" ".repeat(32 * 1024 * 1024)}`);
    expect(store.readFacts(key)).toBeNull();
    rmSync(file);
    const elsewhere = join(outside(), "facts.json");
    writeFileSync(elsewhere, JSON.stringify({ key, facts }));
    symlinkSync(elsewhere, file);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.readFacts(key)).toBeNull();
    rmSync(file);
    mkdirSync(file);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts("../escape", facts)).toBe("refused");
    expect(store.readFacts("../escape")).toBeNull();
  });
});

describe("the folder lock", () => {
  it("16a. a lock left by a dead process, by a reused pid, or older than 60 seconds is taken over at once", async () => {
    const store = await storeOf(repo());
    const lock = join(store.dir, "lock");
    for (const holder of [
      { pid: deadPid(), start: OTHER_START, time: Date.now() },
      { pid: process.pid, start: OTHER_START, time: Date.now() },
      { pid: process.pid, start: await ownStart(), time: Date.now() - 61_000 },
    ]) {
      writeFileSync(lock, JSON.stringify(holder), { mode: 0o600 });
      const started = Date.now();
      ok(await store.publish(publishInput({ tag: "x" })));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(there(lock)).toBe(false);
    }
  });

  it("16b. a live lock holds a publisher in another process for 10 seconds, then busy, and that process ends at once after", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const lock = join(store.dir, "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: await ownStart(), time: Date.now() }), { mode: 0o600 });
    const done = await child({ cmd: "publish", repo: root, tag: "b", count: 1, at: 0, complete: true, files: 0, bytes: 0 }).done;
    rmSync(lock);
    expect((done.out?.results as PublishResult[] | undefined)?.[0], done.stderr).toMatchObject({ ok: false, error: "busy" });
    expect((done.out!.printedAt as number) - done.startedAt).toBeGreaterThanOrEqual(10_000);
    expect(done.exitedAt - (done.out!.printedAt as number)).toBeLessThan(1000);
    expect(folders(store)).toEqual([a]);
  }, 60_000);
});

describe("the graph folder", () => {
  it("18. a cache entry of the old layout and a temp file a crash left are removed once an hour old, and the folder's own files never", async () => {
    const root = repo();
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "a" })));
    await store.updateMeta(() => ({ rate: 1 }));
    const oldEntry = join(store.dir, `${keyOf("old layout")}.json`);
    writeFileSync(oldEntry, "{}");
    writeFileSync(join(store.dir, ".current.123.abcdef01.tmp"), "half");
    await store.collect();
    expect(there(oldEntry)).toBe(true);
    await (await storeOf(root, { now: later(2 * HOUR) })).collect();
    expect(readdirSync(store.dir).sort()).toEqual(["complete", "current", "facts", "generations", "leases", "meta.json"]);
  });
});

describe("meta", () => {
  it("17. two processes updating meta.json at once lose no update", async () => {
    const root = repo();
    const store = await storeOf(root);
    expect(store.readMeta()).toBeNull();
    const runs = [child({ cmd: "meta", repo: root, rounds: 25 }), child({ cmd: "meta", repo: root, rounds: 25 })];
    const outs = await Promise.all(runs.map((r) => r.done));
    expect(outs.map((o) => o.out?.done)).toEqual([25, 25]);
    expect(store.readMeta()).toEqual({ count: 50 });
    writeFileSync(join(store.dir, "meta.json"), "[1, 2]");
    expect(store.readMeta()).toBeNull();
  }, 60_000);
});

describe("listing", () => {
  it("19. lists a build without reading its files while they are as published, and still refuses one that changed", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const projects = join(store.dir, "generations", a, "projects.json");
    // Unreadable but untouched: listing it needs no read, reading it fails.
    chmodSync(projects, 0o000);
    try {
      expect(ids(store)).toEqual([a]);
      expect(store.open({ id: a })?.read("projects.json")).toBeNull();
    } finally {
      chmodSync(projects, 0o600);
    }
    // Changed in place, length kept: refused again.
    writeFileSync(projects, readFileSync(projects, "utf8").replace('"a"', '"z"'));
    expect(ids(store)).toEqual([]);
  });
});

describe("the size bound and kept builds", () => {
  it("20. removes an older kept build that no one holds before the facts the newest build names", async () => {
    const root = repo();
    const writer = await storeOf(root, { maxCacheMb: 64, now: later(2 * HOUR) });
    const keys = Array.from({ length: 10 }, (_, i) => keyOf(`k${i}`));
    const old = Date.now() / 1000 - 3 * 3600;
    for (const [i, k] of keys.entries()) {
      expect(writer.writeFacts(k, factsOf(`k${i}`, 50))).toBe("ok");
      utimesSync(join(writer.dir, "facts", k.slice(0, 2), `${k}.json`), old + i, old + i);
    }
    // An older complete build with a large index, then a newer one naming the same facts.
    const a = ok(await writer.publish(publishInput({ tag: "a", keys, files: { "index/big.jsonl": "z".repeat(1100 * 1024) } })));
    const store = await storeOf(root, { maxCacheMb: 1, now: later(2 * HOUR) });
    const b = await store.publish(publishInput({ tag: "b", keys }));
    const bId = ok(b);
    expect(b.ok && b.collected.removedGenerations).toEqual([a]);
    expect(keys.every((k) => store.hasFacts(k))).toBe(true);
    expect(b.ok && b.overBudget).toBeNull();
    expect(ids(store)).toEqual([bId]);
  });
});
