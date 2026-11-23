import type { LLMConfig, ProcessedStory } from "../../shared/summarizer-core";

export interface PipelineQuality {
  storyFailures: number;
  storyCount: number;
  digestValid: boolean;
}

export interface DailyBriefing {
  schemaVersion: 1;
  date: string;
  generatedAt: string;
  runId: string;
  source: { kind: "hacker-news"; query: "last-24-hours"; windowStart: string; windowEnd: string };
  model: { provider: string; endpoint: string; name: string };
  digest: string;
  stories: ProcessedStory[];
  quality: PipelineQuality;
}

export interface ArchiveEntry {
  date: string;
  path: string;
  runId: string;
  storyCount: number;
}

export interface StageTiming {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
}

export interface InferenceStats {
  requestCount: number;
  elapsedMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface PipelineManifest {
  schemaVersion: 1;
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  completedAt?: string;
  source: { query: "last-24-hours"; windowStart: string; windowEnd: string };
  model: { provider: string; endpoint: string; name: string };
  stages: Partial<Record<"fetch" | "summarize" | "digest" | "publish", StageTiming>>;
  inference: InferenceStats;
  quality?: PipelineQuality;
  error?: { name: string; message: string };
  finalPaths?: { json: string; articles: string; digest: string };
}

export interface GenerateConfig {
  dataRoot: string;
  timeZone: string;
  llm: LLMConfig;
  providerName: string;
}
