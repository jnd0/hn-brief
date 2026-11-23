import { lstat, readdir, rm } from "node:fs/promises";
import { parse, resolve } from "node:path";

const RUN_NAME = /^(\d{4}-\d{2}-\d{2})T\d{6}(?:Z|[+-]\d{4})$/;

/** True for a real calendar date in YYYY-MM-DD form; rejects impossible dates such as 2026-02-30. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return new Date(Date.UTC(year, month - 1, day)).toISOString().startsWith(value);
}

/** The cutoff date for keeping `days` days of runs: the calendar date in `timeZone` that is `days` days before `now`. */
export function cutoffForAge(now: Date, days: number, timeZone: string): string {
  // Take today's calendar date in timeZone, then subtract whole days from that date, so DST shifts can't skip a day.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

function assertCutoff(before: string): void {
  if (!isIsoDate(before)) throw new Error(`Cutoff must be a valid YYYY-MM-DD date: ${before}`);
}

function assertDataRoot(dataRoot: string): string {
  const root = resolve(dataRoot);
  if (dataRoot.trim() === "" || root === parse(root).root) throw new Error(`Unsafe data root: "${dataRoot}"`);
  return root;
}

/** Lists `runs/<name>` directories directly under `dataRoot/runs` whose run date is strictly before `before`. */
export async function planPrune(dataRoot: string, before: string): Promise<string[]> {
  assertCutoff(before);
  const root = assertDataRoot(dataRoot);
  const runsDir = resolve(root, "runs");
  let entries;
  try {
    if ((await lstat(runsDir)).isSymbolicLink()) throw new Error(`Refusing to prune through symlinked runs directory: ${runsDir}`);
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const date = RUN_NAME.exec(entry.name)?.[1];
      return date !== undefined && date < before ? [entry.name] : [];
    })
    .sort()
    .map(name => `runs/${name}`);
}

/** Previews pruning candidates; deletes them only when `confirm` is true. */
export async function pruneRuns(
  dataRoot: string,
  before: string,
  confirm: boolean
): Promise<{ candidates: string[]; deleted: string[] }> {
  const candidates = await planPrune(dataRoot, before);
  if (!confirm) return { candidates, deleted: [] };
  const root = resolve(dataRoot);
  for (const candidate of candidates) await rm(resolve(root, candidate), { recursive: true });
  return { candidates, deleted: candidates };
}
