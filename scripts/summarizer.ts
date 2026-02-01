/**
 * HN-Brief Local Summarizer Script
 * 
 * Use this for batch processing, backfills, and local testing.
 * Run with: bun run scripts/summarizer.ts [options]
 */

import { mkdir } from "fs/promises";
import {
  type ProcessedStory,
  type AlgoliaHit,
  fetchTopStories,
  fetchStoryDetails,
  summarizeStory,
  generateDigest,
  formatArticleMarkdown,
  formatDigestMarkdown,
  getPostTypeLabel,
  getLondonDate,
  resolveLLMConfigWithFallback
} from '../shared/summarizer-core';

// ============================================================================
// Configuration
// ============================================================================

const { config: llmConfig, provider } = await resolveLLMConfigWithFallback({
  // Primary: Cebras
  CEBRAS_API_KEY: process.env.CEBRAS_API_KEY,
  CEBRAS_API_MODEL: process.env.CEBRAS_API_MODEL,
  // Fallback: Nvidia NIM
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_MODEL: process.env.NVIDIA_MODEL,
  // Fallback: Xiaomi MiMo
  XIAOMI_API_KEY: process.env.XIAOMI_API_KEY,
  XIAOMI_API_URL: process.env.XIAOMI_API_URL,
  XIAOMI_MODEL: process.env.XIAOMI_MODEL,
  // Last resort: OpenRouter
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  // Alternative providers
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  // Legacy overrides
  LLM_API_URL: process.env.LLM_API_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  // Thinking mode
  LLM_THINKING_FORCE: process.env.LLM_THINKING_FORCE,
  LLM_THINKING: process.env.LLM_THINKING
}, console);

// ============================================================================
// CLI Arguments
// ============================================================================

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

// ============================================================================
// Date Utilities (local script specific)
// ============================================================================

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

function getDatesInYear(year: string): string[] {
  const dates: string[] = [];
  const today = new Date().toISOString().split('T')[0] ?? '';

  for (let month = 1; month <= 12; month++) {
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
    dates.push(...getDatesInMonth(yearMonth));
  }
  return dates.filter(d => d <= today);
}

// ============================================================================
// Processing Functions
// ============================================================================

