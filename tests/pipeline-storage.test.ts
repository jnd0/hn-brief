import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDataLock,
  createRunStore,
  formatRunId,
  publishDaily
} from "../scripts/pipeline/storage";
import type { DailyBriefing } from "../scripts/pipeline/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "hn-brief-pipeline-"));
  roots.push(value);
  return value;
}

function briefing(runId: string, date: string, storyCount = 0): DailyBriefing {
  return {
    schemaVersion: 1,
    date,
    generatedAt: `${date}T11:30:00.000Z`,
    runId,
    source: { kind: "hacker-news", query: "last-24-hours", windowStart: "2026-09-07T11:00:00.000Z", windowEnd: "2026-09-08T11:00:00.000Z" },
    model: { provider: "openai-compatible", endpoint: "http://llm.test/v1/chat/completions", name: "small-model" },
    digest: "Daily digest",
    stories: Array.from({ length: storyCount }, (_, index) => ({
      id: String(100 + index),
      title: `Story ${index}`,
      url: `https://example.test/${index}`,
      points: 10 + index,
      num_comments: 3,
      summary: "Summary",
      discussion_summary: "Discussion",
      postType: "article"
    })),
    quality: { storyFailures: 0, storyCount, digestValid: true }
  } satisfies DailyBriefing;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

test("formatRunId uses local time and the DST-correct numeric offset", () => {
  expect(formatRunId(new Date("2026-09-08T11:00:00Z"), "America/New_York")).toBe("2026-09-08T070000-0400");
  expect(formatRunId(new Date("2026-01-15T12:05:09Z"), "America/New_York")).toBe("2026-01-15T070509-0500");
  expect(formatRunId(new Date("2026-01-15T12:05:09Z"), "UTC")).toBe("2026-01-15T120509+0000");
});

test("lock excludes overlap and can be released", async () => {
  const dataRoot = await root();
  const release = await acquireDataLock(dataRoot, new Date("2026-09-08T11:00:00Z"));
  await expect(acquireDataLock(dataRoot, new Date("2026-09-08T11:01:00Z"))).rejects.toThrow("already running");
  await release();
  await expect(stat(join(dataRoot, ".generate.lock"))).rejects.toThrow();
  await expect(stat(dataRoot)).resolves.toBeDefined();
  const releaseAgain = await acquireDataLock(dataRoot, new Date("2026-09-08T11:02:00Z"));
  await releaseAgain();
});

test("a lock at least 12 hours old is recovered", async () => {
  const dataRoot = await root();
  const now = new Date("2026-09-08T11:00:00Z");
  await mkdir(join(dataRoot, ".generate.lock"));
  await writeFile(
    join(dataRoot, ".generate.lock", "owner.json"),
    JSON.stringify({ pid: 1, acquiredAt: new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString() })
  );

  const release = await acquireDataLock(dataRoot, now);
  const owner = JSON.parse(await readFile(join(dataRoot, ".generate.lock", "owner.json"), "utf8"));
  expect(owner.acquiredAt).toBe(now.toISOString());
  await release();
});

test("a lock younger than 12 hours stays held", async () => {
  const dataRoot = await root();
  const now = new Date("2026-09-08T11:00:00Z");
  const owner = { pid: 1, token: "live", acquiredAt: new Date(now.getTime() - 11 * 60 * 60 * 1000).toISOString() };
  await mkdir(join(dataRoot, ".generate.lock"));
  await writeFile(join(dataRoot, ".generate.lock", "owner.json"), JSON.stringify(owner));

  await expect(acquireDataLock(dataRoot, now)).rejects.toThrow("already running");
  expect(JSON.parse(await readFile(join(dataRoot, ".generate.lock", "owner.json"), "utf8"))).toEqual(owner);
});

test("a lock released right after a failed take is retried instead of reported as running", async () => {
  const dataRoot = await root();
  // Simulate a lock that exists only for the instant of our rename: the first rename into place fails with EEXIST,
  // and by the time we inspect the lock it is gone.
  const realRename = fsp.rename;
  let injected = false;
  const spy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    if (!injected && String(to).endsWith(".generate.lock")) {
      injected = true;
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    }
    return realRename(from, to);
  });
  try {
    const release = await acquireDataLock(dataRoot, new Date("2026-09-08T11:00:00Z"));
    expect(injected).toBe(true);
    await release();
  } finally {
    spy.mockRestore();
  }
});

