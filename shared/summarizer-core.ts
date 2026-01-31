/**
 * HN-Brief Summarizer Core
 * 
 * Shared logic for both the Cloudflare Worker and the local Bun script.
 * This module contains all the common types, API functions, and formatting logic.
 */

// ============================================================================
// Types
// ============================================================================

export type PostType = 'article' | 'ask_hn' | 'show_hn' | 'tell_hn' | 'launch_hn';

export interface ProcessedStory {
    id: string;
    title: string;
    url: string;
    points: number;
    num_comments: number;
    summary: string;
    discussion_summary: string;
    postType: PostType;
}

export interface LLMConfig {
    apiKey: string;
    apiUrl: string;
    model: string;
    provider?: 'nvidia' | 'openrouter' | 'openai-compatible' | 'xiaomi';
    thinking?: boolean;
}

export interface LLMLogger {
    info: (message: string) => void;
    error: (message: string) => void;
}

export interface AlgoliaHit {
    objectID: string;
    title: string;
    url?: string;
    text?: string;
    points: number;
    num_comments: number;
    created_at_i: number;
}

export interface StoryDetails {
    id: string;
    title: string;
    url?: string;
    text?: string;
    points: number;
    children?: Comment[];
}

export interface Comment {
    id: string;
    author: string;
    text: string;
    children?: Comment[];
}

/** Metadata computed for each comment during tree analysis */
interface CommentMetadata {
    comment: Comment;
    depth: number;
    descendantCount: number;
    directReplyCount: number;
    textLength: number;           // HTML-stripped length
    uniqueAuthorCount: number;
    rootId: string;               // ID of top-level ancestor
    parentId: string | null;
    score: number;
}

/** Options for comment selection algorithm */
interface CommentSelectionOptions {
    maxChars: number;    // Budget on formatted output
    perRootCap: number;  // Max comments from same top-level thread
}

// ============================================================================
// Constants
// ============================================================================

export const ALGOLIA_API = "https://hn.algolia.com/api/v1";

// LLM Provider Defaults
// Priority: OpenRouter > Nvidia NIM > OpenAI-compatible
const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const DEFAULT_NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_NVIDIA_MODEL = "moonshotai/kimi-k2.5";
const DEFAULT_XIAOMI_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const DEFAULT_XIAOMI_MODEL = "mimo-v2-flash";

export const MAX_TOKENS_FOR_REASONING = 16000;
export const MAX_TOKENS_SUMMARY = 1200;
export const MAX_TOKENS_DIGEST = MAX_TOKENS_FOR_REASONING;
const SUMMARY_TEMPERATURE = 0.6;
const SUMMARY_TOP_P = 0.95;

// ============================================================================
// LLM Configuration Factory
// ============================================================================

/**
 * Environment variables for LLM configuration
 */
export interface LLMEnv {
    // Primary: OpenRouter (recommended)
    OPENROUTER_API_KEY?: string;
    OPENROUTER_MODEL?: string;
    // Fallback: Nvidia NIM
    NVIDIA_API_KEY?: string;
    NVIDIA_MODEL?: string;
    // Alternative: OpenAI-compatible
    OPENAI_API_KEY?: string;
    // Xiaomi MiMo fallback
    XIAOMI_API_KEY?: string;
    XIAOMI_API_URL?: string;
    XIAOMI_MODEL?: string;
    // Generic overrides (legacy, prefer provider-specific)
    LLM_API_URL?: string;
    LLM_MODEL?: string;
    // Thinking mode control
    LLM_THINKING_FORCE?: string;
    LLM_THINKING?: string;
}

function parseThinking(value?: string): boolean | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    return String(error);
}

function isNvidiaApi(config: LLMConfig): boolean {
    if (config.provider === 'nvidia') return true;
    return config.apiUrl.includes('integrate.api.nvidia.com');
}

