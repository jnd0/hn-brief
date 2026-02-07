import { describe, expect, test, mock, spyOn } from "bun:test";
import {
  detectPostType,
  parseSummaryResponse,
  isLowQualitySummaryText,
  needsStoryRepair,
  formatArticleMarkdown,
  parseArticleMarkdownStories,
  replaceStoriesInArticleMarkdown,
  findRepairableStoryIdsInMarkdown,
  scoreComment,
  selectAndFormatComments,
  createLLMConfig,
  resolveLLMConfigWithFallback,
  summarizeStory,
  processStoriesWithRateLimit,
  type Comment,
  type CommentMetadata,
  type LLMEnv,
  type AlgoliaHit,
  type LLMConfig
} from "../shared/summarizer-core";

describe("Utility Functions", () => {
  describe("detectPostType", () => {
    test("detects Ask HN", () => {
      expect(detectPostType("Ask HN: Who is hiring?")).toBe("ask_hn");
      expect(detectPostType("Ask HN : Space in colon")).toBe("ask_hn");
      expect(detectPostType("ask hn: lowercase")).toBe("ask_hn");
    });

    test("detects Show HN", () => {
      expect(detectPostType("Show HN: My Project")).toBe("show_hn");
      expect(detectPostType("Show HN : Space")).toBe("show_hn");
    });

    test("detects Tell HN", () => {
      expect(detectPostType("Tell HN: Something")).toBe("tell_hn");
    });

    test("detects Launch HN", () => {
      expect(detectPostType("Launch HN: Startup")).toBe("launch_hn");
    });

    test("defaults to Article", () => {
      expect(detectPostType("Just a normal title")).toBe("article");
      expect(detectPostType("ASK HN: Upper")).toBe("ask_hn");
    });
  });

  describe("parseSummaryResponse", () => {
    test("parses correct XML format", () => {
      const input = `
<Content Summary>
This is the content summary.
</Content Summary>

<Discussion Summary>
This is the discussion summary.
</Discussion Summary>
      `;
      const result = parseSummaryResponse(input);
      expect(result.summary).toBe("This is the content summary.");
      expect(result.discussion).toBe("This is the discussion summary.");
    });

    test("handles extra whitespace", () => {
      const input = `
      <Content Summary>  Trim me  </Content Summary>
      <Discussion Summary>  Trim me too  </Discussion Summary>
      `;
      const result = parseSummaryResponse(input);
      expect(result.summary).toBe("Trim me");
      expect(result.discussion).toBe("Trim me too");
    });

    test("falls back when Discussion Summary tag is missing but content exists", () => {
      const input = `
<Content Summary>
Content part.
</Content Summary>

Here is the discussion without tags. It is long enough to be caught.
It needs to be over 50 chars so I am typing more words here to ensure it is picked up.
      `;
      const result = parseSummaryResponse(input);
      expect(result.summary).toBe("Content part.");
      expect(result.discussion).toContain("Here is the discussion");
    });

    test("returns error messages on complete failure", () => {
      const input = "Garbage output";
      const result = parseSummaryResponse(input);
      expect(result.summary).toBe("Summary unavailable.");
      expect(result.discussion).toBe("Discussion unavailable.");
    });
  });

  describe("repair detection helpers", () => {
    test("isLowQualitySummaryText catches placeholders", () => {
      expect(isLowQualitySummaryText("...")).toBe(true);
      expect(isLowQualitySummaryText("and")).toBe(true);
      expect(isLowQualitySummaryText("A detailed explanation with actual content.")).toBe(false);
    });

    test("isLowQualitySummaryText catches prompt leakage output", () => {
      expect(
        isLowQualitySummaryText(
          "You MUST provide BOTH summaries in exactly this XML format <Content Summary> ... <Discussion Summary>"
        )
      ).toBe(true);
    });

    test("needsStoryRepair combines hard failures and placeholders", () => {
      expect(needsStoryRepair({ summary: "API error: 524", discussion_summary: "ok" })).toBe(true);
      expect(needsStoryRepair({ summary: "...", discussion_summary: "Reasonable discussion" })).toBe(true);
      expect(needsStoryRepair({ summary: "Complete summary", discussion_summary: "Complete discussion" })).toBe(false);
    });
  });

  describe("article markdown story patching", () => {
    test("parseArticleMarkdownStories extracts stories", () => {
      const md = formatArticleMarkdown([
        {
          id: "1",
          title: "Story One",
          url: "https://example.com/1",
          points: 100,
          num_comments: 50,
          summary: "First summary",
          discussion_summary: "First discussion",
          postType: "article"
        },
        {
          id: "2",
          title: "Story Two",
          url: "https://example.com/2",
          points: 80,
          num_comments: 30,
          summary: "Second summary",
          discussion_summary: "Second discussion",
          postType: "show_hn"
        }
      ], "2026-02-06");

      const parsed = parseArticleMarkdownStories(md);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.id).toBe("1");
      expect(parsed[1]?.id).toBe("2");
      expect(parsed[1]?.postType).toBe("show_hn");
    });

    test("parseArticleMarkdownStories keeps legacy blocks without ID", () => {
      const md = [
        "# Hacker News Summary - 2026-02-06",
        "",
        "## [Legacy Story](https://example.com/legacy)",
        "**Score:** 42 | **Comments:** 12",
        "",
        "> **Article:** Legacy summary",
        ">",
        "> **Discussion:** Legacy discussion",
        "",
        "---",
        ""
      ].join("\n");

      const parsed = parseArticleMarkdownStories(md);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.title).toBe("Legacy Story");
      expect(parsed[0]?.id).toBe("");
    });

    test("findRepairableStoryIdsInMarkdown skips repair candidates without IDs", () => {
      const md = [
        "# Hacker News Summary - 2026-02-06",
        "",
        "## [Legacy Story](https://example.com/legacy)",
        "**Score:** 42 | **Comments:** 12",
        "",
        "> **Article:** ...",
        ">",
        "> **Discussion:** ...",
        "",
        "---",
        ""
      ].join("\n");

      expect(findRepairableStoryIdsInMarkdown(md)).toEqual([]);
    });

    test("replaceStoriesInArticleMarkdown updates only selected IDs", () => {
      const md = formatArticleMarkdown([
        {
          id: "1",
          title: "Story One",
          url: "https://example.com/1",
          points: 100,
          num_comments: 50,
          summary: "Original one",
          discussion_summary: "Discussion one",
          postType: "article"
        },
        {
          id: "2",
          title: "Story Two",
          url: "https://example.com/2",
          points: 80,
          num_comments: 30,
          summary: "Original two",
          discussion_summary: "Discussion two",
          postType: "article"
        }
      ], "2026-02-06");

      const replacement = {
        id: "2",
        title: "Story Two",
        url: "https://example.com/2",
        points: 80,
        num_comments: 30,
        summary: "Updated summary two",
        discussion_summary: "Updated discussion two",
        postType: "article" as const
      };

      const patched = replaceStoriesInArticleMarkdown(md, { "2": replacement });
      expect(patched.updatedIds).toEqual(["2"]);
      expect(patched.missingIds).toEqual([]);

      const parsed = parseArticleMarkdownStories(patched.markdown);
      expect(parsed[0]?.summary).toBe("Original one");
      expect(parsed[1]?.summary).toBe("Updated summary two");
    });
  });

  describe("Comment Scoring & Selection", () => {
    const mockComment: Comment = {
      id: "1",
      author: "user1",
      text: "This is a comment.",
      children: []
    };

    const mockMeta: CommentMetadata = {
      comment: mockComment,
      depth: 0,
      descendantCount: 0,
      directReplyCount: 0,
      textLength: 20,
      uniqueAuthorCount: 1,
      rootId: "1",
      parentId: null,
      score: 0
    };

    test("scoreComment calculates valid score", () => {
      const score = scoreComment(mockMeta);
      expect(typeof score).toBe("number");
      // Basic check: score should be positive for non-zero metrics
      const betterMeta = { ...mockMeta, descendantCount: 10, directReplyCount: 5 };
      expect(scoreComment(betterMeta)).toBeGreaterThan(scoreComment(mockMeta));
    });

    test("selectAndFormatComments handles empty input", () => {
      expect(selectAndFormatComments([], { maxChars: 1000, perRootCap: 1 })).toBe("No comments available.");
    });

    test("selectAndFormatComments respects budget", () => {
      const comments: Comment[] = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        author: `user${i}`,
        text: `Long comment text to take up space `.repeat(10), // ~300 chars
        children: []
      }));

      const output = selectAndFormatComments(comments, { maxChars: 500, perRootCap: 10 });
      expect(output.length).toBeLessThanOrEqual(500);
    });
  });
});

