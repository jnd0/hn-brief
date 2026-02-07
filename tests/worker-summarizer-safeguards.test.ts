import { describe, expect, test } from "bun:test";

import {
  countFailuresInArticleMarkdown,
  isDigestFailureText,
  isStorySummaryFailure
} from "../shared/summarizer-core";

import { __test__ } from "../workers/summarizer/index";

describe("workers/summarizer safeguards", () => {
  const toBase64Utf8 = (input: string): string => {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  test("isStorySummaryFailure detects common failure strings", () => {
    expect(
      isStorySummaryFailure({
        summary: "API error: API Error 524",
        discussion_summary: "ok"
      } as any)
    ).toBe(true);

    expect(
      isStorySummaryFailure({
        summary: "Summary unavailable.",
        discussion_summary: "ok"
      } as any)
    ).toBe(true);

    expect(
      isStorySummaryFailure({
        summary: "Error generating summary.",
        discussion_summary: "ok"
      } as any)
    ).toBe(true);

    expect(
      isStorySummaryFailure({
        summary: "All good",
        discussion_summary: "All good"
      } as any)
    ).toBe(false);
  });

  test("countFailuresInArticleMarkdown counts failure blocks", () => {
    const md = [
      "> **Article:** API error: API Error 524",
      "> **Discussion:** ok",
      "",
      "> **Article:** Summary unavailable.",
      "> **Discussion:** Error generating summary.",
      "",
      "> **Discussion:** API error: API Error 400"
    ].join("\n");

    expect(countFailuresInArticleMarkdown(md)).toBe(4);
  });

  test("countFailuresInArticleMarkdown treats placeholder lines as failures", () => {
    const md = [
      "> **Article:** ...",
      "> **Discussion:** and"
    ].join("\n");

    expect(countFailuresInArticleMarkdown(md)).toBe(2);
  });

  test("isDigestFailure detects digest failure text", () => {
    expect(isDigestFailureText("Digest generation failed due to API error.")).toBe(true);
    expect(isDigestFailureText("Digest generation failed (empty content).")).toBe(true);
    expect(isDigestFailureText("All good")).toBe(false);
  });

  test("commitToGitHub skips when skipIfWorse triggers", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    try {
      globalThis.fetch = (async (url: any, init?: any) => {
        const method = (init?.method || "GET") as string;
        calls.push({ url: String(url), method });

        if (method === "GET") {
          const body = {
            sha: "sha-prev",
            content: btoa("prev")
          };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        throw new Error("PUT should not be called when skipping as worse");
      }) as any;

      const res = await __test__.commitToGitHub(
        {
          GITHUB_TOKEN: "x",
          REPO_OWNER: "o",
          REPO_NAME: "r"
        } as any,
        "summaries/2026/02/04.md",
        "next",
        "msg",
        undefined,
        {
          skipIfWorse: () => "worse"
        }
      );

      expect(res.action).toBe("unchanged");
      expect(res.reason).toBe("worse");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("commitToGitHub skips when content identical", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    try {
      globalThis.fetch = (async (url: any, init?: any) => {
        const method = (init?.method || "GET") as string;
        calls.push({ url: String(url), method });

        if (method === "GET") {
          const body = {
            sha: "sha-prev",
            content: btoa("same")
          };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        throw new Error("PUT should not be called when content is identical");
      }) as any;

      const res = await __test__.commitToGitHub(
        {
          GITHUB_TOKEN: "x",
          REPO_OWNER: "o",
          REPO_NAME: "r"
        } as any,
        "summaries/2026/02/04.md",
        "same",
        "msg"
      );

      expect(res.action).toBe("unchanged");
      expect(res.reason).toBe("identical");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("commitToGitHub compares UTF-8 content without mojibake", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    const unicodeText = "Apple's services-first era: low-res PDFs, AI-generated ads, and Apple\u2019s UX decline.";
    try {
      globalThis.fetch = (async (url: any, init?: any) => {
        const method = (init?.method || "GET") as string;
        calls.push({ url: String(url), method });

        if (method === "GET") {
          const body = {
            sha: "sha-prev",
            content: toBase64Utf8(unicodeText)
          };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        throw new Error("PUT should not be called when UTF-8 content is identical");
      }) as any;

      const res = await __test__.commitToGitHub(
        {
          GITHUB_TOKEN: "x",
          REPO_OWNER: "o",
          REPO_NAME: "r"
        } as any,
        "summaries/2026/02/06.md",
        unicodeText,
        "msg"
      );

      expect(res.action).toBe("unchanged");
      expect(res.reason).toBe("identical");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("commitToGitHub PUTs when creating file", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    try {
      globalThis.fetch = (async (url: any, init?: any) => {
        const method = (init?.method || "GET") as string;
        calls.push({ url: String(url), method });

        if (method === "GET") {
          return new Response("not found", { status: 404 });
        }

        if (method === "PUT") {
          const body = {
            commit: { sha: "sha-commit" },
            content: { sha: "sha-content" }
          };
          return new Response(JSON.stringify(body), {
            status: 201,
            headers: { "content-type": "application/json" }
          });
        }

        throw new Error(`unexpected method: ${method}`);
      }) as any;

      const res = await __test__.commitToGitHub(
        {
          GITHUB_TOKEN: "x",
          REPO_OWNER: "o",
          REPO_NAME: "r"
        } as any,
        "summaries/2026/02/04.md",
        "new",
        "msg"
      );

      expect(res.action).toBe("created");
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