function isOpenRouterApi(config: LLMConfig): boolean {
    if (config.provider === 'openrouter') return true;
    return config.apiUrl.includes('openrouter.ai');
}

function supportsThinkingConfig(config: LLMConfig): boolean {
    return isNvidiaApi(config) || isOpenRouterApi(config);
}

function applyThinkingMode(requestBody: Record<string, unknown>, config: LLMConfig, enabled: boolean) {
    if (isNvidiaApi(config)) {
        // Nvidia NIM format
        requestBody.thinking = enabled ? { type: "enabled" } : { type: "disabled" };
    } else if (isOpenRouterApi(config)) {
        // OpenRouter format (arcee-ai/trinity-large-preview:free)
        requestBody.reasoning = { enabled };
    }
}

function resolveThinkingParams(config: LLMConfig, defaultThinking: boolean): {
    thinking: { type: "enabled" } | false;
    temperature: number;
    topP: number;
} {
    const thinking = typeof config.thinking === 'boolean' ? config.thinking : defaultThinking;
    return {
        thinking: thinking ? { type: "enabled" } : false,
        temperature: thinking ? 1.0 : 0.6,
        topP: 0.95
    };
}

async function buildApiError(response: Response): Promise<Error> {
    const contentType = response.headers.get("content-type") || "";
    const errorText = await response.text();
    let detail = errorText;
    if (contentType.includes("application/json")) {
        try {
            const parsed = JSON.parse(errorText);
            detail =
                parsed?.error?.message ||
                parsed?.error?.detail ||
                parsed?.detail ||
                parsed?.title ||
                parsed?.message ||
                errorText;
        } catch {
            detail = errorText;
        }
    }
    const normalized = String(detail).replace(/\s+/g, " ").trim();
    const snippet = normalized || response.statusText || "Unknown error";
    return new Error(`API Error ${response.status}: ${truncateText(snippet, 500)}`);
}

async function fetchCompletion(
    url: string,
    apiKey: string,
    body: Record<string, unknown>
): Promise<string> {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw await buildApiError(response);
    }

    const data = await response.json() as any;
    if (data?.error) {
        const message = data.error?.message || data.error?.detail || JSON.stringify(data.error);
        throw new Error(`API Error: ${truncateText(String(message), 500)}`);
    }

    const content =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        "";

    return typeof content === 'string' ? content : '';
}

/**
 * Helper to fetch and parse SSE stream from LLM API.
 * Handles both "reasoning_content" and "content" fields.
 */
async function fetchStreamCompletion(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    options?: { stopAfter?: string[] }
): Promise<string> {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, stream: true })
    });

    if (!response.ok) {
        throw await buildApiError(response);
    }

    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalContent = "";
    const stopAfter = options?.stopAfter?.filter(Boolean) ?? null;
    let shouldStop = false;
    // Note: We are consuming reasoning_content from the stream but currently only returning 
    // the final content_summary logic expects "content". 
    // If we need to capture reasoning for debugging, we can collect it here too.

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;

                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") continue;

                try {
                    const json = JSON.parse(dataStr);
                    const delta = json.choices?.[0]?.delta;
                    if (delta?.content) {
                        finalContent += delta.content;
                        if (stopAfter && stopAfter.length > 0) {
                            const hasAllStops = stopAfter.every((seq) => finalContent.includes(seq));
                            if (hasAllStops) {
                                shouldStop = true;
                                void reader.cancel();
                                break;
                            }
                        }
                    }
                    // We can also capture delta.reasoning_content if needed
                } catch (e) {
                    console.error("Error parsing stream line:", dataStr.slice(0, 100));
                }
            }
            if (shouldStop) break;
        }
    } finally {
        reader.releaseLock();
    }

    return finalContent;
}

/**
 * Create LLM config from environment variables.
 * Priority: OpenRouter > Nvidia NIM > OpenAI-compatible (legacy, requires explicit config)
 * 
 * @returns LLM config and provider name for logging
 * @throws Error if no API key is configured
 */
