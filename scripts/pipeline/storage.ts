import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isIsoDate } from "./prune";
import type { ArchiveEntry, DailyBriefing, PipelineManifest } from "./types";

const LOCK_DIR = ".generate.lock";
// A full run takes about 90 minutes, so a lock older than this belongs to a crashed run.
const STALE_LOCK_MS = 12 * 60 * 60 * 1000;

export interface RunStore {
  dataRoot: string;
  runId: string;
  runDir: string;
  writeJson(relativePath: string, value: unknown): Promise<void>;
  writeManifest(value: PipelineManifest): Promise<void>;
}

export interface PublishedPaths {
  json: string;
  articles: string;
  digest: string;
}

/** Formats `now` as local time in `timeZone` plus numeric UTC offset, e.g. `2026-09-08T070000-0400`. */
export function formatRunId(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(now).map(part => [part.type, part.value])
  );
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMinutes = Math.round((localAsUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}${parts.minute}${parts.second}${offset}`;
}

async function writeTemporary(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return temporary;
}

/** Writes every file to a temporary sibling first, then renames them all into place. */
async function atomicWriteTexts(files: Array<{ path: string; text: string }>): Promise<void> {
  const temporaries: string[] = [];
  try {
    for (const file of files) temporaries.push(await writeTemporary(file.path, file.text));
    for (const [index, file] of files.entries()) await rename(temporaries[index]!, file.path);
  } catch (error) {
    await Promise.all(temporaries.map(temporary => rm(temporary, { force: true })));
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteTexts([{ path, text: `${JSON.stringify(value, null, 2)}\n` }]);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

interface LockInfo {
  ino: number;
  mtimeMs: number;
  token?: string;
  acquiredAt?: number;
}

/** Reads lock identity; returns undefined when the lock directory does not exist. */
async function readLockInfo(lockDir: string): Promise<LockInfo | undefined> {
  let info: LockInfo;
  try {
    const stats = await stat(lockDir);
    info = { ino: stats.ino, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as { token?: unknown; acquiredAt?: unknown };
    if (typeof owner.token === "string") info.token = owner.token;
    const time = typeof owner.acquiredAt === "string" ? Date.parse(owner.acquiredAt) : NaN;
    if (!Number.isNaN(time)) info.acquiredAt = time;
  } catch {
    // Missing or partial owner.json: staleness falls back to the directory mtime.
  }
  return info;
}

function sameLock(a: LockInfo, b: LockInfo): boolean {
  return a.ino === b.ino && a.token === b.token && (a.token !== undefined || a.mtimeMs === b.mtimeMs);
}

/** Moves `lockDir` aside only if it is still the lock described by `expected`; returns the moved path. */
async function moveLockAside(lockDir: string, expected: LockInfo, label: string): Promise<string | undefined> {
  const aside = `${lockDir}.${label}.${randomUUID()}`;
  try {
    await rename(lockDir, aside);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const moved = await readLockInfo(aside);
  if (moved && sameLock(moved, expected)) return aside;
  // We moved someone else's live lock: put it back if nobody has replaced it meanwhile.
  await rename(aside, lockDir).catch(() => undefined);
  return undefined;
}

/** Acquires `dataRoot/.generate.lock` (created atomically with owner.json); recovers a lock at least 12 hours old once. */
export async function acquireDataLock(dataRoot: string, now: Date = new Date()): Promise<() => Promise<void>> {
  const lockDir = join(dataRoot, LOCK_DIR);
  const running = () => new Error(`Generation already running (lock: ${lockDir})`);
  await mkdir(dataRoot, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    // Build the lock with its owner record beside it, then rename into place so it never exists without an owner.
    const token = randomUUID();
    const candidate = `${lockDir}.new.${token}`;
    try {
      await mkdir(candidate);
      await writeFile(
        join(candidate, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token, acquiredAt: now.toISOString() }, null, 2)}\n`,
        "utf8"
      );
      await rename(candidate, lockDir);
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      if (!isErrorCode(error, "EEXIST") && !isErrorCode(error, "ENOTEMPTY")) throw error;
      const existing = await readLockInfo(lockDir);
      // Released between our rename and this read: try once more.
      if (!existing) continue;
      if (attempt > 0) throw running();
      const lockTime = existing.acquiredAt ?? existing.mtimeMs;
      if (now.getTime() - lockTime < STALE_LOCK_MS) throw running();
      const stale = await moveLockAside(lockDir, existing, "stale");
      if (!stale) throw running();
      await rm(stale, { recursive: true, force: true });
      continue;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const current = await readLockInfo(lockDir);
      if (!current || current.token !== token) return;
      const aside = await moveLockAside(lockDir, current, "release");
      if (aside) await rm(aside, { recursive: true, force: true });
    };
  }
  throw running();
}

