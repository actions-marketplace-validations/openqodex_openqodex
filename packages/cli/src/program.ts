import { Command, CommanderError } from "commander";
import { EXIT_TOOL_FAILED } from "./exit-codes.js";

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
};

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
        const mod = await entry.load();
        process.exitCode = await mod.run(command.args);
      });
  }

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