export function createLLMConfig(env: LLMEnv): { config: LLMConfig; provider: string } {
    const thinking = parseThinking(env.LLM_THINKING_FORCE ?? env.LLM_THINKING);
    
    // Priority 1: OpenRouter (recommended primary provider)
    if (env.OPENROUTER_API_KEY) {
        return {
            config: {
                apiKey: env.OPENROUTER_API_KEY,
                apiUrl: env.LLM_API_URL || DEFAULT_OPENROUTER_URL,
                model: env.OPENROUTER_MODEL || env.LLM_MODEL || DEFAULT_OPENROUTER_MODEL,
                provider: 'openrouter',
                thinking
            },
            provider: 'OpenRouter'
        };
    }

    // Priority 2: Nvidia NIM (fallback)
    if (env.NVIDIA_API_KEY) {
        return {
            config: {
                apiKey: env.NVIDIA_API_KEY,
                apiUrl: env.LLM_API_URL || DEFAULT_NVIDIA_URL,
                model: env.NVIDIA_MODEL || env.LLM_MODEL || DEFAULT_NVIDIA_MODEL,
                provider: 'nvidia',
                thinking
            },
            provider: 'Nvidia NIM'
        };
    }

    // Priority 3: OpenAI-compatible (requires explicit URL and model)
    if (env.OPENAI_API_KEY) {
        if (!env.LLM_API_URL || !env.LLM_MODEL) {
            throw new Error(
                'When using OPENAI_API_KEY, you must also set LLM_API_URL and LLM_MODEL'
            );
        }
        return {
            config: {
                apiKey: env.OPENAI_API_KEY,
                apiUrl: env.LLM_API_URL,
                model: env.LLM_MODEL,
                provider: 'openai-compatible',
                thinking
            },
            provider: 'OpenAI-compatible'
        };
    }

    throw new Error('No LLM API key found. Set OPENROUTER_API_KEY (recommended), NVIDIA_API_KEY, or OPENAI_API_KEY.');
}

export function createXiaomiConfig(env: LLMEnv): { config: LLMConfig; provider: string } | null {
    if (!env.XIAOMI_API_KEY) return null;
    const thinking = parseThinking(env.LLM_THINKING_FORCE ?? env.LLM_THINKING);
    return {
        config: {
            apiKey: env.XIAOMI_API_KEY,
            apiUrl: env.XIAOMI_API_URL || DEFAULT_XIAOMI_URL,
            model: env.XIAOMI_MODEL || DEFAULT_XIAOMI_MODEL,
            provider: 'xiaomi',
            thinking
        },
        provider: 'Xiaomi MiMo'
    };
}

// ============================================================================
// Comment Selection Algorithm
// ============================================================================

// Comment selection configuration (configurable via environment variables in Node.js)
// In Cloudflare Workers, these will use defaults since 'process' is undefined
const MAX_COMMENT_CHARS = typeof process !== 'undefined'
    ? parseInt(process.env?.MAX_COMMENT_CHARS || '15000', 10)
    : 15000;
const MAX_COMMENTS_PER_ROOT = typeof process !== 'undefined'
    ? parseInt(process.env?.MAX_COMMENTS_PER_ROOT || '3', 10)
    : 3;

/**
 * Strip HTML tags from text for accurate length scoring
 */
