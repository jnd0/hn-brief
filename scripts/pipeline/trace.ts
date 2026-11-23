import type { LLMTraceEvent, LLMTraceSink } from "../../shared/summarizer-core";
import type { RunStore } from "./storage";
import type { InferenceStats } from "./types";

export interface FilesystemTraceRecorder {
  sink: LLMTraceSink;
  snapshot(): InferenceStats;
}

function scopeKey(event: LLMTraceEvent): string {
  if (event.scope.operation === "digest") return "digest";
  if (!/^\d+$/.test(event.scope.storyId)) {
    throw new Error(`Invalid story ID for trace path: ${JSON.stringify(event.scope.storyId)}`);
  }
  return `story:${event.scope.storyId}`;
}

function scopeDir(event: LLMTraceEvent): string {
  return event.scope.operation === "digest"
    ? "llm/digest"
    : `llm/stories/${event.scope.storyId}`;
}

function attemptFile(attempt: number, kind: "request" | "response" | "error"): string {
  return attempt <= 1 ? `${kind}.json` : `attempt-${String(attempt).padStart(2, "0")}-${kind}.json`;
}

function usageNumber(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Persists LLM trace events under the run directory; once a call throws, every later call rejects with that error. */
export function createFilesystemTraceRecorder(store: RunStore): FilesystemTraceRecorder {
  const attempts = new Map<string, number>();
  // `${key}#${attempt}` for attempts that recorded a response; a following error on the same attempt shares its elapsed time.
  const responded = new Set<string>();
  const stats: InferenceStats = {
    requestCount: 0,
    elapsedMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  };
  let failure: unknown;

  async function record(event: LLMTraceEvent): Promise<void> {
    const key = scopeKey(event);
    const dir = scopeDir(event);
    // Attempt numbers are assigned synchronously so interleaved scopes stay paired.
    if (event.type === "request") attempts.set(key, (attempts.get(key) ?? 0) + 1);
    const attempt = attempts.get(key) ?? 1;

    switch (event.type) {
      case "request":
        await store.writeJson(`${dir}/${attemptFile(attempt, "request")}`, event.body);
        stats.requestCount++;
        return;
      case "response": {
        responded.add(`${key}#${attempt}`);
        stats.elapsedMs += event.elapsedMs;
        const body = event.body as { usage?: unknown } | null;
        const usage = typeof body === "object" && body !== null ? body.usage : undefined;
        if (typeof usage === "object" && usage !== null) {
          const fields = usage as Record<string, unknown>;
          stats.usage.promptTokens += usageNumber(fields, "prompt_tokens");
          stats.usage.completionTokens += usageNumber(fields, "completion_tokens");
          stats.usage.totalTokens += usageNumber(fields, "total_tokens");
        }
        await store.writeJson(`${dir}/${attemptFile(attempt, "response")}`, {
          recordedAt: event.recordedAt,
          elapsedMs: event.elapsedMs,
          body: event.body
        });
        return;
      }
      case "error":
        if (!responded.has(`${key}#${attempt}`)) stats.elapsedMs += event.elapsedMs;
        await store.writeJson(`${dir}/${attemptFile(attempt, "error")}`, {
          recordedAt: event.recordedAt,
          elapsedMs: event.elapsedMs,
          status: event.status,
          message: event.message,
          body: event.body
        });
        return;
      case "parsed":
        await store.writeJson(`${dir}/parsed.json`, {
          recordedAt: event.recordedAt,
          qualityFailure: event.qualityFailure,
          body: event.body
        });
        return;
    }
  }

  return {
    sink: async event => {
      if (failure !== undefined) throw failure;
      try {
        await record(event);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    },
    snapshot: () => ({ ...stats, usage: { ...stats.usage } })
  };
}
