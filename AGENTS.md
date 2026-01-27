# AGENTS.md

## Project Overview

HN-Brief: AI-powered daily summaries of Hacker News stories. Automated pipeline that fetches top 20 HN stories, summarizes each with an LLM, and generates daily digests.

**Architecture:**
- **Frontend**: Static HTML/CSS/JS site (zero frameworks)
- **Backend**: Cloudflare Workers for scheduled summarization + TTS generation
- **Shared Logic**: `shared/summarizer-core.ts` contains shared types and utilities

## Development Commands

```bash
# Install dependencies
bun install

# Serve static site locally
bunx serve .

# Generate today's summaries
bun run summarize

# Generate for specific date
bun run summarize -- --date 2025-12-25

# Generate only articles or digest
bun run summarize -- --articles
bun run summarize -- --digest

# Deploy workers (from worker directories)
npx wrangler deploy
```

## Project Structure

```
hn-brief/
├── index.html              # Main frontend
├── assets/                 # CSS, JS, favicon
├── pages/                  # Static pages (FAQ, About)
├── scripts/summarizer.ts   # Local Bun summarizer script
├── shared/summarizer-core.ts  # Shared processing logic
├── workers/
│   ├── summarizer/         # Scheduled summary worker
│   └── tts/                # Text-to-speech worker
└── summaries/              # Generated markdown files
    ├── archive.json        # Index of available dates
    └── YYYY/MM/DD.md       # Per-day summaries
```

## Code Style

- TypeScript strict mode enabled
- ESNext target with bundler module resolution
- Keep frontend vanilla (no frameworks)
- Use functional patterns in TypeScript
- Named exports preferred in shared modules

## Environment Variables

Required for LLM summarization:
- `NVIDIA_API_KEY` - Primary LLM provider (default model: `moonshotai/kimi-k2.5`)
- `OPENROUTER_API_KEY` - Fallback LLM provider
- `LLM_MODEL` - Override model name (provider-specific)
- `LLM_THINKING_FORCE` - Force NIM thinking mode for both articles and digest (`true`/`false`)
- `LLM_THINKING` - Alias for `LLM_THINKING_FORCE`

Default behavior with Nvidia NIM: article summaries use Instant mode (temp 0.6), digest uses Thinking mode (temp 1.0). Set `LLM_THINKING_FORCE` to force both.

For GitHub auto-commit (workers only):
- `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`

Comment selection (optional):
- `MAX_COMMENT_CHARS` - Character budget for comments (default: `15000`)
- `MAX_COMMENTS_PER_ROOT` - Max comments per top-level thread (default: `3`)

## Key Conventions

- **Date format**: Always `YYYY-MM-DD`
- **Timezone**: London timezone for date calculations (`getLondonDate()`)
- **Summary files**: `summaries/YYYY/MM/DD.md` (articles) and `DD-digest.md` (digest)
- **Post types**: `article`, `ask_hn`, `show_hn`, `tell_hn`, `launch_hn`

## API Integration

- **HN Algolia API**: `https://hn.algolia.com/api/v1` for story fetching
- **Nvidia NIM**: `https://integrate.api.nvidia.com/v1/chat/completions`
- **OpenRouter**: OpenAI-compatible endpoint for LLM calls
- **GitHub API**: For automated commits (workers)

## When Modifying

- LLM prompts are in `shared/summarizer-core.ts` (`buildSummaryPrompt`, `buildDigestPrompt`)
- Frontend JS is in `assets/app.js`
- Worker configs are in `workers/*/wrangler.jsonc`
- Update `archive.json` when adding new summary dates

## Comment Selection Algorithm

Comments are selected using a scoring algorithm (not by position). Key functions in `shared/summarizer-core.ts`:

**Scoring formula:**
```
score = 2.0 * log(1 + descendantCount)   // Thread engagement
      + 1.0 * log(1 + textLength/100)    // Substantive content
      + 0.8 * directReplyCount            // Immediate reactions
      + 0.3 * uniqueAuthorCount           // Discussion diversity
      - 0.8 * max(0, depth - 2)           // Depth penalty (after level 2)
```

**Selection rules:**
- Budget: 15,000 characters (top ~10-15 quality comments)
- Per-root cap: max 3 comments from same top-level thread
- Deep comments include ancestor chain for context
- HTML stripped for scoring; deleted/empty comments skipped

**To tune:** Modify weights in `scoreComment()` or budget in `selectAndFormatComments()`.

## Inference Configuration (Thinking Protocol)

To prevent timeouts and ensure high-quality reasoning with models like `kimi-k2.5`:

1.  **Streaming (`stream: true`)**: Mandatory to prevent `524` timeouts during long reasoning pauses.
2.  **Parameters**:
    - **Thinking Mode**: `temperature: 1.0`, `top_p: 0.95`, `thinking: { type: "enabled" }`
    - **Instant Mode**: `temperature: 0.6`, `top_p: 0.95`, `thinking: false`
3.  **Max Tokens**: Set to `>= 16000` to prevent truncation of reasoning content.
4.  **Error Handling**: Robust checks for `!response.ok` (handling HTML error pages) and JSON parsing errors.

## Cloudflare Worker Limits

**Subrequest Limit (50 fetch calls):**
The `summarizer` worker is optimized to stay continuously under the strict 50 subrequest limit per execution.

**Usage Breakdown (~48 fetches):**
- **Algolia API**: 21 fetches (1 top stories + 20 details)
- **LLM API**: 21 fetches (20 story summaries + 1 digest)
- **GitHub API**: 6 fetches (3 commit puts + 3 get/check calls)

**Optimization Strategy:**
- The worker reuses the `SHA` from the `fetchGitHubFile` call when updating `archive.json` to save 1 fetch call.
- **Critical**: Do not add extra external API calls without verifying against this limit.