function resolveInside(parent: string, relativePath: string): string {
  const base = resolve(parent);
  const target = resolve(base, relativePath);
  if (!target.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes ${base}: ${relativePath}`);
  }
  return target;
}

export async function createRunStore(dataRoot: string, runId: string): Promise<RunStore> {
  const runsDir = join(dataRoot, "runs");
  const runDir = resolveInside(runsDir, runId);
  await mkdir(runsDir, { recursive: true });
  // Non-recursive: fails if the run directory already exists, so a second run never overwrites the first.
  await mkdir(runDir);
  return {
    dataRoot,
    runId,
    runDir,
    writeJson: async (relativePath, value) => atomicWriteJson(resolveInside(runDir, relativePath), value),
    writeManifest: value => atomicWriteJson(join(runDir, "manifest.json"), value)
  };
}

async function readArchive(path: string): Promise<ArchiveEntry[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new Error(`Invalid archive (expected array): ${path}`);
    for (const entry of value) {
      const e = entry as Partial<ArchiveEntry> | null;
      if (!e || typeof e.date !== "string" || !isIsoDate(e.date) || typeof e.path !== "string" || typeof e.runId !== "string") {
        throw new Error(`Invalid archive entry in ${path}: ${JSON.stringify(entry)}`);
      }
    }
    return value as ArchiveEntry[];
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

/** Publishes daily files, then archive.json, then latest.json; every write is temp file + rename. */
export async function publishDaily(
  store: RunStore,
  record: DailyBriefing,
  markdown: { articles: string; digest: string }
): Promise<PublishedPaths> {
  if (record.runId !== store.runId) {
    throw new Error(`Briefing runId ${record.runId} does not match run store ${store.runId}`);
  }
  if (!isIsoDate(record.date)) throw new Error(`Invalid briefing date: ${record.date}`);
  const [year, month, day] = record.date.split("-");
  const base = `daily/${year}/${month}/${day}`;
  const paths: PublishedPaths = {
    json: `${base}.json`,
    articles: `${base}.md`,
    digest: `${base}-digest.md`
  };
  const root = store.dataRoot;

  // Read and validate the archive before writing anything, so a corrupt archive leaves every file unchanged.
  const archivePath = join(root, "archive.json");
  const entry: ArchiveEntry = {
    date: record.date,
    path: paths.json,
    runId: record.runId,
    storyCount: record.stories.length
  };
  const archive = [entry, ...(await readArchive(archivePath)).filter(existing => existing.date !== record.date)]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  await atomicWriteTexts([
    { path: join(root, paths.json), text: `${JSON.stringify(record, null, 2)}\n` },
    { path: join(root, paths.articles), text: markdown.articles },
    { path: join(root, paths.digest), text: markdown.digest }
  ]);
  await atomicWriteJson(archivePath, archive);

  // A backfill of an older date updates its files and archive entry but leaves latest.json pointing at the newest day.
  if (archive[0]?.date === record.date) {
    await atomicWriteJson(join(root, "latest.json"), { date: record.date, runId: record.runId, path: paths.json });
  }
  return paths;
}
