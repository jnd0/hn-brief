import { expect, mock, test } from "bun:test";
import {
  generateDigest,
  LLMTraceSinkError,
  processStoriesWithRateLimit,
  summarizeStory,
  type AlgoliaHit,
  type LLMConfig,
  type LLMTraceEvent
} from "../shared/summarizer-core";

const config: LLMConfig = {
  apiKey: "must-not-appear",
  apiUrl: "http://llm.test/v1/chat/completions",
  model: "small-model",
  provider: "openai-compatible",
  thinking: false
};

const hit: AlgoliaHit = {
  objectID: "42",
  title: "Asymmetric fixture",
  url: "https://example.test/story",
  points: 91,
  num_comments: 17,
  created_at_i: 1
};

const raw = {
  choices: [{ finish_reason: "stop", message: { content: "<Content Summary>Specific result.</Content Summary><Discussion Summary>Distinct discussion.</Discussion Summary>" } }],
  usage: { prompt_tokens: 111, completion_tokens: 37, total_tokens: 148 },
  timings: { prompt_ms: 20, predicted_ms: 40 }
};

const okFetcher = () => mock(async () => new Response(JSON.stringify(raw), {
  status: 200,
  headers: { "content-type": "application/json" }
}));

test("story tracing records request, raw response, parsed output, and timing without credentials", async () => {
  const events: LLMTraceEvent[] = [];
  const fetcher = mock(async () => {
    await Bun.sleep(20);
    return new Response(JSON.stringify(raw), { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await summarizeStory(hit, [], config, fetcher, undefined, async event => { events.push(event); });

  expect(result.summary).toBe("Specific result.");
  expect(events.map(event => event.type)).toEqual(["request", "response", "parsed"]);
  expect(events[0]).toMatchObject({ type: "request", scope: { operation: "story", storyId: "42" } });
  expect(events[1]).toMatchObject({ type: "response", body: raw });
  expect(JSON.stringify(events)).not.toContain("must-not-appear");
  expect(JSON.stringify(events)).not.toContain("llm.test");
  expect((events[1] as Extract<LLMTraceEvent, { type: "response" }>).elapsedMs).toBeGreaterThanOrEqual(15);
});

test("digest tracing uses digest scope and retains provider errors", async () => {
  const events: LLMTraceEvent[] = [];
  const fetcher = mock(async () => new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
    status: 503,
    headers: { "content-type": "application/json" }
  }));

  const result = await generateDigest([], config, fetcher, async event => { events.push(event); });

  expect(result).toContain("failed");
  expect(events[0]).toMatchObject({ type: "request", scope: { operation: "digest" } });
  expect(events[1]).toMatchObject({
    type: "error",
    scope: { operation: "digest" },
    status: 503,
    body: { error: { message: "model unavailable" } }
  });
  expect(JSON.stringify(events)).not.toContain("must-not-appear");
});

test("a failing trace sink rejects the batch instead of producing an API error story", async () => {
  const fetcher = okFetcher();
  const run = processStoriesWithRateLimit(
    [{ hit, details: { id: hit.objectID, title: hit.title, points: hit.points, children: [] } }],
    config,
    {
      storyDelayMs: 0,
      batchDelayMs: 0,
      fetcher,
      logger: { info: () => {}, error: () => {} },
      trace: event => { if (event.type === "response") throw new Error("disk full"); }
    }
  );

  await expect(run).rejects.toBeInstanceOf(LLMTraceSinkError);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a body read failure on a traced response is recorded as an error event", async () => {
  const events: LLMTraceEvent[] = [];
  const fetcher = mock(async () => ({
    ok: true,
    status: 200,
    text: async () => { throw new Error("socket reset"); }
  }) as unknown as Response);

  await summarizeStory(hit, [], config, fetcher, undefined, async event => { events.push(event); });

  expect(events.map(event => event.type)).toEqual(["request", "error"]);
  expect(events[1]).toMatchObject({ type: "error", scope: { operation: "story" }, message: "socket reset", status: 200 });
});

test("a body read failure on a traced error response is recorded before the API error", async () => {
  const events: LLMTraceEvent[] = [];
  const fetcher = mock(async () => ({
    ok: false,
    status: 502,
    text: async () => { throw new Error("connection dropped"); }
  }) as unknown as Response);

  await summarizeStory(hit, [], config, fetcher, undefined, async event => { events.push(event); });

  expect(events.map(event => event.type)).toEqual(["request", "error"]);
  expect(events[1]).toMatchObject({ type: "error", message: "connection dropped", status: 502 });
});

test("untraced summarizeStory makes exactly one fetch", async () => {
  const fetcher = okFetcher();

  const result = await summarizeStory(hit, [], config, fetcher);

  expect(result.summary).toBe("Specific result.");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
