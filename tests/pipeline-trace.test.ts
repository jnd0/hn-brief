import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMTraceScope } from "../shared/summarizer-core";
import { createRunStore, type RunStore } from "../scripts/pipeline/storage";
import { createFilesystemTraceRecorder } from "../scripts/pipeline/trace";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempStore(): Promise<RunStore> {
  const root = await mkdtemp(join(tmpdir(), "hn-brief-trace-"));
  roots.push(root);
  return createRunStore(root, "2026-09-08T070000-0400");
}

async function readJson(store: RunStore, relativePath: string): Promise<any> {
  return JSON.parse(await readFile(join(store.runDir, relativePath), "utf8"));
}

const story42: LLMTraceScope = { operation: "story", storyId: "42" };

test("maps attempts to base and numbered filenames and accumulates stats", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  await recorder.sink({ type: "request", scope: story42, body: { model: "a" }, recordedAt: "2026-09-08T11:00:00.000Z" });
  await recorder.sink({ type: "response", scope: story42, body: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }, elapsedMs: 10, recordedAt: "2026-09-08T11:00:00.010Z" });
  await recorder.sink({ type: "request", scope: story42, body: { model: "b" }, recordedAt: "2026-09-08T11:00:01.000Z" });
  await recorder.sink({ type: "response", scope: story42, body: { choices: [{ index: 0 }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }, elapsedMs: 12, recordedAt: "2026-09-08T11:00:01.012Z" });
  await recorder.sink({ type: "parsed", scope: story42, body: { summary: "ok" }, qualityFailure: false, recordedAt: "2026-09-08T11:00:01.013Z" });

  expect(await readJson(store, "llm/stories/42/request.json")).toMatchObject({ model: "a" });
  expect(await readJson(store, "llm/stories/42/response.json")).toEqual({
    recordedAt: "2026-09-08T11:00:00.010Z",
    elapsedMs: 10,
    body: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
  });
  expect(await readJson(store, "llm/stories/42/attempt-02-request.json")).toMatchObject({ model: "b" });
  expect(await readJson(store, "llm/stories/42/attempt-02-response.json")).toMatchObject({ elapsedMs: 12, body: { choices: [{ index: 0 }] } });
  expect(await readJson(store, "llm/stories/42/parsed.json")).toEqual({
    recordedAt: "2026-09-08T11:00:01.013Z",
    qualityFailure: false,
    body: { summary: "ok" }
  });
  expect(recorder.snapshot()).toEqual({
    requestCount: 2,
    elapsedMs: 22,
    usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 }
  });
});

test("records errors, including network failures and 200 responses with bad bodies", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  const digest: LLMTraceScope = { operation: "digest" };
  await recorder.sink({ type: "request", scope: digest, body: { model: "a" }, recordedAt: "t1" });
  await recorder.sink({ type: "error", scope: digest, message: "fetch failed", elapsedMs: 5, recordedAt: "t2" });
  await recorder.sink({ type: "request", scope: digest, body: { model: "a" }, recordedAt: "t3" });
  await recorder.sink({ type: "error", scope: digest, message: "bad json", status: 200, body: "<html>", elapsedMs: 7, recordedAt: "t4" });

  expect(await readJson(store, "llm/digest/error.json")).toEqual({ recordedAt: "t2", elapsedMs: 5, message: "fetch failed" });
  expect(await readJson(store, "llm/digest/attempt-02-error.json")).toEqual({
    recordedAt: "t4",
    elapsedMs: 7,
    status: 200,
    message: "bad json",
    body: "<html>"
  });
  expect(recorder.snapshot()).toEqual({ requestCount: 2, elapsedMs: 12, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
});

test("pairs interleaved events from parallel stories with their own attempts", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  const story7: LLMTraceScope = { operation: "story", storyId: "7" };
  await Promise.all([
    recorder.sink({ type: "request", scope: story42, body: { n: "42-1" }, recordedAt: "t" }),
    recorder.sink({ type: "request", scope: story7, body: { n: "7-1" }, recordedAt: "t" })
  ]);
  await Promise.all([
    recorder.sink({ type: "error", scope: story42, message: "boom", elapsedMs: 1, recordedAt: "t" }),
    recorder.sink({ type: "response", scope: story7, body: { n: "7-1" }, elapsedMs: 2, recordedAt: "t" })
  ]);
  await Promise.all([
    recorder.sink({ type: "request", scope: story42, body: { n: "42-2" }, recordedAt: "t" }),
    recorder.sink({ type: "request", scope: story7, body: { n: "7-2" }, recordedAt: "t" })
  ]);
  await Promise.all([
    recorder.sink({ type: "response", scope: story7, body: { n: "7-2" }, elapsedMs: 4, recordedAt: "t" }),
    recorder.sink({ type: "response", scope: story42, body: { n: "42-2" }, elapsedMs: 3, recordedAt: "t" })
  ]);

  expect((await readdir(join(store.runDir, "llm/stories/7"))).sort()).toEqual([
    "attempt-02-request.json",
    "attempt-02-response.json",
    "request.json",
    "response.json"
  ]);
  expect((await readdir(join(store.runDir, "llm/stories/42"))).sort()).toEqual([
    "attempt-02-request.json",
    "attempt-02-response.json",
    "error.json",
    "request.json"
  ]);
  expect(await readJson(store, "llm/stories/7/attempt-02-request.json")).toEqual({ n: "7-2" });
  expect(await readJson(store, "llm/stories/7/attempt-02-response.json")).toMatchObject({ body: { n: "7-2" } });
  expect(await readJson(store, "llm/stories/42/attempt-02-request.json")).toEqual({ n: "42-2" });
  expect(await readJson(store, "llm/stories/42/attempt-02-response.json")).toMatchObject({ body: { n: "42-2" } });
  expect(recorder.snapshot()).toMatchObject({ requestCount: 4, elapsedMs: 10 });
});