describe("LLM Configuration", () => {
  test("createLLMConfig prioritizes OpenRouter", () => {
    const env: LLMEnv = {
      OPENROUTER_API_KEY: "openrouter-key",
      CEBRAS_API_KEY: "cebras-key",
      NVIDIA_API_KEY: "nvidia-key"
    };
    const { provider } = createLLMConfig(env);
    expect(provider).toBe("OpenRouter");
  });

  test("createLLMConfig falls back to Cebras when no OpenRouter key", () => {
    const env: LLMEnv = {
      CEBRAS_API_KEY: "cebras-key",
      NVIDIA_API_KEY: "nvidia-key"
    };
    const { provider } = createLLMConfig(env);
    expect(provider).toBe("Cebras");
  });

  test("createLLMConfig falls back to Nvidia", () => {
    const env: LLMEnv = {
      NVIDIA_API_KEY: "nvidia-key"
    };
    const { provider } = createLLMConfig(env);
    expect(provider).toBe("Nvidia NIM");
  });

  test("createLLMConfig falls back to Xiaomi", () => {
    const env: LLMEnv = {
      XIAOMI_API_KEY: "xiaomi-key"
    };
    const { provider } = createLLMConfig(env);
    expect(provider).toBe("Xiaomi MiMo");
  });

  test("createLLMConfig throws if no keys", () => {
    expect(() => createLLMConfig({})).toThrow("No LLM API key found");
  });

  test("resolveLLMConfigWithFallback tries providers in order", async () => {
    const env: LLMEnv = {
      CEBRAS_API_KEY: "cebras-key",
      NVIDIA_API_KEY: "nvidia-key"
    };

    // Mock fetcher that fails Cebras but succeeds Nvidia
    const mockFetcher = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("cerebras")) {
        // Return 500 error for Cebras probe
        return Promise.resolve(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));
      }
      if (url.includes("nvidia")) {
        // Return success for Nvidia probe
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "OK" } }]
        }), { status: 200 }));
      }
      return Promise.reject("Unknown URL");
    });

    const logger = { info: mock(() => {}), error: mock(() => {}) };

    const result = await resolveLLMConfigWithFallback(env, logger, mockFetcher);

    expect(result.provider).toBe("Nvidia NIM");
    expect(result.usedFallback).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Cebras health check failed"));
  });

  test("resolveLLMConfigWithFallback falls back when OpenRouter quota is exceeded", async () => {
    const env: LLMEnv = {
      OPENROUTER_API_KEY: "openrouter-key",
      CEBRAS_API_KEY: "cebras-key"
    };

    const mockFetcher = mock((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("openrouter.ai")) {
        return Promise.resolve(new Response("Rate limit exceeded: free-models-per-day", { status: 429 }));
      }
      if (url.includes("cerebras")) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "OK" } }]
        }), { status: 200 }));
      }
      return Promise.reject("Unknown URL");
    });

    const logger = { info: mock(() => {}), error: mock(() => {}) };
    const result = await resolveLLMConfigWithFallback(env, logger, mockFetcher);

    expect(result.provider).toBe("Cebras");
    expect(result.usedFallback).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("OpenRouter health check failed"));
  });
});

