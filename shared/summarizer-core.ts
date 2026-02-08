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
    reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LLMLogger {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

export interface LLMConfigSelection {
    config: LLMConfig;
    provider: string;
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

export interface ArticleMarkdownStoryBlock {
    id: string;
    start: number;
    end: number;
    raw: string;
    story: ProcessedStory;
}

/** Metadata computed for each comment during tree analysis */
export interface CommentMetadata {
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
export interface CommentSelectionOptions {
    maxChars: number;    // Budget on formatted output
    perRootCap: number;  // Max comments from same top-level thread
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ============================================================================
// Constants
// ============================================================================

export const ALGOLIA_API = "https://hn.algolia.com/api/v1";

// LLM Provider Defaults
// Priority: OpenRouter > Cebras > Nvidia NIM > Xiaomi MiMo > OpenAI-compatible
const DEFAULT_CEBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
// Default only applies when CEBRAS_API_MODEL is not set.
const DEFAULT_CEBRAS_MODEL = "gpt-oss-120b";
const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL = "arcee-ai/trinity-large-preview:free";
const DEFAULT_NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_NVIDIA_MODEL = "moonshotai/kimi-k2.5";
const DEFAULT_XIAOMI_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const DEFAULT_XIAOMI_MODEL = "mimo-v2-flash";

export const MAX_TOKENS_FOR_REASONING = 16000;
export const MAX_TOKENS_SUMMARY = 4000;
export const MAX_TOKENS_DIGEST = MAX_TOKENS_FOR_REASONING;
const NVIDIA_MAX_TOKENS_SUMMARY = 2500;
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
    CEBRAS_REASONING_EFFORT?: string;
    // Fallback: Nvidia NIM
    NVIDIA_API_KEY?: string;
    NVIDIA_MODEL?: string;
    // Fallback: Xiaomi MiMo
    XIAOMI_API_KEY?: string;
    XIAOMI_API_URL?: string;
    XIAOMI_MODEL?: string;
    // Preferred: OpenRouter
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

function truncateJsonSnippet(text: string, maxLength = 240): string {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return truncateText(normalized, maxLength);
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

function shouldForceOpenRouterReasoning(config: LLMConfig): boolean {
    if (!isOpenRouterApi(config)) return false;

    // Some OpenRouter models/providers require reasoning to be enabled and will error
    // if it is explicitly disabled.
    return config.model.startsWith('stepfun/');
}

function applyThinkingMode(requestBody: Record<string, unknown>, config: LLMConfig, enabled: boolean) {
    if (isNvidiaApi(config)) {
        // Nvidia NIM format
        requestBody.thinking = enabled ? { type: "enabled" } : { type: "disabled" };
    } else if (isOpenRouterApi(config)) {
        // OpenRouter format
        if (enabled || shouldForceOpenRouterReasoning(config)) {
            requestBody.reasoning = { enabled: true };
        } else {
            // Some providers error if reasoning is explicitly disabled.
            // Omitting is safer than sending { enabled: false }.
            delete (requestBody as any).reasoning;
        }
    }
}

function createCebrasConfig(env: LLMEnv, thinking: boolean | undefined): { config: LLMConfig; provider: string } | null {
    if (!env.CEBRAS_API_KEY) return null;

    const model = env.CEBRAS_API_MODEL || DEFAULT_CEBRAS_MODEL;
    const rawEffort = (env.CEBRAS_REASONING_EFFORT || '').trim().toLowerCase();
    const parsedEffort = rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high'
        ? (rawEffort as 'low' | 'medium' | 'high')
        : undefined;

    const reasoningEffort = parsedEffort || (model.startsWith('gpt-oss-') ? 'medium' : undefined);
    return {
        config: {
            apiKey: env.CEBRAS_API_KEY,
            apiUrl: env.CEBRAS_API_URL || DEFAULT_CEBRAS_URL,
            model,
            provider: 'cebras',
            thinking,
            reasoningEffort
        },
        provider: 'Cebras'
    };
}

function createNvidiaConfig(env: LLMEnv, thinking: boolean | undefined): { config: LLMConfig; provider: string } | null {
    if (!env.NVIDIA_API_KEY) return null;
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

function createOpenRouterConfig(env: LLMEnv, thinking: boolean | undefined): { config: LLMConfig; provider: string } | null {
    if (!env.OPENROUTER_API_KEY) return null;
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
    body: Record<string, unknown>,
    fetcher?: FetchLike
): Promise<string> {
    const meta = await fetchCompletionWithMeta(url, apiKey, body, fetcher);
    // If provider indicates content filtering, surface this as an error.
    if (!meta.content.trim() && (meta.finishReason === 'content_filter' || meta.nativeFinishReason === 'content_filter')) {
        throw new Error('Content filtered');
    }
    return meta.content;
}

function coerceContentToString(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';

    // OpenAI-style content parts
    if (Array.isArray(content)) {
        let out = '';
        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string') {
                out += part;
                continue;
            }
            const anyPart = part as any;
            if (anyPart.type === 'text' && typeof anyPart.text === 'string') {
                out += anyPart.text;
                continue;
            }
            if (typeof anyPart.text === 'string') {
                out += anyPart.text;
                continue;
            }
        }
        return out;
    }

    return '';
}

async function fetchCompletionWithMeta(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    fetcher?: FetchLike,
    options?: { signal?: AbortSignal }
): Promise<{ content: string; finishReason?: string; nativeFinishReason?: string }> {
    const _fetch = fetcher || fetch;
    const response = await _fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "HN-Brief",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: options?.signal
    });

    if (!response.ok) {
        throw await buildApiError(response);
    }

    const data = await response.json() as any;
    if (data?.error) {
        const message = data.error?.message || data.error?.detail || JSON.stringify(data.error);
        throw new Error(`API Error: ${truncateText(String(message), 500)}`);
    }

    const choice = data?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason;
    const nativeFinishReason = choice?.native_finish_reason;

    const primary =
        coerceContentToString(message?.content) ||
        coerceContentToString(message?.reasoning_content) ||
        coerceContentToString((message as any)?.reasoning) ||
        coerceContentToString(message?.refusal) ||
        coerceContentToString(choice?.text) ||
        "";

    // Some providers may return the actual answer in `message.reasoning`.
    // Only use it when it contains the expected XML tags to avoid publishing partial reasoning.
    const reasoning = coerceContentToString((message as any)?.reasoning);
    const reasoningLooksLikeAnswer = /<Content Summary>|<Discussion Summary>/.test(reasoning);
    const content = primary || (reasoningLooksLikeAnswer ? reasoning : "");

    return {
        content,
        finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        nativeFinishReason: typeof nativeFinishReason === 'string' ? nativeFinishReason : undefined
    };
}

/**
 * Helper to fetch and parse SSE stream from LLM API.
 * Handles both "reasoning_content" and "content" fields.
 */
async function fetchStreamCompletion(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    fetcher?: FetchLike,
    options?: { stopAfter?: string[]; signal?: AbortSignal }
): Promise<string> {
    const _fetch = fetcher || fetch;
    const response = await _fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "HN-Brief",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal
    });

    if (!response.ok) {
        throw await buildApiError(response);
    }

    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let contentOut = "";
    let reasoningOut = "";
    const stopAfter = options?.stopAfter?.filter(Boolean) ?? null;
    let shouldStop = false;
    // Prefer returning normal assistant content. Keep reasoning separately as fallback.

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
                    const deltaContent = typeof delta?.content === 'string' ? delta.content : '';
                    const deltaReasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';

                    if (deltaContent) {
                        contentOut += deltaContent;
                    } else if (deltaReasoning) {
                        reasoningOut += deltaReasoning;
                    }

                    const combined = contentOut || reasoningOut;
                    if (combined) {
                        if (stopAfter && stopAfter.length > 0) {
                            const hasAllStops = stopAfter.every((seq) => combined.includes(seq));
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

    return contentOut || reasoningOut;
}

/**
 * Create LLM config from environment variables.
 * Priority: OpenRouter > Cebras > Nvidia NIM > Xiaomi MiMo > OpenAI-compatible (legacy, requires explicit config)
 * 
 * @returns LLM config and provider name for logging
 * @throws Error if no API key is configured
 */
export function createLLMConfig(env: LLMEnv): { config: LLMConfig; provider: string } {
    const candidates = createLLMConfigCandidates(env);
    if (candidates.length > 0) {
        return candidates[0]!;
    }

    throw new Error(
        'No LLM API key found. Set CEBRAS_API_KEY, NVIDIA_API_KEY, XIAOMI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY with LLM_API_URL + LLM_MODEL.'
    );
}

export function createLLMConfigCandidates(env: LLMEnv): LLMConfigSelection[] {
    const thinking = parseThinking(env.LLM_THINKING_FORCE ?? env.LLM_THINKING);
    const candidates: LLMConfigSelection[] = [];

    // Priority 1: OpenRouter (preferred)
    const openrouter = createOpenRouterConfig(env, thinking);
    if (openrouter) candidates.push(openrouter);

    // Priority 2: Cebras
    const cebras = createCebrasConfig(env, thinking);
    if (cebras) candidates.push(cebras);

    // Priority 3: Nvidia NIM
    const nvidia = createNvidiaConfig(env, thinking);
    if (nvidia) candidates.push(nvidia);

    // Priority 4: Xiaomi MiMo
    const xiaomi = createXiaomiConfig(env, thinking);
    if (xiaomi) {
        candidates.push(xiaomi);
    }

    // Priority 5: OpenAI-compatible (requires explicit URL and model)
    if (env.OPENAI_API_KEY) {
        if (!env.LLM_API_URL || !env.LLM_MODEL) {
            if (candidates.length === 0) {
                throw new Error(
                    'When using OPENAI_API_KEY, you must also set LLM_API_URL and LLM_MODEL'
                );
            }
            return candidates;
        }
        candidates.push({
            config: {
                apiKey: env.OPENAI_API_KEY,
                apiUrl: env.LLM_API_URL,
                model: env.LLM_MODEL,
                provider: 'openai-compatible',
                thinking
            },
            provider: 'OpenAI-compatible'
        });
    }

    return candidates;
}

export function createXiaomiConfig(env: LLMEnv, thinking?: boolean): { config: LLMConfig; provider: string } | null {
    if (!env.XIAOMI_API_KEY) return null;
    const resolvedThinking = typeof thinking === 'boolean'
        ? thinking
        : parseThinking(env.LLM_THINKING_FORCE ?? env.LLM_THINKING);
    return {
        config: {
            apiKey: env.XIAOMI_API_KEY,
            apiUrl: env.XIAOMI_API_URL || DEFAULT_XIAOMI_URL,
            model: env.XIAOMI_MODEL || DEFAULT_XIAOMI_MODEL,
            provider: 'xiaomi',
            thinking: resolvedThinking
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
export function scoreComment(meta: CommentMetadata): number {
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
export function selectAndFormatComments(
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
export async function fetchTopStories(date?: string, fetcher?: FetchLike): Promise<AlgoliaHit[]> {
    const _fetch = fetcher || fetch;
    if (date) {
        // For specific date, search for top stories from that day
        const startTimestamp = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
        const endTimestamp = startTimestamp + 86400; // +24 hours

        const numericFilters = `created_at_i>=${startTimestamp},created_at_i<${endTimestamp},points>10`;
        const url = `${ALGOLIA_API}/search?tags=story&numericFilters=${encodeURIComponent(numericFilters)}&hitsPerPage=50`;
        const res = await _fetch(url);
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
    const res = await _fetch(url);
    const data = await res.json() as { hits?: AlgoliaHit[] };
    const hits = data.hits || [];
    return hits.sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 20);
}

/**
 * Fetch detailed story info including comments
 */
export async function fetchStoryDetails(storyId: string, fetcher?: FetchLike): Promise<StoryDetails> {
    const _fetch = fetcher || fetch;
    const res = await _fetch(`${ALGOLIA_API}/items/${storyId}`);
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
[3-4 sentences summarizing the ${typeLabel.toLowerCase()} content. Include at least one specific detail (a claim, number, named project, or concrete action).]
</Content Summary>

<Discussion Summary>
[4-6 sentences summarizing the key discussion points. Include: main themes, disagreements, technical insights, community reactions. Use flowing prose, not bullet points unless there are clearly distinct themes. DO NOT start with "The discussion", "The Hacker News discussion", or "The thread". Jump straight into the substance: what people debated, what insights emerged, where they disagreed. Write like a journalist, not a robot.]
</Discussion Summary>

CRITICAL:
- BOTH sections are REQUIRED - never omit Discussion Summary
- Use the exact XML tags shown above (including the forward slash in closing tags)
- Write in English only. No non-English words or phrases.
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

Write a cohesive, engaging digest that is at least 14 paragraphs and roughly 1200-2200 words (vary paragraph length as needed):
1. Opens with the most significant/interesting story of the day (jump straight into it)
2. Groups related topics together
3. Highlights interesting patterns or themes
4. Maintains a smart, cynical, insider tone (like a senior engineer talking to another)
5. Ends with a brief "worth watching" note

CRITICAL STYLE RULES:
- NO "Good morning", "Grab your coffee", "Welcome back", or other fluff.
- NO generic intros like "Today on Hacker News..."
- Start directly with the first story/topic.
- No bullet points or headers. flowing prose only.
- Write in English only.`;
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
            summary: normalizeSummaryText(contentMatch[1]),
            discussion: normalizeDiscussionText(discussionMatch[1])
        };
    }

    // FALLBACK: If we have content but no discussion tag, extract from remaining text
    if (contentMatch?.[1] && !discussionMatch?.[1]) {
        const contentEnd = content.indexOf('</Content Summary>') + '</Content Summary>'.length;
        const remaining = content.slice(contentEnd).trim();
        
        // If there's substantial content after Content Summary, use it
        if (remaining.length > 50) {
            return {
                summary: normalizeSummaryText(contentMatch[1]),
                discussion: normalizeDiscussionText(remaining.replace(/<\/?[^>]+(>|$)/g, '').trim())
            };
        }
    }

    return {
        summary: contentMatch?.[1] ? normalizeSummaryText(contentMatch[1]) : "Summary unavailable.",
        discussion: discussionMatch?.[1] ? normalizeDiscussionText(discussionMatch[1]) : "Discussion unavailable."
    };
}

function normalizeSummaryText(text: string): string {
    return String(text || '').trim();
}

function normalizeDiscussionText(text: string): string {
    let out = String(text || '').trim();
    out = rewriteRoboticDiscussionLead(out);
    return out;
}

function rewriteRoboticDiscussionLead(text: string): string {
    let out = text.trim();

    // Allow up to 2 adverbs between "discussion" and the verb.
    const ADV = '(?:\\w+\\s+){0,2}';

    const rules: Array<[RegExp, string]> = [
        [/^the\s+hacker\s+news\s+discussion\s+centers\s+on\s+/i, 'Commenters focused on '],
        [/^the\s+discussion\s+centers\s+on\s+/i, 'Commenters focused on '],
        [/^the\s+hacker\s+news\s+discussion\s+centered\s+on\s+/i, 'Commenters focused on '],
        [/^the\s+discussion\s+centered\s+on\s+/i, 'Commenters focused on '],
        [/^the\s+hacker\s+news\s+discussion\s+centered\s+around\s+/i, 'Commenters focused on '],
        [/^the\s+discussion\s+centered\s+around\s+/i, 'Commenters focused on '],
        [/^the\s+hacker\s+news\s+discussion\s+revolves\s+around\s+/i, 'Commenters debated '],
        [/^the\s+discussion\s+revolves\s+around\s+/i, 'Commenters debated '],
        [/^the\s+hacker\s+news\s+discussion\s+revolved\s+around\s+/i, 'Commenters debated '],
        [/^the\s+discussion\s+revolved\s+around\s+/i, 'Commenters debated '],
        [/^the\s+hacker\s+news\s+discussion\s+highlights\s+/i, 'Commenters highlighted '],
        [/^the\s+discussion\s+highlights\s+/i, 'Commenters highlighted '],
        [/^the\s+hacker\s+news\s+discussion\s+highlighted\s+/i, 'Commenters highlighted '],
        [/^the\s+discussion\s+highlighted\s+/i, 'Commenters highlighted '],
        [/^the\s+hacker\s+news\s+discussion\s+dissected\s+/i, 'Commenters dissected '],
        [/^the\s+discussion\s+dissected\s+/i, 'Commenters dissected '],
        [/^the\s+hacker\s+news\s+discussion\s+is\s+about\s+/i, 'Commenters discussed '],
        [/^the\s+discussion\s+is\s+about\s+/i, 'Commenters discussed '],
        [/^the\s+hacker\s+news\s+discussion\s+focused\s+on\s+/i, 'Commenters focused on '],
        [/^the\s+discussion\s+focused\s+on\s+/i, 'Commenters focused on '],

        // Common generic openings
        [/^the\s+hacker\s+news\s+discussion\s+reveals\s+/i, 'Commenters revealed '],
        [/^the\s+discussion\s+reveals\s+/i, 'Commenters revealed '],
        [/^the\s+hacker\s+news\s+discussion\s+shows\s+/i, 'Commenters showed '],
        [/^the\s+discussion\s+shows\s+/i, 'Commenters showed '],
        [/^the\s+hacker\s+news\s+discussion\s+discusses\s+/i, 'Commenters discussed '],
        [/^the\s+discussion\s+discusses\s+/i, 'Commenters discussed '],
        [new RegExp(`^the\\s+hacker\\s+news\\s+discussion\\s+${ADV}debated\\s+`, 'i'), 'Commenters debated '],
        [new RegExp(`^the\\s+discussion\\s+${ADV}debated\\s+`, 'i'), 'Commenters debated '],
        [new RegExp(`^the\\s+hacker\\s+news\\s+discussion\\s+${ADV}argued\\s+`, 'i'), 'Commenters argued '],
        [new RegExp(`^the\\s+discussion\\s+${ADV}argued\\s+`, 'i'), 'Commenters argued '],
        [new RegExp(`^the\\s+hacker\\s+news\\s+discussion\\s+${ADV}criticized\\s+`, 'i'), 'Commenters criticized '],
        [new RegExp(`^the\\s+discussion\\s+${ADV}criticized\\s+`, 'i'), 'Commenters criticized '],
        [new RegExp(`^the\\s+hacker\\s+news\\s+discussion\\s+${ADV}praised\\s+`, 'i'), 'Commenters praised '],
        [new RegExp(`^the\\s+discussion\\s+${ADV}praised\\s+`, 'i'), 'Commenters praised '],
        [new RegExp(`^the\\s+hacker\\s+news\\s+discussion\\s+${ADV}noted\\s+`, 'i'), 'Commenters noted '],
        [new RegExp(`^the\\s+discussion\\s+${ADV}noted\\s+`, 'i'), 'Commenters noted ']
    ];

    for (const [pattern, replacement] of rules) {
        if (pattern.test(out)) {
            out = out.replace(pattern, replacement);
            break;
        }
    }

    // Guard against awkward results like "Commenters focused on ,".
    out = out.replace(/\s+,/g, ',').trim();
    return out;
}

function normalizeComparableText(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isLowQualitySummaryText(text: string): boolean {
    const normalized = normalizeComparableText(text);
    if (!normalized) return true;

    const promptLeakMarkers = [
        '<content summary>',
        '<discussion summary>',
        'you must provide both summaries',
        'the content summary should',
        'the discussion summary should',
        'use exact xml tags',
        'write like a journalist',
        'we have an hn article',
        'now produce xml'
    ];
    if (promptLeakMarkers.some((marker) => normalized.includes(marker))) return true;

    if (/^[.?!,_\-:;]+$/.test(normalized)) return true;
    if (/^(?:\.{2,}|…+)$/.test(normalized)) return true;

    const exactPlaceholders = new Set([
        'and',
        'n/a',
        'na',
        'none',
        'null',
        'unknown',
        'tbd',
        'todo',
        '[removed]',
        '[deleted]'
    ]);
    if (exactPlaceholders.has(normalized)) return true;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 1 && normalized.length <= 12) {
        return true;
    }

    return false;
}

export function isStorySummaryLowQuality(story: Pick<ProcessedStory, 'summary' | 'discussion_summary'>): boolean {
    return (
        isLowQualitySummaryText(story.summary) ||
        isLowQualitySummaryText(story.discussion_summary)
    );
}

// ============================================================================
// LLM API Calls
// ============================================================================

export async function probeLLM(config: LLMConfig, fetcher?: FetchLike): Promise<{ ok: boolean; error?: string }> {
    const isCebras = isCebrasApi(config);
    const isGptOss = isCebras && config.model.startsWith('gpt-oss-');
    const needsReasoningProbeHeadroom = isOpenRouterApi(config) && (
        shouldForceOpenRouterReasoning(config) ||
        config.model === 'openrouter/free'
    );

    const requestBody: Record<string, unknown> = {
        model: config.model,
        messages: [
            { role: "system", content: "You are a health check." },
            { role: "user", content: "Reply with OK." }
        ],
        temperature: isNvidiaApi(config) ? 0.6 : (isGptOss ? 1 : 0)
    };

    if (isGptOss) {
        requestBody.top_p = 1;
    }

    if (isCebras && config.reasoningEffort) {
        requestBody.reasoning_effort = config.reasoningEffort;
    }

    // Some models may emit reasoning before final text. Keep probe short, but leave enough headroom.
    applyMaxTokens(requestBody, config, (isGptOss || needsReasoningProbeHeadroom) ? 256 : 32);

    // Use Instant Mode for Nvidia NIM to avoid 524 timeout during health check
    applyThinkingMode(requestBody, config, false);

    const _fetch = fetcher || fetch;
    const controller = new AbortController();
    // Fail fast: health checks are just to validate basic config.
    const timeoutMs = isNvidiaApi(config) ? 30000 : 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await _fetch(config.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "HN-Brief",
                "Authorization": `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();

        if (!response.ok) {
            const snippet = text ? truncateJsonSnippet(text) : (response.statusText || "Unknown error");
            return { ok: false, error: `status=${response.status} ${snippet}` };
        }

        if (!text || !text.trim()) {
            return { ok: false, error: `empty body (status=${response.status})` };
        }

        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            return { ok: false, error: `non-json response (${contentType || 'unknown'}): ${truncateJsonSnippet(text)}` };
        }

        if (data?.error) {
            const message = data.error?.message || data.error?.detail || JSON.stringify(data.error);
            return { ok: false, error: `API error: ${truncateJsonSnippet(String(message))}` };
        }

        const choice = data?.choices?.[0];
        const message = choice?.message;
        const finishReason = choice?.finish_reason;
        const nativeFinishReason = choice?.native_finish_reason;

        const primary =
            coerceContentToString(message?.content) ||
            coerceContentToString(message?.reasoning_content) ||
            coerceContentToString((message as any)?.reasoning) ||
            coerceContentToString(message?.refusal) ||
            coerceContentToString(choice?.text) ||
            "";

        if (!primary || !primary.trim()) {
            const choicesLen = Array.isArray(data?.choices) ? data.choices.length : 0;
            const finish = typeof finishReason === 'string' ? finishReason : '';
            const native = typeof nativeFinishReason === 'string' ? nativeFinishReason : '';
            return {
                ok: false,
                error: `empty response (choices=${choicesLen}${finish ? ` finish=${finish}` : ''}${native ? ` native=${native}` : ''})`
            };
        }

        return { ok: true };
    } catch (error) {
        if (controller.signal.aborted) {
            return { ok: false, error: `timeout after ${timeoutMs}ms` };
        }
        return { ok: false, error: getErrorMessage(error) };
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function resolveLLMConfigWithFallback(
    env: LLMEnv,
    logger: LLMLogger = { info: () => {}, error: () => {} },
    fetcher?: FetchLike
): Promise<{ config: LLMConfig; provider: string; usedFallback: boolean }>{
    // Try providers in order: OpenRouter -> Cebras -> Nvidia -> Xiaomi -> OpenAI-compatible
    const providers = createLLMConfigCandidates(env);
    
    if (providers.length === 0) {
        throw new Error('No LLM API key found. Set CEBRAS_API_KEY, NVIDIA_API_KEY, XIAOMI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.');
    }
    
    // Try each provider with health check
    for (let i = 0; i < providers.length; i++) {
        const current = providers[i]!;
        logger.info(`Trying LLM: ${current.provider} with model: ${current.config.model}`);
        
        // Run a small health check before selecting a provider.
        // This helps avoid burning an entire run on OpenRouter quota errors (e.g. 429 free-models-per-day)
        // and catches obvious misconfiguration early.
        if (current.provider === 'OpenRouter' || current.provider === 'Cebras' || current.provider === 'Nvidia NIM') {
            logger.info(`Running ${current.provider} health check...`);
            const probe = await probeLLM(current.config, fetcher);
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
    config: LLMConfig,
    fetcher?: FetchLike,
    logger?: LLMLogger
): Promise<ProcessedStory> {
    const postType = detectPostType(story.title);
    const prompt = buildSummaryPrompt(story, comments);
    const logError = logger?.error || console.error;

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

        // Encourage early termination once both blocks are produced.
        requestBody.stop = ["</Discussion Summary>"];

        if (isCebrasApi(config) && config.reasoningEffort) {
            requestBody.reasoning_effort = config.reasoningEffort;
        }
        const maxTokens = isNvidiaApi(config) ? NVIDIA_MAX_TOKENS_SUMMARY : MAX_TOKENS_SUMMARY;
        applyMaxTokens(requestBody, config, maxTokens);

        // Apply thinking mode with provider-specific format
        // Nvidia uses 'thinking' field or chat_template_kwargs
        // OpenRouter uses 'reasoning' field
        if (isNvidiaApi(config) && thinkingParams?.thinking) {
            requestBody.chat_template_kwargs = { thinking: thinkingParams.thinking };
        }
        applyThinkingMode(requestBody, config, Boolean(thinkingParams?.thinking));

        let content = "";
        let finishReason: string | undefined;
        try {
            const controller = new AbortController();
            const timeoutMs = isNvidiaApi(config) ? 90000 : 60000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                // Avoid streaming (keeps Worker CPU lower); rely on stop sequences + timeouts instead.
                const meta = await fetchCompletionWithMeta(config.apiUrl, config.apiKey, requestBody, fetcher, {
                    signal: controller.signal
                });
                content = meta.content;
                finishReason = meta.finishReason || meta.nativeFinishReason;

                // Some OpenRouter upstreams return empty content with finish_reason=content_filter.
                // Retry once with a fallback model to avoid publishing "Summary unavailable".
                if (!content.trim() && isOpenRouterApi(config) && finishReason === 'content_filter') {
                    const logInfo = logger?.info || console.log;
                    if (config.model !== OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL) {
                        logInfo(
                            `Content filtered for "${story.title}" (${story.objectID}) ` +
                            `on ${config.model}; retrying with ${OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL}...`
                        );
                        const retryBody = { ...requestBody, model: OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL };
                        const retryMeta = await fetchCompletionWithMeta(config.apiUrl, config.apiKey, retryBody, fetcher);
                        content = retryMeta.content;
                        finishReason = retryMeta.finishReason || retryMeta.nativeFinishReason;
                    }
                }
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (apiError: any) {
            const errorMessage = getErrorMessage(apiError);
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;

            // Some OpenRouter upstreams error out on sensitive content (or return content_filter).
            // Try a single alternate OpenRouter model before giving up.
            if (isOpenRouterApi(config) && config.model !== OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL) {
                const isPossiblyFiltered =
                    /content[_\s-]?filter/i.test(errorMessage) ||
                    /\b451\b/.test(errorMessage) ||
                    /provider returned error/i.test(errorMessage);

                if (isPossiblyFiltered) {
                    const logInfo = logger?.info || console.log;
                    logInfo(
                        `OpenRouter error for "${story.title}" (${story.objectID}) on ${config.model}; ` +
                        `retrying with ${OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL}...`
                    );
                    try {
                        const retryBody = { ...requestBody, model: OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL };
                        const retryMeta = await fetchCompletionWithMeta(config.apiUrl, config.apiKey, retryBody, fetcher);
                        content = retryMeta.content;
                        finishReason = retryMeta.finishReason || retryMeta.nativeFinishReason;

                        // Continue through normal parsing path
                    } catch (retryError: any) {
                        const retryMessage = getErrorMessage(retryError);
                        logError(
                            `API error for "${story.title}" (${story.objectID}) ` +
                            `[openrouter:${OPENROUTER_CONTENT_FILTER_FALLBACK_MODEL}]: ${retryMessage}`
                        );
                    }
                }
            }

            if (!content.trim()) {
                logError(`API error for "${story.title}" (${story.objectID}) [${providerLabel}]: ${errorMessage}`);
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
        }

        // Log if content is empty (might be thinking only?)
        if (!content) {
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
            const reason = finishReason ? ` finish_reason=${finishReason}` : '';
            logError(`Empty response for "${story.title}" (${story.objectID}) [${providerLabel}]${reason}`);
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
        logError(`Failed to summarize: ${story.title}`, e);
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

function scoreStoryOutput(story: Pick<ProcessedStory, 'summary' | 'discussion_summary'>): number {
    const summary = (story.summary || '').trim();
    const discussion = (story.discussion_summary || '').trim();

    let score = 0;
    if (!isLowQualitySummaryText(summary)) score += 500;
    if (!isLowQualitySummaryText(discussion)) score += 500;

    score += Math.min(summary.length, 800);
    score += Math.min(discussion.length, 1200);
    return score;
}

export async function summarizeStoryWithFallbacks(
    story: AlgoliaHit,
    comments: Comment[],
    candidates: LLMConfig[],
    fetcher?: FetchLike,
    logger?: LLMLogger
): Promise<ProcessedStory> {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('summarizeStoryWithFallbacks requires at least one LLM config candidate');
    }

    const logInfo = logger?.info || console.log;

    let best: ProcessedStory | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
        const config = candidates[i]!;
        const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
        if (i > 0) {
            logInfo(`Retrying "${story.title}" (${story.objectID}) with fallback ${providerLabel}`);
        }

        const next = await summarizeStory(story, comments, config, fetcher, logger);
        const nextScore = scoreStoryOutput(next);

        if (nextScore > bestScore) {
            best = next;
            bestScore = nextScore;
        }

        if (!needsStoryRepair(next)) {
            return next;
        }
    }

    return best!;
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
        fetcher?: FetchLike;
        logger?: LLMLogger;
    }
): Promise<ProcessedStory[]> {
    const isNvidia = isNvidiaApi(llmConfig);
    const {
        batchSize = 5,
        storyDelayMs = isNvidia ? 0 : 1000,
        batchDelayMs = isNvidia ? 0 : 5000,
        indent = '',
        fetcher,
        logger
    } = options || {};

    const logInfo = logger?.info || console.log;
    
    const processedStories: ProcessedStory[] = [];
    const totalBatches = Math.ceil(storyDetails.length / batchSize);
    
    for (let i = 0; i < storyDetails.length; i += batchSize) {
        const batch = storyDetails.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        logInfo(`${indent}Processing batch ${batchNum}/${totalBatches} (${batch.length} stories)...`);

        if (isNvidia) {
            // Nvidia NIM is typically latency-bound. Run each batch in parallel to fit within cron time limits.
            const results = await Promise.all(
                batch.map(({ hit, details }) => summarizeStory(hit, details.children || [], llmConfig, fetcher, logger))
            );
            processedStories.push(...results);
        } else {
            // Process sequentially with delay between each
            for (const { hit, details } of batch) {
                const summary = await summarizeStory(hit, details.children || [], llmConfig, fetcher, logger);
                processedStories.push(summary);

                // Small delay between stories to avoid overwhelming API
                if (processedStories.length < storyDetails.length && storyDelayMs > 0) {
                    await new Promise(r => setTimeout(r, storyDelayMs));
                }
            }
        }
        
        // Delay between batches
        if (i + batchSize < storyDetails.length && batchDelayMs > 0) {
            logInfo(`${indent}⏳ Waiting ${batchDelayMs/1000}s before next batch...`);
            await new Promise(r => setTimeout(r, batchDelayMs));
        }
    }
    
    logInfo(`${indent}✅ Summarized ${processedStories.length} stories`);
    return processedStories;
}

/**
 * Generate the daily digest from processed stories
 */
export async function generateDigest(
    stories: ProcessedStory[],
    config: LLMConfig,
    fetcher?: FetchLike
): Promise<string> {
    const prompt = buildDigestPrompt(stories);

    try {
        const useThinkingConfig = supportsThinkingConfig(config);
        const thinkingParams = useThinkingConfig
            ? resolveThinkingParams(config, true)
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

        if (isCebrasApi(config) && config.reasoningEffort) {
            requestBody.reasoning_effort = config.reasoningEffort;
        }

        if (thinkingParams) {
            requestBody.top_p = thinkingParams.topP;
            // Only use chat_template_kwargs for Nvidia (vLLM/SGLang format)
            if (isNvidiaApi(config) && thinkingParams.thinking) {
                requestBody.chat_template_kwargs = { thinking: thinkingParams.thinking };
            }
        }

        applyThinkingMode(requestBody, config, Boolean(thinkingParams?.thinking));

        const controller = new AbortController();
        const timeoutMs = isNvidiaApi(config) ? 210000 : 120000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // Avoid streaming here as well; use a longer timeout for digest.
            const content = (await fetchCompletionWithMeta(config.apiUrl, config.apiKey, requestBody, fetcher, {
                signal: controller.signal
            })).content;

            return content || "Digest generation failed (empty content).";
        } catch (apiError: any) {
            const providerLabel = `${config.provider ?? 'unknown'}:${config.model}`;
            if (controller.signal.aborted) {
                console.error(`Digest API timeout [${providerLabel}] after ${timeoutMs}ms`);
                return "Digest generation failed due to API timeout.";
            }
            const errorMessage = getErrorMessage(apiError);
            console.error(`Digest API error [${providerLabel}]: ${errorMessage}`);
            return "Digest generation failed due to API error.";
        } finally {
            clearTimeout(timeoutId);
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

function getPostTypeFromSummaryLabel(label: string): PostType {
    const normalized = String(label || '').trim().toLowerCase();
    if (normalized === 'question') return 'ask_hn';
    if (normalized === 'project') return 'show_hn';
    if (normalized === 'post') return 'tell_hn';
    if (normalized === 'launch') return 'launch_hn';
    return 'article';
}

function extractHnItemId(url: string): string {
    const value = String(url || '').trim();
    if (!value) return '';

    const queryMatch = value.match(/[?&]id=(\d+)/);
    if (queryMatch?.[1]) return queryMatch[1];

    const trailingMatch = value.match(/\/(\d+)\/?$/);
    if (trailingMatch?.[1]) return trailingMatch[1];

    return '';
}

export function hasValidStoryId(id: string | null | undefined): id is string {
    return /^\d+$/.test(String(id || '').trim());
}

export function buildRepairStoryHit(existing: ProcessedStory, details: StoryDetails): AlgoliaHit {
    const existingId = String(existing.id || '').trim();
    const detailId = String(details.id || '').trim();
    const resolvedId = hasValidStoryId(existingId) ? existingId : detailId;

    if (!hasValidStoryId(resolvedId)) {
        throw new Error(`Cannot build repair hit without valid story ID (title: ${existing.title})`);
    }

    const fallbackUrl = existing.url || `https://news.ycombinator.com/item?id=${resolvedId}`;
    const detailChildren = Array.isArray(details.children) ? details.children : [];

    return {
        objectID: resolvedId,
        title: details.title || existing.title,
        url: details.url || fallbackUrl,
        text: details.text,
        points: typeof details.points === 'number' ? details.points : existing.points,
        num_comments: existing.num_comments || detailChildren.length || 0,
        created_at_i: Math.floor(Date.now() / 1000)
    };
}

function parseStoryBlock(block: string): ProcessedStory | null {
    const titleMatch = block.match(/^## \[([^\]]+)\]\(([^)]+)\)/m);
    const metaMatch = block.match(/\*\*Score:\*\* (\d+)(?:\s*\|\s*\*\*Comments:\*\* (\d+))?(?:\s*\|\s*\*\*ID:\*\*\s*(\d+))?/m);
    const url = titleMatch?.[2] || '';
    const id = (metaMatch?.[3]?.trim() || extractHnItemId(url)).trim();

    if (!titleMatch || !metaMatch) return null;

    let summaryLabel = 'Article';
    const summaryParts: string[] = [];
    const discussionParts: string[] = [];
    let section: 'summary' | 'discussion' = 'summary';

    for (const line of block.split('\n')) {
        if (!line.startsWith('> ')) continue;
        const content = line.slice(2);

        const summaryLabelMatch = content.match(/^\*\*(Article|Question|Project|Post|Launch):\*\*\s*(.*)$/);
        if (summaryLabelMatch) {
            summaryLabel = summaryLabelMatch[1] || summaryLabel;
            section = 'summary';
            const initial = (summaryLabelMatch[2] || '').trim();
            if (initial) summaryParts.push(initial);
            continue;
        }

        const discussionMatch = content.match(/^\*\*Discussion:\*\*\s*(.*)$/);
        if (discussionMatch) {
            section = 'discussion';
            const initial = (discussionMatch[1] || '').trim();
            if (initial) discussionParts.push(initial);
            continue;
        }

        if (!content.trim()) {
            if (section === 'discussion') {
                discussionParts.push('');
            } else {
                summaryParts.push('');
            }
            continue;
        }

        if (section === 'discussion') {
            discussionParts.push(content);
        } else {
            summaryParts.push(content);
        }
    }

    return {
        id,
        title: titleMatch[1] || '',
        url: url || (id ? `https://news.ycombinator.com/item?id=${id}` : ''),
        points: parseInt(metaMatch[1] || '0', 10),
        num_comments: parseInt(metaMatch[2] || '0', 10),
        summary: summaryParts.join('\n').trim(),
        discussion_summary: discussionParts.join('\n').trim(),
        postType: getPostTypeFromSummaryLabel(summaryLabel)
    };
}

export function extractArticleMarkdownStoryBlocks(md: string): ArticleMarkdownStoryBlock[] {
    const text = String(md || '');
    const starts: number[] = [];
    const titlePattern = /^## \[/gm;
    let match: RegExpExecArray | null;

    while ((match = titlePattern.exec(text)) !== null) {
        starts.push(match.index);
    }

    const blocks: ArticleMarkdownStoryBlock[] = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i]!;
        const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
        const raw = text.slice(start, end);
        const story = parseStoryBlock(raw);
        if (!story) continue;
        blocks.push({ id: story.id, start, end, raw, story });
    }

    return blocks;
}

export function parseArticleMarkdownStories(md: string): ProcessedStory[] {
    return extractArticleMarkdownStoryBlocks(md).map((block) => block.story);
}

export function formatArticleStoryBlock(story: ProcessedStory): string {
    const typeLabel = getPostTypeLabel(story.postType);
    let out = `## [${story.title}](${story.url})\n`;
    out += `**Score:** ${story.points} | **Comments:** ${story.num_comments} | **ID:** ${story.id}\n\n`;
    out += `> **${typeLabel}:** ${story.summary}\n>\n`;
    out += `> **Discussion:** ${story.discussion_summary}\n\n`;
    out += `---\n\n`;
    return out;
}

export function replaceStoriesInArticleMarkdown(
    md: string,
    replacements: Map<string, ProcessedStory> | Record<string, ProcessedStory>
): { markdown: string; updatedIds: string[]; missingIds: string[] } {
    const replacementMap = replacements instanceof Map
        ? replacements
        : new Map(Object.entries(replacements));

    if (replacementMap.size === 0) {
        return { markdown: md, updatedIds: [], missingIds: [] };
    }

    const blocks = extractArticleMarkdownStoryBlocks(md);
    const seen = new Set<string>();
    const updatedIds: string[] = [];

    let cursor = 0;
    let output = '';

    for (const block of blocks) {
        output += md.slice(cursor, block.start);

        const replacement = replacementMap.get(block.id);
        if (replacement) {
            output += formatArticleStoryBlock(replacement);
            seen.add(block.id);
            updatedIds.push(block.id);
        } else {
            output += block.raw;
        }

        cursor = block.end;
    }

    output += md.slice(cursor);

    const missingIds = Array.from(replacementMap.keys()).filter((id) => !seen.has(id));
    return { markdown: output, updatedIds, missingIds };
}

export function findRepairableStoryIdsInMarkdown(md: string): string[] {
    return parseArticleMarkdownStories(md)
        .filter((story) => hasValidStoryId(story.id) && needsStoryRepair(story))
        .map((story) => story.id);
}

export function isDigestMarkdownEmptyOrFailed(md: string): boolean {
    const text = String(md || '');
    if (!text.trim()) return true;
    if (isDigestFailureText(text)) return true;

    const body = text
        .replace(/^# HN Daily Digest - .*$/m, '')
        .replace(/\n\n---[\s\S]*$/m, '')
        .trim();

    return body.length < 40;
}

// ============================================================================
// Publication Guardrails (Shared)
// ============================================================================

export function isStorySummaryFailure(story: Pick<ProcessedStory, 'summary' | 'discussion_summary'>): boolean {
    const summary = (story.summary || '').trim();
    const discussion = (story.discussion_summary || '').trim();

    return (
        /^API error:/i.test(summary) ||
        /^API error:/i.test(discussion) ||
        /^Error generating summary\.?$/i.test(summary) ||
        /^Error generating summary\.?$/i.test(discussion) ||
        /^Summary unavailable\.?$/i.test(summary) ||
        /^Summary unavailable\.?$/i.test(discussion) ||
        /^Discussion unavailable\.?$/i.test(discussion)
    );
}

export function needsStoryRepair(story: Pick<ProcessedStory, 'summary' | 'discussion_summary'>): boolean {
    return isStorySummaryFailure(story) || isStorySummaryLowQuality(story);
}

export function isDigestFailureText(digestContent: string): boolean {
    return /^\s*Digest generation failed/i.test((digestContent || '').trim());
}

export function countFailuresInArticleMarkdown(md: string): number {
    // formatArticleMarkdown emits blocks like:
    // > **Article:** ...
    // > **Discussion:** ...
    // We count failure blocks (not stories) so the metric stays stable even if a single story
    // has multiple failures.
    const text = String(md || '');
    const hardFailureMatches = text.match(
        /> \*\*[^*]+:\*\*\s*(?:API error:|Error generating summary\.?|Summary unavailable\.?|Discussion unavailable\.?)/gi
    );
    const placeholderMatches = text.match(
        /> \*\*[^*]+:\*\*\s+(?:\.\.\.|and)\s*$/gim
    );

    return (hardFailureMatches?.length || 0) + (placeholderMatches?.length || 0);
}

export function wouldWorsenArticleMarkdown(nextMd: string, prevMd: string): string | null {
    const nextFailures = countFailuresInArticleMarkdown(nextMd);
    const prevFailures = countFailuresInArticleMarkdown(prevMd);
    return nextFailures > prevFailures ? `would worsen failure count (${prevFailures} -> ${nextFailures})` : null;
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
