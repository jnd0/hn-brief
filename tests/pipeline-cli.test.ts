import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireDataLock } from "../scripts/pipeline/storage";

const repoRoot = resolve(import.meta.dir, "..");

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}

test("pipeline --help and prune --help exit 0 without LLM configuration", async () => {
  const help = await run(["scripts/pipeline/cli.ts", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("prune --before YYYY-MM-DD");
  expect(help.stderr).not.toContain("No LLM API key");

  const pruneHelp = await run(["scripts/pipeline/cli.ts", "prune", "--help"]);
  expect(pruneHelp.code).toBe(0);
  expect(pruneHelp.stdout).toContain("--confirm");
});

test("prune without --before exits nonzero with a usage error", async () => {
  const result = await run(["scripts/pipeline/cli.ts", "prune"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("--before YYYY-MM-DD");
});

test("prune rejects a malformed cutoff with a clear error", async () => {
  const result = await run(["scripts/pipeline/cli.ts", "prune", "--before", "2026-9-8"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("YYYY-MM-DD");
});

test("importing parseArgs runs nothing: the CLI entrypoint is guarded", async () => {
  const proc = Bun.spawn(["bun", "-e", 'import { parseArgs } from "./scripts/pipeline/cli.ts"; console.log(parseArgs(["prune", "--before", "2026-09-08"]).kind);'], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("prune\n");
  expect(await new Response(proc.stderr).text()).toBe("");
});

test("prune --confirm refuses to delete while a generation holds the data lock; a dry run still lists", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "hn-brief-cli-lock-"));
  const run7 = join(dataRoot, "runs", "2026-09-07T070000-0400");
  await Bun.write(join(run7, "manifest.json"), "{}");
  const release = await acquireDataLock(dataRoot);
  try {
    const dry = await run(["scripts/pipeline/cli.ts", "prune", "--before", "2026-09-09"], { DATA_DIR: dataRoot });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("runs/2026-09-07T070000-0400");

    const confirm = await run(["scripts/pipeline/cli.ts", "prune", "--before", "2026-09-09", "--confirm"], { DATA_DIR: dataRoot });
    expect(confirm.code).toBe(1);
    expect(confirm.stderr).toContain("already running");
    expect(await stat(run7).then(() => true, () => false)).toBe(true);
  } finally {
    await release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("prune --older-than-days removes only runs older than the age, and needs a positive whole number", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "hn-brief-cli-age-"));
  const day = (daysAgo: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
  const old = join(dataRoot, "runs", `${day(100)}T070000Z`);
  const recent = join(dataRoot, "runs", `${day(80)}T070000Z`);
  await Bun.write(join(old, "manifest.json"), "{}");
  await Bun.write(join(recent, "manifest.json"), "{}");
  try {
    const result = await run(["scripts/pipeline/cli.ts", "prune", "--older-than-days", "90", "--confirm"], { DATA_DIR: dataRoot, TZ: "UTC" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Deleted 1 run(s)");
    expect(await stat(old).then(() => true, () => false)).toBe(false);
    expect(await stat(recent).then(() => true, () => false)).toBe(true);

    for (const bad of ["0", "-5", "1.5", "ninety", "99999999999"]) {
      const rejected = await run(["scripts/pipeline/cli.ts", "prune", "--older-than-days", bad], { DATA_DIR: dataRoot });
      expect(rejected.code).toBe(1);
    }
    const both = await run(["scripts/pipeline/cli.ts", "prune", "--before", "2026-01-01", "--older-than-days", "90"], { DATA_DIR: dataRoot });
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("exactly one");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("summarizer --help exits 0 without API keys", async () => {
  const result = await run(["scripts/summarizer.ts", "--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("HN-Brief Summarizer");
  expect(result.stderr).not.toContain("No LLM API key");
});
