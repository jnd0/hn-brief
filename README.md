# HN-Brief

**AI-powered daily summaries of Hacker News stories and discussions.**

Too busy to scroll through Hacker News every day? HN-Brief automatically fetches the top 20 stories, summarizes each article and its discussion using AI, and generates a cohesive daily digest all hosted as a simple static site.

🔗 **Live site**: [hn-brief.com](https://hn-brief.com)

## How It Works

1. **Fetch** — A Cloudflare Worker runs every 2 hours, pulling the top stories from the [HN Algolia API](https://hn.algolia.com/api).
2. **Summarize** — Each story + its comments are sent to an LLM (via Nvidia NIM or [OpenRouter](https://openrouter.ai)).
3. **Digest** — All summaries are combined into a single, flowing narrative for quick reading.
4. **Publish** — The Worker commits the markdown files directly to GitHub, triggering a Cloudflare Pages redeploy.

## Features

- **Article Mode**: Per-story summaries with article + discussion breakdown
- **Digest Mode**: All stories summarized into one cohesive narrative
- **Daily Archive**: Browse summaries from previous days via calendar picker
- **HN Aesthetic**: Classic Hacker News styling with Verdana font
- **Zero Framework**: Pure HTML/CSS/JS frontend

## Quick Start

### Prerequisites
- [Bun](https://bun.sh/) (v1.0+)
- API key for summarization (Nvidia NIM, OpenRouter, or OpenAI-compatible)

### Installation

```bash
# Clone the repository
git clone https://github.com/jnd0/hn-brief.git
cd hn-brief

# Install dependencies
bun install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys
```

### Run Locally

```bash
# Serve the static site
bunx serve .
```
Visit `http://localhost:3000`

### Generate Summaries

```bash
# Generate today's summaries (Article + Digest modes)
bun run summarize

# Show all CLI options
bun run summarize -- --help
```

#### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--date <YYYY-MM-DD>` | `-d` | Run for a specific date (default: today) |
| `--articles` | `-a` | Generate only article summaries |
| `--digest` | `-g` | Generate only digest summary |
| `--help` | `-h` | Show help message |

#### Examples

```bash
# Generate both modes for today
bun run summarize

# Generate for a specific date
bun run summarize -- --date 2025-12-25

# Generate only articles
bun run summarize -- --articles

# Generate only digest for a specific date
bun run summarize -- -d 2025-12-25 -g
```


## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NVIDIA_API_KEY` | Nvidia NIM API key (recommended for K2.5) | Yes (or one of below) |
| `OPENROUTER_API_KEY` | OpenRouter API key | Yes (or one of below) |
| `OPENAI_API_KEY` | OpenAI-compatible API key | Yes (or another key) |
| `LLM_MODEL` | Model to use (default: `moonshotai/kimi-k2.5` on NIM) | No |
| `LLM_API_URL` | Override LLM API URL | No |
| `LLM_THINKING_FORCE` | Force NIM thinking mode for both articles and digest (`true`/`false`) | No |
| `LLM_THINKING` | Alias for `LLM_THINKING_FORCE` | No |
| `GITHUB_TOKEN` | GitHub PAT for automated commits | For Worker only |
| `REPO_OWNER` | GitHub username | For Worker only |
| `REPO_NAME` | Repository name | For Worker only |
| `MAX_COMMENT_CHARS` | Character budget for comments (default: 15000) | No |
| `MAX_COMMENTS_PER_ROOT` | Max comments per top-level thread (default: 3) | No |

Default behavior with Nvidia NIM: article summaries run in Instant mode (temp 0.6), digest runs in Thinking mode (temp 1.0). Set `LLM_THINKING_FORCE` to force both.


## Project Structure

```
hn-brief/
├── index.html          # Frontend (Article/Digest toggle)
├── assets/
│   ├── style.css       # HN-style CSS
│   ├── app.js          # Frontend JavaScript
│   └── favicon.png     # Site favicon
├── pages/
│   ├── faq.html        # FAQ page
│   └── about.html      # About page
├── scripts/
│   └── summarizer.ts   # Bun script for local generation
├── worker/
│   ├── index.ts        # Cloudflare Worker
│   └── wrangler.jsonc  # Worker config
└── summaries/          # Generated summaries (organized by year/month)
    ├── archive.json    # Index of available dates (see below)
    └── YYYY/
        └── MM/
            ├── DD.md
            └── DD-digest.md
```


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
