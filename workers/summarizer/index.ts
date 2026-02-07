/// <reference types="@cloudflare/workers-types" />

import {
    type ProcessedStory,
    type AlgoliaHit,
    type StoryDetails,
    type LLMEnv,
    fetchTopStories,
    fetchStoryDetails,
    processStoriesWithRateLimit,
    generateDigest,
    formatArticleMarkdown,
    formatDigestMarkdown,
    getLondonDate,
    parseDateComponents,
    resolveLLMConfigWithFallback,
    createLLMConfig,
    createLLMConfigCandidates,
    needsStoryRepair,
    isDigestFailureText,
    wouldWorsenArticleMarkdown,
    summarizeStoryWithFallbacks,
    parseArticleMarkdownStories,
    replaceStoriesInArticleMarkdown,
    findRepairableStoryIdsInMarkdown,
    isDigestMarkdownEmptyOrFailed
} from '../../shared/summarizer-core';

const MAX_STORY_FAILURES_TO_PUBLISH = 12;
const MAX_AUTOMATED_REPAIRS_PER_RUN = 3;
const REPAIR_CRON = '20 */2 * * *';

type CommitOptions = {
    skipIfWorse?: (nextContent: string, existingContent: string) => string | null;
    existingContent?: string;
};

type CommitResult = {
    action: 'created' | 'updated' | 'unchanged';
    sha?: string;
    reason?: 'identical' | 'worse';
};

