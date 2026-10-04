// The review `init` ends with, after the install boundary is released: of
// the change when the repository has one; else one question (the whole
// repository, a pull request, a branch, not now); without a terminal, the
// three commands instead of the question. It runs in this process with
// scanner downloads off, so it never starts another install step, and it
// never throws: init's exit code is about the install.
import { relative, resolve } from "node:path";
import { getChange, loadConfig } from "@openqodex/core";
import { parseFlags } from "../flags.js";
import { DEFAULT_TIMEOUT_SECONDS, runReview } from "../review-run.js";
import type { ReviewOptions } from "../review-run.js";
import type { ReviewerDriver } from "../reviewers/driver.js";

export type Choice = { kind: "all" } | { kind: "target"; target: string } | null;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

async function askWhat(): Promise<Choice> {
  const prompts = await import("@clack/prompts");
  const what = await prompts.select({
    message: "There is no change to review here. What should OpenQodex review?",
    options: [
      { value: "all", label: "The whole repository" },
      { value: "pr", label: "A pull request" },
      { value: "branch", label: "A branch" },
      { value: "none", label: "Not now" },
    ],
  });
  if (prompts.isCancel(what) || what === "none") return null;
  if (what === "all") return { kind: "all" };
  const answer = await prompts.text({ message: what === "pr" ? "Pull request number or link" : "Branch name" });
  if (prompts.isCancel(answer) || answer.trim() === "") return null;
  const target = answer.trim();
  return { kind: "target", target: what === "pr" && /^\d+$/.test(target) ? `#${target}` : target };
}

export async function reviewAfterInit(o: {
  repoRoot: string;
  // The command the developer types: the launcher, or the pinned npx form.
  runner: string;
  // A terminal to ask in, and no --yes.
  interactive: boolean;
  // Absolute paths of the files init wrote in this run: a change made of
  // these alone (the team section in CLAUDE.md, project-scope agent files)
  // is init's, not the developer's, and is not reviewed now.
  initFiles?: string[];
  // Tests pass a model provider stand-in.
  drivers?: ReviewerDriver[];
  ask?: () => Promise<Choice>;
}): Promise<void> {
  try {
    const { global } = parseFlags(["--cwd", o.repoRoot, "--no-install"], {});
    const review = (extra: Partial<ReviewOptions>) =>
      runReview({ flags: global, scope: {}, noGraph: false, timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000, drivers: o.drivers, ...extra });
    const { config } = loadConfig(o.repoRoot);
    const change = await getChange({ repoRoot: o.repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase });
    const mine = new Set((o.initFiles ?? []).map((p) => relative(resolve(o.repoRoot), resolve(p))));
    if (change.files.some((f) => !mine.has(f.path))) {
      out();
      out("Reviewing your change now. This takes one to three minutes.");
      await review({});
      return;
    }
    if (!o.interactive) {
      out();
      out("No change to review here. To review something else, run one of these:");
      out(`  ${o.runner} review --all          the whole repository`);
      out(`  ${o.runner} review '#<number>'    a pull request`);
      out(`  ${o.runner} review <branch>       a branch`);
      return;
    }
    const choice = await (o.ask ?? askWhat)();
    if (choice === null) return;
    await review(choice.kind === "all" ? { all: true } : { target: choice.target });
  } catch (error) {
    process.stderr.write(`openqodex: the review after init did not run: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