test("an error after a response on the same attempt is written but its elapsed time counts once", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  await recorder.sink({ type: "request", scope: story42, body: { model: "a" }, recordedAt: "t" });
  await recorder.sink({ type: "response", scope: story42, body: { error: { message: "overloaded" } }, elapsedMs: 50, recordedAt: "t" });
  await recorder.sink({ type: "error", scope: story42, message: "overloaded", status: 200, body: { error: { message: "overloaded" } }, elapsedMs: 50, recordedAt: "t" });
  await recorder.sink({ type: "request", scope: story42, body: { model: "a" }, recordedAt: "t" });
  await recorder.sink({ type: "error", scope: story42, message: "fetch failed", elapsedMs: 20, recordedAt: "t" });

  expect((await readdir(join(store.runDir, "llm/stories/42"))).sort()).toEqual([
    "attempt-02-error.json",
    "attempt-02-request.json",
    "error.json",
    "request.json",
    "response.json"
  ]);
  expect(await readJson(store, "llm/stories/42/error.json")).toMatchObject({ status: 200, message: "overloaded" });
  expect(recorder.snapshot()).toMatchObject({ requestCount: 2, elapsedMs: 70 });
});

test("writes events without a preceding request as attempt 1", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  await recorder.sink({ type: "response", scope: story42, body: { ok: true }, elapsedMs: 4, recordedAt: "t" });
  expect(await readJson(store, "llm/stories/42/response.json")).toMatchObject({ body: { ok: true } });
  expect(recorder.snapshot()).toMatchObject({ requestCount: 0, elapsedMs: 4 });
});

test("rejects story IDs that are not digits", async () => {
  const store = await tempStore();
  for (const storyId of ["4/2", "..", "", "42a"]) {
    const recorder = createFilesystemTraceRecorder(store);
    await expect(
      recorder.sink({ type: "request", scope: { operation: "story", storyId }, body: {}, recordedAt: "t" })
    ).rejects.toThrow();
  }
  expect(await readdir(store.runDir)).toEqual([]);
});

test("ignores missing or non-numeric usage fields", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  await recorder.sink({ type: "response", scope: story42, body: { usage: { prompt_tokens: "10", completion_tokens: 3 } }, elapsedMs: 1, recordedAt: "t" });
  await recorder.sink({ type: "response", scope: story42, body: "plain text", elapsedMs: 1, recordedAt: "t" });
  await recorder.sink({ type: "response", scope: story42, body: { usage: null }, elapsedMs: 1, recordedAt: "t" });
  expect(recorder.snapshot().usage).toEqual({ promptTokens: 0, completionTokens: 3, totalTokens: 0 });
});

test("snapshot returns a copy", async () => {
  const store = await tempStore();
  const recorder = createFilesystemTraceRecorder(store);
  await recorder.sink({ type: "response", scope: story42, body: { usage: { total_tokens: 5 } }, elapsedMs: 1, recordedAt: "t" });
  const snapshot = recorder.snapshot();
  snapshot.requestCount = 99;
  snapshot.usage.totalTokens = 99;
  expect(recorder.snapshot()).toEqual({ requestCount: 0, elapsedMs: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 5 } });
});

test("rejects every later event after a write failure", async () => {
  const written: string[] = [];
  let failNext = true;
  const store: RunStore = {
    dataRoot: "/unused",
    runId: "run",
    runDir: "/unused/runs/run",
    writeJson: async relativePath => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      written.push(relativePath);
    },
    writeManifest: async () => {}
  };
  const recorder = createFilesystemTraceRecorder(store);
  await expect(recorder.sink({ type: "request", scope: story42, body: {}, recordedAt: "t" })).rejects.toThrow("disk full");
  expect(recorder.snapshot().requestCount).toBe(0);
  await expect(
    recorder.sink({ type: "request", scope: { operation: "story", storyId: "7" }, body: {}, recordedAt: "t" })
  ).rejects.toThrow("disk full");
  await expect(recorder.sink({ type: "parsed", scope: { operation: "digest" }, body: {}, qualityFailure: true, recordedAt: "t" })).rejects.toThrow();
  expect(written).toEqual([]);
});