async function processDate(date: string | null, mode: string): Promise<{ date: string; storyCount: number }> {
  // Use London date for file naming when in "live" mode (last 24 hours)
  const fileDate = date || getLondonDate();
  const [year, month, day] = fileDate.split('-');
  const folderPath = `summaries/${year}/${month}`;

  if (date) {
    console.log(`\n📅 Processing: ${date}`);
  } else {
    console.log(`\n📅 Processing: Last 24 hours (saving to ${fileDate})`);
  }

  // Fetch and process stories (null date = last 24 hours like the worker)
  const stories = await fetchTopStories(date || undefined);
  if (stories.length === 0) {
    console.log(`   ⚠️ No stories found for ${fileDate}, skipping...`);
    return { date: fileDate, storyCount: 0 };
  }

  console.log(`   Found ${stories.length} stories, fetching details in parallel...`);

  // Fetch all story details in PARALLEL
  const storyDetails = await Promise.all(
    stories.map(async (hit: AlgoliaHit) => {
      const details = await fetchStoryDetails(hit.objectID);
      return { hit, details };
    })
  );
  console.log(`   Fetched all details, now summarizing...`);

  // Check for API key
  if (!llmConfig.apiKey) {
    console.log(`   ⚠️ No API key found, running in simulation mode`);
  }

  // Process LLM calls with rate limiting for Cebras
  // Cebras is very fast but has tokens-per-minute limits
  // Add small delay between stories + batch delays
  const BATCH_SIZE = 3;
  const STORY_DELAY_MS = 2000; // 2 seconds between each story
  const BATCH_DELAY_MS = 10000; // 10 seconds between batches
  const processedStories: ProcessedStory[] = [];

  for (let i = 0; i < storyDetails.length; i += BATCH_SIZE) {
    const batch = storyDetails.slice(i, i + BATCH_SIZE);
    console.log(`   Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(storyDetails.length / BATCH_SIZE)} (${batch.length} stories)...`);

    // Process sequentially with delay between each
    for (const { hit, details } of batch) {
      const summary = await summarizeStory(hit, details.children || [], llmConfig);
      processedStories.push(summary);
      
      // Small delay between stories to avoid overwhelming Cebras
      if (processedStories.length < storyDetails.length) {
        await new Promise(r => setTimeout(r, STORY_DELAY_MS));
      }
    }

    // Delay between batches
    if (i + BATCH_SIZE < storyDetails.length) {
      console.log(`   ⏳ Waiting ${BATCH_DELAY_MS/1000}s before next batch...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  console.log(`   ✅ Summarized ${processedStories.length} stories`);

  await mkdir(folderPath, { recursive: true });

  // Generate Article Mode Markdown
  if (mode === 'all' || mode === 'articles') {
    const articleMd = formatArticleMarkdown(processedStories, fileDate);
    await Bun.write(`${folderPath}/${day}.md`, articleMd);
    console.log(`   ✅ Saved articles`);
  }

  // Wait before generating digest to avoid rate limits
  if ((mode === 'all' || mode === 'digest') && processedStories.length > 0) {
    console.log(`   ⏳ Waiting 10s before generating digest...`);
    await new Promise(r => setTimeout(r, 10000));
    
    // Generate Digest Mode
    const digestContent = await generateDigest(processedStories, llmConfig);
    const digestMd = formatDigestMarkdown(digestContent, fileDate, processedStories.length);
    await Bun.write(`${folderPath}/${day}-digest.md`, digestMd);
    console.log(`   ✅ Saved digest`);
  }

  return { date: fileDate, storyCount: processedStories.length };
}

// ============================================================================
// Archive Management
// ============================================================================

async function updateArchive(results: { date: string; storyCount: number }[], mode: string) {
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
      hasDigest: mode === 'all' || mode === 'digest',
      storyCount: result.storyCount
    };

    if (existingIndex === -1) {
      archive.push(newEntry);
    } else {
      archive[existingIndex] = newEntry;
    }
  }

  // Scan for existing files not in archive
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

  // Normalize and sort
  archive = archive.map((entry: any) =>
    typeof entry === 'string' ? { date: entry, hasDigest: false, storyCount: 0 } : entry
  );
  archive.sort((a, b) => b.date.localeCompare(a.date));

  await Bun.write(archivePath, JSON.stringify(archive, null, 2));
  console.log(`\n📋 Updated archive index (${archive.length} total dates).`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const options = parseCliArgs();

  if (options.help) {
    showHelp();
    return;
  }

  // Determine dates to process
  let datesToProcess: (string | null)[] = [];
  let isLiveMode = false;

  if (options.year) {
    console.log(`\n🗓️ Batch mode: Processing year ${options.year}`);
    datesToProcess = getDatesInYear(options.year);
  } else if (options.month) {
    console.log(`\n🗓️ Batch mode: Processing month ${options.month}`);
    datesToProcess = getDatesInMonth(options.month);
  } else if (options.date) {
    // Specific date mode
    datesToProcess = [options.date];
  } else {
    // Live mode - last 24 hours (like the worker)
    isLiveMode = true;
    datesToProcess = [null];
  }

  console.log(`📊 Will process ${datesToProcess.length} date(s)`);
  console.log(`🎯 Mode: ${options.mode}${isLiveMode ? ' (live - last 24h)' : ''}`);

  // Process each date
  const results: { date: string; storyCount: number }[] = [];
  for (const date of datesToProcess) {
    try {
      const result = await processDate(date, options.mode || 'all');
      results.push(result);

      // Add delay between dates
      if (datesToProcess.length > 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`   ❌ Error processing ${date}:`, e);
    }
  }

  // Update archive
  await updateArchive(results, options.mode || 'all');

  // Summary
  const successCount = results.filter(r => r.storyCount > 0).length;
  console.log(`\n🎉 Done! Processed ${successCount}/${datesToProcess.length} dates.`);
}

main().catch(console.error);
