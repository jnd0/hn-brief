import { resolve } from "node:path";
import { createLLMConfig } from "../../shared/summarizer-core";
import { runGeneration } from "./generate";
import { cutoffForAge, planPrune, pruneRuns } from "./prune";
import { acquireDataLock } from "./storage";

const USAGE = `Usage: bun run pipeline -- <command> [options]

Commands:
  generate                              Run one live daily generation
  prune --before YYYY-MM-DD [--confirm] Preview intermediate runs older than the cutoff;
                                        delete them only with --confirm. Daily data is never removed.
  prune --older-than-days N [--confirm] Same, with the cutoff N days before today (in TZ).

Options:
  -h, --help                            Show this help

Environment:
  DATA_DIR  Data root (default: data)
  TZ        Time zone for run IDs and daily dates (default: America/New_York)`;

const PRUNE_USAGE = `Usage: bun run pipeline -- prune (--before YYYY-MM-DD | --older-than-days N) [--confirm]

Removes only runs/<run-id> directories whose run date is strictly before the cutoff.
Without --confirm, lists the candidates and deletes nothing.`;

type Command =
  | { kind: "help" }
  | { kind: "prune-help" }
  | { kind: "generate" }
  | { kind: "prune"; cutoff: { before: string } | { olderThanDays: number }; confirm: boolean };

/** Parses argv without reading any LLM configuration, so help works with no API keys set. */
export function parseArgs(args: string[]): Command {
  const [command, ...rest] = args;
  if (command === undefined) throw new Error(`Missing command.\n\n${USAGE}`);
  if (command === "--help" || command === "-h") return { kind: "help" };
  if (command === "generate") {
    if (rest.length === 0) return { kind: "generate" };
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { kind: "help" };
    throw new Error(`generate takes no options.\n\n${USAGE}`);
  }
  if (command === "prune") {
    if (rest.includes("--help") || rest.includes("-h")) return { kind: "prune-help" };
    const optionIndexes = ["--before", "--older-than-days"].map(name => rest.indexOf(name)).filter(index => index !== -1);
    if (optionIndexes.length !== 1) {
      throw new Error(`prune requires exactly one of --before YYYY-MM-DD or --older-than-days N.\n\n${PRUNE_USAGE}`);
    }
    const optionIndex = optionIndexes[0];
    const value = rest[optionIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${rest[optionIndex]} requires a value.\n\n${PRUNE_USAGE}`);
    }
    let cutoff: { before: string } | { olderThanDays: number };
    if (rest[optionIndex] === "--before") {
      cutoff = { before: value };
    } else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 36500) throw new Error(`--older-than-days must be a whole number of days from 1 to 36500: ${value}`);
      cutoff = { olderThanDays: Number(value) };
    }
    const confirm = rest.includes("--confirm");
    const unknown = rest.filter((arg, index) => arg !== "--confirm" && index !== optionIndex && index !== optionIndex + 1);
    if (unknown.length > 0) throw new Error(`Unknown prune option: ${unknown[0]}\n\n${PRUNE_USAGE}`);
    return { kind: "prune", cutoff, confirm };
  }
  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

async function main(args: string[]): Promise<void> {
  const command = parseArgs(args);
  const dataRoot = resolve(process.env.DATA_DIR || "data");
  const timeZone = process.env.TZ || "America/New_York";

  switch (command.kind) {
    case "help":
      console.log(USAGE);
      return;
    case "prune-help":
      console.log(PRUNE_USAGE);
      return;
    case "generate": {
      const { config, provider } = createLLMConfig(process.env);
      const daily = await runGeneration({ dataRoot, timeZone, llm: config, providerName: provider });
      console.log(`Generated ${daily.date} (run ${daily.runId}, ${daily.stories.length} stories).`);
      return;
    }
    case "prune": {
      const before = "before" in command.cutoff
        ? command.cutoff.before
        : cutoffForAge(new Date(), command.cutoff.olderThanDays, timeZone);
      // Deleting must not race a live generation, so only --confirm takes the data lock.
      // Validate the cutoff and data root before touching the lock.
      await planPrune(dataRoot, before);
      const release = command.confirm ? await acquireDataLock(dataRoot) : undefined;
      try {
        const { candidates, deleted } = await pruneRuns(dataRoot, before, command.confirm);
        for (const candidate of candidates) console.log(candidate);
        if (!command.confirm) {
          console.log(`Dry run: ${candidates.length} run(s) older than ${before} would be deleted. Re-run with --confirm to delete.`);
        } else {
          console.log(`Deleted ${deleted.length} run(s) older than ${before}.`);
        }
      } finally {
        await release?.();
      }
      return;
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
