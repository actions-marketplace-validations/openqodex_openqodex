// The store in a process of its own, for the tests that need two processes
// or one that can be killed. store.test.ts bundles this file with esbuild
// and runs it with one JSON command as its argument; it prints one JSON
// line with what happened and then ends by itself (no process.exit), so a
// timer left pending would show as a late exit.
import { openStore } from "../src/store/store.js";
import type { GraphStore } from "../src/store/types.js";
import { publishInput } from "./fixtures/store/input.js";

// `home`: OpenQodex's home the test gives every store, where the record of
// published builds lives.
type Command = { home: string } & (
  | { cmd: "publish"; repo: string; tag: string; count: number; at: number; complete: boolean; files: number; bytes: number }
  | { cmd: "lease-loop"; repo: string; rounds: number; holdMs: number }
  | { cmd: "publish-loop"; repo: string; rounds: number }
  | { cmd: "meta"; repo: string; rounds: number }
);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function run(store: GraphStore, c: Command): Promise<unknown> {
  switch (c.cmd) {
    case "publish": {
      if (c.at > Date.now()) await sleep(c.at - Date.now());
      const extra: Record<string, string> = {};
      for (let i = 0; i < c.files; i++) extra[`part-${String(i).padStart(5, "0")}.txt`] = `${c.tag}\n${"y".repeat(c.bytes)}`;
      const results = [];
      for (let i = 0; i < c.count; i++) results.push(await store.publish(publishInput({ tag: c.tag, complete: c.complete, files: extra })));
      return { results };
    }
    case "lease-loop": {
      let leased = 0;
      const failures: string[] = [];
      for (let i = 0; i < c.rounds; i++) {
        const got = await store.lease("current", "review");
        if (got === null) {
          await sleep(2);
          continue;
        }
        leased++;
        const paths = Object.keys(got.generation.manifest.files);
        for (const pass of [1, 2]) {
          for (const p of paths) if (got.generation.read(p) === null) failures.push(`${got.lease.id} ${p} pass ${pass}`);
          // Long enough for the other process to publish twice and collect.
          if (pass === 1) await sleep(c.holdMs);
        }
        got.lease.release();
      }
      return { leased, failures };
    }
    case "publish-loop": {
      let published = 0;
      let removed = 0;
      for (let i = 0; i < c.rounds; i++) {
        const r = await store.publish(publishInput({ tag: `loop-${i}`, complete: false }));
        if (r.ok) {
          published++;
          removed += r.collected.removedGenerations.length;
        }
        if (i % 5 === 4) removed += (await store.collect()).removedGenerations.length;
      }
      return { published, removed };
    }
    case "meta": {
      for (let i = 0; i < c.rounds; i++) await store.updateMeta((m) => ({ ...m, count: (typeof m?.count === "number" ? m.count : 0) + 1 }));
      return { done: c.rounds };
    }
  }
}

async function main(): Promise<unknown> {
  const c = JSON.parse(process.argv[2] ?? "{}") as Command;
  const opened = await openStore(c.repo, { home: c.home });
  if (!opened.ok) return { refused: opened.reason };
  return run(opened.store, c);
}

void main().then(
  (out) => process.stdout.write(`${JSON.stringify({ ...(out as object), printedAt: Date.now() })}\n`),
  (error: unknown) => process.stdout.write(`${JSON.stringify({ thrown: String(error), printedAt: Date.now() })}\n`),
);