test("release leaves a lock taken over by another owner, and repeated release is a no-op", async () => {
  const dataRoot = await root();
  const release = await acquireDataLock(dataRoot, new Date("2026-09-08T11:00:00Z"));
  const takeover = { pid: 2, token: "other-owner", acquiredAt: "2026-09-09T12:00:00.000Z" };
  await writeFile(join(dataRoot, ".generate.lock", "owner.json"), JSON.stringify(takeover));

  await release();
  await release();
  expect(JSON.parse(await readFile(join(dataRoot, ".generate.lock", "owner.json"), "utf8"))).toEqual(takeover);
  expect(await readdir(dataRoot)).toEqual([".generate.lock"]);
});

test("an orphaned lock with an unreadable owner.json is recovered by directory age", async () => {
  const dataRoot = await root();
  const now = new Date("2026-09-08T11:00:00Z");
  const lockDir = join(dataRoot, ".generate.lock");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner.json"), "{\"pid\":");
  const old = new Date(now.getTime() - 13 * 60 * 60 * 1000);
  await utimes(lockDir, old, old);

  const release = await acquireDataLock(dataRoot, now);
  expect(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).acquiredAt).toBe(now.toISOString());
  await release();
  expect(await readdir(dataRoot)).toEqual([]);
});

test("a fresh orphaned lock with an unreadable owner.json stays held", async () => {
  const dataRoot = await root();
  await mkdir(join(dataRoot, ".generate.lock"));
  await writeFile(join(dataRoot, ".generate.lock", "owner.json"), "{\"pid\":");
  await expect(acquireDataLock(dataRoot)).rejects.toThrow("already running");
});

test("publication writes final files and preserves older archive entries", async () => {
  const dataRoot = await root();
  await writeFile(join(dataRoot, "archive.json"), JSON.stringify([{ date: "2026-09-07", path: "daily/2026/09/07.json", runId: "old", storyCount: 19 }]));
  const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  const record = briefing(store.runId, "2026-09-08", 2);

  const paths = await publishDaily(store, record, { articles: "# Articles", digest: "# Digest" });

  expect(paths).toEqual({
    json: "daily/2026/09/08.json",
    articles: "daily/2026/09/08.md",
    digest: "daily/2026/09/08-digest.md"
  });
  expect(JSON.parse(await readFile(join(dataRoot, paths.json), "utf8"))).toEqual(record);
  expect(await readFile(join(dataRoot, paths.articles), "utf8")).toBe("# Articles");
  expect(await readFile(join(dataRoot, paths.digest), "utf8")).toBe("# Digest");
  expect(JSON.parse(await readFile(join(dataRoot, "latest.json"), "utf8"))).toEqual({
    date: "2026-09-08",
    runId: store.runId,
    path: paths.json
  });
  const archive = JSON.parse(await readFile(join(dataRoot, "archive.json"), "utf8"));
  expect(archive).toEqual([
    { date: "2026-09-08", path: paths.json, runId: store.runId, storyCount: 2 },
    { date: "2026-09-07", path: "daily/2026/09/07.json", runId: "old", storyCount: 19 }
  ]);
  expect((await listFiles(dataRoot)).filter(file => file.endsWith(".tmp"))).toEqual([]);
});

