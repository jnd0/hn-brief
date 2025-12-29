/// <reference types="@cloudflare/workers-types" />
interface Env {
    OPENROUTER_API_KEY: string;
    OPENROUTER_MODEL: string;
    GITHUB_TOKEN: string;
    REPO_OWNER: string;
    REPO_NAME: string;
}

const ALGOLIA_API = "https://hn.algolia.com/api/v1";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Post type detection
type PostType = 'article' | 'ask_hn' | 'show_hn' | 'tell_hn' | 'launch_hn';

function detectPostType(title: string): PostType {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.startsWith('ask hn:') || lowerTitle.startsWith('ask hn ')) return 'ask_hn';
    if (lowerTitle.startsWith('show hn:') || lowerTitle.startsWith('show hn ')) return 'show_hn';
    if (lowerTitle.startsWith('tell hn:') || lowerTitle.startsWith('tell hn ')) return 'tell_hn';
    if (lowerTitle.startsWith('launch hn:') || lowerTitle.startsWith('launch hn ')) return 'launch_hn';
    return 'article';
}

function getPostTypeLabel(type: PostType): string {
    switch (type) {
        case 'ask_hn': return 'Question';
        case 'show_hn': return 'Project';
        case 'tell_hn': return 'Post';
        case 'launch_hn': return 'Launch';
        default: return 'Article';
    }
}

interface ProcessedStory {
    id: string;
    title: string;
    url: string;
    points: number;
    num_comments: number;
    summary: string;
    discussion_summary: string;
    postType: PostType;
}

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(generateDailySummary(env));
    },

    // Manual trigger via HTTP for testing
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.searchParams.get("key") !== env.OPENROUTER_API_KEY?.substring(0, 10)) {
            return new Response("Unauthorized", { status: 401 });
        }

        ctx.waitUntil(generateDailySummary(env));
        return new Response("Triggered summary generation.");
    }
};

async function generateDailySummary(env: Env) {
    // Use London timezone for date calculation
    const now = new Date();
    const londonDate = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }); // YYYY-MM-DD format
    const date = londonDate;
    const [year, month, day] = date.split('-');

    console.log(`Generating summary for ${date}`);

    // 1. Fetch Stories (top 20 by points - exactly 49 subrequests, at the limit!)
    const stories = await fetchTopStories();
    const top20 = stories.slice(0, 20);

    // 2. Fetch all story details in PARALLEL (fast!)
    console.log(`Fetching ${top20.length} story details in parallel...`);
    const storyDetails = await Promise.all(
        top20.map(async (hit: any) => {
            const details = await fetchStoryDetails(hit.objectID);
            return { hit, details };
        })
    );
    console.log(`Fetched all story details.`);

    // 3. Process LLM calls in BATCHES of 10 (parallel within batch)
    const BATCH_SIZE = 10;
    const processedStories: ProcessedStory[] = [];

    for (let i = 0; i < storyDetails.length; i += BATCH_SIZE) {
        const batch = storyDetails.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(storyDetails.length / BATCH_SIZE)}...`);

        const batchResults = await Promise.all(
            batch.map(async ({ hit, details }) => {
                const summary = await summarizeStory(hit, details.children || [], env);
                return summary;
            })
        );

        processedStories.push(...batchResults);

        // Small delay between batches
        if (i + BATCH_SIZE < storyDetails.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    console.log(`Summarized ${processedStories.length} stories.`);

    // 2. Generate Article Mode Markdown
    let articleMd = `# Hacker News Summary - ${date}\n\n`;
    for (const s of processedStories) {
        const typeLabel = getPostTypeLabel(s.postType);
        articleMd += `## [${s.title}](${s.url})\n`;
        articleMd += `**Score:** ${s.points} | **Comments:** ${s.num_comments} | **ID:** ${s.id}\n\n`;
        articleMd += `> **${typeLabel}:** ${s.summary}\n>\n`;
        articleMd += `> **Discussion:** ${s.discussion_summary}\n\n`;
        articleMd += `---\n\n`;
    }

    // 3. Generate Digest Mode
    const digestContent = await generateDigest(processedStories, env);
    let digestMd = `# HN Daily Digest - ${date}\n\n`;
    digestMd += digestContent;
    digestMd += `\n\n---\n\n*This digest summarizes ${processedStories.length} stories from Hacker News.*`;

    // 4. Commit both files to GitHub (new folder structure)
    const folderPath = `summaries/${year}/${month}`;
    await commitToGitHub(env, `${folderPath}/${day}.md`, articleMd, `Add articles for ${date}`);
    await commitToGitHub(env, `${folderPath}/${day}-digest.md`, digestMd, `Add digest for ${date}`);

    // 5. Update Archive Index
    await updateArchive(env, date, processedStories.length);

    console.log(`✅ Completed summary for ${date}`);
}

