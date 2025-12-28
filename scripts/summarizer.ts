import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import { parseArgs } from "util";

// Configuration
const ALGOLIA_API = "http://hn.algolia.com/api/v1";

// LLM Provider Configuration
// Priority: OpenRouter > Kimi > OpenAI-compatible
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Determine which API to use
const USE_OPENROUTER = !!OPENROUTER_API_KEY;
const API_KEY = OPENROUTER_API_KEY || KIMI_API_KEY || OPENAI_API_KEY;
const API_URL = USE_OPENROUTER
  ? "https://openrouter.ai/api/v1/chat/completions"
  : "https://api.moonshot.cn/v1/chat/completions";
const MODEL = USE_OPENROUTER
  ? OPENROUTER_MODEL
  : "moonshot-v1-8k";

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

// CLI Arguments
interface CLIOptions {
  date?: string;
  month?: string;  // YYYY-MM format
  year?: string;   // YYYY format
  mode?: 'all' | 'articles' | 'digest';
  help?: boolean;
}

function parseCliArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { mode: 'all' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--date' || arg === '-d') {
      options.date = args[++i];
    } else if (arg === '--month' || arg === '-m') {
      options.month = args[++i];
    } else if (arg === '--year' || arg === '-y') {
      options.year = args[++i];
    } else if (arg === '--articles' || arg === '-a') {
      options.mode = 'articles';
    } else if (arg === '--digest' || arg === '-g') {
      options.mode = 'digest';
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
HN-Brief Summarizer

Usage: bun run scripts/summarizer.ts [options]

Options:
  -d, --date <YYYY-MM-DD>   Run for a specific date (default: today)
  -m, --month <YYYY-MM>     Generate for entire month (batch mode)
  -y, --year <YYYY>         Generate for entire year (batch mode)
  -a, --articles            Generate only article summaries
  -g, --digest              Generate only digest summary
  -h, --help                Show this help message

Examples:
  bun run scripts/summarizer.ts                      # Generate both for today
  bun run scripts/summarizer.ts --date 2025-12-25   # Generate for specific date
  bun run scripts/summarizer.ts --month 2025-12    # Generate for Dec 2025
  bun run scripts/summarizer.ts --year 2025         # Generate for all of 2025
  bun run scripts/summarizer.ts -m 2025-12 -a       # Month, articles only
  bun run scripts/summarizer.ts -d 2025-12-25 -g   # Generate only digest for date
`);
}

console.log(`Using ${USE_OPENROUTER ? 'OpenRouter' : 'Kimi'} with model: ${MODEL}`);

// 1. Fetch Front Page Stories (supports date filter)
async function fetchTopStories(date?: string) {
  console.log("Fetching front page stories...");

  // For specific date, search for top stories from that day
  // Note: front_page tag only works for current stories, so we search by date + sort by points
  if (date) {
    const startTimestamp = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const endTimestamp = startTimestamp + 86400; // +24 hours

    // Search for stories from that date - fetch more, then filter to top by points
    // Using points>10 to exclude very low engagement posts while still getting enough results
    const url = `${ALGOLIA_API}/search?tags=story&numericFilters=created_at_i>=${startTimestamp},created_at_i<${endTimestamp},points>10&hitsPerPage=50`;
    const res = await fetch(url);
    const data = await res.json() as any;

    // Sort by points descending and take top 20
    const sortedHits = (data.hits || []).sort((a: any, b: any) => (b.points || 0) - (a.points || 0));
    return sortedHits.slice(0, 20);
  }

  // Default: today's front page (last 24h)
  // Modified to be explicit about time range to avoid old stories via "front_page" tag
  console.log("   Fetching top stories from the last 24 hours...");
  const now = Math.floor(Date.now() / 1000);
  const yesterday = now - 86400;

  const url = `${ALGOLIA_API}/search?tags=story&numericFilters=created_at_i>${yesterday},points>10&hitsPerPage=50`;
  const res = await fetch(url);
  const data = await res.json() as any;
  const hits = data.hits || [];
  return hits.sort((a: any, b: any) => (b.points || 0) - (a.points || 0)).slice(0, 20);
}

// 2. Fetch Story Details & Comments
async function fetchStoryDetails(storyId: string) {
  const res = await fetch(`${ALGOLIA_API}/items/${storyId}`);
  return await res.json();
}

// 3. Summarize the story and its comments
async function summarizeStory(story: any, comments: any[]): Promise<ProcessedStory> {
  const postType = detectPostType(story.title);
  const typeLabel = getPostTypeLabel(postType);

  // Flatten comments for context (heuristic: top 10 top-level comments + 1 nested level)
  const commentText = comments.slice(0, 10).map((c: any) => {
    return `- ${c.author}: ${c.text} \n` + (c.children || []).slice(0, 2).map((child: any) => `  - ${child.author}: ${child.text}`).join("\n");
  }).join("\n\n");

  // Adjust prompt based on post type
  const isSelfPost = postType !== 'article';
  const contentDescription = isSelfPost
    ? `This is a ${typeLabel} post (self-post with text content, no external article).`
    : `This links to an external article.`;

  const summaryInstruction = isSelfPost
    ? `Summarize the author's main point/question from the post text below.`
    : `Provide a concise summary of what the linked article is about (infer from title, URL, and discussion if needed).`;

  const prompt = `
  Analyze this Hacker News ${typeLabel.toLowerCase()} and its discussion.
  
  ${contentDescription}
  
  Title: ${story.title}
  URL: ${story.url || 'N/A (self-post)'}
  Post Text: ${story.text || 'N/A'}
  
  Top Comments:
  ${commentText}
  
  ${summaryInstruction}
  Also summarize the discussion (consensus, disagreements, key insights). 
  Write in a high-quality, objective, slightly cynical but informed tone typical of a senior engineer.
  
  Format:
  <Content Summary>
  [Your ${typeLabel.toLowerCase()} summary here]
  </Content Summary>
  <Discussion Summary>
  [Your discussion summary here]
  </Discussion Summary>
  `;

  if (!API_KEY) {
    return {
      id: story.objectID,
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
      points: story.points,
      num_comments: story.num_comments,
      summary: `Simulation: API Key missing. ${typeLabel} summary would go here.`,
      discussion_summary: "Simulation: Discussion summary would go here.",
      postType
    };
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a helpful assistant summarizing Hacker News." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3
      })
    });

    const result = await response.json() as any;
    const content = result.choices?.[0]?.message?.content || "";

    // Parse with new tags
    const contentMatch = content.match(/<Content Summary>([\s\S]*?)<\/Content Summary>/);
    const discussionMatch = content.match(/<Discussion Summary>([\s\S]*?)<\/Discussion Summary>/);

    return {
      id: story.objectID,
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
      points: story.points,
      num_comments: story.num_comments,
      summary: contentMatch ? contentMatch[1].trim() : "Failed to parse summary.",
      discussion_summary: discussionMatch ? discussionMatch[1].trim() : "Failed to parse discussion.",
      postType
    };

  } catch (error) {
    console.error(`Failed to summarize ${story.title}:`, error);
    return {
      id: story.objectID,
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.objectID}`,
      points: story.points,
      num_comments: story.num_comments,
      summary: "Error generating summary.",
      discussion_summary: "Error generating discussion summary.",
      postType
    };
  }
}

// 4. Generate Digest Summary (all articles into one cohesive summary)
async function generateDigest(stories: ProcessedStory[]): Promise<string> {
  const storiesContext = stories.map((s, i) =>
    `${i + 1}. "${s.title}" (${s.points} points, ${s.num_comments} comments, type: ${getPostTypeLabel(s.postType)})\n   Summary: ${s.summary}\n   Discussion: ${s.discussion_summary}`
  ).join("\n\n");

  const prompt = `
  You are writing a daily Hacker News digest for busy tech professionals.
  
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
  - No bullet points or headers. flowing prose only.
  `;

  if (!API_KEY) {
    return "Simulation: API Key missing. Digest would go here.";
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a tech journalist writing a daily Hacker News digest." },
          { role: "user", content: prompt }
        ],
        temperature: 0.5,
        max_tokens: 4000,
        // Re-enabling reasoning based on documentation for MiMo-V2-Flash
        reasoning: {
          enabled: true
        }
      })
    });

    const result = await response.json() as any;
    return result.choices?.[0]?.message?.content || "Failed to generate digest.";
  } catch (error) {
    console.error("Failed to generate digest:", error);
    return "Error generating digest.";
  }
}

// Helper: Generate dates for a month
function getDatesInMonth(yearMonth: string): string[] {
  const parts = yearMonth.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const dates: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date().toISOString().split('T')[0] ?? '';

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (date <= today) {
      dates.push(date);
    }
  }
  return dates;
}

// Helper: Generate dates for a year
function getDatesInYear(year: string): string[] {
  const dates: string[] = [];
  const today = new Date().toISOString().split('T')[0] ?? '';

  for (let month = 1; month <= 12; month++) {
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
    dates.push(...getDatesInMonth(yearMonth));
  }
  return dates.filter(d => d <= today);
}

// Process a single date
async function processDate(date: string, mode: string): Promise<{ date: string; storyCount: number }> {
  const [year, month, day] = date.split('-');
  const folderPath = `summaries/${year}/${month}`;

  console.log(`\n📅 Processing: ${date}`);

  // Fetch and process stories
  const stories = await fetchTopStories(date);
  if (stories.length === 0) {
    console.log(`   ⚠️ No stories found for ${date}, skipping...`);
    return { date, storyCount: 0 };
  }

  console.log(`   Found ${stories.length} stories, fetching details in parallel...`);

  // Fetch all story details in PARALLEL (fast!)
  const storyDetails = await Promise.all(
    stories.map(async (hit: any) => {
      const details = await fetchStoryDetails(hit.objectID) as any;
      return { hit, details };
    })
  );
  console.log(`   Fetched all details, now summarizing...`);

  // Process LLM calls in BATCHES of 10 (parallel within batch, sequential between batches)
  // This respects OpenRouter's 20 req/min limit while being much faster
  const BATCH_SIZE = 10;
  const processedStories: ProcessedStory[] = [];

  for (let i = 0; i < storyDetails.length; i += BATCH_SIZE) {
    const batch = storyDetails.slice(i, i + BATCH_SIZE);
    console.log(`   Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(storyDetails.length / BATCH_SIZE)} (${batch.length} stories)...`);

    const batchResults = await Promise.all(
      batch.map(async ({ hit, details }) => {
        const summary = await summarizeStory(hit, details.children || []);
        return summary;
      })
    );

    processedStories.push(...batchResults);

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < storyDetails.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`   ✅ Summarized ${processedStories.length} stories`);

  await mkdir(folderPath, { recursive: true });

  // Generate Article Mode Markdown
  if (mode === 'all' || mode === 'articles') {
    let articleMd = `# Hacker News Summary - ${date}\n\n`;
    for (const s of processedStories) {
      const typeLabel = getPostTypeLabel(s.postType);
      articleMd += `## [${s.title}](${s.url})\n`;
      articleMd += `**Score:** ${s.points} | **Comments:** ${s.num_comments} | **ID:** ${s.id}\n\n`;
      articleMd += `> **${typeLabel}:** ${s.summary}\n>\n`;
      articleMd += `> **Discussion:** ${s.discussion_summary}\n\n`;
      articleMd += `---\n\n`;
    }
    await Bun.write(`${folderPath}/${day}.md`, articleMd);
    console.log(`   ✅ Saved articles`);
  }

  // Generate Digest Mode
  if (mode === 'all' || mode === 'digest') {
    const digestContent = await generateDigest(processedStories);
    let digestMd = `# HN Daily Digest - ${date}\n\n`;
    digestMd += digestContent;
    digestMd += `\n\n---\n\n*This digest summarizes the top ${processedStories.length} stories from Hacker News.*`;
    await Bun.write(`${folderPath}/${day}-digest.md`, digestMd);
    console.log(`   ✅ Saved digest`);
  }

  return { date, storyCount: processedStories.length };
}

