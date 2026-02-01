/// <reference types="@cloudflare/workers-types" />

import {
    type ProcessedStory,
    type AlgoliaHit,
    type LLMEnv,
    fetchTopStories,
    fetchStoryDetails,
    processStoriesWithRateLimit,
    generateDigest,
    formatArticleMarkdown,
    formatDigestMarkdown,
    getLondonDate,
    parseDateComponents,
    getPostTypeLabel,
    resolveLLMConfigWithFallback,
    createLLMConfig
} from '../../shared/summarizer-core';

// ============================================================================
// Environment Interface
// ============================================================================

interface Env extends LLMEnv {
    // GitHub
    GITHUB_TOKEN: string;
    REPO_OWNER: string;
    REPO_NAME: string;
}

// ============================================================================
// Worker Handlers
// ============================================================================

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(generateDailySummary(env));
    },

    // Manual trigger via HTTP for testing
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Reuse createLLMConfig to get the active API key
        let activeApiKey = '';
        try {
            const { config } = createLLMConfig(env);
            activeApiKey = config.apiKey;
        } catch (e) {
            // No API key is configured
        }

        if (url.searchParams.get("key") !== activeApiKey.substring(0, 10)) {
            return new Response("Unauthorized", { status: 401 });
        }

        ctx.waitUntil(generateDailySummary(env));
        return new Response("Triggered summary generation.");
    }
};

// ============================================================================
// Main Summary Generation
// ============================================================================

async function generateDailySummary(env: Env) {
    // Use London timezone for date calculation
    const date = getLondonDate();
    const { year, month, day } = parseDateComponents(date);

    console.log(`Generating summary for ${date}`);

    // Create LLM config from environment using shared utility
    let llmConfig;
    let provider;
    try {
        const result = await resolveLLMConfigWithFallback(env, console);
        llmConfig = result.config;
        provider = result.provider;
    } catch (e) {
        console.error(`Failed to create LLM config: ${e}`);
        console.error(
            `Available env keys: CEBRAS_API_KEY=${!!env.CEBRAS_API_KEY}, NVIDIA_API_KEY=${!!env.NVIDIA_API_KEY}, XIAOMI_API_KEY=${!!env.XIAOMI_API_KEY}, OPENROUTER_API_KEY=${!!env.OPENROUTER_API_KEY}, OPENAI_API_KEY=${!!env.OPENAI_API_KEY}`
        );
        throw e;
    }

    // 1. Fetch Stories (top 20 by points)
    const stories = await fetchTopStories();
    const top20 = stories.slice(0, 20);

    // 2. Fetch all story details in PARALLEL
    console.log(`Fetching ${top20.length} story details in parallel...`);
    const storyDetails = await Promise.all(
        top20.map(async (hit: AlgoliaHit) => {
            const details = await fetchStoryDetails(hit.objectID);
            return { hit, details };
        })
    );
    console.log(`Fetched all story details.`);

    // 3. Process LLM calls with rate limiting using shared function
    const processedStories = await processStoriesWithRateLimit(storyDetails, llmConfig);

    // 4. Generate Markdown using shared formatters
    const articleMd = formatArticleMarkdown(processedStories, date);
    
    // Wait before generating digest to avoid rate limits
    console.log(`⏳ Waiting 10s before generating digest...`);
    await new Promise(r => setTimeout(r, 10000));
    
    const digestContent = await generateDigest(processedStories, llmConfig);
    const digestMd = formatDigestMarkdown(digestContent, date, processedStories.length);

    // 5. Commit both files to GitHub
    const folderPath = `summaries/${year}/${month}`;
    await commitToGitHub(env, `${folderPath}/${day}.md`, articleMd, `Add articles for ${date}`);
    await commitToGitHub(env, `${folderPath}/${day}-digest.md`, digestMd, `Add digest for ${date}`);

    // 6. Update Archive Index
    await updateArchive(env, date, processedStories.length);

    console.log(`✅ Completed summary for ${date}`);
}

// ============================================================================
// GitHub Functions
// ============================================================================

async function fetchGitHubFile(env: Env, path: string): Promise<{ content: string; sha: string }> {
    const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;
    const res = await fetch(url, {
        headers: {
            "User-Agent": "HN-Brief-Worker",
            "Authorization": `token ${env.GITHUB_TOKEN}`
        }
    });
    if (!res.ok) throw new Error("File not found");
    const data: any = await res.json();
    return { content: atob(data.content), sha: data.sha };
}

function utf8_to_b64(str: string): string {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        (match, p1) => String.fromCharCode(parseInt(p1, 16)))
    );
}

async function commitToGitHub(env: Env, path: string, content: string, message: string, shaOverride?: string) {
    const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;

    // Get SHA if file exists and not provided
    let sha = shaOverride;
    if (!sha) {
        try {
            const check = await fetch(url, {
                headers: { "User-Agent": "HN-Brief-Worker", "Authorization": `token ${env.GITHUB_TOKEN}` }
            });
            if (check.ok) {
                const data: any = await check.json();
                sha = data.sha;
            }
        } catch { }
    }

    const res = await fetch(url, {
        method: "PUT",
        headers: {
            "User-Agent": "HN-Brief-Worker",
            "Authorization": `token ${env.GITHUB_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ message, content: utf8_to_b64(content), sha })
    });

    if (!res.ok) {
        console.error(`GitHub commit failed for ${path}:`, await res.text());
    }
}

async function updateArchive(env: Env, date: string, storyCount: number) {
    const archivePath = "summaries/archive.json";
    let archive: any[] = [];
    let currentSha: string | undefined;

    try {
        const { content, sha } = await fetchGitHubFile(env, archivePath);
        archive = JSON.parse(content);
        currentSha = sha;
    } catch {
        // File doesn't exist yet
    }

    // Normalize and add/update entry
    archive = archive.map((entry: any) =>
        typeof entry === 'string' ? { date: entry, hasDigest: false, storyCount: 0 } : entry
    );

    const existingIndex = archive.findIndex((entry: any) => entry.date === date);
    const newEntry = { date, hasDigest: true, storyCount };

    if (existingIndex === -1) {
        archive.push(newEntry);
    } else {
        archive[existingIndex] = newEntry;
    }

    // Sort by date descending
    archive.sort((a, b) => b.date.localeCompare(a.date));

    await commitToGitHub(env, archivePath, JSON.stringify(archive, null, 2), `Update archive for ${date}`, currentSha);
}