// Helper for valid summary response
const VALID_XML_RESPONSE = `
<Content Summary>
Valid content summary.
</Content Summary>
<Discussion Summary>
Valid discussion summary.
</Discussion Summary>
`;

describe("LLM Interactions & Error Handling", () => {
  const mockStory: AlgoliaHit = {
    objectID: "123",
    title: "Test Story",
    points: 100,
    num_comments: 50,
    created_at_i: 1234567890
  };

  const mockConfig: LLMConfig = {
    apiKey: "test-key",
    apiUrl: "https://api.test/v1/chat/completions",
    model: "test-model",
    provider: "openai-compatible" // simple provider for testing
  };

  test("summarizeStory handles API errors gracefully", async () => {
     // Mock fetch to throw error
     const mockFetcher = mock(() => Promise.resolve(new Response("Gateway Timeout", { status: 524 })));
     const logger = { info: mock(() => {}), error: mock(() => {}) };

     const result = await summarizeStory(mockStory, [], mockConfig, mockFetcher, logger);

     expect(result.summary).toContain("API error");
     expect(result.summary).toContain("524");
     expect(logger.error).toHaveBeenCalled();
  });

  test("summarizeStory handles 429 Rate Limits", async () => {
     const mockFetcher = mock(() => Promise.resolve(new Response("Too Many Requests", { status: 429 })));
     const logger = { info: mock(() => {}), error: mock(() => {}) };

     const result = await summarizeStory(mockStory, [], mockConfig, mockFetcher, logger);

     expect(result.summary).toContain("API error");
     expect(result.summary).toContain("429");
  });

  test("summarizeStory handles 401 Auth Errors", async () => {
     const mockFetcher = mock(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));
     const logger = { info: mock(() => {}), error: mock(() => {}) };

     const result = await summarizeStory(mockStory, [], mockConfig, mockFetcher, logger);

     expect(result.summary).toContain("API error");
     expect(result.summary).toContain("401");
  });

  test("summarizeStory handles empty content but valid reasoning (Nvidia/OpenRouter)", async () => {
     const responseBody = {
       choices: [{
         message: {
           content: null,
           reasoning_content: VALID_XML_RESPONSE
         }
       }]
     };

     const mockFetcher = mock(() => Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 })));

     const result = await summarizeStory(mockStory, [], mockConfig, mockFetcher);
     expect(result.summary).toBe("Valid content summary.");
  });

  test("processStoriesWithRateLimit batches and delays", async () => {
    const stories = [
        { hit: { ...mockStory, objectID: "1" }, details: { id: "1", title: "1", points: 1 } },
        { hit: { ...mockStory, objectID: "2" }, details: { id: "2", title: "2", points: 1 } },
        { hit: { ...mockStory, objectID: "3" }, details: { id: "3", title: "3", points: 1 } },
        { hit: { ...mockStory, objectID: "4" }, details: { id: "4", title: "4", points: 1 } }
    ];

    // Mock fetcher always returns success
    const mockFetcher = mock(() => Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: VALID_XML_RESPONSE } }]
    }), { status: 200 })));

    const logger = { info: mock(() => {}), error: mock(() => {}) };

    // Use small delays to make test fast
    const options = {
        batchSize: 2,
        storyDelayMs: 1,
        batchDelayMs: 1,
        fetcher: mockFetcher,
        logger
    };

    const processed = await processStoriesWithRateLimit(stories, mockConfig, options);

    expect(processed).toHaveLength(4);
    expect(mockFetcher).toHaveBeenCalledTimes(4);
    // Verify batching log calls
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Processing batch 1/2"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Processing batch 2/2"));
  });
});
