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
    provider?: 'cebras' | 'nvidia' | 'openrouter' | 'openai-compatible' | 'xiaomi';
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
// Priority: Cebras > Nvidia NIM > Xiaomi MiMo > OpenRouter > OpenAI-compatible
const DEFAULT_CEBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const DEFAULT_CEBRAS_MODEL = "qwen-3-235b-a22b-instruct-2507";
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
    // Primary: Cebras
    CEBRAS_API_KEY?: string;
    CEBRAS_API_URL?: string;
    CEBRAS_API_MODEL?: string;
    // Fallback: Nvidia NIM
    NVIDIA_API_KEY?: string;
    NVIDIA_MODEL?: string;
    // Fallback: Xiaomi MiMo
    XIAOMI_API_KEY?: string;
    XIAOMI_API_URL?: string;
    XIAOMI_MODEL?: string;
    // Last resort: OpenRouter
    OPENROUTER_API_KEY?: string;
    OPENROUTER_MODEL?: string;
    // Alternative: OpenAI-compatible
    OPENAI_API_KEY?: string;
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

function isCebrasApi(config: LLMConfig): boolean {
    if (config.provider === 'cebras') return true;
    return config.apiUrl.includes('cerebras.ai');
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

function applyMaxTokens(requestBody: Record<string, unknown>, config: LLMConfig, maxTokens: number) {
    if (isCebrasApi(config)) {
        requestBody.max_completion_tokens = maxTokens;
        return;
    }
    requestBody.max_tokens = maxTokens;
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
            "User-Agent": "HN-Brief",
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

    const message = data?.choices?.[0]?.message;
    const content =
        message?.content ??
        message?.reasoning_content ??
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
            "User-Agent": "HN-Brief",
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
                    const deltaContent = delta?.content || delta?.reasoning_content;
                    if (deltaContent) {
                        finalContent += deltaContent;
                        if (stopAfter && stopAfter.length > 0) {
                            const hasAllStops = stopAfter.every((seq) => finalContent.includes(seq));
                            if (hasAllStops) {
                                shouldStop = true;
                                void reader.cancel();
                                break;
                            }
                        }
                    }
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
 * Priority: Cebras > Nvidia NIM > Xiaomi MiMo > OpenRouter > OpenAI-compatible (legacy, requires explicit config)
 * 
 * @returns LLM config and provider name for logging
 * @throws Error if no API key is configured
 */
export function createLLMConfig(env: LLMEnv): { config: LLMConfig; provider: string } {
    const thinking = parseThinking(env.LLM_THINKING_FORCE ?? env.LLM_THINKING);
    
    // Priority 1: Cebras (primary provider)
    if (env.CEBRAS_API_KEY) {
        return {
            config: {
                apiKey: env.CEBRAS_API_KEY,
                apiUrl: env.CEBRAS_API_URL || DEFAULT_CEBRAS_URL,
                model: env.CEBRAS_API_MODEL || DEFAULT_CEBRAS_MODEL,
                provider: 'cebras',
                thinking
            },
            provider: 'Cebras'
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

    // Priority 3: Xiaomi MiMo (fallback)
    const xiaomi = createXiaomiConfig(env);
    if (xiaomi) {
        return xiaomi;
    }

    // Priority 4: OpenRouter (last resort)
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

    // Priority 5: OpenAI-compatible (requires explicit URL and model)
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

    throw new Error(
        'No LLM API key found. Set CEBRAS_API_KEY, NVIDIA_API_KEY, XIAOMI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY with LLM_API_URL + LLM_MODEL.'
    );
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

        const numericFilters = `created_at_i>=${startTimestamp},created_at_i<${endTimestamp},points>10`;
        const url = `${ALGOLIA_API}/search?tags=story&numericFilters=${encodeURIComponent(numericFilters)}&hitsPerPage=50`;
        const res = await fetch(url);
        const data = await res.json() as { hits?: AlgoliaHit[] };

        // Sort by points descending and take top 20
        const sortedHits = (data.hits || []).sort((a, b) => (b.points || 0) - (a.points || 0));
        return sortedHits.slice(0, 20);
    }

    // Default: last 24 hours sorted by points
    const now = Math.floor(Date.now() / 1000);
    const yesterday = now - 86400;

    const numericFilters = `created_at_i>${yesterday},points>10`;
    const url = `${ALGOLIA_API}/search?tags=story&numericFilters=${encodeURIComponent(numericFilters)}&hitsPerPage=50`;
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

You MUST provide BOTH summaries in exactly this XML format:

<Content Summary>
[2-3 sentences summarizing the ${typeLabel.toLowerCase()} content]
</Content Summary>

<Discussion Summary>
[2-4 sentences summarizing the key discussion points. Include: main themes, disagreements, technical insights, community reactions. Use flowing prose, not bullet points unless there are clearly distinct themes. DO NOT start with "The Hacker News discussion" or similar robotic phrases. Jump straight into the substance: what people debated, what insights emerged, where they disagreed. Write like a journalist, not a robot.]
</Discussion Summary>

CRITICAL:
- BOTH sections are REQUIRED - never omit Discussion Summary
- Use the exact XML tags shown above (including the forward slash in closing tags)
- Output will be parsed programmatically using these specific tags`;
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

    // If we have both tags, perfect!
    if (contentMatch?.[1] && discussionMatch?.[1]) {
        return {
            summary: contentMatch[1].trim(),
            discussion: discussionMatch[1].trim()
        };
    }

    // FALLBACK: If we have content but no discussion tag, extract from remaining text
    if (contentMatch?.[1] && !discussionMatch?.[1]) {
        const contentEnd = content.indexOf('</Content Summary>') + '</Content Summary>'.length;
        const remaining = content.slice(contentEnd).trim();
        
        // If there's substantial content after Content Summary, use it
        if (remaining.length > 50) {
            return {
                summary: contentMatch[1].trim(),
                discussion: remaining.replace(/<\/?[^>]+(>|$)/g, '').slice(0, 800)
            };
        }
    }

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
        temperature: isNvidiaApi(config) ? 0.6 : 0
    };
    applyMaxTokens(requestBody, config, 32);

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
    // Try providers in order: Cebras -> Nvidia -> Xiaomi -> OpenRouter
    const providers: { config: LLMConfig; provider: string }[] = [];
    
    // Build list of available providers
    if (env.CEBRAS_API_KEY) {
        providers.push(createLLMConfig(env));
    }
    if (env.NVIDIA_API_KEY) {
        const nvidia = createLLMConfig({ ...env, CEBRAS_API_KEY: undefined });
        providers.push(nvidia);
    }
    const xiaomi = createXiaomiConfig(env);
    if (xiaomi) {
        providers.push(xiaomi);
    }
    if (env.OPENROUTER_API_KEY) {
        const openrouter = createLLMConfig({ 
            ...env, 
            CEBRAS_API_KEY: undefined, 
            NVIDIA_API_KEY: undefined,
            XIAOMI_API_KEY: undefined 
        });
        providers.push(openrouter);
    }
    
    if (providers.length === 0) {
        throw new Error('No LLM API key found. Set CEBRAS_API_KEY, NVIDIA_API_KEY, XIAOMI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.');
    }
    
    // Try each provider with health check
    for (let i = 0; i < providers.length; i++) {
        const current = providers[i]!;
        logger.info(`Trying LLM: ${current.provider} with model: ${current.config.model}`);
        
        // Run health check for Cebras and Nvidia
        if (current.provider === 'Cebras' || current.provider === 'Nvidia NIM') {
            logger.info(`Running ${current.provider} health check...`);
            const probe = await probeLLM(current.config);
            if (!probe.ok) {
                const detail = probe.error ? ` (${probe.error})` : '';
                logger.error(`${current.provider} health check failed${detail}.`);
                
                // Try next provider
                if (i < providers.length - 1) {
                    const next = providers[i + 1]!;
                    logger.info(`Falling back to ${next.provider}...`);
                    continue;
                } else {
                    logger.error('All providers failed health checks.');
                    throw new Error(`All LLM providers failed. Last error: ${probe.error || 'Unknown'}`);
                }
            }
            logger.info(`${current.provider} health check ok.`);
        }
        
        logger.info(`Active LLM: ${current.provider} with model: ${current.config.model}`);
        return { 
            config: current.config, 
            provider: current.provider, 
            usedFallback: i > 0 
        };
    }
    
    // Should not reach here, but just in case
    throw new Error('Failed to find a working LLM provider.');
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
            top_p: thinkingParams ? thinkingParams.topP : SUMMARY_TOP_P
        };
        applyMaxTokens(requestBody, config, MAX_TOKENS_SUMMARY);

        // Apply thinking mode with provider-specific format
        // Nvidia uses 'thinking' field or chat_template_kwargs
        // OpenRouter uses 'reasoning' field
        if (isNvidiaApi(config) && thinkingParams?.thinking) {
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
 * Process multiple stories with rate limiting
 * Handles batching, sequential processing, and delays between requests
 * to avoid overwhelming LLM APIs (especially Cebras with its tokens-per-minute limits)
 */
export async function processStoriesWithRateLimit(
    storyDetails: { hit: AlgoliaHit; details: StoryDetails }[],
    llmConfig: LLMConfig,
    options?: {
        batchSize?: number;
        storyDelayMs?: number;
        batchDelayMs?: number;
        indent?: string;
    }
): Promise<ProcessedStory[]> {
    const {
        batchSize = 3,
        storyDelayMs = 2000,
        batchDelayMs = 10000,
        indent = ''
    } = options || {};
    
    const processedStories: ProcessedStory[] = [];
    const totalBatches = Math.ceil(storyDetails.length / batchSize);
    
    for (let i = 0; i < storyDetails.length; i += batchSize) {
        const batch = storyDetails.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        console.log(`${indent}Processing batch ${batchNum}/${totalBatches} (${batch.length} stories)...`);
        
        // Process sequentially with delay between each
        for (const { hit, details } of batch) {
            const summary = await summarizeStory(hit, details.children || [], llmConfig);
            processedStories.push(summary);
            
            // Small delay between stories to avoid overwhelming API
            if (processedStories.length < storyDetails.length) {
                await new Promise(r => setTimeout(r, storyDelayMs));
            }
        }
        
        // Delay between batches
        if (i + batchSize < storyDetails.length) {
            console.log(`${indent}⏳ Waiting ${batchDelayMs/1000}s before next batch...`);
            await new Promise(r => setTimeout(r, batchDelayMs));
        }
    }
    
    console.log(`${indent}✅ Summarized ${processedStories.length} stories`);
    return processedStories;
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
            temperature: thinkingParams ? thinkingParams.temperature : 0.5
        };
        applyMaxTokens(requestBody, config, MAX_TOKENS_DIGEST);

        if (thinkingParams) {
            requestBody.top_p = thinkingParams.topP;
            // Only use chat_template_kwargs for Nvidia (vLLM/SGLang format)
            if (isNvidiaApi(config) && thinkingParams.thinking) {
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
