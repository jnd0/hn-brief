import {
  fetchStoryDetails,
  fetchTopStories,
  formatArticleMarkdown,
  formatDigestMarkdown,
  generateDigest,
  isDigestFailureText,
  needsStoryRepair,
  processStoriesWithRateLimit,
  type AlgoliaHit,
  type LLMConfig,
  type LLMTraceSink,
  type ProcessedStory,
  type StoryDetails
} from "../../shared/summarizer-core";
import { acquireDataLock, createRunStore, formatRunId, publishDaily, type RunStore } from "./storage";
import { createFilesystemTraceRecorder, type FilesystemTraceRecorder } from "./trace";
import type { DailyBriefing, GenerateConfig, InferenceStats, PipelineManifest } from "./types";

export interface GenerationDependencies {
  now(): Date;
  fetchTopStories(): Promise<AlgoliaHit[]>;
  fetchStoryDetails(id: string): Promise<StoryDetails>;
  processStories(
    entries: { hit: AlgoliaHit; details: StoryDetails }[],
    config: LLMConfig,
    trace: LLMTraceSink
  ): Promise<ProcessedStory[]>;
  generateDigest(stories: ProcessedStory[], config: LLMConfig, trace: LLMTraceSink): Promise<string>;
}

const MAX_STORY_FAILURES = 12;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const defaultDependencies: GenerationDependencies = {
  now: () => new Date(),
  fetchTopStories: () => fetchTopStories(),
  fetchStoryDetails: id => fetchStoryDetails(id),
  processStories: (entries, config, trace) => processStoriesWithRateLimit(entries, config, { trace }),
  generateDigest: (stories, config, trace) => generateDigest(stories, config, undefined, trace)
};

function emptyInferenceStats(): InferenceStats {
  return { requestCount: 0, elapsedMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
}

function formatBriefingDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function sourceWindow(startedAt: Date) {
  return {
    query: "last-24-hours" as const,
    windowStart: new Date(startedAt.getTime() - WINDOW_MS).toISOString(),
    windowEnd: startedAt.toISOString()
  };
}

function modelInfo(config: GenerateConfig) {
  return { provider: config.providerName, endpoint: redactEndpoint(config.llm.apiUrl), name: config.llm.model };
}

/** Drops URL userinfo, query, and fragment so a credential-bearing LLM_API_URL is never persisted. */
function redactEndpoint(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid URL]";
  }
}

function createRunningManifest(config: GenerateConfig, runId: string, startedAt: Date): PipelineManifest {
  return {
    schemaVersion: 1,
    runId,
    status: "running",
    startedAt: startedAt.toISOString(),
    source: sourceWindow(startedAt),
    model: modelInfo(config),
    stages: {},
    inference: emptyInferenceStats()
  };
}

function createDailyBriefing(
  config: GenerateConfig,
  runId: string,
  startedAt: Date,
  generatedAt: Date,
  stories: ProcessedStory[],
  digest: string
): DailyBriefing {
  return {
    schemaVersion: 1,
    date: formatBriefingDate(startedAt, config.timeZone),
    generatedAt: generatedAt.toISOString(),
    runId,
    source: { kind: "hacker-news", ...sourceWindow(startedAt) },
    model: modelInfo(config),
    digest,
    stories,
    quality: { storyFailures: stories.filter(needsStoryRepair).length, storyCount: stories.length, digestValid: true }
  };
}

/** Runs `work`, records its wall-clock timing in the manifest, and rewrites the manifest whether it succeeds or throws. */
async function runStage<T>(
  manifest: PipelineManifest,
  store: RunStore,
  stage: keyof PipelineManifest["stages"],
  now: () => Date,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = now();
  const begin = performance.now();
  const record = async () => {
    manifest.stages[stage] = {
      startedAt: startedAt.toISOString(),
      completedAt: now().toISOString(),
      elapsedMs: Math.round(performance.now() - begin)
    };
    await store.writeManifest(manifest);
  };
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await record().catch(() => undefined);
    throw error;
  }
  await record();
  return result;
}

/** Runs every task to completion and only then rethrows the first failure, so no work is in flight afterwards. */
async function settleAll<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const settled = await Promise.allSettled(items.map(task));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map(r => (r as PromiseFulfilledResult<R>).value);
}

export async function runGeneration(
  config: GenerateConfig,
  overrides: Partial<GenerationDependencies> = {}
): Promise<DailyBriefing> {
  const deps: GenerationDependencies = { ...defaultDependencies, ...overrides };
  const startedAt = deps.now();
  const release = await acquireDataLock(config.dataRoot, startedAt);
  let store: RunStore | undefined;
  let manifest: PipelineManifest | undefined;
  let recorder: FilesystemTraceRecorder | undefined;
  try {
    const runId = formatRunId(startedAt, config.timeZone);
    store = await createRunStore(config.dataRoot, runId);
    recorder = createFilesystemTraceRecorder(store);
    manifest = createRunningManifest(config, runId, startedAt);
    await store.writeManifest(manifest);
    const runStore = store;
    const trace = recorder;

    const entries = await runStage(manifest, store, "fetch", deps.now, async () => {
      const hits = await deps.fetchTopStories();
      if (hits.length === 0) throw new Error("No stories returned");
      await runStore.writeJson("hn/top-stories.json", hits);
      return settleAll(hits, async hit => {
        if (!/^\d+$/.test(hit.objectID)) throw new Error(`Invalid HN story ID: ${hit.objectID}`);
        const details = await deps.fetchStoryDetails(hit.objectID);
        await runStore.writeJson(`hn/stories/${hit.objectID}.json`, details);
        return { hit, details };
      });
    });

    const stories = await runStage(manifest, store, "summarize", deps.now, () =>
      deps.processStories(entries, config.llm, trace.sink)
    );
    const storyFailures = stories.filter(needsStoryRepair).length;
    if (storyFailures > MAX_STORY_FAILURES) {
      throw new Error(`Too many story failures: ${storyFailures}/${stories.length}`);
    }

    const digest = await runStage(manifest, store, "digest", deps.now, () =>
      deps.generateDigest(stories, config.llm, trace.sink)
    );
    if (!digest.trim()) throw new Error("Digest generation returned empty text");
    if (isDigestFailureText(digest)) throw new Error(digest);

    const daily = createDailyBriefing(config, runId, startedAt, deps.now(), stories, digest);
    const paths = await runStage(manifest, store, "publish", deps.now, () =>
      publishDaily(runStore, daily, {
        articles: formatArticleMarkdown(stories, daily.date),
        digest: formatDigestMarkdown(digest, daily.date, stories.length)
      })
    );
    manifest = {
      ...manifest,
      status: "complete",
      completedAt: deps.now().toISOString(),
      quality: daily.quality,
      inference: recorder.snapshot(),
      finalPaths: paths
    };
    await store.writeManifest(manifest);
    return daily;
  } catch (error) {
    if (store && manifest) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await store.writeManifest({
        ...manifest,
        status: "failed",
        completedAt: deps.now().toISOString(),
        inference: recorder?.snapshot() ?? emptyInferenceStats(),
        error: { name: normalized.name, message: normalized.message },
        finalPaths: undefined
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await release();
  }
}