// --- Fetch Functions ---

async function fetchTopStories() {
    // Fetch stories from the last 24 hours to ensure freshness
    // 12-day old stories on "front_page" is a known Algolia edge case we want to avoid
    const now = Math.floor(Date.now() / 1000);
    const yesterday = now - 86400;

    const url = `${ALGOLIA_API}/search?tags=story&numericFilters=created_at_i>${yesterday},points>10&hitsPerPage=50`;
    const res = await fetch(url);
    const data: any = await res.json();

    // Sort by points descending to get the true "top" stories of the day
    const hits = data.hits || [];
    return hits.sort((a: any, b: any) => (b.points || 0) - (a.points || 0));
}

async function fetchStoryDetails(id: string) {
    const res = await fetch(`${ALGOLIA_API}/items/${id}`);
    return await res.json() as any;
}

// --- LLM Functions ---

async function summarizeStory(story: any, comments: any[], env: Env): Promise<ProcessedStory> {
    const postType = detectPostType(story.title);
    const typeLabel = getPostTypeLabel(postType);
    const isSelfPost = postType !== 'article';

    const commentText = comments.slice(0, 10).map((c: any) => {
        return `- ${c.author}: ${c.text}\n` + (c.children || []).slice(0, 2).map((child: any) => `  - ${child.author}: ${child.text}`).join("\n");
    }).join("\n\n");

    const contentDescription = isSelfPost
        ? `This is a ${typeLabel} post (self-post, no external article).`
        : `This links to an external article.`;

    const prompt = `Analyze this HN ${typeLabel.toLowerCase()} and discussion.
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
[summary of key discussion points]
</Discussion Summary>`;

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: env.OPENROUTER_MODEL || "xiaomi/mimo-v2-flash:free",
                messages: [
                    { role: "system", content: "You are a helpful assistant summarizing Hacker News." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3
            })
        });

        const result: any = await response.json();
        const content = result.choices?.[0]?.message?.content || "";

        const contentMatch = content.match(/<Content Summary>([\s\S]*?)<\/Content Summary>/);
        const discussionMatch = content.match(/<Discussion Summary>([\s\S]*?)<\/Discussion Summary>/);

        return {
            id: story.objectID,
            title: story.title,
            url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
            points: story.points,
            num_comments: story.num_comments,
            summary: contentMatch ? contentMatch[1].trim() : "Summary unavailable.",
            discussion_summary: discussionMatch ? discussionMatch[1].trim() : "Discussion unavailable.",
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

async function generateDigest(stories: ProcessedStory[], env: Env): Promise<string> {
    const storiesContext = stories.map((s, i) =>
        `${i + 1}. "${s.title}" (${s.points} points, type: ${getPostTypeLabel(s.postType)})\n   ${s.summary}`
    ).join("\n\n");

    const prompt = `Write a cohesive daily HN digest for tech professionals based on these stories:
${storiesContext}

Write 10-15 paragraphs. Open with the most significant story immediately. Group related topics. End with emerging trends. 
Tone: Smart, cynical, insider.
CRITICAL: NO "Good morning", NO "Grab your coffee", NO generic intros. Start directly with the content.
No headers or bullets - flowing prose only.`;

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: env.OPENROUTER_MODEL || "xiaomi/mimo-v2-flash:free",
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

        const result: any = await response.json();
        return result.choices?.[0]?.message?.content || "Digest generation failed.";
    } catch (e) {
        console.error("Digest generation failed", e);
        return "Digest generation failed.";
    }
}

// --- GitHub Functions ---

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

async function commitToGitHub(env: Env, path: string, content: string, message: string) {
    const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;

    // Get SHA if file exists
    let sha: string | undefined;
    try {
        const check = await fetch(url, {
            headers: { "User-Agent": "HN-Brief-Worker", "Authorization": `token ${env.GITHUB_TOKEN}` }
        });
        if (check.ok) {
            const data: any = await check.json();
            sha = data.sha;
        }
    } catch { }

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

    try {
        const { content } = await fetchGitHubFile(env, archivePath);
        archive = JSON.parse(content);
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

    await commitToGitHub(env, archivePath, JSON.stringify(archive, null, 2), `Update archive for ${date}`);
}