// failure detection helpers live in shared/summarizer-core.ts

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
        if (event.cron === REPAIR_CRON) {
            ctx.waitUntil(runAutomatedRepair(env));
            return;
        }
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

        const mode = (url.searchParams.get('mode') || '').trim().toLowerCase();
        if (mode === 'repair') {
            const date = (url.searchParams.get('date') || getLondonDate()).trim();
            const ids = Array.from(new Set(url.searchParams.getAll('id').map((id) => id.trim()).filter(Boolean)));
            const maxParam = parseInt(url.searchParams.get('max') || '', 10);
            const maxRepairs = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : MAX_AUTOMATED_REPAIRS_PER_RUN;

            ctx.waitUntil(
                repairStoriesForDate(env, {
                    date,
                    targetIds: ids.length > 0 ? ids : undefined,
                    maxRepairs,
                    reason: 'manual'
                })
            );
            return new Response(`Triggered repair for ${date}${ids.length ? ` (ids=${ids.join(',')})` : ''}.`);
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
    try {
        const result = await resolveLLMConfigWithFallback(env, console);
        llmConfig = result.config;
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

    const storyFailureCount = processedStories.filter(needsStoryRepair).length;
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
    const digestSucceeded = !isDigestFailureText(digestContent);

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
                    return wouldWorsenArticleMarkdown(next, prev);
                }
            }
        );

        let digestPublished = false;
        if (articleCommit.action === 'unchanged' && articleCommit.reason === 'worse') {
            console.error(`⚠️ Articles would be worse for ${date}; keeping previous articles and continuing with digest/archive update.`);
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

type RepairOptions = {
    date: string;
    targetIds?: string[];
    maxRepairs?: number;
    reason: 'manual' | 'automated';
};

function buildRepairHit(
    id: string,
    existing: ProcessedStory,
    details: StoryDetails
): AlgoliaHit {
    const fallbackUrl = existing.url || `https://news.ycombinator.com/item?id=${id}`;
    const detailChildren = Array.isArray(details.children) ? details.children : [];

    return {
        objectID: id,
        title: details.title || existing.title,
        url: details.url || fallbackUrl,
        text: details.text,
        points: typeof details.points === 'number' ? details.points : existing.points,
        num_comments: existing.num_comments || detailChildren.length || 0,
        created_at_i: Math.floor(Date.now() / 1000)
    };
}

async function runAutomatedRepair(env: Env): Promise<void> {
    const date = getLondonDate();
    console.log(`Running automated repair pass for ${date}`);
    await repairStoriesForDate(env, {
        date,
        maxRepairs: MAX_AUTOMATED_REPAIRS_PER_RUN,
        reason: 'automated'
    });
}

async function repairStoriesForDate(env: Env, options: RepairOptions): Promise<void> {
    const date = options.date;
    const { year, month, day } = parseDateComponents(date);
    const folderPath = `summaries/${year}/${month}`;
    const articlePath = `${folderPath}/${day}.md`;
    const digestPath = `${folderPath}/${day}-digest.md`;
    const maxRepairs = options.maxRepairs || MAX_AUTOMATED_REPAIRS_PER_RUN;

    console.log(`Starting ${options.reason} repair for ${date}`);

    let articleContent: string;
    let articleSha: string;
    try {
        const articleFile = await fetchGitHubFile(env, articlePath);
        articleContent = articleFile.content;
        articleSha = articleFile.sha;
    } catch {
        console.log(`No article file found for ${date}; skipping repair.`);
        return;
    }

    const parsedStories = parseArticleMarkdownStories(articleContent);
    const storiesById = new Map(parsedStories.map((story) => [story.id, story]));

    let targetIds = Array.from(new Set((options.targetIds || []).map((id) => id.trim()).filter(Boolean)));
    if (targetIds.length === 0) {
        targetIds = findRepairableStoryIdsInMarkdown(articleContent).slice(0, maxRepairs);
    }

    if (targetIds.length === 0) {
        console.log(`No repairable stories found for ${date}.`);
    }

    const candidates = createLLMConfigCandidates(env).map((candidate) => candidate.config);
    const replacements = new Map<string, ProcessedStory>();

    for (const id of targetIds) {
        const existing = storiesById.get(id);
        if (!existing) {
            console.log(`Story ${id} not found in ${articlePath}; skipping.`);
            continue;
        }

        try {
            const details = await fetchStoryDetails(id);
            const hit = buildRepairHit(id, existing, details);
            const repaired = await summarizeStoryWithFallbacks(
                hit,
                details.children || [],
                candidates,
                undefined,
                console
            );

            if (needsStoryRepair(repaired)) {
                console.log(`Story ${id} still low quality after fallback attempts; keeping existing text.`);
                continue;
            }

            replacements.set(id, repaired);
        } catch (error) {
            console.error(`Failed repairing story ${id}:`, error);
        }
    }

    let nextArticleContent = articleContent;
    if (replacements.size > 0) {
        const patched = replaceStoriesInArticleMarkdown(articleContent, replacements);
        nextArticleContent = patched.markdown;

        if (patched.updatedIds.length > 0) {
            await commitToGitHub(
                env,
                articlePath,
                nextArticleContent,
                `Repair ${patched.updatedIds.length} article summaries for ${date}`,
                articleSha,
                {
                    existingContent: articleContent,
                    skipIfWorse: (next, prev) => wouldWorsenArticleMarkdown(next, prev)
                }
            );
        }
    }

    let digestContent = '';
    let digestSha: string | undefined;
    let shouldRepairDigest = true;

    try {
        const digestFile = await fetchGitHubFile(env, digestPath);
        digestContent = digestFile.content;
        digestSha = digestFile.sha;
        shouldRepairDigest = isDigestMarkdownEmptyOrFailed(digestContent);
    } catch {
        shouldRepairDigest = true;
    }

    if (!shouldRepairDigest) {
        console.log(`Digest for ${date} is healthy; leaving untouched.`);
        return;
    }

    const storiesForDigest = parseArticleMarkdownStories(nextArticleContent);
    if (storiesForDigest.length === 0) {
        console.log(`No stories available to regenerate digest for ${date}; skipping digest repair.`);
        return;
    }

    const llm = await resolveLLMConfigWithFallback(env, console);
    const nextDigest = await generateDigest(storiesForDigest, llm.config);
    if (isDigestFailureText(nextDigest)) {
        console.error(`Digest regeneration failed for ${date}; keeping existing digest.`);
        return;
    }

    const digestMd = formatDigestMarkdown(nextDigest, date, storiesForDigest.length);
    await commitToGitHub(
        env,
        digestPath,
        digestMd,
        `Repair digest for ${date}`,
        digestSha,
        { existingContent: digestContent }
    );
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
    return { content: decodeBase64Utf8(data.content), sha: data.sha };
}

function decodeBase64Utf8(content: string): string {
    const normalized = String(content || '').replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(content: string): string {
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
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
    let existingContent: string | undefined = options?.existingContent;
    
    if (!existingSha) {
        try {
            const check = await fetch(url, {
                headers: { "User-Agent": "HN-Brief-Worker", "Authorization": `token ${env.GITHUB_TOKEN}` }
            });
            if (check.ok) {
                const data: any = await check.json();
                existingSha = data.sha;
                existingContent = decodeBase64Utf8(data.content);
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
        body: JSON.stringify({ message, content: encodeBase64Utf8(content), sha: existingSha })
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
    commitToGitHub,
    encodeBase64Utf8
};
