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

const MAX_STORY_FAILURES_TO_PUBLISH = 3;

type CommitOptions = {
    skipIfWorse?: (nextContent: string, existingContent: string) => string | null;
};

type CommitResult = {
    action: 'created' | 'updated' | 'unchanged';
    sha?: string;
    reason?: 'identical' | 'worse';
};

function isStorySummaryFailure(story: ProcessedStory): boolean {
    const summary = (story.summary || '').trim();
    const discussion = (story.discussion_summary || '').trim();
    return (
        /^API error:/i.test(summary) ||
        /^API error:/i.test(discussion) ||
        /^Error generating summary\.?$/i.test(summary) ||
        /^Error generating summary\.?$/i.test(discussion) ||
        /^Summary unavailable\.?$/i.test(summary) ||
        /^Summary unavailable\.?$/i.test(discussion)
    );
}

function isDigestFailure(digestContent: string): boolean {
    return /^\s*Digest generation failed/i.test((digestContent || '').trim());
}

function countFailuresInArticleMarkdown(md: string): number {
    // formatArticleMarkdown emits blocks like:
    // > **Article:** ...
    // > **Discussion:** ...
    // We count failure blocks (not stories) so the metric stays stable even if a single story
    // has both an article and discussion failure.
    const matches = md.match(
        /> \*\*[^*]+:\*\*\s*(?:API error:|Error generating summary\.?|Summary unavailable\.?)/gi
    );
    return matches ? matches.length : 0;
}

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

    const storyFailureCount = processedStories.filter(isStorySummaryFailure).length;
    if (storyFailureCount > MAX_STORY_FAILURES_TO_PUBLISH) {
        console.error(
            `⚠️ Too many story summary failures for ${date} (${storyFailureCount}/${processedStories.length}). ` +
            `Skipping GitHub updates to avoid overwriting good summaries.`
        );
        return;
    }

    // 4. Generate Markdown using shared formatters
    const articleMd = formatArticleMarkdown(processedStories, date);
    
    // Wait before generating digest to avoid rate limits
    console.log(`⏳ Waiting 5s before generating digest...`);
    await new Promise(r => setTimeout(r, 5000));
    
    const digestContent = await generateDigest(processedStories, llmConfig);
    const digestMd = formatDigestMarkdown(digestContent, date, processedStories.length);
    const digestSucceeded = !isDigestFailure(digestContent);

    // 5. Commit both files to GitHub
    const folderPath = `summaries/${year}/${month}`;
    try {
        const articleCommit = await commitToGitHub(
            env,
            `${folderPath}/${day}.md`,
            articleMd,
            `Add articles for ${date}`,
            undefined,
            {
                skipIfWorse: (next, prev) => {
                    const nextFailures = countFailuresInArticleMarkdown(next);
                    const prevFailures = countFailuresInArticleMarkdown(prev);
                    return nextFailures > prevFailures
                        ? `would worsen failure count (${prevFailures} -> ${nextFailures})`
                        : null;
                }
            }
        );

        let digestPublished = false;
        if (articleCommit.action === 'unchanged' && articleCommit.reason === 'worse') {
            console.error(`⚠️ Articles would be worse for ${date}; skipping digest and archive update.`);
            return;
        }

        if (digestSucceeded) {
            const digestCommit = await commitToGitHub(
                env,
                `${folderPath}/${day}-digest.md`,
                digestMd,
                `Add digest for ${date}`
            );
            digestPublished = digestCommit.action !== 'unchanged' || digestCommit.reason === 'identical';
        } else {
            console.error(`⚠️ Digest generation failed for ${date}; leaving existing digest intact.`);
        }

        // 6. Update Archive Index
        await updateArchive(env, date, processedStories.length, digestPublished);

        console.log(`✅ Completed summary for ${date}`);
    } catch (error) {
        console.error(`❌ Failed to commit files for ${date}:`, error);
        throw error; // Re-throw to ensure Worker reports failure
    }
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

async function commitToGitHub(
    env: Env,
    path: string,
    content: string,
    message: string,
    shaOverride?: string,
    options?: CommitOptions
): Promise<CommitResult> {
    const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;

    // Get existing file info if it exists
    let existingSha: string | undefined = shaOverride;
    let existingContent: string | undefined;
    
    if (!existingSha) {
        try {
            const check = await fetch(url, {
                headers: { "User-Agent": "HN-Brief-Worker", "Authorization": `token ${env.GITHUB_TOKEN}` }
            });
            if (check.ok) {
                const data: any = await check.json();
                existingSha = data.sha;
                existingContent = atob(data.content);
            }
        } catch (e) {
            // File doesn't exist - that's fine, we'll create it
            console.log(`File ${path} does not exist, will create`);
        }
    }

    // Optional: avoid overwriting with worse content
    if (existingContent !== undefined) {
        const reason = options?.skipIfWorse?.(content, existingContent);
        if (reason) {
            console.log(`⏭️ Skipping ${path} - ${reason}`);
            return { action: 'unchanged', sha: existingSha, reason: 'worse' };
        }
    }

    // Skip if content is identical (avoid empty commits)
    if (existingContent !== undefined && existingContent === content) {
        console.log(`⏭️ Skipping ${path} - content unchanged`);
        return { action: 'unchanged', sha: existingSha, reason: 'identical' };
    }

    const res = await fetch(url, {
        method: "PUT",
        headers: {
            "User-Agent": "HN-Brief-Worker",
            "Authorization": `token ${env.GITHUB_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ message, content: utf8_to_b64(content), sha: existingSha })
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`GitHub commit failed for ${path}:`, errorText);
        throw new Error(`GitHub commit failed for ${path}: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const result: any = await res.json();
    const action = existingSha ? 'updated' : 'created';
    console.log(`✅ ${action === 'created' ? 'Created' : 'Updated'} ${path} (commit: ${result.commit?.sha?.slice(0, 7)})`);
    
    return { action, sha: result.content?.sha };
}

async function updateArchive(env: Env, date: string, storyCount: number, digestSucceeded: boolean) {
    const archivePath = "summaries/archive.json";
    let archive: any[] = [];
    let currentSha: string | undefined;

    try {
        const { content, sha } = await fetchGitHubFile(env, archivePath);
        archive = JSON.parse(content);
        currentSha = sha;
    } catch {
        // File doesn't exist yet - will be created
        console.log(`Archive file doesn't exist, will create new one`);
    }

    // Normalize and add/update entry
    archive = archive.map((entry: any) =>
        typeof entry === 'string' ? { date: entry, hasDigest: false, storyCount: 0 } : entry
    );

    const existingIndex = archive.findIndex((entry: any) => entry.date === date);
    const existing = existingIndex === -1 ? null : archive[existingIndex];
    const hasDigest = digestSucceeded || Boolean(existing?.hasDigest);
    const newEntry = { date, hasDigest, storyCount };

    if (existingIndex === -1) {
        archive.push(newEntry);
    } else {
        archive[existingIndex] = newEntry;
    }

    // Sort by date descending
    archive.sort((a, b) => b.date.localeCompare(a.date));

    await commitToGitHub(env, archivePath, JSON.stringify(archive, null, 2), `Update archive for ${date}`, currentSha);
}

export const __test__ = {
    isStorySummaryFailure,
    isDigestFailure,
    countFailuresInArticleMarkdown,
    commitToGitHub
};