function stripHtml(text: string): string {
    return text
        .replace(/<[^>]*>/g, '')           // Remove HTML tags
        .replace(/&[a-z]+;/gi, ' ')        // Replace HTML entities with space
        .replace(/&#x[0-9a-f]+;/gi, ' ')   // Replace hex entities
        .replace(/&#\d+;/gi, ' ')          // Replace decimal entities
        .trim();
}

/**
 * Check if a comment should be skipped (deleted or empty)
 */
function shouldSkipComment(comment: Comment): boolean {
    if (!comment.text) return true;
    const stripped = stripHtml(comment.text);
    if (!stripped || stripped === '[deleted]' || stripped === '[dead]') return true;
    return false;
}

/**
 * Compute quality score for a comment based on structural signals
 */
function scoreComment(meta: CommentMetadata): number {
    const descendantScore = 2.0 * Math.log(1 + meta.descendantCount);
    const textScore = 1.0 * Math.log(1 + meta.textLength / 100);
    const replyScore = 0.8 * meta.directReplyCount;
    const authorScore = 0.3 * meta.uniqueAuthorCount;
    const depthPenalty = 0.8 * Math.max(0, meta.depth - 2);

    // Tie-breaker for stable ordering
    const tieBreaker = (meta.descendantCount * 0.001) + (meta.textLength * 0.00001);

    return descendantScore + textScore + replyScore + authorScore - depthPenalty + tieBreaker;
}

/**
 * Recursively analyze comment tree and build metadata for all comments
 */
function analyzeCommentTree(
    comments: Comment[],
    depth: number = 0,
    rootId: string | null = null,
    parentId: string | null = null
): CommentMetadata[] {
    const results: CommentMetadata[] = [];

    for (const comment of comments) {
        if (shouldSkipComment(comment)) continue;

        const currentRootId = rootId ?? comment.id;
        const children = comment.children || [];

        // Recursively analyze children first
        const childMetadata = analyzeCommentTree(
            children,
            depth + 1,
            currentRootId,
            comment.id
        );

        // Compute statistics
        const descendantCount = childMetadata.reduce(
            (sum, m) => sum + 1 + m.descendantCount,
            0
        );
        const directReplyCount = children.filter(c => !shouldSkipComment(c)).length;
        const textLength = stripHtml(comment.text).length;

        // Count unique authors in subtree
        const authors = new Set<string>([comment.author]);
        for (const m of childMetadata) {
            authors.add(m.comment.author);
        }
        const uniqueAuthorCount = authors.size;

        const meta: CommentMetadata = {
            comment,
            depth,
            descendantCount,
            directReplyCount,
            textLength,
            uniqueAuthorCount,
            rootId: currentRootId,
            parentId,
            score: 0 // Will be computed below
        };
        meta.score = scoreComment(meta);

        results.push(meta);
        results.push(...childMetadata);
    }

    return results;
}

/**
 * Build ancestor chain for a comment by traversing up the tree
 */
function buildAncestorChain(
    commentId: string,
    metaById: Map<string, CommentMetadata>,
    maxDepth: number = 3
): Comment[] {
    const chain: Comment[] = [];
    let current = metaById.get(commentId);
    let depth = 0;

    while (current?.parentId && depth < maxDepth) {
        const parent = metaById.get(current.parentId);
        if (parent) {
            chain.unshift(parent.comment);
            current = parent;
            depth++;
        } else {
            break;
        }
    }

    return chain;
}

/**
 * Format a single comment with optional context
 */
function formatComment(
    comment: Comment,
    ancestors: Comment[],
    replies: Comment[]
): string {
    let result = '';

    // Add ancestors for context (if deep comment)
    for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestors[i];
        if (!ancestor) continue;
        const ancestorIndent = '  '.repeat(i);
        const ancestorText = stripHtml(ancestor.text).slice(0, 150);
        result += `${ancestorIndent}[context] ${ancestor.author}: ${ancestorText}...\n`;
    }

    // Add main comment
    const mainIndent = '  '.repeat(ancestors.length);
    result += `${mainIndent}- ${comment.author}: ${stripHtml(comment.text)}\n`;

    // Add best replies
    for (const reply of replies) {
        const replyIndent = '  '.repeat(ancestors.length + 1);
        result += `${replyIndent}- ${reply.author}: ${stripHtml(reply.text)}\n`;
    }

    return result;
}

/**
 * Select and format best comments using scoring algorithm
 * Returns formatted text respecting character budget
 */
function selectAndFormatComments(
    comments: Comment[],
    options: CommentSelectionOptions
): string {
    if (!comments || comments.length === 0) {
        return 'No comments available.';
    }

    // Analyze entire tree
    const allMetadata = analyzeCommentTree(comments);

    if (allMetadata.length === 0) {
        return 'No comments available.';
    }

    // Sort by score descending
    const sorted = [...allMetadata].sort((a, b) => b.score - a.score);

    // Select comments with per-root diversity cap
    const selected: CommentMetadata[] = [];
    const rootCounts = new Map<string, number>();

    for (const meta of sorted) {
        const rootCount = rootCounts.get(meta.rootId) || 0;
        if (rootCount >= options.perRootCap) continue;

        selected.push(meta);
        rootCounts.set(meta.rootId, rootCount + 1);
    }

    // Format selected comments with budget enforcement
    let result = '';

    // Pre-build indexes for O(1) lookups
    const metaById = new Map(allMetadata.map(m => [m.comment.id, m]));
    const childrenByParentId = new Map<string, CommentMetadata[]>();
    for (const m of allMetadata) {
        if (m.parentId) {
            const siblings = childrenByParentId.get(m.parentId) || [];
            siblings.push(m);
            childrenByParentId.set(m.parentId, siblings);
        }
    }

    for (const meta of selected) {
        // Build ancestor chain if deep comment (reuse metaById)
        const ancestors = meta.depth > 0
            ? buildAncestorChain(meta.comment.id, metaById)
            : [];

        // Get best 1-2 replies using pre-built index
        const children = childrenByParentId.get(meta.comment.id) || [];
        const replies = children
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map(m => m.comment);

        // Format this comment thread
        const formatted = formatComment(meta.comment, ancestors, replies);

        // Check budget
        if (result.length + formatted.length > options.maxChars) {
            break; // Budget exhausted
        }

        result += formatted + '\n';
    }

    return result.trim() || 'No comments available.';
}

// ============================================================================
// Post Type Detection
// ============================================================================

export function detectPostType(title: string): PostType {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.startsWith('ask hn:') || lowerTitle.startsWith('ask hn ')) return 'ask_hn';
    if (lowerTitle.startsWith('show hn:') || lowerTitle.startsWith('show hn ')) return 'show_hn';
    if (lowerTitle.startsWith('tell hn:') || lowerTitle.startsWith('tell hn ')) return 'tell_hn';
    if (lowerTitle.startsWith('launch hn:') || lowerTitle.startsWith('launch hn ')) return 'launch_hn';
    return 'article';
}

