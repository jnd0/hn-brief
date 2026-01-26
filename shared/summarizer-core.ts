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
const DEFAULT_NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_NVIDIA_MODEL = "moonshotai/kimi-k2-thinking";
const DEFAULT_OPENROUTER_MODEL = "xiaomi/mimo-v2-flash:free";

// ============================================================================
// LLM Configuration Factory
// ============================================================================

/**
 * Environment variables for LLM configuration
 */
export interface LLMEnv {
    NVIDIA_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    OPENAI_API_KEY?: string;
    LLM_API_URL?: string;
    LLM_MODEL?: string;
}

/**
 * Create LLM config from environment variables.
 * Priority: Nvidia NIM > OpenRouter > OpenAI (explicit URL/model required)
 * 
 * @returns LLM config and provider name for logging
 * @throws Error if using OpenAI without explicit URL/model
 */
export function createLLMConfig(env: LLMEnv): { config: LLMConfig; provider: string } {
    if (env.NVIDIA_API_KEY) {
        return {
            config: {
                apiKey: env.NVIDIA_API_KEY,
                apiUrl: env.LLM_API_URL || DEFAULT_NVIDIA_URL,
                model: env.LLM_MODEL || DEFAULT_NVIDIA_MODEL
            },
            provider: 'Nvidia NIM'
        };
    }

    if (env.OPENROUTER_API_KEY) {
        return {
            config: {
                apiKey: env.OPENROUTER_API_KEY,
                apiUrl: env.LLM_API_URL || DEFAULT_OPENROUTER_URL,
                model: env.LLM_MODEL || DEFAULT_OPENROUTER_MODEL
            },
            provider: 'OpenRouter'
        };
    }

    if (env.OPENAI_API_KEY) {
        // OpenAI-compatible requires explicit URL and model
        if (!env.LLM_API_URL || !env.LLM_MODEL) {
            throw new Error(
                'When using OPENAI_API_KEY, you must also set LLM_API_URL and LLM_MODEL'
            );
        }
        return {
            config: {
                apiKey: env.OPENAI_API_KEY,
                apiUrl: env.LLM_API_URL,
                model: env.LLM_MODEL
            },
            provider: 'OpenAI-compatible'
        };
    }

    throw new Error('No LLM API key found. Set NVIDIA_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.');
}

// ============================================================================
// Comment Selection Algorithm
// ============================================================================

// Comment selection configuration (configurable via environment variables)
const MAX_COMMENT_CHARS = parseInt(process.env.MAX_COMMENT_CHARS || '15000', 10);
const MAX_COMMENTS_PER_ROOT = parseInt(process.env.MAX_COMMENTS_PER_ROOT || '3', 10);

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
        const response = await fetch(config.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: "system", content: "You are a helpful assistant summarizing Hacker News." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7
            })
        });

        const result = await response.json() as { choices?: { message?: { content?: string } }[] };
        const content = result.choices?.[0]?.message?.content || "";
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
        const response = await fetch(config.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: "system", content: "You are a tech journalist writing a daily Hacker News digest." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.5,
                max_tokens: 4000,
                reasoning: {
                    enabled: true
                }
            })
        });

        const result = await response.json() as { choices?: { message?: { content?: string } }[] };
        return result.choices?.[0]?.message?.content || "Digest generation failed.";
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