// 5. Main Loop
async function main() {
  const options = parseCliArgs();

  if (options.help) {
    showHelp();
    return;
  }

  // Determine dates to process
  let datesToProcess: string[] = [];

  if (options.year) {
    console.log(`\n🗓️ Batch mode: Processing year ${options.year}`);
    datesToProcess = getDatesInYear(options.year);
  } else if (options.month) {
    console.log(`\n🗓️ Batch mode: Processing month ${options.month}`);
    datesToProcess = getDatesInMonth(options.month);
  } else {
    datesToProcess = [options.date || new Date().toISOString().split('T')[0] || ''];
  }

  console.log(`📊 Will process ${datesToProcess.length} date(s)`);
  console.log(`🎯 Mode: ${options.mode}`);

  // Process each date
  const results: { date: string; storyCount: number }[] = [];
  for (const date of datesToProcess) {
    try {
      const result = await processDate(date, options.mode || 'all');
      results.push(result);

      // Add small delay between dates to avoid rate limiting
      if (datesToProcess.length > 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`   ❌ Error processing ${date}:`, e);
    }
  }

  // Update Archive Index - scan ALL existing files to ensure sync
  const archivePath = "summaries/archive.json";
  let archive: any[] = [];
  try {
    const file = await Bun.file(archivePath).text();
    archive = JSON.parse(file);
  } catch (e) {
    // File doesn't exist yet
  }

  // Add/update entries for processed dates
  for (const result of results) {
    if (result.storyCount === 0) continue;

    const existingIndex = archive.findIndex((entry: any) =>
      typeof entry === "string" ? entry === result.date : entry.date === result.date
    );

    const newEntry = {
      date: result.date,
      hasDigest: options.mode === 'all' || options.mode === 'digest',
      storyCount: result.storyCount
    };

    if (existingIndex === -1) {
      archive.push(newEntry);
    } else {
      archive[existingIndex] = newEntry;
    }
  }

  // Also scan for existing files not in archive (from previous runs)
  try {
    const { readdir } = await import('fs/promises');
    const baseDir = 'summaries';
    const years = await readdir(baseDir);

    for (const year of years) {
      if (!year.match(/^\d{4}$/)) continue;
      const months = await readdir(`${baseDir}/${year}`);

      for (const month of months) {
        if (!month.match(/^\d{2}$/)) continue;
        const files = await readdir(`${baseDir}/${year}/${month}`);

        for (const file of files) {
          const match = file.match(/^(\d{2})\.md$/);
          if (!match) continue;

          const date = `${year}-${month}-${match[1]}`;
          const hasDigest = files.includes(`${match[1]}-digest.md`);

          // Check if already in archive
          const exists = archive.some((entry: any) =>
            (typeof entry === 'string' ? entry : entry.date) === date
          );

          if (!exists) {
            archive.push({ date, hasDigest, storyCount: 20 });
          }
        }
      }
    }
  } catch (e) {
    console.error('Error scanning files:', e);
  }

  // Normalize all entries to object format and sort by date descending
  archive = archive.map((entry: any) =>
    typeof entry === 'string' ? { date: entry, hasDigest: false, storyCount: 0 } : entry
  );
  archive.sort((a, b) => b.date.localeCompare(a.date));

  await Bun.write(archivePath, JSON.stringify(archive, null, 2));

  // Summary
  const successCount = results.filter(r => r.storyCount > 0).length;
  console.log(`\n📋 Updated archive index (${archive.length} total dates).`);
  console.log(`\n🎉 Done! Processed ${successCount}/${datesToProcess.length} dates.`);
}

main().catch(console.error);