export function getPostTypeLabel(type: PostType): string {
    switch (type) {
        case 'ask_hn': return 'Question';
        case 'show_hn': return 'Project';
        case 'tell_hn': return 'Post';
        case 'launch_hn': return 'Launch';
        default: return 'Article';
    }
}

// ============================================================================
// Algolia API Functions
// ============================================================================

/**
 * Fetch top stories from HN Algolia API
 * @param date Optional date string (YYYY-MM-DD) to fetch historical stories
 */
export async function fetchTopStories(date?: string): Promise<AlgoliaHit[]> {
    if (date) {
        // For specific date, search for top stories from that day
        const startTimestamp = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
        const endTimestamp = startTimestamp + 86400; // +24 hours

        const url = `${ALGOLIA_API}/search?tags=story&numericFilters=created_at_i>=${startTimestamp},created_at_i<${endTimestamp},points>10&hitsPerPage=50`;
        const res = await fetch(url);
        const data = await res.json() as { hits?: AlgoliaHit[] };

        // Sort by points descending and take top 20
        const sortedHits = (data.hits || []).sort((a, b) => (b.points || 0) - (a.points || 0));
        return sortedHits.slice(0, 20);
    }

    // Default: last 24 hours sorted by points
    const now = Math.floor(Date.now() / 1000);
    const yesterday = now - 86400;

    const url = `${ALGOLIA_API}/search?tags=story&numericFilters=created_at_i>${yesterday},points>10&hitsPerPage=50`;
    const res = await fetch(url);
    const data = await res.json() as { hits?: AlgoliaHit[] };
    const hits = data.hits || [];
    return hits.sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 20);
}

