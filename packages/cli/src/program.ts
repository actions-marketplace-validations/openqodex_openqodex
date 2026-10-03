import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { OpenQodexError } from "@openqodex/core";
import { EXIT_TOOL_FAILED } from "./exit-codes.js";
import { noteInternalError, offer, takePending } from "./feedback.js";

type CommandModule = { run: (args: string[]) => Promise<number> };

// Each command is loaded only when it runs, so startup stays fast.
const commands: Record<string, { summary: string; load: () => Promise<CommandModule> }> = {
  review: { summary: "Review the current change", load: () => import("./commands/review.js") },
  scan: { summary: "Run the scanners on the current change", load: () => import("./commands/scan.js") },
  init: { summary: "Install OpenQodex into your coding agent", load: () => import("./commands/init.js") },
  doctor: { summary: "Show which scanners are installed", load: () => import("./commands/doctor.js") },
  hook: { summary: "Run as a git hook", load: () => import("./commands/hook.js") },
  trust: { summary: "Approve a custom scanner from .openqodex.yaml", load: () => import("./commands/trust.js") },
  guide: { summary: "Print the docs", load: () => import("./commands/guide.js") },
  demo: { summary: "Build the demo repo with planted bugs", load: () => import("./commands/demo.js") },
  report: { summary: "Report a problem with OpenQodex as a GitHub issue", load: () => import("./commands/report.js") },
  update: { summary: "Update OpenQodex now, roll back, or turn updates off", load: () => import("./commands/update.js") },
};

// The hook check must stay silent, and report shows its own offer.
const NO_OFFER = new Set(["hook", "report"]);

function cwdOf(args: string[]): string {
  const i = args.findIndex((a) => a === "--cwd" || a.startsWith("--cwd="));
  const value = i === -1 ? undefined : args[i].startsWith("--cwd=") ? args[i].slice(6) : args[i + 1];
  return resolve(value ?? process.cwd());
}

// An input or usage problem prints its one line. Anything else is a bug in
// OpenQodex: one line, with the stack only under --verbose.
function reportError(error: unknown, command: string, args: string[]): number {
  if (error instanceof OpenQodexError) {
    process.stderr.write(`openqodex: ${error.message}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`openqodex failed: ${message}\n`);
    if (args.includes("--verbose") && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    noteInternalError(command, args, error);
  }
  return EXIT_TOOL_FAILED;
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command("openqodex")
    .description("Open source code review that runs inside your coding agent, before you push.")
    .version(__OPENQODEX_VERSION__, "-v, --version", "Print the version")
    .exitOverride();

  for (const [name, entry] of Object.entries(commands)) {
    program
      .command(name)
      .description(entry.summary)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(async (_options: unknown, command: Command) => {
        try {
          const mod = await entry.load();
          process.exitCode = await mod.run(command.args);
        } catch (error) {
          process.exitCode = reportError(error, name, command.args);
        }
        // At most one offer per run, after the command's own output.
        const problem = takePending();
        if (problem !== null && !NO_OFFER.has(name)) await offer(problem, name, command.args, cwdOf(command.args));
        // Last: the update notices on stderr and, after a review, scan or
        // hook run through the launcher, the detached daily check.
        const { afterCommand } = await import("./update/trigger.js");
        afterCommand(name, command.args);
      });
  }

  // Hidden: one scanner install, run as a detached process by the toolchain
  // so it keeps going after the command that started it exits.
  program
    .command("__install <tool>", { hidden: true })
    .action(async (tool: string) => {
      const { ADAPTERS, IN_PROCESS, runInstallWorker } = await import("@openqodex/scanners");
      // Only a name from the toolchain reaches the worker: the name becomes a
      // folder under the home folder.
      const known = new Set<string>(["uv", ...ADAPTERS.map((a) => a.source).filter((s) => !IN_PROCESS.has(s))]);
      if (!known.has(tool)) {
        process.stderr.write(`openqodex: unknown tool: ${tool}\n`);
        process.exitCode = EXIT_TOOL_FAILED;
        return;
      }
      process.exitCode = (await runInstallWorker(tool)) === 0 ? 0 : EXIT_TOOL_FAILED;
    });

  // Hidden: the update worker, run as a detached process after a command.
  // It ends by itself; the exit is explicit so no open socket keeps it.
  program.command("__update", { hidden: true }).action(async () => {
    const { runUpdateWorker } = await import("./update/worker.js");
    const result = await runUpdateWorker({ anyAge: false });
    process.exit(result.outcome === "failed" ? EXIT_TOOL_FAILED : 0);
  });

  // Hidden: refreshes the recorded agent files from this runtime's templates.
  // The updater runs the new runtime's own copy inside install.lock.
  program
    .command("__refresh", { hidden: true })
    .option("--probe")
    .action(async (options: { probe?: boolean }) => {
      if (options.probe) return;
      const { runRefresh } = await import("./update/refresh.js");
      process.stdout.write(`${JSON.stringify(await runRefresh(__OPENQODEX_VERSION__))}\n`);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version exit 0; every usage error is a tool failure.
      process.exit(error.exitCode === 0 ? 0 : EXIT_TOOL_FAILED);
    }
    throw error;
  }
}