test("a backfill of an older date leaves latest.json pointing at the newest day", async () => {
  const dataRoot = await root();
  const newer = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  await publishDaily(newer, briefing(newer.runId, "2026-09-08", 2), { articles: "a", digest: "d" });
  const older = await createRunStore(dataRoot, "2026-09-07T070000-0400");
  await publishDaily(older, briefing(older.runId, "2026-09-07", 1), { articles: "a", digest: "d" });

  expect(JSON.parse(await readFile(join(dataRoot, "latest.json"), "utf8"))).toEqual({
    date: "2026-09-08",
    runId: newer.runId,
    path: "daily/2026/09/08.json"
  });
  expect(await readFile(join(dataRoot, "daily/2026/09/07.md"), "utf8")).toBe("a");
  const archive = JSON.parse(await readFile(join(dataRoot, "archive.json"), "utf8"));
  expect(archive.map((entry: { date: string }) => entry.date)).toEqual(["2026-09-08", "2026-09-07"]);
});

test("republishing the same date replaces its archive entry instead of duplicating it", async () => {
  const dataRoot = await root();
  const first = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  await publishDaily(first, briefing(first.runId, "2026-09-08", 1), { articles: "a", digest: "d" });
  const second = await createRunStore(dataRoot, "2026-09-08T090000-0400");
  await publishDaily(second, briefing(second.runId, "2026-09-08", 3), { articles: "a2", digest: "d2" });

  const archive = JSON.parse(await readFile(join(dataRoot, "archive.json"), "utf8"));
  expect(archive).toEqual([
    { date: "2026-09-08", path: "daily/2026/09/08.json", runId: second.runId, storyCount: 3 }
  ]);
  expect(await readFile(join(dataRoot, "daily/2026/09/08.md"), "utf8")).toBe("a2");
});

test("run store writes inside the run directory and rejects escaping paths", async () => {
  const dataRoot = await root();
  const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  expect(store.runDir).toBe(join(dataRoot, "runs", "2026-09-08T070000-0400"));

  await store.writeJson("hn/top-stories.json", { hits: [] });
  expect(JSON.parse(await readFile(join(store.runDir, "hn/top-stories.json"), "utf8"))).toEqual({ hits: [] });

  await expect(store.writeJson("../outside.json", {})).rejects.toThrow();
  await expect(stat(join(dataRoot, "runs", "outside.json"))).rejects.toThrow();
  await expect(store.writeJson(join(dataRoot, "absolute.json"), {})).rejects.toThrow();
});

test("publication leaves every file unchanged when archive.json is corrupt", async () => {
  // Invalid JSON, and valid JSON whose entry would sort ahead of the new date and silently skip latest.json.
  for (const corrupt of ["{not json", '[{"date":"not-a-date","path":"x","runId":"y"}]']) {
    const dataRoot = await root();
    await writeFile(join(dataRoot, "archive.json"), corrupt);
    const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
    const before = await listFiles(dataRoot);
    await expect(publishDaily(store, briefing(store.runId, "2026-09-08"), { articles: "a", digest: "d" })).rejects.toThrow(/JSON|Invalid archive/);
    expect(await readFile(join(dataRoot, "archive.json"), "utf8")).toBe(corrupt);
    expect(await listFiles(dataRoot)).toEqual(before);
  }
});

test("publication rejects impossible calendar dates before writing anything", async () => {
  const dataRoot = await root();
  const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  const before = await listFiles(dataRoot);
  for (const date of ["2026-02-30", "2026-13-45"]) {
    await expect(publishDaily(store, briefing(store.runId, date), { articles: "a", digest: "d" })).rejects.toThrow("Invalid briefing date");
  }
  expect(await listFiles(dataRoot)).toEqual(before);
});

test("a run store refuses to reuse an existing run directory", async () => {
  const dataRoot = await root();
  const first = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  await first.writeJson("hn/top-stories.json", { hits: ["first"] });
  await expect(createRunStore(dataRoot, "2026-09-08T070000-0400")).rejects.toThrow();
  expect(JSON.parse(await readFile(join(first.runDir, "hn/top-stories.json"), "utf8"))).toEqual({ hits: ["first"] });
});

test("publication rejects a record from a different run", async () => {
  const dataRoot = await root();
  const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  await expect(publishDaily(store, briefing("other-run", "2026-09-08"), { articles: "a", digest: "d" })).rejects.toThrow("does not match");
  await expect(stat(join(dataRoot, "latest.json"))).rejects.toThrow();
});