/**
 * Fetch detailed story info including comments
 */
export async function fetchStoryDetails(storyId: string): Promise<StoryDetails> {
    const res = await fetch(`${ALGOLIA_API}/items/${storyId}`);
    return await res.json() as StoryDetails;
}

// ============================================================================
// LLM Prompt Building
// ============================================================================

/**
 * Build the prompt for summarizing a single story
 */
export function buildSummaryPrompt(story: AlgoliaHit, comments: Comment[]): string {
    const postType = detectPostType(story.title);
    const typeLabel = getPostTypeLabel(postType);
    const isSelfPost = postType !== 'article';

    // Use scoring-based comment selection
    const commentText = selectAndFormatComments(comments, {
        maxChars: MAX_COMMENT_CHARS,
        perRootCap: MAX_COMMENTS_PER_ROOT
    });

    const contentDescription = isSelfPost
        ? `This is a ${typeLabel} post (self-post, no external article).`
        : `This links to an external article.`;

    return `Analyze this HN ${typeLabel.toLowerCase()} and discussion.
${contentDescription}
Title: ${story.title}
URL: ${story.url || 'N/A'}
Post Text: ${story.text || 'N/A'}
Comments: ${commentText}

Provide concise summaries in this format:
<Content Summary>
[summary of the ${typeLabel.toLowerCase()}]
</Content Summary>
<Discussion Summary>
[summary of key discussion points - prefer flowing prose; only use bullet points if there are clearly distinct themes]
</Discussion Summary>`;
}

/**
 * Build the prompt for generating the daily digest
 */
export function buildDigestPrompt(stories: ProcessedStory[]): string {
    const storiesContext = stories.map((s, i) =>
        `${i + 1}. "${s.title}" (${s.points} points, ${s.num_comments} comments, type: ${getPostTypeLabel(s.postType)})\n   Summary: ${s.summary}\n   Discussion: ${s.discussion_summary}`
    ).join("\n\n");

    return `You are writing a daily Hacker News digest for busy tech professionals.

Here are today's top stories with their individual summaries:
${storiesContext}

Write a cohesive, engaging 15-20 paragraph digest that:
1. Opens with the most significant/interesting story of the day (jump straight into it)
2. Groups related topics together
3. Highlights interesting patterns or themes
4. Maintains a smart, cynical, insider tone (like a senior engineer talking to another)
5. Ends with a brief "worth watching" note

CRITICAL STYLE RULES:
- NO "Good morning", "Grab your coffee", "Welcome back", or other fluff.
- NO generic intros like "Today on Hacker News..."
- Start directly with the first story/topic.
- No bullet points or headers. flowing prose only.`;
}

// ============================================================================
// LLM Response Parsing
// ============================================================================

/**
 * Parse the summary response from the LLM
 */
export function parseSummaryResponse(content: string): { summary: string; discussion: string } {
    const contentMatch = content.match(/<Content Summary>([\s\S]*?)<\/Content Summary>/);
    const discussionMatch = content.match(/<Discussion Summary>([\s\S]*?)<\/Discussion Summary>/);

    return {
        summary: contentMatch?.[1]?.trim() ?? "Summary unavailable.",
        discussion: discussionMatch?.[1]?.trim() ?? "Discussion unavailable."
    };
}

// ============================================================================
// LLM API Calls
// ============================================================================

export async function probeLLM(config: LLMConfig): Promise<{ ok: boolean; error?: string }> {
    const requestBody: Record<string, unknown> = {
        model: config.model,
        messages: [
            { role: "system", content: "You are a health check." },
            { role: "user", content: "Reply with OK." }
        ],
        temperature: isNvidiaApi(config) ? 0.6 : 0,
        max_tokens: 32
    };

    // Use Instant Mode for Nvidia NIM to avoid 524 timeout during health check
    applyThinkingMode(requestBody, config, false);

    try {
        const content = await fetchCompletion(config.apiUrl, config.apiKey, requestBody);
        if (!content || !content.trim()) {
            return { ok: false, error: 'empty response' };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: getErrorMessage(error) };
    }
}

export async function resolveLLMConfigWithFallback(
    env: LLMEnv,
    logger: LLMLogger = { info: () => {}, error: () => {} }
): Promise<{ config: LLMConfig; provider: string; usedFallback: boolean }>{
    const primary = createLLMConfig(env);
    logger.info(`Primary LLM: ${primary.provider} with model: ${primary.config.model}`);

    const xiaomiFallback = createXiaomiConfig(env);
    if (primary.provider === 'Nvidia NIM' && xiaomiFallback) {
        logger.info('Running Nvidia health check...');
        const probe = await probeLLM(primary.config);
        if (!probe.ok) {
            const detail = probe.error ? ` (${probe.error})` : '';
            logger.error(`Nvidia health check failed${detail}. Falling back to ${xiaomiFallback.provider}.`);
            logger.info(`Active LLM: ${xiaomiFallback.provider} with model: ${xiaomiFallback.config.model}`);
            return { config: xiaomiFallback.config, provider: xiaomiFallback.provider, usedFallback: true };
        }
        logger.info('Nvidia health check ok.');
    }

    logger.info(`Active LLM: ${primary.provider} with model: ${primary.config.model}`);
    return { config: primary.config, provider: primary.provider, usedFallback: false };
}

/**
 * Summarize a single story using the LLM
 */
export async function summarizeStory(
    story: AlgoliaHit,
    comments: Comment[],
    config: LLMConfig
): Promise<ProcessedStory> {
    const postType = detectPostType(story.title);
    const prompt = buildSummaryPrompt(story, comments);

    try {
        const useThinkingConfig = supportsThinkingConfig(config);
        const thinkingParams = useThinkingConfig
            ? resolveThinkingParams(config, false)
            : null;

        const requestBody: Record<string, unknown> = {
            model: config.model,
            messages: [
                { role: "system", content: "You are a helpful assistant summarizing Hacker News." },
                { role: "user", content: prompt }
            ],
            temperature: thinkingParams ? thinkingParams.temperature : SUMMARY_TEMPERATURE,
            top_p: thinkingParams ? thinkingParams.topP : SUMMARY_TOP_P,
            max_tokens: MAX_TOKENS_SUMMARY
        };

        if (thinkingParams?.thinking) {
            requestBody.chat_template_kwargs = { thinking: thinkingParams.thinking };
        }
        applyThinkingMode(requestBody, config, Boolean(thinkingParams?.thinking));

        let content = "";
        try {
            if (thinkingParams?.thinking) {
                content = await fetchStreamCompletion(config.apiUrl, config.apiKey, requestBody, {
                    stopAfter: ["</Content Summary>", "</Discussion Summary>"]
                });
            } else {
                content = await fetchCompletion(config.apiUrl, config.apiKey, requestBody);
            }
        } catch (apiError: any) {
            const errorMessage = getErrorMessage(apiError);
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
            console.error(`API error for "${story.title}" (${story.objectID}) [${providerLabel}]: ${errorMessage}`);
            const errorSnippet = truncateText(errorMessage, 120);
            return {
                id: story.objectID,
                title: story.title,
                url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
                points: story.points,
                num_comments: story.num_comments,
                summary: `API error: ${errorSnippet}`,
                discussion_summary: `API error: ${errorSnippet}`,
                postType
            };
        }

        // Log if content is empty (might be thinking only?)
        if (!content) {
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
            console.error(`Empty response for "${story.title}" (${story.objectID}) [${providerLabel}]`);
        }

        const parsed = parseSummaryResponse(content);

        return {
            id: story.objectID,
            title: story.title,
            url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
            points: story.points,
            num_comments: story.num_comments,
            summary: parsed.summary,
            discussion_summary: parsed.discussion,
            postType
        };
    } catch (e) {
        console.error(`Failed to summarize: ${story.title}`, e);
        return {
            id: story.objectID,
            title: story.title,
            url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
            points: story.points,
            num_comments: story.num_comments,
            summary: "Error generating summary.",
            discussion_summary: "Error generating summary.",
            postType: 'article'
        };
    }
}

/**
 * Generate the daily digest from processed stories
 */
export async function generateDigest(
    stories: ProcessedStory[],
    config: LLMConfig
): Promise<string> {
    const prompt = buildDigestPrompt(stories);

    try {
        const useThinkingConfig = supportsThinkingConfig(config);
        const thinkingParams = useThinkingConfig
            ? resolveThinkingParams({ ...config, thinking: true }, true)
            : null;

        const requestBody: Record<string, unknown> = {
            model: config.model,
            messages: [
                { role: "system", content: "You are a tech journalist writing a daily Hacker News digest." },
                { role: "user", content: prompt }
            ],
            temperature: thinkingParams ? thinkingParams.temperature : 0.5,
            max_tokens: MAX_TOKENS_DIGEST
        };

        if (thinkingParams) {
            requestBody.top_p = thinkingParams.topP;
            if (thinkingParams.thinking) {
                requestBody.chat_template_kwargs = { thinking: thinkingParams.thinking };
            }
        }

        applyThinkingMode(requestBody, config, true);

        try {
            const content = thinkingParams?.thinking
                ? await fetchStreamCompletion(config.apiUrl, config.apiKey, requestBody)
                : await fetchCompletion(config.apiUrl, config.apiKey, requestBody);
            return content || "Digest generation failed (empty content).";
        } catch (apiError: any) {
            const errorMessage = getErrorMessage(apiError);
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
            console.error(`Digest API error [${providerLabel}]: ${errorMessage}`);
            return "Digest generation failed due to API error.";
        }

    } catch (e) {
        console.error("Digest generation failed", e);
        return "Digest generation failed.";
    }
}

// ============================================================================
// Markdown Formatting
// ============================================================================

/**
 * Format processed stories as article-mode markdown
 */
export function formatArticleMarkdown(stories: ProcessedStory[], date: string): string {
    let md = `# Hacker News Summary - ${date}\n\n`;
    for (const s of stories) {
        const typeLabel = getPostTypeLabel(s.postType);
        md += `## [${s.title}](${s.url})\n`;
        md += `**Score:** ${s.points} | **Comments:** ${s.num_comments} | **ID:** ${s.id}\n\n`;
        md += `> **${typeLabel}:** ${s.summary}\n>\n`;
        md += `> **Discussion:** ${s.discussion_summary}\n\n`;
        md += `---\n\n`;
    }
    return md;
}

/**
 * Format digest content as markdown
 */
export function formatDigestMarkdown(digestContent: string, date: string, storyCount: number): string {
    let md = `# HN Daily Digest - ${date}\n\n`;
    md += digestContent;
    md += `\n\n---\n\n*This digest summarizes the top ${storyCount} stories from Hacker News.*`;
    return md;
}

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Get the current date in London timezone (YYYY-MM-DD format)
 */
export function getLondonDate(): string {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === 'year')?.value ?? '';
    const month = parts.find(p => p.type === 'month')?.value ?? '';
    const day = parts.find(p => p.type === 'day')?.value ?? '';
    return `${year}-${month}-${day}`;
}

/**
 * Parse a date string into year, month, day components
 */
export function parseDateComponents(date: string): { year: string; month: string; day: string } {
    const [year, month, day] = date.split('-');
    return { year: year ?? '', month: month ?? '', day: day ?? '' };
}
